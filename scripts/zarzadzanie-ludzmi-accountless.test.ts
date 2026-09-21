import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const page = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url), 'utf8');

test('member table keeps Sekcja first and places the profile trigger in Ksywa', () => {
  assert.match(page, /<tr>\s*\n\s*<th scope="col" class="czl-section-cell"/);
  assert.doesNotMatch(page, /<tr>\s*\n\s*<th scope="col"><\/th>\s*\n\s*<th scope="col" class="czl-section-cell"/);
  assert.match(script, /<td class="czl-section-cell"[\s\S]*?<td class="czl-name-cell"[\s\S]*?<td class="czl-nickname-cell">[\s\S]*?profile-trigger profile-trigger--icon/);
  assert.doesNotMatch(script, /<tr class="membership-member[\s\S]*?<td>\s*\n\s*<button type="button" class="profile-trigger profile-trigger--icon"/);
});

test('Zarządzanie ludźmi has an Osoby bez konta section with add form, table and merge controls', () => {
  assert.match(page, /<section id="accountless-section"/);
  assert.match(page, /id="accountless-add-toggle"[^>]*>Dodaj osobę bez konta</);
  assert.match(page, /id="accountless-form-panel"[\s\S]*?id="accountless-ksywka"[\s\S]*?id="accountless-first-name"[\s\S]*?id="accountless-last-name"[\s\S]*?id="accountless-category"[\s\S]*?id="accountless-section-select"[\s\S]*?id="accountless-weapons"/);
  assert.match(page, /<tbody id="accountless-list"><\/tbody>/);
  assert.match(page, /id="accountless-merge-section"[^>]*hidden/);
  assert.match(page, /id="accountless-merge-email"/);
  assert.match(page, /id="accountless-merge-person"/);
});

test('Osoby bez konta rows render from the staff persons list with edit / detach / deactivate / purge actions', () => {
  assert.match(script, /'\/lista-wyjazdowa\/persons'/);
  assert.match(script, /function renderAccountless\(persons\)/);
  assert.match(script, /class="member-action accountless-edit">Edytuj</);
  assert.match(script, /class="member-action accountless-detach">Odepnij</);
  assert.match(script, /class="member-action accountless-deactivate">Deaktywuj</);
  assert.match(script, /class="member-action accountless-purge">Usuń trwale</);
  // A deactivated person is read-only: no edit/detach/deactivate, only permanent removal.
  assert.match(script, /person\.deleted \? '' : '<button type="button" class="member-action accountless-edit">/);
  assert.match(script, /person\.deleted \? '' : '<button type="button" class="member-action accountless-deactivate">/);
});

test('Osoby bez konta writes go through the persons routes and the admin-only merge', () => {
  assert.match(script, /'\/lista-wyjazdowa\/persons'/);
  assert.match(script, /'\/lista-wyjazdowa\/persons\/owner'/);
  assert.match(script, /'\/lista-wyjazdowa\/persons\/account'/);
  assert.match(script, /'\/lista-wyjazdowa\/persons\/permanent'/);
  assert.match(script, /MutationFeedback\.confirmed\(\{/);
  assert.match(script, /accountless-merge-section'\)\.hidden = !isAdminCaller/);
  assert.match(script, /const ACCOUNT_NO_WEAPON_CATEGORY_IDS = \['niewiasta', 'bobo'\]/);
});
