import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifest,
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
