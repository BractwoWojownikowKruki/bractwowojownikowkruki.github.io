import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const panel = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/shared/profile-panel.css', import.meta.url), 'utf8');

test('the profile drawer is read-only until an identity-capable editor chooses Edytuj', () => {
  assert.match(panel, /profile\.editor\?\.canEditIdentity/);
  assert.match(panel, /profile-identity-edit/);
  assert.match(panel, /data-profile-edit="identity"/);
  assert.match(panel, />Edytuj</);
  assert.match(panel, /profile-identity-form/);
  assert.match(panel, /profile-identity-cancel/);
  assert.match(panel, /data-profile-cancel="identity"/);
  assert.match(panel, />Anuluj</);
});

test('identity editing uses the profile lookup lists for all identity fields', () => {
  assert.match(panel, /name="firstName"/);
  assert.match(panel, /name="lastName"/);
  assert.match(panel, /name="nickname"/);
  assert.match(panel, /name="sectionId"/);
  assert.match(panel, /name="categoryId"/);
  assert.match(panel, /lookupLists\.sections/);
  assert.match(panel, /lookupLists\.categories/);
});

test('the identity section saves through the target-specific route with feedback and a GET refresh', () => {
  assert.match(panel, /window\.MutationFeedback\.confirmed\(\{/);
  assert.match(panel, /\/admin\/members\/profile/);
  assert.match(panel, /\/lista-wyjazdowa\/persons/);
  assert.match(panel, /method: 'PUT'/);
  assert.match(panel, /loadProfileTarget\(target\)/);
  assert.match(panel, /refreshProfileDrawer\(\)/);
  assert.match(panel, /weaponIds: profile\.weaponIds \?\? \[\]/);
});

test('identity save keeps drafts on inline errors, disables only its pending section, and exits safely on auth loss', () => {
  assert.match(panel, /profile-identity-section--pending/);
  assert.match(panel, /save\.disabled = true/);
  assert.match(panel, /renderProfile\(editorState\.profile\)/);
  assert.match(panel, /if \(err\.status === 401 \|\| err\.status === 403\)/);
  assert.match(panel, /closeDrawer\(\)/);
  assert.match(panel, /drawerShowReauth/);
  assert.match(panel, /Nie udało się zapisać lub odświeżyć danych/);
  assert.match(css, /\.profile-identity-section/);
  assert.match(css, /\.profile-identity-error/);
});
