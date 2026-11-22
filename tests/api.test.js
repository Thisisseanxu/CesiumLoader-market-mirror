import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';

function fixture() {
  const alpha = {
    id: 'AlphaMod', name: 'Alpha 模组', author: 'Alice', summary: 'Shows cards',
    tags: ['工具'], downloads: 7, updatedAt: '2026-11-20T12:00:00Z', latestVersion: '2.0.0',
    sha256: 'a'.repeat(64), sizeBytes: 128, downloadUrl: '/packages/alpha-2.zip',
    coverUrl: '/covers/alpha.webp', sdkVersion: '3.8.10', platforms: ['windows'],
  };
  const beta = {
    id: 'BetaMod', name: 'Beta 模组', author: 'Bob', summary: 'Shop helper',
    tags: ['辅助'], downloads: 99, updatedAt: '2026-11-22T12:00:00Z', latestVersion: '1.0.0',
    sha256: 'b'.repeat(64), sizeBytes: 64, downloadUrl: '/packages/beta-1.zip',
    sdkVersion: '3.8.10', platforms: ['windows'],
  };
  const details = {
    AlphaMod: {
      ...alpha, license: 'MIT', readme: '# Alpha',
      versions: [
        { version: '2.0.0', downloadUrl: '/packages/alpha-2.zip', sha256: alpha.sha256, sizeBytes: 128 },
        { version: '1.0.0', downloadUrl: '/packages/alpha-1.zip', sha256: 'c'.repeat(64), sizeBytes: 120 },
      ],
    },
    BetaMod: { ...beta, versions: [{ version: '1.0.0', downloadUrl: '/packages/beta-1.zip' }] },
  };
  return {
    schemaVersion: 1, upstream: 'https://forge.example', generatedAt: '2026-11-22T13:00:00Z',
    languages: {
      'zh-Hans': { items: [alpha, beta], details },
      en: {
        items: [{ ...alpha, name: 'Alpha English' }, beta],
        details: { ...details, AlphaMod: { ...details.AlphaMod, name: 'Alpha English' } },
      },
    },
    stickerCatalog: {
      generatedAt: '2026-11-22T13:00:00Z', total: 1,
      groups: [{ groupId: '101', groupName: '角色', count: 1 }],
      items: [{ stickerId: 'emoji', imageUrl: '/stickers/101/emoji.webp' }],
    },
    modStickers: {
      generatedAt: '2026-11-22T13:00:00Z',
      items: [{ modId: 'AlphaMod', reactionTotal: 3, stickers: [
        { stickerId: 'emoji', imageUrl: '/stickers/101/emoji.webp', count: 3, reactedByMe: true },
      ] }],
    },
  };
}

function request(path, snapshot = fixture(), method = 'GET') {
  return handleRequest(new Request('https://mirror.example' + path, { method }), snapshot);
}

test('list protocol preserves integrity metadata and applies search, tag, pagination, and sorting', async () => {
  const first = await request('/api/mods?page=1&pageSize=1&sort=updated').json();
  assert.equal(first.apiVersion, 1);
  assert.equal(first.total, 2);
  assert.equal(first.items[0].id, 'BetaMod');
  assert.equal(first.items[0].sha256, 'b'.repeat(64));
  assert.equal(first.generatedAt, '2026-11-22T13:00:00Z');
  assert.deepEqual(new Set(first.tags), new Set(['工具', '辅助']));
  const second = await request('/api/mods?page=2&pageSize=1&sort=downloads').json();
  assert.equal(second.items[0].id, 'AlphaMod');
  const search = await request('/api/mods?query=ALICE&tag=' + encodeURIComponent('工具')).json();
  assert.deepEqual(search.items.map((item) => item.id), ['AlphaMod']);
  const empty = await request('/api/mods?query=not-present').json();
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.items, []);
  const byName = await request('/api/mods?sort=name').json();
  assert.equal(byName.items[0].id, 'AlphaMod');
});

test('Toys page size limits and language fallback are supported', async () => {
  const data = await request('/api/mods?lang=en&pageSize=999&page=0').json();
  assert.equal(data.pageSize, 60);
  assert.equal(data.page, 1);
  assert.equal(data.items.find((item) => item.id === 'AlphaMod').name, 'Alpha English');
  assert.equal((await request('/api/mods/AlphaMod?lang=unknown').json()).name, 'Alpha 模组');
  assert.equal((await request('/api/mods/AlphaMod?lang=ja').json()).name, 'Alpha 模组');
  assert.equal((await request('/api/mods?page=1e100&pageSize=nope').json()).pageSize, 24);
});

test('details and fixed historical version downloads resolve to mirrored static assets', async () => {
  const detail = await request('/api/mods/alphamod?lang=en').json();
  assert.equal(detail.id, 'AlphaMod');
  assert.equal(detail.name, 'Alpha English');
  assert.equal(detail.versions.length, 2);
  assert.equal(detail.license, 'MIT');
  const latest = request('/api/mods/AlphaMod/download');
  assert.equal(latest.status, 302);
  assert.equal(latest.headers.get('location'), '/packages/alpha-2.zip');
  const historical = request('/api/mods/AlphaMod/download?version=1.0.0');
  assert.equal(historical.status, 302);
  assert.equal(historical.headers.get('location'), '/packages/alpha-1.zip');
  assert.equal(request('/api/mods/AlphaMod/download?version=9.0.0').status, 404);
  assert.equal(request('/api/mods/UnknownMod').status, 404);
  const cover = request('/api/mods/AlphaMod/cover?v=hash');
  assert.equal(cover.status, 302);
  assert.equal(cover.headers.get('location'), '/covers/alpha.webp');
  assert.equal(request('/api/mods/BetaMod/cover').status, 404);
});

test('redirects cannot silently escape the mirror or traverse static directories', () => {
  for (const value of ['https://origin.example/file.zip', '//origin.example/a.zip', '/packages/../secret', '/packages/a\\b.zip']) {
    const snapshot = fixture();
    snapshot.languages['zh-Hans'].details.AlphaMod.versions[0].downloadUrl = value;
    const response = request('/api/mods/AlphaMod/download', snapshot);
    assert.equal(response.status, 503, value);
    assert.equal(response.headers.get('location'), null);
  }
});

test('stickers retain the Toys-compatible path and snapshot counts have no personal voter state', async () => {
  const snapshot = fixture();
  const catalog = await request('/api/stickers', snapshot).json();
  assert.equal(catalog.items[0].imageUrl, '/stickers/101/emoji.webp');
  const response = request('/api/mod-stickers?modIds=AlphaMod,alphamod,BetaMod', snapshot);
  const data = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].stickers[0].count, 3);
  assert.equal(data.items[0].stickers[0].reactedByMe, false);
  assert.deepEqual(data.items[1], { modId: 'BetaMod', stickers: [], reactionTotal: 0 });
  assert.equal(snapshot.modStickers.items[0].stickers[0].reactedByMe, true);
  assert.deepEqual((await request('/api/mod-stickers').json()).items, []);
  assert.equal(request('/api/mod-stickers/AlphaMod/reactions', snapshot, 'POST').status, 405);
});

test('missing snapshots fail explicitly and health exposes sync provenance', async () => {
  const absent = handleRequest(new Request('https://mirror.example/api/health'), null);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).status, 'unavailable');
  assert.equal(handleRequest(new Request('https://mirror.example/api/mods'), {}).status, 503);
  const health = await request('/api/health').json();
  assert.equal(health.readOnly, true);
  assert.equal(health.mods, 2);
  assert.equal(health.versions, 3);
  assert.equal(health.upstream, 'https://forge.example');
});

test('unknown and malformed routes return JSON errors; HEAD omits the body', async () => {
  const unknown = request('/api/not-a-route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await unknown.json()).error, 'not_found');
  assert.equal(request('/api/mods/%ZZ').status, 400);
  assert.equal(request('/').status, 404);
  assert.equal(request('/api/mods', fixture(), 'POST').status, 405);
  const head = request('/api/mods', fixture(), 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
