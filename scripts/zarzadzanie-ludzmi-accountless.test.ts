import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const page = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url), 'utf8');

test('Zarządzanie ludźmi has an Osoby bez konta section with add form, table and merge controls', () => {
  assert.match(page, /<section id="accountless-section"/);
  assert.match(page, /id="accountless-add-toggle"[^>]*>Dodaj osobę bez konta</);
  assert.match(page, /id="accountless-form-panel"[\s\S]*?id="accountless-ksywka"[\s\S]*?id="accountless-first-name"[\s\S]*?id="accountless-last-name"[\s\S]*?id="accountless-category"[\s\S]*?id="accountless-section-select"[\s\S]*?id="accountless-weapons"/);
  assert.match(page, /<tbody id="accountless-list"><\/tbody>/);
  assert.match(page, /id="accountless-merge-section"[^>]*hidden/);
  assert.match(page, /id="accountless-merge-email"/);
  assert.match(page, /id="accountless-merge-person"/);
});

test('Osoby bez konta rows render from the roster with Edytuj / Odepnij / Usuń actions', () => {
  assert.match(script, /'\/lista-wyjazdowa\/roster'/);
  assert.match(script, /roster\.filter\(\(person\) => person\.accountless\)/);
  assert.match(script, /class="member-action accountless-edit">Edytuj</);
  assert.match(script, /class="member-action accountless-detach">Odepnij</);
  assert.match(script, /class="member-action accountless-delete">Usuń</);
});

test('Osoby bez konta writes go through the persons routes and the admin-only merge', () => {
  assert.match(script, /'\/lista-wyjazdowa\/persons'/);
  assert.match(script, /'\/lista-wyjazdowa\/persons\/owner'/);
  assert.match(script, /'\/lista-wyjazdowa\/persons\/account'/);
  assert.match(script, /MutationFeedback\.confirmed\(\{/);
  assert.match(script, /accountless-merge-section'\)\.hidden = !isAdminCaller/);
  assert.match(script, /const ACCOUNT_NO_WEAPON_CATEGORY_IDS = \['niewiasta', 'bobo'\]/);
});
