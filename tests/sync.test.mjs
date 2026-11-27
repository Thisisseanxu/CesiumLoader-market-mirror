import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMirror, verifyBytes, safeSegment, mapLimit } from '../scripts/sync.mjs';

const zip = Buffer.from('PK\x03\x04fixture-zip');
const webp = Buffer.from('RIFF0000WEBPfixture-image');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('rejects corrupt, oversized and HTML masquerading as packages/images', () => {
  assert.equal(verifyBytes(zip, { hash: hash(zip), size: zip.length }), hash(zip));
  assert.throws(() => verifyBytes(zip, { hash: '0'.repeat(64) }), /SHA-256/);
  assert.throws(() => verifyBytes(zip, { size: 1 }), /Size mismatch/);
  assert.throws(() => verifyBytes(zip, { limit: 2 }), /oversized/);
  assert.throws(() => verifyBytes(Buffer.from('<html>error</html>')), /not a ZIP/);
  assert.throws(() => verifyBytes(zip, { kind: 'cover' }), /not WebP/);
  for (const value of ['..', '../escape', 'bad/id', 'bad\\id', '', 'v:1']) assert.throws(() => safeSegment(value));
});

test('worker failures wait for pending workers to finish before rejecting', async () => {
  let completed = false;
  await assert.rejects(mapLimit([0, 1], 2, async value => {
    if (!value) { await new Promise(r => setTimeout(r, 2)); throw new Error('failure'); }
    await new Promise(r => setTimeout(r, 20)); completed = true;
  }), /failure/);
  assert.equal(completed, true);
});

test('full sync mirrors four languages and all versions; restores corrupt cache; failure preserves old snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-sync-test-'));
  let corrupt = false;
  let staleSummary = false;
  let packageRequests = 0;
  const version = { version: '1.0.0', sha256: hash(zip), sizeBytes: zip.length, downloadUrl: '/download', sourceUrl: '', hosted: true, permissions: 1, dependencies: [] };
  const item = { id: 'Example', name: '示例', author: 'author', summary: 'test', tags: ['工具'], latestVersion: '1.0.0', sha256: hash(zip), sizeBytes: zip.length, coverUrl: '/cover', downloadUrl: '/download' };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api/mods') return res.end(JSON.stringify({ apiVersion: 1, total: 1, page: 1, pageSize: 60, items: [{ ...item, sha256: staleSummary ? '0'.repeat(64) : item.sha256 }] }));
    if (path === '/api/resources') return res.end(JSON.stringify({ apiVersion: 1, total: 0, items: [], types: [] }));
    if (path === '/api/mods/Example') return res.end(JSON.stringify({ ...item, license: 'EULA', licenseText: 'preserve me', versions: [version, { ...version, version: '0.9.0' }] }));
    if (path === '/api/stickers') return res.end(JSON.stringify({ groups: [{ groupId: '1' }], items: [{ stickerId: 'sticker1', imageUrl: '/stickers/one.webp' }], total: 1 }));
    if (path === '/api/mod-stickers') return res.end(JSON.stringify({ items: [{ modId: 'Example', stickers: [{ stickerId: 'sticker1', imageUrl: '/stickers/one.webp', count: 2, reactedByMe: true }], reactionTotal: 2 }] }));
    if (path === '/download') { packageRequests++; res.setHeader('Content-Type', 'application/zip'); return res.end(corrupt ? Buffer.from('PK\x03\x04wrong-bytes') : zip); }
    if (path === '/cover' || path === '/stickers/one.webp') {
      res.setHeader('ETag', '"image-v1"');
      if (req.headers['if-none-match'] === '"image-v1"') { res.writeHead(304); return res.end(); }
      res.setHeader('Content-Type', 'image/webp'); return res.end(webp);
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const options = { root, upstream: `http://127.0.0.1:${server.address().port}`, log: () => {} };
  const snapshot = await syncMirror(options);
  assert.deepEqual(Object.keys(snapshot.languages), ['zh-Hans', 'zh-Hant', 'en', 'ja']);
  assert.equal(snapshot.languages.en.details.Example.versions.length, 2);
  assert.equal(snapshot.languages.en.details.Example.licenseText, 'preserve me');
  assert.equal(snapshot.modStickers.items[0].stickers[0].reactedByMe, false);
  for (const data of Object.values(snapshot.languages)) {
    assert.match(data.items[0].downloadUrl, /^\/packages\/Example\//);
    for (const version of data.details.Example.versions) {
      assert.deepEqual(await readFile(join(root, 'public', version.downloadUrl)), zip);
    }
  }
  assert.match(snapshot.stickerCatalog.items[0].imageUrl, /^\/stickers\/[a-f0-9]{64}\.webp$/);
  const beforeReuse = packageRequests;
  await syncMirror(options);
  assert.equal(packageRequests, beforeReuse, 'verified packages are reused');
  const packageCache = join(root, '.cache', 'forge-mirror', 'objects', hash(zip));
  const imageCache = join(root, '.cache', 'forge-mirror', 'objects', hash(webp));
  await writeFile(packageCache, 'corrupt');
  await writeFile(imageCache, 'corrupt');
  await syncMirror(options);
  assert.deepEqual(await readFile(packageCache), zip);
  assert.deepEqual(await readFile(imageCache), webp);
  const lastSnapshot = await readFile(join(root, 'generated', 'snapshot.js'), 'utf8');
  staleSummary = true;
  await assert.rejects(syncMirror(options), /Latest summary metadata/);
  assert.equal(await readFile(join(root, 'generated', 'snapshot.js'), 'utf8'), lastSnapshot);
  staleSummary = false;
  await writeFile(packageCache, 'corrupt');
  corrupt = true;
  await assert.rejects(syncMirror(options), /Size mismatch|SHA-256 mismatch/);
  assert.equal(await readFile(join(root, 'generated', 'snapshot.js'), 'utf8'), lastSnapshot);
  assert.deepEqual(await readdir(join(root, '.tmp')), []);
});
