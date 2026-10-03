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

test('people sharing an order number are shuffled among themselves; others keep their position', async () => {
  const mk = (name: string, order: number | null) => ({ name, order, mainPhoto: null, photos: [] });
  const people = [mk('first', 1), mk('a', 2), mk('b', 2), mk('c', 2), mk('d', 2), mk('u1', null), mk('u2', null)];
  const cache = load(() => ok({ version: 1, people }));
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const out: string[] = Array.from(await cache.loadStaticPeople('Emeryci'), (p: any) => p.name);
    assert.equal(out[0], 'first');
    assert.deepEqual(out.slice(1, 5).sort(), ['a', 'b', 'c', 'd']);
    assert.deepEqual(out.slice(5), ['u1', 'u2']);
    seen.add(out.slice(1, 5).join(''));
  }
  assert.ok(seen.size > 1, 'order within the equal-order group should vary');
});
