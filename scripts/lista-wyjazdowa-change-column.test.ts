import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const page = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/index.html', import.meta.url), 'utf8');
const skladkiPage = readFileSync(new URL('../public/lista-wyjazdowa/skladki/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const sortable = readFileSync(new URL('../public/shared/sortable-table.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');

test('event roster keeps Zmiana as the final sortable column', () => {
  const thead = page.match(/<thead>[\s\S]*?<\/thead>/)?.[0];
  assert.ok(thead);
  assert.match(thead, /data-sort-key="statusChangedAt"[^>]*>[\s\S]*?Zmiana/);
  assert.equal(thead.indexOf('data-sort-key="statusChangedAt"') > thead.indexOf('data-sort-key="weapon"'), true);
  assert.match(script, /colspan="5"/);
});

test('event roster renders statusChangedAt and applies the successful signup response locally', () => {
  assert.match(script, /function formatStatusChangedAt\(iso\)/);
  assert.match(script, /case 'statusChangedAt': return signupByEmail\.get\(member\.email\)\?\.statusChangedAt \?\? '';/);
  assert.match(script, /<td class="lw-status-changed-cell">\$\{escapeHtml\(formatStatusChangedAt\(signup\?\.statusChangedAt\)\)\}<\/td>/);
  assert.match(script, /apply: \(result\) =>|\(result\) => \{/);
  assert.match(script, /Object\.assign\(signup, savedSignup\)/);
});

test('missing statusChangedAt stays visually blank and date cells use the tiny table style', () => {
  assert.match(script, /if \(!iso\) return '';/);
  assert.match(css, /\.czl-table tbody td\.lw-status-changed-cell\s*\{[^}]*font-size:\s*0\.7rem/);
});

test('date comparator keeps missing timestamps last in both directions', () => {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(sortable, context);
  const compareDateValues = context.compareDateValues as (a: string, b: string, dir: string) => number;
  assert.ok(compareDateValues);
  assert.ok(compareDateValues('', '2026-01-01T00:00:00.000Z', 'asc') > 0);
  assert.ok(compareDateValues('', '2026-01-01T00:00:00.000Z', 'desc') > 0);
  assert.ok(compareDateValues('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'asc') < 0);
  assert.ok(compareDateValues('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'desc') > 0);
});

test('event roster filter is two labelled checkboxes instead of a toggle or select', () => {
  assert.doesNotMatch(page, /<select\s+id="roster-filter-select"/);
  assert.doesNotMatch(page, /id="roster-filter-toggle"/);
  assert.match(page, /<input\s+type="checkbox"\s+id="roster-filter-niezgloszeni"\s*\/>/);
  assert.match(page, /<input\s+type="checkbox"\s+id="roster-filter-zgloszeni"\s+checked\s*\/>/);
  assert.match(page, /<label\s+class="lw-filter-check">[\s\S]*?Niezgłoszeni[\s\S]*?<\/label>/);
  assert.match(page, /<label\s+class="lw-filter-check">[\s\S]*?Zgłoszeni \+ ja[\s\S]*?<\/label>/);
});

test('event roster filter checkboxes use the page accent and label layout', () => {
  assert.match(css, /\.lw-filter-check\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.lw-filter-check input\[type="checkbox"\]\s*\{[^}]*accent-color:\s*var\(--gold\)/);
  assert.doesNotMatch(css, /\.lw-roster-filter-toggle/);
});

test('fee panels expose labelled fields and a remove button on both pages', () => {
  assert.match(page, /<label\s+for="skladka-fee-input">Kwota \/ opis składki<\/label>/);
  assert.match(page, /<label\s+for="skladka-fee-duedate-input">Termin płatności<\/label>/);
  assert.match(page, /id="skladka-fee-remove"/);
  assert.match(page, /id="skladka-fee-save"[^>]*class="add-album-submit"|class="add-album-submit"[^>]*id="skladka-fee-save"/);
  assert.match(skladkiPage, /<label\s+for="skladki-year-fee-input">Kwota \/ opis składki rocznej<\/label>/);
  assert.match(skladkiPage, /<label\s+for="skladki-year-fee-duedate-input">Termin płatności<\/label>/);
  assert.match(skladkiPage, /id="skladki-year-fee-remove"/);
  assert.match(skladkiPage, /id="skladki-year-fee-save"[^>]*class="add-album-submit"|class="add-album-submit"[^>]*id="skladki-year-fee-save"/);
});

test('fee edit panels share the ordered layout styles', () => {
  assert.match(css, /\.lw-fee-edit\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.lw-fee-actions\s*\{[^}]*display:\s*flex/);
});
