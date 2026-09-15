import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const page = readFileSync(new URL('../public/czlonkowie/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/czlonkowie/czlonkowie.js', import.meta.url), 'utf8');

test('Spis Ludności labels the name columns as display name and full name', () => {
  assert.match(page, /data-sort-key="displayName"[^>]*>[\s\S]*?Display name/);
  assert.match(page, /data-sort-key="fullName"[^>]*>[\s\S]*?Imię i nazwisko/);
  assert.doesNotMatch(page, /data-sort-key="nickname"/);
});

test('Spis Ludności renders and sorts the primary name with displayName', () => {
  assert.match(script, /sortState\.key === 'displayName' \? displayName\(member\) : member\[sortState\.key\]/);
  assert.match(script, /\$\{cell\(displayName\(m\)\)\}/);
  assert.match(script, /\$\{cell\(m\.fullName\)\}/);
  assert.match(script, /compareValues\(displayName\(a\), displayName\(b\), sortState\.dir\)/);
});
