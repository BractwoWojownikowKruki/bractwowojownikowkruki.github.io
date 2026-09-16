import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const page = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/index.html', import.meta.url), 'utf8');
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

test('event roster filter is an initially inactive accessible toggle instead of a select', () => {
  assert.doesNotMatch(page, /<select\s+id="roster-filter-select"/);
  assert.match(page, /<button\s+id="roster-filter-toggle"\s+class="lw-roster-filter-toggle"\s+type="button"\s+aria-pressed="false">/);
  assert.match(page, /<span\s+class="lw-roster-filter-toggle-track"\s+aria-hidden="true"><\/span>/);
  assert.match(page, /<button[^>]*id="roster-filter-toggle"[\s\S]*?Tylko zgłoszeni \+ ja[\s\S]*?<\/button>/);
});

test('event roster filter toggle exposes active switch and keyboard-focus states', () => {
  assert.match(css, /\.lw-roster-filter-toggle\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.lw-roster-filter-toggle\[aria-pressed="true"\]\s*\.lw-roster-filter-toggle-track\s*\{[^}]*border-color:\s*var\(--gold\)/);
  assert.match(css, /\.lw-roster-filter-toggle\[aria-pressed="true"\]\s*\.lw-roster-filter-toggle-track::before\s*\{[^}]*transform:\s*translateX\(1\.1rem\)/);
  assert.match(css, /\.lw-roster-filter-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--gold\)/);
});
