// Decimal GB keeps the mirror below both 1 GB and 1 GiB limits.
export const MIRROR_LIMIT_BYTES = 1_000_000_000;
export const STATIC_FILE_BYTES = 25_000_000;
export const CHUNK_BYTES = 20 * 1024 * 1024;
export const METADATA_RESERVE_BYTES = 16 * 1024 * 1024;
export const STATIC_FILE_COUNT = 18_000;

/** Drop whole items (all their versions), largest resources before largest mods. */
export function selectGroups(groups, measure, {
  bytes = MIRROR_LIMIT_BYTES - METADATA_RESERVE_BYTES, files = STATIC_FILE_COUNT,
} = {}) {
  const retained = [...groups];
  const skipped = [];
  const order = [...groups].sort((a, b) =>
    (a.kind === 'resource' ? 0 : 1) - (b.kind === 'resource' ? 0 : 1)
    || b.packageBytes - a.packageBytes || a.key.localeCompare(b.key, 'en'));
  let usage = measure(retained);
  for (const group of order) {
    if (usage.bytes <= bytes && usage.files <= files) break;
    retained.splice(retained.indexOf(group), 1);
    skipped.push({ kind: group.kind, id: group.id, packageBytes: group.packageBytes,
      versions: group.versions.length, reason: usage.bytes > bytes ? 'capacity' : 'file-count' });
    usage = measure(retained);
  }
  if (usage.bytes > bytes || usage.files > files) throw new Error('Common assets exceed mirror budget');
  return { retained, skipped, usage };
}
