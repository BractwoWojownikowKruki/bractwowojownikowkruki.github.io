import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const page = readFileSync(new URL('../public/czlonkowie/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/czlonkowie/czlonkowie.js', import.meta.url), 'utf8');

test('Spis Ludności keeps only display name as the visible name column', () => {
  assert.match(page, /data-sort-key="displayName"[^>]*>[\s\S]*?Display name/);
  assert.doesNotMatch(page, /data-sort-key="fullName"/);
  assert.doesNotMatch(page, /Imię i nazwisko/);
});

test('Spis Ludności renders and sorts the primary name with displayName', () => {
  assert.match(script, /sortState\.key === 'displayName' \? displayName\(member\) : \(member\[sortState\.key\] \?\? ''\)/);
  assert.match(script, /name: displayName\(m\)/);
  assert.doesNotMatch(script, /\$\{cell\(m\.fullName\)\}/);
  assert.match(script, /compareValues\(displayName\(a\), displayName\(b\), sortState\.dir\)/);
});

test('Spis Ludności unions accountless people from the roster and renders them read-only with the marker', () => {
  assert.match(page, /shared\/person-pill\.js/);
  assert.match(script, /'\/lista-wyjazdowa\/roster'/);
  assert.match(script, /personPillHtml\(\{/);
  assert.match(script, /accountless: m\.accountless === true/);
  assert.match(script, /data-person-id="\$\{escapeAttr\(m\.personId\)\}"/);
  assert.doesNotMatch(script, /categoryNamePillAttrs/);
  assert.match(script, /name: m\.categoryLabel \|\| 'Brak statusu',[\s\S]*?mode: 'category-label'/);
});
