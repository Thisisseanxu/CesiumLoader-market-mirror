import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { get } from 'node:http';
import { validateBuild, resolvePublicPath } from '../scripts/build.mjs';
import { createDevServer } from '../scripts/dev.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['generated', 'src', 'public/packages', 'public/covers', 'public/stickers'].map((folder) => mkdir(path.join(root, folder), { recursive: true })));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'src/api.js'), 'export const api = true;');
  const bytes = Buffer.from('original package bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const url = '/packages/ExampleMod-1.0.0.zip';
  await writeFile(path.join(root, 'public/packages/ExampleMod-1.0.0.zip'), bytes);
  const version = { version: '1.0.0', sha256, sizeBytes: bytes.length, downloadUrl: url };
  const item = { id: 'ExampleMod', latestVersion: '1.0.0', sha256, sizeBytes: bytes.length, downloadUrl: url };
  const catalog = { items: [item], details: { ExampleMod: { ...item, versions: [version] } } };
  const snapshot = {
    schemaVersion: 1, generatedAt: '2026-11-22T00:00:00Z',
    languages: Object.fromEntries(['zh-Hans', 'zh-Hant', 'en', 'ja'].map((language) => [language, structuredClone(catalog)])),
    files: { [url]: { sha256, sizeBytes: bytes.length, kind: 'package' } },
    stickerCatalog: { items: [] }, modStickers: { items: [] },
  };
  const save = () => writeFile(path.join(root, 'generated/snapshot.js'), `export default ${JSON.stringify(snapshot)};`);
  await save();
  return { root, snapshot, save };
}

test('validates a complete four-language deployment and reports unique files', async (t) => {
  const { root } = await fixture(t);
  const result = await validateBuild(root);
  assert.equal(result.mods, 1);
  assert.equal(result.versions, 1);
  assert.equal(result.languages, 4);
  assert.equal(result.files, 1);
});

test('rejects content corruption even when the file size has not changed', async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'public/packages/ExampleMod-1.0.0.zip'), Buffer.from('modified package bytes'));
  await assert.rejects(validateBuild(root), /SHA-256 mismatch/);
});

test('rejects incorrect asset size and unsigned extra files', async (t) => {
  const { root, snapshot, save } = await fixture(t);
  snapshot.files['/packages/ExampleMod-1.0.0.zip'].sizeBytes += 1;
  await save();
  await assert.rejects(validateBuild(root), /size mismatch/);
  snapshot.files['/packages/ExampleMod-1.0.0.zip'].sizeBytes -= 1;
  await save();
  await writeFile(path.join(root, 'public/unexpected.txt'), 'unexpected');
  await assert.rejects(validateBuild(root), /Unindexed static files/);
});

test('rejects source URLs and escaped paths before reading files', async (t) => {
  const { root } = await fixture(t);
  for (const url of ['https://example.com/mod.zip', '//example.com/mod.zip', '/packages/../secret', '/packages/%2e%2e/secret', '/packages/%2fsecret', '/packages/%5csecret', '/packages/x?sig=1', '/packages/%00secret']) {
    assert.throws(() => resolvePublicPath(path.join(root, 'public'), url), /Asset URL|Unsafe asset/);
  }
});

test('rejects mismatched localized catalogs and latest versions', async (t) => {
  const { root, snapshot, save } = await fixture(t);
  delete snapshot.languages.en.details.ExampleMod;
  await save();
  await assert.rejects(validateBuild(root), /List\/detail mod IDs differ/);
  snapshot.languages.en = structuredClone(snapshot.languages['zh-Hans']);
  snapshot.languages.en.details.ExampleMod.latestVersion = '2.0.0';
  await save();
  await assert.rejects(validateBuild(root), /Latest version/);
});

test('enforces file, total storage, count and edge bundle budgets', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(validateBuild(root, { limits: { fileBytes: 1 } }), /single-file limit/);
  await assert.rejects(validateBuild(root, { limits: { totalBytes: 1 } }), /deployment size budget/);
  await assert.rejects(validateBuild(root, { limits: { files: 1 } }), /Too many static files/);
  await assert.rejects(validateBuild(root, { limits: { bundleBytes: 1 } }), /bundle budget/);
});

test('rejects version hashes that differ from the mirrored package', async (t) => {
  const { root, snapshot, save } = await fixture(t);
  snapshot.languages.ja.details.ExampleMod.versions[0].sha256 = 'a'.repeat(64);
  await save();
  await assert.rejects(validateBuild(root), /Package metadata differs/);
});

test('local server preserves ZIP bytes, serves root health and refuses encoded traversal', async (t) => {
  const { root, snapshot } = await fixture(t);
  const server = await createDevServer(root, { snapshot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(origin);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const result = await fetch(`${origin}/packages/ExampleMod-1.0.0.zip`);
  assert.equal(result.headers.get('content-type'), 'application/zip');
  assert.equal(result.headers.get('content-encoding'), null);
  assert.equal(Buffer.from(await result.arrayBuffer()).toString(), 'original package bytes');
  const head = await fetch(`${origin}/packages/ExampleMod-1.0.0.zip`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  // Use raw HTTP so URL normalization cannot erase the malicious path first.
  const status = await new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: server.address().port, path: '/packages/%2e%2e/private.txt' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(status, 400);
});
