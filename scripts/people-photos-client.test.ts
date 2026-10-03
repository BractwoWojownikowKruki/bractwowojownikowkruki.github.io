import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads public/people-photos.js (a browser global script) with a stubbed window/fetch.
function load(fetchImpl: (url: string) => Promise<unknown>) {
  const window: Record<string, any> = {};
  vm.runInNewContext(readFileSync(new URL('../public/people-photos.js', import.meta.url), 'utf8'), {
    window,
    fetch: fetchImpl,
    Math,
    Promise,
  });
  return window.PeoplePhotoCache;
}

const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });

test('loadStaticPeople reads /people-data/<slug>.json and marks photos as static', async () => {
  let requested = '';
  const cache = load(url => {
    requested = url;
    return ok({ version: 1, people: [{ name: 'A', order: 1, mainPhoto: { id: 'x', url: '/people-photos/x.jpg' }, photos: [] }] });
  });
  const people = await cache.loadStaticPeople('Założyciele');
  assert.equal(requested, '/people-data/zalozyciele.json');
  assert.equal(people[0].mainPhoto.fromStatic, true);
});

test('loadStaticPeople returns null (=> live API fallback) on 404, bad version, network error, unknown category', async () => {
  assert.equal(await load(() => Promise.resolve({ ok: false })).loadStaticPeople('Blachowi'), null);
  assert.equal(await load(() => ok({ version: 2, people: [] })).loadStaticPeople('Blachowi'), null);
  assert.equal(await load(() => Promise.reject(new Error('offline'))).loadStaticPeople('Blachowi'), null);
  assert.equal(await load(() => ok({ version: 1, people: [] })).loadStaticPeople('Inna'), null);
});
