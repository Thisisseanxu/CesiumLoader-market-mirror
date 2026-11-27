import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, copyFile, stat, cp } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBuild } from './build.mjs';
import { MIRROR_LIMIT_BYTES, STATIC_FILE_BYTES, CHUNK_BYTES, METADATA_RESERVE_BYTES, selectGroups } from './policy.mjs';
import { openResponse, pause, cachePackage, splitPackage, packageUrl } from './packages.mjs';

export const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
export const MAX_FILE_BYTES = STATIC_FILE_BYTES;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function safeSegment(value, label = 'identifier') {
  const text = String(value ?? '');
  if (!text || text === '.' || text === '..' || !/^[A-Za-z0-9_.+-]+$/.test(text)) {
    throw new Error(`Unsafe ${label}: ${text}`);
  }
  return text;
}

export function verifyBytes(bytes, { hash, size, kind = 'package', limit = MAX_FILE_BYTES } = {}) {
  if (!bytes.length || bytes.length > limit) throw new Error(`Empty or oversized ${kind}: ${bytes.length}`);
  if (size != null && bytes.length !== size) throw new Error(`Size mismatch: expected ${size}, got ${bytes.length}`);
  const actual = sha256(bytes);
  if (hash && actual !== hash.toLowerCase()) throw new Error(`SHA-256 mismatch: expected ${hash}, got ${actual}`);
  if (kind === 'package' && !(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) {
    throw new Error('Package is not a ZIP (possible HTML error page)');
  }
  if (kind !== 'package' && !(bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')) {
    throw new Error('Image is not WebP');
  }
  return actual;
}

export async function mapLimit(items, concurrency, fn) {
  let cursor = 0;
  const results = new Array(items.length);
  // Wait for every worker before handling failure: no worker can write after cleanup.
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!errors.length) {
      const index = cursor++;
      if (index >= items.length) break;
      try { results[index] = await fn(items[index], index); }
      catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw errors[0];
  return results;
}

async function boundedBody(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw new Error(`File exceeds ${limit} bytes`); }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit) throw new Error(`Response exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export async function requestBytes(url, { limit = MAX_FILE_BYTES, headers = {}, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await openResponse(url, { headers });
      if (response.status === 304) return { notModified: true, headers: response.headers };
      return { bytes: await boundedBody(response, limit), headers: response.headers };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await pause(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function getJson(url, limit = 8 * 1024 * 1024) {
  const { bytes } = await requestBytes(url, { limit, headers: { accept: 'application/json' } });
  return JSON.parse(bytes.toString('utf8'));
}

async function listAll(base, language, category) {
  const items = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 1000; page++) {
    const data = await getJson(`${base}/api/${category}?lang=${language}&sort=name&page=${page}&pageSize=60`);
    if (data.apiVersion !== 1 || !Array.isArray(data.items) || !Number.isSafeInteger(data.total)
      || data.total < 0 || (category === 'mods' && data.total === 0)) throw new Error('Invalid/empty market list');
    total ??= data.total;
    if (total !== data.total) throw new Error('Market changed while listing; retry the sync');
    if (!data.items.length && total !== 0) throw new Error('Truncated market pagination');
    for (const item of data.items) {
      safeSegment(item.id, 'mod ID');
      if (seen.has(item.id)) throw new Error(`Duplicate list item: ${item.id}`);
      seen.add(item.id);
      items.push(item);
    }
    if (items.length >= total) {
      if (items.length !== total) throw new Error('Invalid market total');
      return { items, types: data.types ?? [] };
    }
  }
  throw new Error('Too many market pages');
}

async function exists(path) { try { return await stat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function readJsonOr(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }

async function publishStage(root, stage) {
  const backup = join(stage, 'previous');
  await mkdir(backup);
  const changed = [];
  try {
    for (const name of ['public', 'generated']) {
      const dest = join(root, name);
      const hadPrevious = !!(await exists(dest));
      if (hadPrevious) await rename(dest, join(backup, name));
      changed.push({ name, hadPrevious, installed: false });
      await rename(join(stage, name), dest);
      changed.at(-1).installed = true;
    }
  } catch (error) {
    for (const item of changed.reverse()) {
      if (item.installed) await rm(join(root, item.name), { recursive: true, force: true });
      if (item.hadPrevious) await rename(join(backup, item.name), join(root, item.name));
    }
    throw error;
  }
}

export async function syncMirror({ root = ROOT, upstream = process.env.FORGE_UPSTREAM || 'https://forge.hiynet.com', concurrency = 4,
  budgetBytes = MIRROR_LIMIT_BYTES - METADATA_RESERVE_BYTES, log = console.log } = {}) {
  root = resolve(root);
  const origin = new URL(upstream);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Invalid FORGE_UPSTREAM');
  const base = origin.href.replace(/\/$/, '');
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0 || budgetBytes > MIRROR_LIMIT_BYTES - METADATA_RESERVE_BYTES) throw new Error('Invalid mirror budget');
  const stage = join(root, '.tmp', `sync-${randomUUID()}`);
  const cacheRoot = join(root, '.cache', 'forge-mirror');
  await mkdir(join(stage, 'public'), { recursive: true });
  await mkdir(join(stage, 'generated'), { recursive: true });
  await mkdir(join(cacheRoot, 'objects'), { recursive: true });
  const cacheIndex = await readJsonOr(join(cacheRoot, 'images.json'), {});
  const files = {};
  const pendingImages = new Map();
  const objectWrites = new Map();
  const outputWrites = new Map();

  async function cacheObject(bytes, hash) {
    const path = join(cacheRoot, 'objects', hash);
    if (!objectWrites.has(hash)) objectWrites.set(hash, writeFile(path, bytes).then(() => path));
    return objectWrites.get(hash);
  }
  async function readCached(hash, options) {
    if (!/^[a-f0-9]{64}$/.test(hash ?? '')) return null;
    try {
      const path = join(cacheRoot, 'objects', hash);
      const bytes = await readFile(path);
      verifyBytes(bytes, { ...options, hash });
      return { bytes, path };
    } catch { return null; }
  }
  async function outputFile(url, objectPath, hash, sizeBytes, kind) {
    if (!outputWrites.has(url)) outputWrites.set(url, (async () => {
      const path = join(stage, 'public', url.slice(1));
      await mkdir(dirname(path), { recursive: true });
      await copyFile(objectPath, path);
      files[url] = { sha256: hash, sizeBytes, kind };
    })());
    await outputWrites.get(url);
  }
  async function image(source, kind) {
    if (!source) return null;
    const absolute = new URL(source, `${base}/`).href;
    const key = `${kind}:${absolute}`;
    if (pendingImages.has(key)) return pendingImages.get(key);
    const promise = (async () => {
      const previous = cacheIndex[absolute];
      const limit = kind === 'sticker' ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
      const cached = await readCached(previous?.hash, { kind, limit });
      const headers = {};
      if (cached && previous.etag) headers['if-none-match'] = previous.etag;
      if (cached && previous.modified) headers['if-modified-since'] = previous.modified;
      const response = await requestBytes(absolute, { headers, limit });
      const bytes = response.notModified ? cached?.bytes : response.bytes;
      if (!bytes) throw new Error('Unexpected 304 without cached image');
      const hash = verifyBytes(bytes, { kind });
      const objectPath = await cacheObject(bytes, hash);
      const url = `/${kind === 'cover' ? 'covers' : kind === 'preview' ? 'previews' : 'stickers'}/${hash}.webp`;
      await outputFile(url, objectPath, hash, bytes.length, kind);
      cacheIndex[absolute] = {
        hash,
        etag: response.notModified ? previous?.etag || '' : response.headers.get('etag') || '',
        modified: response.notModified ? previous?.modified || '' : response.headers.get('last-modified') || '',
      };
      return url;
    })();
    pendingImages.set(key, promise);
    return promise;
  }

  try {
    const markets = {};
    const groups = [];
    for (const category of ['mods', 'resources']) {
      const languages = markets[category] = {};
      for (const language of LANGUAGES) {
        log(`Reading ${language} ${category} catalogue…`);
        const { items, types } = await listAll(base, language, category);
        const details = await mapLimit(items, concurrency, async item => {
          const detail = await getJson(`${base}/api/${category}/${encodeURIComponent(item.id)}?lang=${language}`);
          if (detail.id !== item.id || !Array.isArray(detail.versions) || !detail.versions.length) throw new Error(`Invalid detail: ${item.id}`);
          return detail;
        });
        languages[language] = { items, details: Object.fromEntries(details.map(item => [item.id, item])),
          ...(category === 'resources' ? { types } : {}) };
      }
      const canonical = languages['zh-Hans'];
      const ids = canonical.items.map(item => item.id).sort();
      for (const language of LANGUAGES) {
        if (JSON.stringify(languages[language].items.map(item => item.id).sort()) !== JSON.stringify(ids)) throw new Error(`Language list differs: ${category}/${language}`);
      }
      for (const id of ids) {
        const detail = canonical.details[id];
        const versions = detail.versions.map(version => ({ ...version, sha256: String(version.sha256).toLowerCase() }));
        if (new Set(versions.map(v => v.version)).size !== versions.length) throw new Error(`Duplicate version: ${id}`);
        if (!versions.some(v => v.version === detail.latestVersion)) throw new Error(`Latest version missing: ${id}`);
        for (const version of versions) {
          safeSegment(version.version, 'version');
          if (!/^[a-f0-9]{64}$/.test(version.sha256) || !Number.isSafeInteger(version.sizeBytes) || version.sizeBytes <= 0) throw new Error(`Invalid hash/size: ${id}@${version.version}`);
          if (!version.downloadUrl) throw new Error(`Download URL missing: ${id}`);
        }
        for (const language of LANGUAGES) {
          const localized = languages[language].details[id];
          const summary = languages[language].items.find(item => item.id === id);
          const latest = versions.find(v => v.version === detail.latestVersion);
          if (localized.latestVersion !== detail.latestVersion || localized.versions.length !== versions.length
            || new Set(localized.versions.map(v => v.version)).size !== versions.length) throw new Error(`Versions changed during sync: ${id}`);
          if (summary.latestVersion !== detail.latestVersion || summary.sha256?.toLowerCase() !== latest.sha256 || summary.sizeBytes !== latest.sizeBytes) throw new Error(`Latest summary metadata differs: ${language}/${id}`);
          for (const version of localized.versions) {
            const reference = versions.find(v => v.version === version.version);
            if (!reference || version.sha256?.toLowerCase() !== reference.sha256 || version.sizeBytes !== reference.sizeBytes) throw new Error(`Version changed during sync: ${id}`);
          }
        }
        groups.push({ key: `${category}:${id}`, id, category, kind: category === 'resources' ? 'resource' : 'mod',
          versions, assets: new Set(), packageBytes: versions.reduce((n, v) => n + v.sizeBytes, 0) });
      }
    }
    const commonAssets = new Set();
    function measure(retained) {
      const assets = new Set(commonAssets);
      const packages = new Map();
      for (const group of retained) {
        for (const url of group.assets) assets.add(url);
        for (const version of group.versions) packages.set(packageUrl(group, version), version);
      }
      return {
        bytes: [...assets].reduce((n, url) => n + files[url].sizeBytes, 0) + [...packages.values()].reduce((n, v) => n + v.sizeBytes, 0),
        files: assets.size + [...packages.values()].reduce((n, v) => n + (v.sizeBytes > STATIC_FILE_BYTES ? Math.ceil(v.sizeBytes / CHUNK_BYTES) : 1), 0),
      };
    }
    // Reject impossible packages by size before downloading any of their bytes.
    const preliminary = selectGroups(groups, measure, { bytes: budgetBytes });
    const manifestWrites = new Map();
    async function manifest(version) {
      if (!version.manifestUrl) throw new Error('Resource package manifest missing');
      if (!manifestWrites.has(version.sha256)) manifestWrites.set(version.sha256, (async () => {
        const data = await getJson(new URL(version.manifestUrl, `${base}/`).href, MAX_FILE_BYTES);
        if (data.sha256?.toLowerCase() !== version.sha256 || data.packageSize !== version.sizeBytes
          || !Array.isArray(data.files) || data.fileCount !== data.files.length) throw new Error('Resource manifest differs from package metadata');
        const bytes = Buffer.from(JSON.stringify(data));
        const hash = sha256(bytes);
        const url = `/manifests/${version.sha256}.json`;
        await outputFile(url, await cacheObject(bytes, hash), hash, bytes.length, 'manifest');
        return url;
      })());
      return manifestWrites.get(version.sha256);
    }
    await mapLimit(preliminary.retained, concurrency, async group => {
      const add = url => { if (url) group.assets.add(url); return url; };
      for (const language of LANGUAGES) {
        const catalog = markets[group.category][language];
        const detail = catalog.details[group.id];
        detail.coverUrl = add(await image(detail.coverUrl, 'cover'));
        catalog.items.find(item => item.id === group.id).coverUrl = detail.coverUrl;
        for (const preview of detail.previews ?? []) {
          preview.url = add(await image(preview.url, 'preview'));
          if (preview.sha256 && files[preview.url].sha256 !== preview.sha256.toLowerCase()) throw new Error('Preview SHA-256 mismatch');
        }
        for (const version of detail.versions) {
          if (group.kind === 'resource') version.manifestUrl = add(await manifest(group.versions.find(v => v.version === version.version)));
        }
      }
    });
    const stickerCatalog = await getJson(`${base}/api/stickers`);
    if (!Array.isArray(stickerCatalog.items) || !Array.isArray(stickerCatalog.groups) || stickerCatalog.items.length !== stickerCatalog.total) throw new Error('Invalid sticker catalogue');
    log(`Mirroring ${stickerCatalog.total} stickers…`);
    let mirroredStickers = 0;
    await mapLimit(stickerCatalog.items, concurrency, async item => {
      if (!item.imageUrl) throw new Error(`Sticker image missing: ${item.stickerId}`);
      item.imageUrl = await image(item.imageUrl, 'sticker');
      commonAssets.add(item.imageUrl);
      mirroredStickers++;
      if (mirroredStickers % 100 === 0 || mirroredStickers === stickerCatalog.total) log(`Stickers: ${mirroredStickers}/${stickerCatalog.total}`);
    });
    const ids = preliminary.retained.filter(g => g.kind === 'mod').map(g => g.id);
    const modStickers = { generatedAt: new Date().toISOString(), items: [] };
    for (let offset = 0; offset < ids.length; offset += 100) {
      const data = await getJson(`${base}/api/mod-stickers?modIds=${encodeURIComponent(ids.slice(offset, offset + 100).join(','))}`);
      if (!Array.isArray(data.items)) throw new Error('Invalid sticker reactions');
      modStickers.items.push(...data.items);
    }
    await mapLimit(modStickers.items, concurrency, async item => {
      const group = preliminary.retained.find(g => g.kind === 'mod' && g.id.toLowerCase() === String(item.modId).toLowerCase());
      for (const sticker of item.stickers ?? []) {
        sticker.imageUrl = await image(sticker.imageUrl, 'sticker');
        if (group && sticker.imageUrl) group.assets.add(sticker.imageUrl);
        sticker.reactedByMe = false;
      }
    });
    const selection = selectGroups(preliminary.retained, measure, { bytes: budgetBytes });
    const retained = selection.retained;
    const skipped = [...preliminary.skipped, ...selection.skipped];
    for (const item of skipped) log(`Skipping ${item.kind} ${item.id}: ${item.reason} (${(item.packageBytes / 1024 ** 2).toFixed(2)} MiB)`);
    const retainedKeys = new Set(retained.map(g => g.key));
    const usedAssets = new Set([...commonAssets, ...retained.flatMap(g => [...g.assets])]);
    for (const url of Object.keys(files)) {
      if (!usedAssets.has(url)) {
        await rm(join(stage, 'public', url.slice(1)));
        delete files[url];
      }
    }
    const downloads = {};
    const packageWrites = new Map();
    const splits = new Map();
    log(`Mirroring ${retained.filter(g => g.kind === 'mod').length} mods / ${retained.filter(g => g.kind === 'resource').length} resources…`);
    await mapLimit(retained.flatMap(group => group.versions.map(version => ({ group, version }))), concurrency, async ({ group, version }) => {
      const hash = version.sha256;
      if (!packageWrites.has(hash)) packageWrites.set(hash, cachePackage(new URL(version.downloadUrl, `${base}/`).href, version, join(cacheRoot, 'objects')));
      const filename = await packageWrites.get(hash);
      const url = packageUrl(group, version);
      version.mirrorUrl = url;
      if (version.sizeBytes <= STATIC_FILE_BYTES) {
        await outputFile(url, filename, hash, version.sizeBytes, 'package');
      } else {
        if (!splits.has(hash)) splits.set(hash, splitPackage(filename, version, join(stage, 'public'), (url, sha256, sizeBytes, kind) => {
          files[url] = { sha256, sizeBytes, kind };
        }));
        downloads[url] = { sha256: hash, sizeBytes: version.sizeBytes,
          filename: `${group.id}-${version.version}.zip`, parts: await splits.get(hash) };
      }
      log(`Verified ${group.kind} ${group.id}@${version.version}: ${(version.sizeBytes / 1024 ** 2).toFixed(2)} MiB`);
    });
    for (const [category, languages] of Object.entries(markets)) {
      const allowed = new Map(retained.filter(g => g.category === category).map(g => [g.id, g]));
      for (const catalog of Object.values(languages)) {
        catalog.items = catalog.items.filter(item => retainedKeys.has(`${category}:${item.id}`));
        catalog.details = Object.fromEntries(Object.entries(catalog.details).filter(([id]) => allowed.has(id)));
        for (const item of catalog.items) {
          const detail = catalog.details[item.id];
          const group = allowed.get(item.id);
          item.downloadUrl = group.versions.find(v => v.version === detail.latestVersion).mirrorUrl;
          for (const version of detail.versions) version.downloadUrl = group.versions.find(v => v.version === version.version).mirrorUrl;
        }
      }
    }
    const retainedModIds = new Set(retained.filter(g => g.kind === 'mod').map(g => g.id.toLowerCase()));
    modStickers.items = modStickers.items.filter(item => retainedModIds.has(String(item.modId).toLowerCase()));
    const staticBytes = Object.values(files).reduce((n, f) => n + f.sizeBytes, 0);
    const syncReport = { limitBytes: MIRROR_LIMIT_BYTES, staticBudgetBytes: budgetBytes,
      reservedBytes: METADATA_RESERVE_BYTES, staticBytes,
      mods: retainedModIds.size, resources: retained.filter(g => g.kind === 'resource').length, skipped };
    const snapshot = { schemaVersion: 1, upstream: base, generatedAt: new Date().toISOString(),
      languages: markets.mods, resources: { languages: markets.resources }, downloads, stickerCatalog, modStickers, syncReport, files };
    const moduleText = `// Generated by npm run sync. Do not edit.\nexport default ${JSON.stringify(snapshot)};\n`;
    if (Buffer.byteLength(moduleText) > 4.4 * 1024 * 1024) throw new Error('Snapshot exceeds Edge Functions bundle budget');
    await writeFile(join(stage, 'generated', 'snapshot.js'), moduleText);
    await writeFile(join(stage, 'generated', 'sync-report.json'), JSON.stringify({ generatedAt: snapshot.generatedAt, ...syncReport }, null, 2) + '\n');
    // Validate the complete staged deployment before replacing either live folder.
    await cp(join(ROOT, 'src'), join(stage, 'src'), { recursive: true });
    await validateBuild(stage);
    await publishStage(root, stage);
    await writeFile(join(cacheRoot, 'images.json'), JSON.stringify(cacheIndex));
    log(`Synced ${syncReport.mods} mods, ${syncReport.resources} resources, ${retained.reduce((n, g) => n + g.versions.length, 0)} versions, ${stickerCatalog.total} stickers; ${(staticBytes / 1024 ** 2).toFixed(2)} MiB static files; skipped ${skipped.length} items.`);
    return snapshot;
  } finally {
    // stage is generated locally below this project's .tmp, never from upstream input.
    if (!stage.startsWith(join(root, '.tmp') + sep)) throw new Error('Unsafe cleanup path');
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  syncMirror().catch(error => { console.error(`Sync aborted; previous deployment remains valid: ${error.message}`); process.exitCode = 1; });
}
