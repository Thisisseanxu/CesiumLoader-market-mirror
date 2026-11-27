const PART_PATH = /^\/chunks\/[a-f0-9]{64}\/\d+-[a-f0-9]{64}\.part$/;

function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end
    || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end, partial: true };
}

/** Stream immutable same-origin parts into the original ZIP, including byte ranges. */
export async function serveDownload(request, entry, fetcher = fetch, { waitUntil } = {}) {
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes)
    || entry.sizeBytes <= 0 || !Array.isArray(entry.parts) || !entry.parts.length || entry.parts.length > 60
    || entry.parts.some(p => !PART_PATH.test(p.url) || !Number.isSafeInteger(p.sizeBytes) || p.sizeBytes <= 0)
    || entry.parts.reduce((n, p) => n + p.sizeBytes, 0) !== entry.sizeBytes) {
    return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  const etag = `"${entry.sha256}"`;
  const headers = new Headers({
    'content-type': 'application/zip', 'accept-ranges': 'bytes', etag,
    'cache-control': 'public, max-age=31536000, immutable, no-transform',
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="${/^[A-Za-z0-9_.+-]+$/.test(entry.filename ?? '') ? entry.filename : entry.sha256 + '.zip'}"`,
  });
  if ((request.headers.get('if-none-match') ?? '').split(',').map(s => s.trim()).some(s => s === '*' || s.replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers });
  }
  const ifRange = request.headers.get('if-range');
  const range = rangeFor(!ifRange || ifRange === etag ? request.headers.get('range') : null, entry.sizeBytes);
  if (!range) {
    headers.set('content-range', `bytes */${entry.sizeBytes}`);
    headers.set('cache-control', 'no-store');
    return new Response(null, { status: 416, headers });
  }
  headers.set('content-length', String(range.end - range.start + 1));
  if (range.partial) headers.set('content-range', `bytes ${range.start}-${range.end}/${entry.sizeBytes}`);
  if (request.method === 'HEAD') return new Response(null, { status: range.partial ? 206 : 200, headers });

  const selected = [];
  let offset = 0;
  for (const part of entry.parts) {
    const start = Math.max(0, range.start - offset);
    const end = Math.min(part.sizeBytes - 1, range.end - offset);
    if (start <= end) selected.push({ ...part, start, end });
    offset += part.sizeBytes;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  // EdgeOne's incoming Request does not always expose the optional signal.
  request.signal?.addEventListener('abort', cancel, { once: true });
  if (request.signal?.aborted) abort.abort();
  let state;
  let cursor = 0;
  let disposed = false;
  const dispose = async () => {
    disposed = true;
    request.signal?.removeEventListener('abort', cancel);
    abort.abort();
    const current = state;
    state = null;
    try { await current?.reader.cancel(); } catch { /* An aborted reader may already be closed. */ }
  };
  async function openPart() {
    const part = selected[cursor++];
    if (!part) return false;
    const partial = part.start !== 0 || part.end !== part.sizeBytes - 1;
    const partHeaders = new Headers({ 'accept-encoding': 'identity' });
    // Preview deployments protect static assets with the same cookie as the API.
    if (request.headers.has('cookie')) partHeaders.set('cookie', request.headers.get('cookie'));
    if (partial) partHeaders.set('range', `bytes=${part.start}-${part.end}`);
    const response = await fetcher(new URL(part.url, request.url).href, {
      headers: partHeaders, redirect: 'error', signal: abort.signal,
      eo: { timeoutSetting: { connectTimeout: 10_000, readTimeout: 300_000, writeTimeout: 300_000 } },
    });
    if (disposed || abort.signal.aborted) { await response.body?.cancel(); throw new Error('Download cancelled'); }
    const wanted = part.end - part.start + 1;
    const expected = response.status === 206 ? wanted : part.sizeBytes;
    if (![200, 206].includes(response.status) || !response.body
      || (response.status === 206 && response.headers.get('content-range') !== `bytes ${part.start}-${part.end}/${part.sizeBytes}`)
      || (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== expected)
      || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
      await response.body?.cancel();
      throw new Error('Mirror part unavailable or has invalid length');
    }
    state = { reader: response.body.getReader(), remaining: wanted,
      skip: response.status === 206 ? 0 : part.start, received: 0, expected,
      canCancel: response.status === 200 && part.end < part.sizeBytes - 1 };
    return true;
  }
  try { await openPart(); }
  catch {
    await dispose();
    return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  // EdgeOne cannot construct ReadableStream directly. FixedLengthStream also
  // lets its runtime retain Content-Length instead of forcing chunked encoding.
  const length = range.end - range.start + 1;
  const { readable, writable } = typeof FixedLengthStream === 'function'
    ? new FixedLengthStream(length) : new TransformStream();
  const writer = writable.getWriter();
  writer.closed.catch(() => dispose());
  const transfer = (async () => {
      try {
        while (state) {
          if (state.remaining === 0 && state.canCancel) {
            const current = state;
            state = null;
            await current.reader.cancel();
            if (disposed) return;
            if (!await openPart()) break;
          }
          const current = state;
          const result = await current.reader.read();
          if (disposed) return;
          if (result.done) {
            if (state.remaining || state.received !== state.expected) throw new Error('Mirror part truncated');
            state = null;
            if (!await openPart()) break;
            continue;
          }
          const value = result.value;
          // Native edge readers may return ArrayBuffer rather than Uint8Array.
          let bytes = value instanceof Uint8Array ? value : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
          state.received += bytes.byteLength;
          if (state.received > state.expected) throw new Error('Mirror part exceeds declared length');
          const skipped = Math.min(state.skip, bytes.byteLength);
          state.skip -= skipped;
          bytes = bytes.subarray(skipped);
          const count = Math.min(state.remaining, bytes.byteLength);
          state.remaining -= count;
          if (count) await writer.write(bytes.subarray(0, count));
        }
        await dispose();
        await writer.close();
      } catch (error) {
        if (disposed) return;
        await dispose();
        try { await writer.abort(error); } catch { /* The client may already have cancelled. */ }
      }
  })();
  waitUntil?.(transfer);
  return new Response(readable, { status: range.partial ? 206 : 200, headers });
}
