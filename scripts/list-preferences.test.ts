import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/list-preferences.js', import.meta.url), 'utf8');
const skladkiSource = readFileSync(new URL('../public/lista-wyjazdowa/skladki/skladki.js', import.meta.url), 'utf8');
const wyjazdSource = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function load(storage: Storage | undefined): Record<string, any> {
  const context: Record<string, unknown> = { localStorage: storage };
  vm.runInNewContext(
    `${source}\n;globalThis.__h = { readBooleanPreference, writeBooleanPreference, LIST_PREFERENCE_KEYS, LIST_PREFERENCES_VERSION };`,
    context,
    { filename: 'list-preferences.js' },
  );
  return context.__h as Record<string, any>;
}

// Values built inside the vm context have another realm's prototypes, so compare plain copies.
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

const FIELDS = ['paid', 'unpaid', 'notApplicable'];

test('a written boolean preference reads back under the versioned envelope', () => {
  const storage = memoryStorage();
  const h = load(storage);
  h.writeBooleanPreference(h.LIST_PREFERENCE_KEYS.skladkiStatusFilter, { paid: true, unpaid: false, notApplicable: true });

  assert.deepEqual(JSON.parse(storage.map.get(h.LIST_PREFERENCE_KEYS.skladkiStatusFilter)), {
    v: 1,
    value: { paid: true, unpaid: false, notApplicable: true },
  });
  assert.deepEqual(
    plain(h.readBooleanPreference(h.LIST_PREFERENCE_KEYS.skladkiStatusFilter, FIELDS)),
    { paid: true, unpaid: false, notApplicable: true },
  );
});

test('a missing key reads as null so the page keeps its defaults', () => {
  const h = load(memoryStorage());
  assert.equal(h.readBooleanPreference(h.LIST_PREFERENCE_KEYS.skladkiStatusFilter, FIELDS), null);
});

test('invalid JSON, another version, or a non-boolean field reads as null', () => {
  const key = load(memoryStorage()).LIST_PREFERENCE_KEYS.skladkiStatusFilter as string;
  const cases = [
    'not json{',
    JSON.stringify({ v: 2, value: { paid: true, unpaid: false, notApplicable: false } }),
    JSON.stringify({ v: 1, value: { paid: 'yes', unpaid: false, notApplicable: false } }),
    JSON.stringify({ v: 1, value: { paid: true, unpaid: false } }),
    JSON.stringify({ v: 1, value: null }),
    JSON.stringify(null),
  ];
  for (const raw of cases) {
    const h = load(memoryStorage({ [key]: raw }));
    assert.equal(h.readBooleanPreference(key, FIELDS), null, `expected null for ${raw}`);
  }
});

test('extra fields in a valid stored value are dropped', () => {
  const key = 'k';
  const h = load(memoryStorage({ [key]: JSON.stringify({ v: 1, value: { niezgloszeni: true, zgloszeni: false, junk: 1 } }) }));
  assert.deepEqual(plain(h.readBooleanPreference(key, ['niezgloszeni', 'zgloszeni'])), { niezgloszeni: true, zgloszeni: false });
});

test('storage that is missing or throws never breaks the page', () => {
  const throwing: Storage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  for (const storage of [undefined, throwing]) {
    const h = load(storage);
    assert.equal(h.readBooleanPreference('k', FIELDS), null);
    assert.doesNotThrow(() => h.writeBooleanPreference('k', { paid: true, unpaid: false, notApplicable: false }));
  }
});

test('the fees filter and the trip roster view are saved and restored through the shared helper', () => {
  assert.match(skladkiSource, /writeBooleanPreference\(LIST_PREFERENCE_KEYS\.skladkiStatusFilter, skladkiStatusFilter\)/);
  assert.match(skladkiSource, /readBooleanPreference\(LIST_PREFERENCE_KEYS\.skladkiStatusFilter, Object\.keys\(skladkiStatusFilter\)\)/);
  assert.match(wyjazdSource, /writeBooleanPreference\(LIST_PREFERENCE_KEYS\.wyjazdRosterFilter, \{ niezgloszeni: showNotSignedUp, zgloszeni: showSignedUpAndMe \}\)/);
  assert.match(wyjazdSource, /readBooleanPreference\(LIST_PREFERENCE_KEYS\.wyjazdRosterFilter, ROSTER_FILTER_PREFERENCE_FIELDS\)/);
});
