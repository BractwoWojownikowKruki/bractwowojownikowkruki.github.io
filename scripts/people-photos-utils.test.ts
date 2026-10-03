import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifest,
  buildSnapshot,
  sortPeopleDeterministically,
  type RemotePersonFull,
  collectWantedPhotos,
  fileNameFor,
  parseFileName,
  planSync,
  versionOf,
  type RemotePerson,
} from './people-photos-utils.ts';

const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);
const person = (main: [string, string?] | null, gallery: [string, string?][] = []): RemotePerson => ({
  mainPhoto: main ? { id: main[0], url: `https://lh3.example/${main[0]}=s800`, md5: main[1] } : null,
  photos: gallery.map(([id, md5]) => ({ id, url: `https://lh3.example/${id}=s300`, md5 })),
});

test('collectWantedPhotos takes main at 800 and gallery at 300, deduplicated', () => {
  const wanted = collectWantedPhotos([person(['m1', MD5_A], [['g1', MD5_A]]), person(['m1', MD5_A])]);
  assert.deepEqual(wanted.map(w => `${w.id}-${w.size}-${w.version}`), ['m1-800-aaaaaaaaaa', 'g1-300-aaaaaaaaaa']);
});

test('collectWantedPhotos skips unsafe ids, unknown sizes and a missing main photo', () => {
  const bad: RemotePerson = {
    mainPhoto: { id: '../evil', url: 'https://x/y=s800' },
    photos: [{ id: 'ok', url: 'https://x/y=s1600' }, { id: 'nosize', url: 'https://x/y' }],
  };
  assert.deepEqual(collectWantedPhotos([bad, person(null)]), []);
});

test('versionOf falls back to 0 without a valid md5', () => {
  assert.equal(versionOf(undefined), '0');
  assert.equal(versionOf('nope'), '0');
  assert.equal(versionOf(MD5_B), 'bbbbbbbbbb');
});

test('planSync downloads only what is missing and deletes only what is stale', () => {
  const wanted = collectWantedPhotos([person(['m1', MD5_A], [['g1', MD5_A]])]);
  const existing = [
    fileNameFor(wanted[0], 'jpg'), // up to date
    'g1-300-bbbbbbbbbb.jpg', // g1 edited in place (new md5) -> old copy stale
    'gone-800-aaaaaaaaaa.jpg', // person removed
  ];
  const plan = planSync(wanted, existing);
  assert.deepEqual(plan.toDownload.map(w => w.id), ['g1']);
  assert.deepEqual(plan.toDelete.sort(), ['g1-300-bbbbbbbbbb.jpg', 'gone-800-aaaaaaaaaa.jpg']);
  assert.equal(plan.upToDate, 1);
});

test('planSync is a no-op when everything is cached (idempotent)', () => {
  const wanted = collectWantedPhotos([person(['m1', MD5_A], [['g1', MD5_A]])]);
  const plan = planSync(wanted, wanted.map(w => fileNameFor(w, 'jpg')));
  assert.deepEqual(plan, { toDownload: [], toDelete: [], upToDate: 2 });
});

test('buildManifest lists only wanted photos that exist on disk', () => {
  const wanted = collectWantedPhotos([person(['m1', MD5_A], [['g1', MD5_A]])]);
  const manifest = buildManifest(wanted, ['m1-800-aaaaaaaaaa.webp', 'orphan-300-aaaaaaaaaa.jpg']);
  assert.deepEqual(manifest, {
    version: 1,
    photos: { m1: { v: 'aaaaaaaaaa', files: { '800': 'people-photos/m1-800-aaaaaaaaaa.webp' } } },
  });
});

test('parseFileName rejects the manifest and foreign files', () => {
  assert.equal(parseFileName('manifest.json'), null);
  assert.deepEqual(parseFileName('a_b-1-300-0.jpg'), { id: 'a_b-1', size: 300, version: '0', ext: 'jpg' });
});

const full = (name: string, order: number | null, p: RemotePerson, extra: Partial<RemotePersonFull> = {}): RemotePersonFull => ({
  name, order, description: `opis ${name}`, inMemoriam: false, ...p, ...extra,
});

test('sortPeopleDeterministically: numbered by order then name, unnumbered by name last', () => {
  const sorted = sortPeopleDeterministically([
    { name: 'Zofia', order: null }, { name: 'Ola', order: 2 }, { name: 'Ania', order: 2 },
    { name: 'Bartek', order: 1 }, { name: 'Ćma', order: null }, { name: 'Adam', order: null },
  ]);
  assert.deepEqual(sorted.map(p => p.name), ['Bartek', 'Ania', 'Ola', 'Adam', 'Ćma', 'Zofia']);
});

test('buildSnapshot uses cached local paths, drops uncached photos, never stores Drive URLs', () => {
  const people = [full('Ania', 1, person(['m1', MD5_A], [['g1', MD5_A], ['g2', MD5_A]]), { inMemoriam: true })];
  const wanted = collectWantedPhotos(people);
  // g2 failed to download: not on disk, so not in the manifest
  const manifest = buildManifest(wanted, ['m1-800-aaaaaaaaaa.jpg', 'g1-300-aaaaaaaaaa.jpg']);
  const snapshot = buildSnapshot(people, manifest);
  assert.deepEqual(snapshot, {
    version: 1,
    people: [{
      name: 'Ania', order: 1, description: 'opis Ania', inMemoriam: true,
      mainPhoto: { id: 'm1', url: '/people-photos/m1-800-aaaaaaaaaa.jpg' },
      photos: [{ id: 'g1', url: '/people-photos/g1-300-aaaaaaaaaa.jpg' }],
    }],
  });
  assert.ok(!JSON.stringify(snapshot).includes('lh3.example'));
});

test('buildSnapshot is deterministic regardless of the API order (no nightly churn)', () => {
  const a = full('A', 1, person(null)), b = full('B', 1, person(null));
  const m = buildManifest([], []);
  assert.equal(JSON.stringify(buildSnapshot([a, b], m)), JSON.stringify(buildSnapshot([b, a], m)));
});

test('buildManifest output does not depend on the order photos are listed in', () => {
  const people = [person(['m1', MD5_A], [['g1', MD5_A]]), person(['m2', MD5_B])];
  const files = ['m1-800-aaaaaaaaaa.jpg', 'g1-300-aaaaaaaaaa.jpg', 'm2-800-bbbbbbbbbb.jpg'];
  const forward = JSON.stringify(buildManifest(collectWantedPhotos(people), files));
  const reversed = JSON.stringify(buildManifest(collectWantedPhotos([...people].reverse()), files));
  assert.equal(forward, reversed);
});
