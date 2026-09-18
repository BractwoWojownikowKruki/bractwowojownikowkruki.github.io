import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const panel = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');

test('the profile drawer opens a person without an account through the person-keyed endpoint', () => {
  assert.match(panel, /async function openPerson\(personId\)/);
  assert.match(panel, /\/lista-wyjazdowa\/person-profile\?personId=/);
  assert.match(panel, /trigger\.dataset\.personId\) openPerson\(trigger\.dataset\.personId\)/);
  assert.match(panel, /open\(trigger\.dataset\.email\)/);
});

test('the profile drawer marks an accountless person with the shared person icon', () => {
  assert.match(panel, /const PERSON_MARKER_ICON = '<svg class="person-pill-icon"/);
  assert.match(panel, /profile\.accountless \? PERSON_MARKER_ICON : ''/);
  assert.match(panel, /aria-label="osoba bez konta"/);
  // KRKG-0089: the add-companion child figure, not the profile-open person icon.
  assert.match(panel, /M9\.2 22l2\.8-7/);
});

test('the profile drawer shows who an accountless person is a companion of', () => {
  assert.match(panel, /profile\.ownerName \? `<dt>Opiekun<\/dt><dd>\$\{escapeHtml\(profile\.ownerName\)\}<\/dd>`/);
});
