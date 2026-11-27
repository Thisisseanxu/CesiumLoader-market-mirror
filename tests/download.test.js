import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serveDownload } from '../src/download.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture({ ignoreRange = false, failPart = -1, truncatePart = -1, invalidRange = false, arrayBuffers = false } = {}) {
  const Stream = ReadableStream;
  const bytes = Buffer.from('PK\x03\x04original ZIP data across three parts');
  const buffers = [bytes.subarray(0, 12), bytes.subarray(12, 27), bytes.subarray(27)];
  const sha256 = hash(bytes);
  const entry = { sha256, sizeBytes: bytes.length, filename: 'Cards-1.0.zip', parts: buffers.map((b, i) => ({
    url: `/chunks/${sha256}/${i}-${hash(b)}.part`, sha256: hash(b), sizeBytes: b.length,
  })) };
  const calls = [];
  const fetcher = async (url, init) => {
    const index = entry.parts.findIndex(p => url === `https://mirror.example${p.url}`);
    assert.notEqual(index, -1, 'requests only immutable same-origin parts');
    calls.push({ index, headers: init.headers });
    assert.equal(init.redirect, 'error');
    if (index === failPart) return new Response(null, { status: 404 });
    let body = buffers[index];
    const range = init.headers.get('range');
    let status = 200;
    const headers = new Headers();
    if (range && !ignoreRange) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
      status = 206;
      body = body.subarray(Number(start), Number(end) + 1);
      headers.set('content-range', invalidRange ? 'bytes 0-0/1' : `bytes ${start}-${end}/${buffers[index].length}`);
    }
    if (index === truncatePart) body = body.subarray(0, body.length - 1);
    // Small chunks exercise the streaming skip/limit logic, without buffer helpers.
    const stream = new Stream({ start(controller) {
      for (let offset = 0; offset < body.length; offset += 3) {
        const bytes = body.subarray(offset, offset + 3);
        controller.enqueue(arrayBuffers ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
      }
      controller.close();
    } });
    const response = new Response(stream, { status, headers });
    response.arrayBuffer = () => { throw new Error('Must never buffer an upstream part'); };
    return response;
  };
  const request = (headers = {}, method = 'GET') => new Request(`https://mirror.example/api/downloads/${sha256}.zip`, { headers, method });
  return { bytes, entry, fetcher, request, calls };
}

test('streamed download reconstructs the byte-identical ZIP, passes the preview cookie and sets integrity headers', async () => {
  const f = fixture();
  const response = await serveDownload(f.request({ cookie: 'eo_preview=test' }), f.entry, f.fetcher);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('etag'), `"${f.entry.sha256}"`);
  assert.match(response.headers.get('content-disposition'), /Cards-1.0.zip/);
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), f.entry.sha256);
  assert.deepEqual(f.calls.map(c => c.index), [0, 1, 2]);
  assert.ok(f.calls.every(c => c.headers.get('cookie') === 'eo_preview=test'));
});

for (const ignoreRange of [false, true]) {
  test(`byte ranges cross parts and handle a static origin that ${ignoreRange ? 'ignores' : 'supports'} Range`, async () => {
    for (const [range, start, end] of [['bytes=8-30', 8, 30], ['bytes=12-14', 12, 14], ['bytes=-5', -5], ['bytes=27-', 27]]) {
      const f = fixture({ ignoreRange });
      const response = await serveDownload(f.request({ range }), f.entry, f.fetcher);
      assert.equal(response.status, 206, range);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(start, end == null ? undefined : end + 1), range);
      assert.ok(f.calls.length <= 3);
    }
  });
}

test('HEAD, conditional requests and invalid ranges never fetch any part', async () => {
  const f = fixture();
  const head = await serveDownload(f.request({}, 'HEAD'), f.entry, f.fetcher);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal((await serveDownload(f.request({ 'if-none-match': `W/"${f.entry.sha256}"` }), f.entry, f.fetcher)).status, 304);
  for (const range of ['bytes=99-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,3-4', 'garbage', 'bytes=-']) {
    const response = await serveDownload(f.request({ range }), f.entry, f.fetcher);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${f.bytes.length}`);
  }
  assert.equal(f.calls.length, 0);
});

test('If-Range mismatch returns the complete ZIP', async () => {
  const f = fixture();
  const response = await serveDownload(f.request({ range: 'bytes=1-2', 'if-range': '"older"' }), f.entry, f.fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
});

test('first-part failures return 502; later missing/truncated parts abort the stream', async () => {
  const first = fixture({ failPart: 0 });
  assert.equal((await serveDownload(first.request(), first.entry, first.fetcher)).status, 502);
  for (const options of [{ failPart: 1 }, { truncatePart: 0 }, { truncatePart: 2 }]) {
    const f = fixture(options);
    const response = await serveDownload(f.request(), f.entry, f.fetcher);
    await assert.rejects(response.arrayBuffer(), /part/);
  }
  const f = fixture({ invalidRange: true });
  assert.equal((await serveDownload(f.request({ range: 'bytes=1-2' }), f.entry, f.fetcher)).status, 502);
});

test('invalid descriptors cannot fetch arbitrary URLs or exceed the per-invocation fetch budget', async () => {
  const f = fixture();
  for (const entry of [{ ...f.entry, sizeBytes: 100 },
    { ...f.entry, parts: [{ ...f.entry.parts[0], url: 'https://other.example/secret' }] },
    { ...f.entry, parts: Array(65).fill(f.entry.parts[0]) }]) {
    assert.equal((await serveDownload(f.request(), entry, f.fetcher)).status, 503);
  }
  assert.equal(f.calls.length, 0);
});

test('cancelled responses stop fetching subsequent parts', async () => {
  const f = fixture();
  const response = await serveDownload(f.request(), f.entry, f.fetcher);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(f.calls.map(c => c.index), [0]);
});

test('cancellation while waiting on a slow part closes the pending read', async () => {
  const f = fixture();
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  let cancelled = false;
  let calls = 0;
  const response = await serveDownload(f.request(), f.entry, async () => {
    calls++;
    return new Response(new ReadableStream({
      pull() { reading(); },
      cancel() { cancelled = true; },
    }));
  });
  const reader = response.body.getReader();
  const pending = reader.read();
  await started;
  await reader.cancel();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('edge requests without AbortSignal still stream the original package', async () => {
  const f = fixture();
  const request = f.request();
  const response = await serveDownload({ url: request.url, method: 'GET', headers: request.headers }, f.entry, f.fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
});

test('edge runtime without a ReadableStream constructor supports ArrayBuffer chunks and waitUntil', async t => {
  const f = fixture({ arrayBuffers: true });
  t.mock.method(globalThis, 'ReadableStream', function () { throw new Error('EdgeOne does not expose this constructor'); });
  const tasks = [];
  const response = await serveDownload(f.request(), f.entry, f.fetcher, { waitUntil: task => tasks.push(task) });
  assert.equal(tasks.length, 1);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  await tasks[0];
});

test('native FixedLengthStream is used when available for accurate download size', async t => {
  const f = fixture();
  let length;
  class FixedStream extends TransformStream {
    constructor(size) { super(); length = size; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
  Object.defineProperty(globalThis, 'FixedLengthStream', { configurable: true, value: FixedStream });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'FixedLengthStream', previous);
    else delete globalThis.FixedLengthStream;
  });
  const response = await serveDownload(f.request({ range: 'bytes=8-30' }), f.entry, f.fetcher);
  assert.equal(length, 23);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(8, 31));
});
