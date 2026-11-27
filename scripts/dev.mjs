import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRequest } from '../src/api.js';
import { loadSnapshot, resolvePublicPath } from './build.mjs';

function sendError(response, status, message) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

export async function createDevServer(root, { snapshot } = {}) {
  snapshot ??= await loadSnapshot(root);
  const publicRoot = await realpath(path.join(root, 'public'));
  return createServer(async (incoming, outgoing) => {
    try {
      incoming.resume();
      const rawPath = (incoming.url ?? '/').split(/[?#]/, 1)[0];
      if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return sendError(outgoing, 400, 'invalid_path');
      if (rawPath === '/' || rawPath.startsWith('/api/')) {
        const route = rawPath === '/' ? '/api/health' : incoming.url;
        const controller = new AbortController();
        outgoing.on('close', () => { if (!outgoing.writableFinished) controller.abort(); });
        const request = new Request(`http://${incoming.headers.host}${route}`, {
          method: incoming.method, headers: incoming.headers, signal: controller.signal,
        });
        const result = await handleRequest(request, snapshot);
        outgoing.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) await pipeline(Readable.fromWeb(result.body), outgoing);
        else outgoing.end();
        return;
      }
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        outgoing.setHeader('allow', 'GET, HEAD');
        return sendError(outgoing, 405, 'method_not_allowed');
      }
      let filename;
      try { filename = resolvePublicPath(publicRoot, rawPath); }
      catch { return sendError(outgoing, 400, 'invalid_path'); }
      let actual;
      let info;
      try {
        actual = await realpath(filename);
        info = await stat(actual);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendError(outgoing, 404, 'not_found');
        throw error;
      }
      if (!actual.startsWith(publicRoot + path.sep) || !info.isFile()) return sendError(outgoing, 404, 'not_found');
      const contentType = actual.endsWith('.zip') ? 'application/zip'
        : actual.endsWith('.webp') ? 'image/webp'
        : actual.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
      outgoing.writeHead(200, {
        'content-type': contentType,
        'content-length': info.size,
        'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff',
      });
      if (incoming.method === 'HEAD') outgoing.end();
      else await pipeline(createReadStream(actual), outgoing);
    } catch (error) {
      if (!outgoing.headersSent) sendError(outgoing, 500, 'internal_error');
      else outgoing.destroy(error);
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const port = Number(process.env.PORT ?? 8788);
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
    const server = await createDevServer(root);
    server.listen(port, '127.0.0.1', () => console.log(`Toys mirror API: http://127.0.0.1:${port}`));
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) {
    console.error(`Cannot start local mirror: ${error.message}`);
    process.exitCode = 1;
  }
}
