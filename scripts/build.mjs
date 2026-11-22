import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD_LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 4 * 1024 ** 3,
  files: 19000,
  bundleBytes: 4.5 * 1024 * 1024,
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Resolve a generated asset URL without accepting URL/path traversal aliases. */
export function resolvePublicPath(publicRoot, url) {
  requireValue(typeof url === 'string' && url.startsWith('/') && !url.startsWith('//'),
    `Asset URL must be a local absolute path: ${url}`);
  requireValue(!/[\\\x00-\x1f?#]/.test(url), `Unsafe asset URL: ${url}`);
  const segments = url.slice(1).split('/').map((segment) => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error(`Invalid asset URL encoding: ${url}`); }
    requireValue(decoded && decoded !== '.' && decoded !== '..'
      && !/[\\/\x00-\x1f<>:"|?*]/.test(decoded), `Unsafe asset URL segment: ${url}`);
    return decoded;
  });
  const root = path.resolve(publicRoot);
  const target = path.resolve(root, ...segments);
  requireValue(target.startsWith(root + path.sep), `Asset escapes public directory: ${url}`);
  return target;
}

export async function loadSnapshot(root) {
  const filename = path.join(root, 'generated', 'snapshot.js');
  // Fresh imports let local tooling validate a newly synchronized snapshot.
  const source = await readFile(filename);
  const version = createHash('sha256').update(source).digest('hex');
  const { default: snapshot } = await import(`${pathToFileURL(filename).href}?sha256=${version}`);
  return snapshot;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    requireValue(!entry.isSymbolicLink(), `Symbolic links cannot be deployed: ${filename}`);
    if (entry.isDirectory()) files.push(...await walkFiles(filename));
    else {
      requireValue(entry.isFile(), `Unsupported filesystem entry: ${filename}`);
      files.push(filename);
    }
  }
  return files;
}

/** Validate a complete, immutable deployment; a failed sync must never deploy. */
export async function validateBuild(root, { limits: customLimits = {} } = {}) {
  const limits = { ...BUILD_LIMITS, ...customLimits };
  const snapshot = await loadSnapshot(root);
  requireValue(snapshot?.schemaVersion === 1, 'Snapshot schemaVersion must be 1');
  requireValue(typeof snapshot.generatedAt === 'string' && Number.isFinite(Date.parse(snapshot.generatedAt)),
    'Snapshot generatedAt must be a valid timestamp');
  requireValue(snapshot.files && typeof snapshot.files === 'object' && !Array.isArray(snapshot.files),
    'Snapshot files index is missing');
  const publicRoot = path.join(root, 'public');
  const publicFiles = await walkFiles(publicRoot);
  requireValue(publicFiles.length < limits.files, `Too many static files: ${publicFiles.length}`);
  const indexedFiles = new Set();
  let totalBytes = 0;
  for (const [url, metadata] of Object.entries(snapshot.files)) {
    const filename = resolvePublicPath(publicRoot, url);
    requireValue(!indexedFiles.has(filename), `Duplicate asset path: ${url}`);
    indexedFiles.add(filename);
    requireValue(metadata && /^[a-f0-9]{64}$/i.test(metadata.sha256)
      && Number.isSafeInteger(metadata.sizeBytes) && metadata.sizeBytes > 0
      && typeof metadata.kind === 'string' && metadata.kind.length > 0, `Invalid asset metadata: ${url}`);
    const info = await lstat(filename);
    requireValue(info.isFile() && !info.isSymbolicLink(), `Asset is not a regular file: ${url}`);
    requireValue(info.size <= limits.fileBytes, `Asset exceeds single-file limit: ${url}`);
    requireValue(info.size === metadata.sizeBytes, `Asset size mismatch: ${url}`);
    requireValue(await hashFile(filename) === metadata.sha256.toLowerCase(), `Asset SHA-256 mismatch: ${url}`);
    totalBytes += info.size;
  }
  requireValue(publicFiles.length === indexedFiles.size
    && publicFiles.every((filename) => indexedFiles.has(filename)), 'Unindexed static files found in public');
  requireValue(totalBytes < limits.totalBytes, `Static files exceed deployment size budget: ${totalBytes}`);

  const checkAsset = (url, description) => {
    resolvePublicPath(publicRoot, url);
    requireValue(Object.hasOwn(snapshot.files, url), `Missing asset index entry for ${description}: ${url}`);
    return snapshot.files[url];
  };
  let referenceIds;
  let versions = 0;
  const languages = ['zh-Hans', 'zh-Hant', 'en', 'ja'];
  for (const language of languages) {
    const catalog = snapshot.languages?.[language];
    requireValue(Array.isArray(catalog?.items) && catalog.items.length > 0
      && catalog.details && typeof catalog.details === 'object', `Incomplete language catalog: ${language}`);
    const ids = catalog.items.map((item) => item.id);
    requireValue(ids.every((id) => typeof id === 'string' && id.length > 0)
      && new Set(ids).size === ids.length, `Invalid or duplicate mod IDs: ${language}`);
    const sortedIds = [...ids].sort();
    requireValue(JSON.stringify(sortedIds) === JSON.stringify(Object.keys(catalog.details).sort()),
      `List/detail mod IDs differ: ${language}`);
    if (!referenceIds) referenceIds = sortedIds;
    requireValue(JSON.stringify(sortedIds) === JSON.stringify(referenceIds), `Language mod IDs differ: ${language}`);
    for (const item of catalog.items) {
      const detail = catalog.details[item.id];
      requireValue(detail.id === item.id && Array.isArray(detail.versions) && detail.versions.length > 0,
        `Incomplete detail: ${language}/${item.id}`);
      requireValue(detail.latestVersion === item.latestVersion
        && detail.versions.some((version) => version.version === detail.latestVersion),
      `Latest version is missing or inconsistent: ${language}/${item.id}`);
      requireValue(new Set(detail.versions.map((version) => version.version)).size === detail.versions.length,
        `Duplicate version: ${language}/${item.id}`);
      if (item.coverUrl) checkAsset(item.coverUrl, `${item.id} summary cover`);
      if (detail.coverUrl) checkAsset(detail.coverUrl, `${item.id} detail cover`);
      const latestFile = checkAsset(item.downloadUrl, `${item.id} latest package`);
      const latestVersion = detail.versions.find((version) => version.version === detail.latestVersion);
      requireValue(item.downloadUrl === latestVersion.downloadUrl
        && item.sha256?.toLowerCase() === latestFile.sha256.toLowerCase()
        && item.sizeBytes === latestFile.sizeBytes,
      `Latest summary metadata differs from mirrored file: ${language}/${item.id}`);
      for (const version of detail.versions) {
        const file = checkAsset(version.downloadUrl, `${item.id}/${version.version} package`);
        requireValue(version.downloadUrl.startsWith('/packages/') && file.kind === 'package'
          && /^[a-f0-9]{64}$/i.test(version.sha256)
          && file.sha256.toLowerCase() === version.sha256.toLowerCase()
          && file.sizeBytes === version.sizeBytes,
        `Package metadata differs from mirrored file: ${language}/${item.id}/${version.version}`);
      }
      if (language === 'zh-Hans') versions += detail.versions.length;
    }
  }
  for (const sticker of snapshot.stickerCatalog?.items ?? []) {
    requireValue(sticker.imageUrl.startsWith('/stickers/') && sticker.imageUrl.endsWith('.webp'),
      `Toys-incompatible sticker path: ${sticker.imageUrl}`);
    checkAsset(sticker.imageUrl, `sticker ${sticker.stickerId}`);
  }
  for (const state of snapshot.modStickers?.items ?? []) {
    for (const sticker of state.stickers ?? []) checkAsset(sticker.imageUrl, `sticker reaction ${sticker.stickerId}`);
  }
  const bundleBytes = (await readFile(path.join(root, 'generated', 'snapshot.js'))).length
    + (await readFile(path.join(root, 'src', 'api.js'))).length;
  requireValue(bundleBytes <= limits.bundleBytes, `Edge Function source exceeds bundle budget: ${bundleBytes}`);
  return { mods: referenceIds.length, versions, languages: languages.length, files: publicFiles.length, totalBytes, bundleBytes };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const result = await validateBuild(root);
    console.log(`Validated ${result.mods} mods / ${result.versions} versions / ${result.languages} languages; `
      + `${result.files} assets, ${(result.totalBytes / 1024 ** 2).toFixed(2)} MiB; `
      + `Edge Function source ${(result.bundleBytes / 1024 ** 2).toFixed(2)} MiB.`);
  } catch (error) {
    console.error(`Build validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
