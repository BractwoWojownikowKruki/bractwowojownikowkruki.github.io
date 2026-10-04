import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const panel = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');

test('the profile drawer opens a person without an account through the person-keyed endpoint', () => {
  assert.match(panel, /async function openPerson\(personId, name = '', folderId = ''\)/);
  assert.match(panel, /\/lista-wyjazdowa\/person-profile\?personId=/);
  assert.match(panel, /trigger\.dataset\.personId\) openPerson\(trigger\.dataset\.personId, triggerName\(trigger\)\)/);
  assert.match(panel, /open\(trigger\.dataset\.email, triggerName\(trigger\), trigger\.dataset\.folderId\)/);
});

test('the profile drawer marks an accountless person with the shared person icon', () => {
  assert.match(panel, /const PERSON_MARKER_ICON = '<svg class="person-pill-icon"/);
  assert.match(panel, /profile\.accountless \? PERSON_MARKER_ICON : ''/);
  assert.match(panel, /aria-label="osoba bez konta"/);
  // KRKG-0089: the add-companion child figure, not the profile-open person icon.
  assert.match(panel, /M9\.2 22l2\.8-7/);
});

test('the profile drawer shows who an accountless person is a companion of', () => {
  assert.match(panel, /profile\.ownerName \? `<dt>Osoba towarzysząca<\/dt><dd>\$\{escapeHtml\(profile\.ownerName\)\}<\/dd>`/);
});

test('the profile drawer shows a decorative Brokuł icon in a visible category label', () => {
  assert.match(panel, /categoryPillBroccoliIconHtml\(profile\.categoryId, 'category-label'\)/);
});

test('the drawer asks the backend to skip its Drive reads only when a snapshot entry exists, and merges the snapshot back', () => {
  assert.match(panel, /staticPerson: findStaticPerson\(folderId\)/);
  assert.match(panel, /\$\{staticPerson \? '&skipPublic=1' : ''\}/);
  assert.match(panel, /profile\.publicSkipped && staticPerson/);
  assert.match(panel, /profile\.description = staticPerson\.description \|\| null/);
  assert.match(panel, /profile\.published = true/);
});

test('opening the lightbox fetches the live Drive links for snapshot photos (the 1600px size is not cached)', () => {
  assert.match(panel, /async function upgradeStaticPhotosForLightbox\(\)/);
  assert.match(panel, /photos\.some\(\(p\) => p\.fromStatic && !p\.remoteUrl\)/);
  assert.match(panel, /setLightboxIndex\(photoIndex\);\s+upgradeStaticPhotosForLightbox\(\);/);
});
