import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGroups, MIRROR_LIMIT_BYTES, METADATA_RESERVE_BYTES } from '../scripts/policy.mjs';

const group = (id, kind, packageBytes) => ({ id, kind, key: `${kind}:${id}`, packageBytes, versions: [{}] });
const measure = items => ({ bytes: items.reduce((n, g) => n + g.packageBytes, 0), files: items.length });

test('capacity drops largest resources first, then largest mods, within the decimal 1 GB limit', () => {
  const groups = [group('small', 'mod', 50e6), group('large', 'mod', 900e6),
    group('cards', 'resource', 300e6), group('audio', 'resource', 100e6)];
  const result = selectGroups(groups, measure);
  assert.deepEqual(result.skipped.map(g => g.id), ['cards', 'audio']);
  assert.equal(result.usage.bytes, 950e6);
  assert.ok(result.usage.bytes + METADATA_RESERVE_BYTES <= MIRROR_LIMIT_BYTES);
  const tighter = selectGroups(groups, measure, { bytes: 800e6 });
  assert.deepEqual(tighter.skipped.map(g => g.id), ['cards', 'audio', 'large']);
  assert.deepEqual(tighter.retained.map(g => g.id), ['small']);
  assert.equal(groups.length, 4, 'selection does not mutate the input');
});

test('selection measures shared assets again after each removal and resolves ties consistently', () => {
  const groups = [group('b', 'resource', 20), group('a', 'resource', 20), group('mod', 'mod', 50)];
  const result = selectGroups(groups, items => ({ bytes: measure(items).bytes + 15, files: items.length }), { bytes: 90 });
  assert.deepEqual(result.skipped.map(g => g.id), ['a']);
  assert.equal(result.usage.bytes, 85);
  const byCount = selectGroups(groups, measure, { bytes: 100, files: 1 });
  assert.deepEqual(byCount.skipped.map(g => g.id), ['a', 'b']);
  assert.ok(byCount.skipped.every(g => g.reason === 'file-count'));
});

test('impossible common asset budget fails instead of publishing an oversized mirror', () => {
  assert.throws(() => selectGroups([], () => ({ bytes: 101, files: 1 }), { bytes: 100 }), /Common assets/);
});
