import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CHUNK_BYTES, STATIC_FILE_BYTES } from './policy.mjs';

export const USER_AGENT = 'cesium-market-mirror/0.2 (AstralParty.Toys compatible read-only mirror)';
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function openResponse(url, { headers = {}, timeout = 60_000 } = {}) {
  let target = new URL(url);
  const signal = AbortSignal.timeout(timeout);
  for (let hops = 0; hops <= 8; hops++) {
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid upstream URL');
    const response = await fetch(target, { headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hops === 8) throw new Error('Invalid or excessive redirects');
      const next = new URL(location, target);
      if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade refused');
      target = next;
      continue;
    }
    if (!response.ok && response.status !== 304) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} for ${target.origin}${target.pathname}`);
    }
    return response;
  }
}

export async function verifyPackageFile(filename, { sha256, sizeBytes }) {
  if ((await stat(filename)).size !== sizeBytes) throw new Error('Size mismatch in package cache');
  const hash = createHash('sha256');
  let signature = Buffer.alloc(0);
  for await (const chunk of createReadStream(filename)) {
    if (signature.length < 4) signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
    hash.update(chunk);
  }
  if (!signature.equals(Buffer.from('PK\x03\x04'))) throw new Error('Package is not a ZIP');
  if (hash.digest('hex') !== sha256.toLowerCase()) throw new Error('SHA-256 mismatch in package cache');
}

/** Stream to disk, then publish the verified cache object atomically. */
export async function cachePackage(url, metadata, objectsRoot) {
  const filename = join(objectsRoot, metadata.sha256.toLowerCase());
  try { await verifyPackageFile(filename, metadata); return filename; } catch { /* Replace missing/corrupt cache. */ }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const temp = `${filename}.${randomUUID()}.tmp`;
    let handle;
    try {
      const response = await openResponse(url, { timeout: 10 * 60_000 });
      if (!response.body) throw new Error('Empty package body');
      const declared = response.headers.get('content-length');
      if (declared != null && Number(declared) !== metadata.sizeBytes) {
        await response.body.cancel();
        throw new Error(`Size mismatch: expected ${metadata.sizeBytes}, got ${declared}`);
      }
      handle = await open(temp, 'wx');
      const hash = createHash('sha256');
      let size = 0;
      let signature = Buffer.alloc(0);
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > metadata.sizeBytes) throw new Error('Size mismatch: package exceeds declared size');
        if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(chunk.subarray(0, 4 - signature.length))]);
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (size !== metadata.sizeBytes) throw new Error(`Size mismatch: expected ${metadata.sizeBytes}, got ${size}`);
      if (!signature.equals(Buffer.from('PK\x03\x04'))) throw new Error('Package is not a ZIP (possible HTML error page)');
      if (hash.digest('hex') !== metadata.sha256.toLowerCase()) throw new Error('SHA-256 mismatch in package download');
      await handle.close(); handle = null;
      // Windows rename cannot replace a restored corrupt cache object.
      await rm(filename, { force: true });
      await rename(temp, filename);
      return filename;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await pause(500 * 2 ** attempt);
    } finally {
      await handle?.close();
      await rm(temp, { force: true });
    }
  }
  throw lastError;
}

export function packageUrl(group, version) {
  return version.sizeBytes > STATIC_FILE_BYTES
    ? `/api/downloads/${version.sha256.toLowerCase()}.zip`
    : `/packages/${group.kind === 'resource' ? 'resources/' : ''}${group.id}/${version.version}-${version.sha256.toLowerCase()}.zip`;
}

/** Each deployed part is small; no full oversized ZIP is left in public/. */
export async function splitPackage(filename, version, publicRoot, outputFile) {
  const parts = [];
  const handle = await open(filename, 'r');
  try {
    for (let offset = 0, index = 0; offset < version.sizeBytes; index++) {
      const length = Math.min(CHUNK_BYTES, version.sizeBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (!bytesRead) throw new Error('Package cache truncated during split');
        filled += bytesRead;
      }
      const hash = createHash('sha256').update(buffer).digest('hex');
      const url = `/chunks/${version.sha256.toLowerCase()}/${String(index).padStart(3, '0')}-${hash}.part`;
      const target = join(publicRoot, url.slice(1));
      await mkdir(dirname(target), { recursive: true });
      const part = await open(target, 'w');
      try { await part.writeFile(buffer); } finally { await part.close(); }
      outputFile(url, hash, length, 'chunk');
      parts.push({ url, sha256: hash, sizeBytes: length });
      offset += length;
    }
  } finally { await handle.close(); }
  return parts;
}
