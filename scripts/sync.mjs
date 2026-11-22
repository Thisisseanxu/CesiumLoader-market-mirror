import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBuild } from './build.mjs';

export const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'CesiumLoader-market-mirror/0.1 (AstralParty.Toys compatible read-only mirror)';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      let target = new URL(url);
      const deadline = AbortSignal.timeout(60_000);
      for (let hops = 0; hops <= 8; hops++) {
        if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid upstream URL');
        const response = await fetch(target, {
          headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'manual', signal: deadline,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || hops === 8) throw new Error('Invalid or excessive redirects');
          const next = new URL(location, target);
          if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade refused');
          target = next;
          continue;
        }
        if (response.status === 304) return { notModified: true, headers: response.headers };
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} for ${target.origin}${target.pathname}`); }
        return { bytes: await boundedBody(response, limit), headers: response.headers };
      }
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await pause(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function getJson(url) {
  const { bytes } = await requestBytes(url, { limit: 8 * 1024 * 1024, headers: { accept: 'application/json' } });
  return JSON.parse(bytes.toString('utf8'));
}

async function listAll(base, language) {
  const items = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= 1000; page++) {
    const data = await getJson(`${base}/api/mods?lang=${language}&sort=name&page=${page}&pageSize=60`);
    if (data.apiVersion !== 1 || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total <= 0) throw new Error('Invalid/empty market list');
    total ??= data.total;
    if (total !== data.total) throw new Error('Market changed while listing; retry the sync');
    if (!data.items.length) throw new Error('Truncated market pagination');
    for (const item of data.items) {
      safeSegment(item.id, 'mod ID');
      if (seen.has(item.id)) throw new Error(`Duplicate list item: ${item.id}`);
      seen.add(item.id);
      items.push(item);
    }
    if (items.length >= total) {
      if (items.length !== total) throw new Error('Invalid market total');
      return items;
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

export async function syncMirror({ root = ROOT, upstream = process.env.FORGE_UPSTREAM || 'https://forge.hiynet.com', concurrency = 4, log = console.log } = {}) {
  root = resolve(root);
  const origin = new URL(upstream);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Invalid FORGE_UPSTREAM');
  const base = origin.href.replace(/\/$/, '');
  const stage = join(root, '.tmp', `sync-${randomUUID()}`);
  const cacheRoot = join(root, '.cache', 'forge-mirror');
  await mkdir(join(stage, 'public'), { recursive: true });
  await mkdir(join(stage, 'generated'), { recursive: true });
  await mkdir(join(cacheRoot, 'objects'), { recursive: true });
  const cacheIndex = await readJsonOr(join(cacheRoot, 'images.json'), {});
  const files = {};
  const pendingImages = new Map();
  const objectWrites = new Map();

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
    const path = join(stage, 'public', url.slice(1));
    await mkdir(dirname(path), { recursive: true });
    await copyFile(objectPath, path);
    files[url] = { sha256: hash, sizeBytes, kind };
  }
  async function image(source, kind) {
    if (!source) return null;
    const absolute = new URL(source, `${base}/`).href;
    const key = `${kind}:${absolute}`;
    if (pendingImages.has(key)) return pendingImages.get(key);
    const promise = (async () => {
      const previous = cacheIndex[absolute];
      const cached = await readCached(previous?.hash, { kind, limit: kind === 'cover' ? 8 * 1024 * 1024 : 2 * 1024 * 1024 });
      const headers = {};
      if (cached && previous.etag) headers['if-none-match'] = previous.etag;
      if (cached && previous.modified) headers['if-modified-since'] = previous.modified;
      const response = await requestBytes(absolute, { headers, limit: kind === 'cover' ? 8 * 1024 * 1024 : 2 * 1024 * 1024 });
      const bytes = response.notModified ? cached?.bytes : response.bytes;
      if (!bytes) throw new Error('Unexpected 304 without cached image');
      const hash = verifyBytes(bytes, { kind });
      const objectPath = await cacheObject(bytes, hash);
      const url = `/${kind === 'cover' ? 'covers' : 'stickers'}/${hash}.webp`;
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
    const languages = {};
    for (const language of LANGUAGES) {
      log(`Reading ${language} catalogue…`);
      const items = await listAll(base, language);
      const detailsArray = await mapLimit(items, concurrency, async item => {
        const detail = await getJson(`${base}/api/mods/${encodeURIComponent(item.id)}?lang=${language}`);
        if (detail.id !== item.id || !Array.isArray(detail.versions) || !detail.versions.length) throw new Error(`Invalid detail: ${item.id}`);
        return detail;
      });
      languages[language] = { items, details: Object.fromEntries(detailsArray.map(item => [item.id, item])) };
    }
    const canonical = languages['zh-Hans'];
    const ids = canonical.items.map(item => item.id).sort();
    const packages = new Map();
    for (const id of ids) {
      const detail = canonical.details[id];
      const seenVersions = new Set();
      if (!detail.versions.some(v => v.version === detail.latestVersion)) throw new Error(`Latest version missing: ${id}`);
      for (const version of detail.versions) {
        safeSegment(version.version, 'version');
        if (seenVersions.has(version.version)) throw new Error(`Duplicate version: ${id}@${version.version}`);
        seenVersions.add(version.version);
        if (!/^[a-f0-9]{64}$/i.test(version.sha256) || !Number.isSafeInteger(version.sizeBytes) || version.sizeBytes <= 0 || version.sizeBytes > MAX_FILE_BYTES) {
          throw new Error(`Invalid hash/size or >25 MiB: ${id}@${version.version}`);
        }
        if (!version.downloadUrl) throw new Error(`Download URL missing: ${id}`);
        packages.set(`${id}@${version.version}`, { id, ...version });
      }
    }
    for (const language of LANGUAGES) {
      const localized = languages[language];
      if (JSON.stringify(localized.items.map(item => item.id).sort()) !== JSON.stringify(ids)) throw new Error(`Language list differs: ${language}`);
      for (const id of ids) {
        const detail = localized.details[id];
        const reference = canonical.details[id];
        if (detail.latestVersion !== reference.latestVersion || detail.versions.length !== reference.versions.length) throw new Error(`Versions changed during sync: ${id}`);
        for (const version of detail.versions) {
          const referenceVersion = packages.get(`${id}@${version.version}`);
          if (!referenceVersion || version.sha256.toLowerCase() !== referenceVersion.sha256.toLowerCase() || version.sizeBytes !== referenceVersion.sizeBytes) throw new Error(`Version changed during sync: ${id}`);
        }
      }
    }
    log(`Mirroring ${ids.length} mods / ${packages.size} versions…`);
    await mapLimit([...packages.values()], concurrency, async version => {
      const hash = version.sha256.toLowerCase();
      let cached = await readCached(hash, { kind: 'package', size: version.sizeBytes });
      if (!cached) {
        const { bytes } = await requestBytes(new URL(version.downloadUrl, `${base}/`).href);
        verifyBytes(bytes, { hash, size: version.sizeBytes });
        // Replace a corrupted restored cache entry as well as a missing one.
        const path = await cacheObject(bytes, hash);
        cached = { bytes, path };
      }
      const url = `/packages/${version.id}/${version.version}-${hash}.zip`;
      await outputFile(url, cached.path, hash, cached.bytes.length, 'package');
      version.mirrorUrl = url;
    });
    for (const language of LANGUAGES) {
      await mapLimit(languages[language].items, concurrency, async item => {
        const detail = languages[language].details[item.id];
        detail.coverUrl = await image(detail.coverUrl, 'cover');
        item.coverUrl = detail.coverUrl;
        item.downloadUrl = packages.get(`${item.id}@${detail.latestVersion}`).mirrorUrl;
        for (const version of detail.versions) version.downloadUrl = packages.get(`${item.id}@${version.version}`).mirrorUrl;
      });
    }
    const stickerCatalog = await getJson(`${base}/api/stickers`);
    if (!Array.isArray(stickerCatalog.items) || !Array.isArray(stickerCatalog.groups) || stickerCatalog.items.length !== stickerCatalog.total) throw new Error('Invalid sticker catalogue');
    log(`Mirroring ${stickerCatalog.total} stickers…`);
    await mapLimit(stickerCatalog.items, concurrency, async item => {
      if (!item.imageUrl) throw new Error(`Sticker image missing: ${item.stickerId}`);
      item.imageUrl = await image(item.imageUrl, 'sticker');
    });
    const modStickers = { generatedAt: new Date().toISOString(), items: [] };
    for (let offset = 0; offset < ids.length; offset += 100) {
      const data = await getJson(`${base}/api/mod-stickers?modIds=${encodeURIComponent(ids.slice(offset, offset + 100).join(','))}`);
      if (!Array.isArray(data.items)) throw new Error('Invalid sticker reactions');
      modStickers.items.push(...data.items);
    }
    await mapLimit(modStickers.items, concurrency, async item => {
      for (const sticker of item.stickers ?? []) {
        sticker.imageUrl = await image(sticker.imageUrl, 'sticker');
        sticker.reactedByMe = false;
      }
    });
    const snapshot = { schemaVersion: 1, upstream: base, generatedAt: new Date().toISOString(), languages, stickerCatalog, modStickers, files };
    const moduleText = `// Generated by npm run sync. Do not edit.\nexport default ${JSON.stringify(snapshot)};\n`;
    if (Buffer.byteLength(moduleText) > 4.4 * 1024 * 1024) throw new Error('Snapshot exceeds Edge Functions bundle budget');
    if (Object.keys(files).length > 18_000 || Object.values(files).reduce((sum, file) => sum + file.sizeBytes, 0) > 4 * 1024 ** 3) throw new Error('Static output exceeds free-plan budget');
    await writeFile(join(stage, 'generated', 'snapshot.js'), moduleText);
    // Validate the complete staged deployment before replacing either live folder.
    await mkdir(join(stage, 'src'));
    await copyFile(join(ROOT, 'src', 'api.js'), join(stage, 'src', 'api.js'));
    await validateBuild(stage);
    await publishStage(root, stage);
    await writeFile(join(cacheRoot, 'images.json'), JSON.stringify(cacheIndex));
    log(`Synced ${ids.length} mods, ${packages.size} versions, ${stickerCatalog.total} stickers; ${(Object.values(files).reduce((n, f) => n + f.sizeBytes, 0) / 1024 ** 2).toFixed(2)} MiB static files.`);
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
