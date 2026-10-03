import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/summary-filter.js', import.meta.url), 'utf8');

function load(): Record<string, any> {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(`${source}\n;globalThis.__h = { createSummaryFilter, summaryFilterActive, summaryFilterMatches, summaryFilterPrune, summaryFilterChipHtml, summaryFilterBlockHtml };`, context, { filename: 'summary-filter.js' });
  return context.__h as Record<string, any>;
}

test('pills within a group widen the result, pills across groups narrow it', () => {
  const h = load();
  const filter = h.createSummaryFilter(['section', 'category']);
  const poznanNiewiasta = { section: 'poznan', category: 'niewiasta' };
  const poznanBrokul = { section: 'poznan', category: 'brokul' };
  const krakowNiewiasta = { section: 'krakow', category: 'niewiasta' };

  assert.equal(h.summaryFilterActive(filter), false);
  assert.ok(h.summaryFilterMatches(filter, krakowNiewiasta), 'nothing pressed = everyone');

  filter.selected.section.add('poznan');
  filter.selected.section.add('krakow');
  assert.ok(h.summaryFilterMatches(filter, poznanBrokul));
  assert.ok(h.summaryFilterMatches(filter, krakowNiewiasta));

  filter.selected.section.delete('krakow');
  filter.selected.category.add('niewiasta');
  assert.ok(h.summaryFilterMatches(filter, poznanNiewiasta));
  assert.equal(h.summaryFilterMatches(filter, poznanBrokul), false);
  assert.equal(h.summaryFilterMatches(filter, krakowNiewiasta), false);
});

test('a group missing from the row is ignored, and null is its own pill', () => {
  const h = load();
  const filter = h.createSummaryFilter(['section', 'category']);
  filter.selected.category.add('niewiasta');
  assert.ok(h.summaryFilterMatches(filter, { section: 'krakow' }), 'equipment has no status - only sekcja applies');
  filter.selected.section.add('');
  assert.ok(h.summaryFilterMatches(filter, { section: null }));
  assert.equal(h.summaryFilterMatches(filter, { section: 'krakow' }), false);
});

test('prune drops pressed values whose pill is gone', () => {
  const h = load();
  const filter = h.createSummaryFilter(['section']);
  filter.selected.section.add('poznan');
  filter.selected.section.add('');
  h.summaryFilterPrune(filter, { section: new Map([[null, 1], ['krakow', 2]]).keys() });
  assert.deepEqual([...filter.selected.section], ['']);
});

test('chips are pressed buttons and the block carries headings and one clear button', () => {
  const h = load();
  const filter = h.createSummaryFilter(['section']);
  filter.selected.section.add('poznan');
  const pressed = h.summaryFilterChipHtml(filter, 'section', 'poznan', { className: 'section-pill', attrs: 'data-section="poznan"', content: 'Poznań' });
  assert.match(pressed, /^<button type="button" class="section-pill lw-summary-chip lw-filter-chip" data-section="poznan" data-filter-group="section" data-filter-value="poznan" aria-pressed="true">Poznań<\/button>$/);
  const plain = h.summaryFilterChipHtml(filter, 'section', null, { content: 'Bez sekcji' });
  assert.match(plain, /data-filter-value="" aria-pressed="false"/);
  const block = h.summaryFilterBlockHtml(filter, [{ heading: 'Filtruj wg sekcji', chipsHtml: pressed }]);
  assert.match(block, /data-filter-active="true"/);
  assert.match(block, /<h3>Filtruj wg sekcji<\/h3>/);
  assert.equal((block.match(/data-filter-clear/g) ?? []).length, 1);
  assert.doesNotMatch(block, /data-filter-clear disabled/);
});
