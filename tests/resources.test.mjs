import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMirror } from '../scripts/sync.mjs';
import { validateBuild } from '../scripts/build.mjs';
import { createDevServer } from '../scripts/dev.mjs';
import { handleRequest } from '../src/api.js';
import { CHUNK_BYTES, STATIC_FILE_BYTES } from '../scripts/policy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const zip = (size, seed) => { const bytes = Buffer.alloc(size, seed); bytes.write('PK\x03\x04', 'binary'); return bytes; };
const webp = Buffer.from('RIFF0000WEBPfixture-image');

async function fixture(t, { large = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-resources-'));
  await cp(new URL('../src/', import.meta.url), join(root, 'src'), { recursive: true });
  const requests = [];
  const packages = { Small: zip(64, 1), Big: zip(1024, 2), Cards: zip(large ? 26 * 1024 ** 2 + 53 : 2048, 3), Audio: zip(256, 4) };
  const types = [{ type: 'card_skin', enabled: true, toysAction: 'install-resource', maxPackageBytes: 1024 ** 3 }, { type: 'audio_skin', enabled: true }];
  const state = { badManifest: false };
  const summaries = Object.fromEntries(Object.entries(packages).map(([id, bytes]) => [id, {
    id, name: id, summary: 'preserved', latestVersion: '1.0.0', sha256: hash(bytes), sizeBytes: bytes.length,
    downloadUrl: `/download/${id}`, coverUrl: '/image', tags: ['sample'], origin: id === 'Small' ? 'official' : 'community',
    ...(id === 'Cards' ? { type: 'card_skin', attributes: { cardCount: 1 }, fileCount: 1 }
      : id === 'Audio' ? { type: 'audio_skin', fileCount: 1 } : {}),
  }]));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    requests.push(path);
    res.setHeader('content-type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    if (path === '/api/mods' || path === '/api/resources') {
      const resource = path.endsWith('resources');
      return send({ apiVersion: 1, total: 2, items: (resource ? ['Cards', 'Audio'] : ['Small', 'Big']).map(id => summaries[id]),
        ...(resource ? { types } : {}) });
    }
    const detail = /^\/api\/(mods|resources)\/([^/]+)$/.exec(path);
    if (detail) {
      const id = detail[2];
      const resource = detail[1] === 'resources';
      return send({ ...summaries[id], name: `${id}-${url.searchParams.get('lang')}`, license: 'MIT',
        licenseText: 'license preserved', resourceDependencies: [],
        ...(id === 'Cards' ? { previews: [{ sha256: hash(webp), url: '/image', caption: 'preview preserved' }] } : {}),
        versions: [{ version: '1.0.0', sha256: hash(packages[id]), sizeBytes: packages[id].length,
          downloadUrl: `/download/${id}`, ...(resource ? { manifestUrl: `/manifest/${id}`, resourceDependencies: [] } : {}) }],
      });
    }
    if (path.startsWith('/manifest/')) {
      const bytes = packages[path.split('/')[2]];
      return send({ sha256: state.badManifest ? '0'.repeat(64) : hash(bytes), packageSize: bytes.length,
        fileCount: 1, rootPrefix: 'Cards/', files: [{ path: 'skin.json', size: 20, compressedSize: 20, crc32: 123, isStore: true }] });
    }
    if (path === '/api/stickers') return send({ total: 1, groups: [], items: [{ stickerId: 'one', imageUrl: '/image' }] });
    if (path === '/api/mod-stickers') return send({ items: [] });
    if (path === '/image') { res.setHeader('content-type', 'image/webp'); return res.end(webp); }
    if (path.startsWith('/download/')) { res.setHeader('content-type', 'application/zip'); return res.end(packages[path.split('/')[2]]); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(), 'forge-resources-')));
    await rm(root, { recursive: true, force: true });
  });
  return { root, requests, packages, state, options: { root, upstream: `http://127.0.0.1:${server.address().port}`, log: () => {} } };
}

test('resource market preserves types, four languages, previews and manifests; oversized ZIP downloads byte-identically', async t => {
  const f = await fixture(t, { large: true });
  const snapshot = await syncMirror(f.options);
  const validation = await validateBuild(f.root);
  assert.equal(validation.mods, 2);
  assert.equal(validation.resources, 2);
  assert.equal(validation.versions, 4);
  assert.ok(Object.values(snapshot.files).every(file => file.sizeBytes <= STATIC_FILE_BYTES));
  const detail = snapshot.resources.languages['zh-Hans'].details.Cards;
  assert.equal(detail.licenseText, 'license preserved');
  assert.equal(detail.previews[0].caption, 'preview preserved');
  assert.equal(detail.attributes.cardCount, 1);
  assert.deepEqual(detail.versions[0].resourceDependencies, []);
  const url = detail.versions[0].downloadUrl;
  assert.match(url, /^\/api\/downloads\/[a-f0-9]{64}\.zip$/);
  assert.deepEqual(snapshot.downloads[url].parts.map(p => p.sizeBytes), [CHUNK_BYTES, f.packages.Cards.length - CHUNK_BYTES]);
  assert.equal(snapshot.files[url], undefined, 'full oversized ZIP is never a static asset');
  const request = path => handleRequest(new Request('https://mirror.example' + path), snapshot);
  const list = await request('/api/resources?type=card_skin&lang=en').json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].name, 'Cards');
  assert.equal(list.types[0].toysAction, 'install-resource');
  assert.equal((await request('/api/resources/Cards?lang=en').json()).name, 'Cards-en');
  assert.equal(request('/api/resources/Cards/download').headers.get('location'), url);
  assert.equal(request('/api/resources/Cards/versions/1.0.0/manifest').headers.get('location'), detail.versions[0].manifestUrl);
  assert.equal(request(`/api/resources/Cards/previews/${hash(webp)}`).headers.get('location'), detail.previews[0].url);
  assert.equal((await request('/api/mods?origin=official').json()).items[0].id, 'Small');

  const mirror = await createDevServer(f.root, { snapshot });
  await new Promise(resolve => mirror.listen(0, '127.0.0.1', resolve));
  t.after(() => { mirror.closeAllConnections(); return new Promise(resolve => mirror.close(resolve)); });
  const base = `http://127.0.0.1:${mirror.address().port}`;
  const download = await fetch(`${base}/api/resources/Cards/download`);
  assert.equal(download.headers.get('content-length'), String(f.packages.Cards.length));
  assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(f.packages.Cards));
  const start = CHUNK_BYTES - 8;
  const end = CHUNK_BYTES + 12;
  const range = await fetch(base + url, { headers: { range: `bytes=${start}-${end}` } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.packages.Cards.subarray(start, end + 1));
  const manifest = await (await fetch(base + detail.versions[0].manifestUrl)).json();
  assert.equal(manifest.sha256, hash(f.packages.Cards));
  assert.equal(manifest.files[0].path, 'skin.json');

  const before = await readFile(join(f.root, 'generated/snapshot.js'), 'utf8');
  f.state.badManifest = true;
  await assert.rejects(syncMirror(f.options), /manifest differs/);
  assert.equal(await readFile(join(f.root, 'generated/snapshot.js'), 'utf8'), before);
  // Individually valid part hashes are insufficient: build checks the whole ZIP order too.
  snapshot.downloads[url].parts.reverse();
  await writeFile(join(f.root, 'generated/snapshot.js'), `export default ${JSON.stringify(snapshot)};`);
  await assert.rejects(validateBuild(f.root), /Reassembled package SHA-256/);
});

test('capacity skips whole large resource groups before normal mods, never requests skipped packages, and removes stale files', async t => {
  const f = await fixture(t);
  await syncMirror(f.options);
  f.requests.length = 0;
  const snapshot = await syncMirror({ ...f.options, budgetBytes: 500 });
  assert.deepEqual(snapshot.syncReport.skipped.map(g => g.id), ['Cards', 'Audio', 'Big']);
  for (const language of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    assert.deepEqual(snapshot.languages[language].items.map(i => i.id), ['Small']);
    assert.deepEqual(Object.keys(snapshot.languages[language].details), ['Small']);
    assert.deepEqual(snapshot.resources.languages[language].items, []);
    assert.deepEqual(Object.keys(snapshot.resources.languages[language].details), []);
  }
  assert.ok(snapshot.syncReport.staticBytes <= 500);
  assert.ok(!f.requests.some(path => /^\/(download|manifest)\/(Cards|Audio|Big)/.test(path)));
  assert.ok(!Object.keys(snapshot.files).some(path => /Big|Cards|Audio|\/manifests\//.test(path)));
  assert.equal((await validateBuild(f.root)).mods, 1);
  const health = await handleRequest(new Request('https://mirror.example/api/health'), snapshot).json();
  assert.equal(health.syncReport.skipped.length, 3);
  const diskReport = JSON.parse(await readFile(join(f.root, 'generated/sync-report.json'), 'utf8'));
  assert.equal(diskReport.staticBytes, health.syncReport.staticBytes);
});

test('budget includes covers, sticker assets and installation manifests before package downloads', async t => {
  const f = await fixture(t);
  const snapshot = await syncMirror({ ...f.options, budgetBytes: 1350 });
  assert.deepEqual(snapshot.syncReport.skipped.map(g => g.id), ['Cards', 'Audio']);
  assert.ok(snapshot.syncReport.staticBytes <= 1350);
  assert.ok(!f.requests.includes('/download/Audio'));
  assert.ok(!Object.keys(snapshot.files).some(path => path.startsWith('/manifests/')));
  assert.equal((await validateBuild(f.root)).resources, 0);
});
