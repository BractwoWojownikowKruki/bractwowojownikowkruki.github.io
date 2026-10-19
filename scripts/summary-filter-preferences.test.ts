import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const listPreferencesSource = readFileSync(new URL('../public/shared/list-preferences.js', import.meta.url), 'utf8');
const summaryFilterSource = readFileSync(new URL('../public/shared/summary-filter.js', import.meta.url), 'utf8');
const czlonkowieSource = readFileSync(new URL('../public/czlonkowie/czlonkowie.js', import.meta.url), 'utf8');
const skladkiSource = readFileSync(new URL('../public/lista-wyjazdowa/skladki/skladki.js', import.meta.url), 'utf8');
const wyjazdSource = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

function load(storage: Storage | undefined): Record<string, any> {
  const context: Record<string, unknown> = { localStorage: storage };
  vm.runInNewContext(
    `${listPreferencesSource}\n${summaryFilterSource}\n;globalThis.__h = { createSummaryFilter, wireSummaryFilter, summaryFilterMatches, summaryFilterPrune, LIST_PREFERENCE_KEYS };`,
    context,
    { filename: 'summary-filter.js' },
  );
  return context.__h as Record<string, any>;
}

// A pill click as wireSummaryFilter sees it: the delegated listener reads closest('[data-filter-group]').
function captureContainer() {
  let handler: ((e: any) => void) | null = null;
  return {
    container: {
      addEventListener: (_type: string, fn: (e: any) => void) => { handler = fn; },
      querySelectorAll: () => [],
    },
    click(group: string, value: string) {
      const chip = { dataset: { filterGroup: group, filterValue: value }, disabled: false, focus() {} };
      handler!({ target: { closest: (sel: string) => (sel === '[data-filter-group]' ? chip : null) } });
    },
    clear() {
      const clearButton = { dataset: { filterClear: '' }, disabled: false, focus() {} };
      handler!({ target: { closest: (sel: string) => (sel === '[data-filter-clear]' ? clearButton : null) } });
    },
  };
}

const values = (set: Set<string>) => [...set];

test('a filter without a preference never touches storage', () => {
  const h = load(undefined);
  const filter = h.createSummaryFilter(['section']);
  const ui = captureContainer();
  h.wireSummaryFilter(ui.container, filter, () => {});
  assert.doesNotThrow(() => ui.click('section', 'krakow'));
  assert.deepEqual(values(filter.selected.section), ['krakow']);
});

test('pressed pills are saved on click under the page-type key and slot, and restored on the next visit', () => {
  const storage = memoryStorage();
  const h = load(storage);
  const key = h.LIST_PREFERENCE_KEYS.spisSummaryFilter as string;
  const filter = h.createSummaryFilter(['section', 'category'], { key, slot: 'directory' });
  const ui = captureContainer();
  h.wireSummaryFilter(ui.container, filter, () => {});

  ui.click('section', 'krakow');
  ui.click('category', 'niewiasta');
  assert.deepEqual(JSON.parse(storage.map.get(key)!), {
    v: 1,
    value: { directory: { section: ['krakow'], category: ['niewiasta'] } },
  });

  const restored = h.createSummaryFilter(['section', 'category'], { key, slot: 'directory' });
  assert.deepEqual(values(restored.selected.section), ['krakow']);
  assert.deepEqual(values(restored.selected.category), ['niewiasta']);
});

test('clearing the filter saves the empty selection', () => {
  const storage = memoryStorage();
  const h = load(storage);
  const key = h.LIST_PREFERENCE_KEYS.spisSummaryFilter as string;
  const filter = h.createSummaryFilter(['section'], { key, slot: 'directory' });
  const ui = captureContainer();
  h.wireSummaryFilter(ui.container, filter, () => {});
  ui.click('section', 'poznan');
  ui.clear();
  const restored = h.createSummaryFilter(['section'], { key, slot: 'directory' });
  assert.deepEqual(values(restored.selected.section), []);
});

test('several slots under one page-type key keep each other (event roster and equipment)', () => {
  const storage = memoryStorage();
  const h = load(storage);
  const key = h.LIST_PREFERENCE_KEYS.wyjazdSummaryFilter as string;
  const roster = h.createSummaryFilter(['section', 'weapon', 'category'], { key, slot: 'roster' });
  const equipment = h.createSummaryFilter(['equipmentCategory'], { key, slot: 'equipment' });
  const rosterUi = captureContainer();
  const equipmentUi = captureContainer();
  h.wireSummaryFilter(rosterUi.container, roster, () => {});
  h.wireSummaryFilter(equipmentUi.container, equipment, () => {});

  rosterUi.click('weapon', 'miecz');
  equipmentUi.click('equipmentCategory', 'namioty');

  const restoredRoster = h.createSummaryFilter(['section', 'weapon', 'category'], { key, slot: 'roster' });
  const restoredEquipment = h.createSummaryFilter(['equipmentCategory'], { key, slot: 'equipment' });
  assert.deepEqual(values(restoredRoster.selected.weapon), ['miecz']);
  assert.deepEqual(values(restoredEquipment.selected.equipmentCategory), ['namioty']);
});

test('page types have their own keys, so Spis, trip and Składki selections do not leak into each other', () => {
  const h = load(memoryStorage());
  const keys = [h.LIST_PREFERENCE_KEYS.spisSummaryFilter, h.LIST_PREFERENCE_KEYS.wyjazdSummaryFilter, h.LIST_PREFERENCE_KEYS.skladkiSummaryFilter];
  assert.equal(new Set(keys).size, 3);
});

test('invalid stored values fall back to an empty selection and only named groups are restored', () => {
  const key = 'k';
  const cases = [
    'not json{',
    JSON.stringify({ v: 1, value: { slot: { section: 'krakow' } } }),
    JSON.stringify({ v: 1, value: { slot: { section: [1, 2] } } }),
    JSON.stringify({ v: 1, value: { slot: 'nope' } }),
    JSON.stringify({ v: 2, value: { slot: { section: ['krakow'] } } }),
  ];
  for (const raw of cases) {
    const h = load(memoryStorage({ [key]: raw }));
    const filter = h.createSummaryFilter(['section'], { key, slot: 'slot' });
    assert.deepEqual(values(filter.selected.section), [], `expected empty for ${raw}`);
  }
  const h = load(memoryStorage({ [key]: JSON.stringify({ v: 1, value: { slot: { section: ['krakow'], other: ['x'] } } }) }));
  const filter = h.createSummaryFilter(['section'], { key, slot: 'slot' });
  assert.deepEqual(Object.keys(filter.selected), ['section']);
  assert.deepEqual(values(filter.selected.section), ['krakow']);
});

test('a throwing or missing storage never breaks clicking a pill', () => {
  const throwing: Storage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  for (const storage of [undefined, throwing]) {
    const h = load(storage);
    const filter = h.createSummaryFilter(['section'], { key: 'k', slot: 's' });
    const ui = captureContainer();
    h.wireSummaryFilter(ui.container, filter, () => {});
    assert.doesNotThrow(() => ui.click('section', 'krakow'));
    assert.deepEqual(values(filter.selected.section), ['krakow']);
  }
});

test('the three page types opt in with their own slots', () => {
  assert.match(czlonkowieSource, /createSummaryFilter\(\['section', 'category'\], \{ key: LIST_PREFERENCE_KEYS\.spisSummaryFilter, slot: 'directory' \}\)/);
  assert.match(skladkiSource, /createSummaryFilter\(\['section', 'category'\], \{ key: LIST_PREFERENCE_KEYS\.skladkiSummaryFilter, slot: 'summary' \}\)/);
  assert.match(wyjazdSource, /createSummaryFilter\(\['section', 'weapon', 'category'\], \{ key: LIST_PREFERENCE_KEYS\.wyjazdSummaryFilter, slot: 'roster' \}\)/);
  assert.match(wyjazdSource, /createSummaryFilter\(\['equipmentCategory'\], \{ key: LIST_PREFERENCE_KEYS\.wyjazdSummaryFilter, slot: 'equipment' \}\)/);
});

test('summary-filter.js no longer claims pills are never persisted', () => {
  assert.doesNotMatch(summaryFilterSource, /Not persisted/);
});
