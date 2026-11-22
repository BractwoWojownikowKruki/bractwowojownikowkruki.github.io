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
  assert.match(script, /class="member-action accountless-edit edit-compact">Edytuj</);
  assert.match(script, /class="member-action accountless-detach">Odepnij</);
  assert.match(script, /class="member-action accountless-deactivate">Deaktywuj</);
  assert.match(script, /class="member-action accountless-purge">Usuń trwale</);
  // A deactivated person is read-only: no edit/detach/deactivate, only permanent removal.
  assert.match(script, /person\.deleted \? '' : '<button type="button" class="member-action accountless-edit edit-compact">/);
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

test('accountants can load the accountless table without rendering its write actions', () => {
  assert.doesNotMatch(script, /getElementById\('accountless-records-section'\)\.hidden = isAccountantOnlyCaller/);
  assert.match(script, /if \(isAccountantOnlyCaller\) \{[\s\S]*?loadAccountless\(\);/);
  assert.match(script, /function accountlessActionsHtml\(person\)[\s\S]*?if \(isAccountantOnlyCaller\) return ''/);
  assert.match(script, /accountlessActionsHtml\(person\)/);
  const submitStart = script.indexOf('async function submitAccountlessForm()');
  const submit = script.slice(submitStart, script.indexOf("document.getElementById('accountless-add-toggle')", submitStart));
  assert.doesNotMatch(submit, /!isAccountantOnlyCaller/);
  const loadStart = script.indexOf('async function loadAccountless()');
  const load = script.slice(loadStart, script.indexOf('function populateAccountlessOwnerOptions', loadStart));
  assert.doesNotMatch(load, /resetAccountlessForm\(\)/);
  assert.match(load, /const lists = isAccountantOnlyCaller \? accountlessCache : staffLists/);
  assert.match(script, /async function loadAccountlessCreationOptions\(\)[\s\S]*?persons: accountlessCache\.persons/);
  assert.match(script, /async function loadAccountlessCreationOptions\(\)[\s\S]*?if \(accountlessTableLoaded\) renderAccountless\(accountlessCache\.persons\)/);
});

test('accountless summary filter preserves loading and error rows until the table has loaded', () => {
  assert.match(script, /wireSummaryFilter\(document\.getElementById\('accountless-summary-filter'\), accountlessFilter, \(\) => \{\s*if \(accountlessTableLoaded\) renderAccountless\(accountlessCache\.persons\);\s*\}\)/);
  const loadStart = script.indexOf('async function loadAccountless()');
  const load = script.slice(loadStart, script.indexOf('function populateAccountlessOwnerOptions', loadStart));
  assert.match(load, /accountlessTableLoaded = false;\s*document\.getElementById\('accountless-summary-filter'\)\.innerHTML = ''/);
  assert.match(load, /catch \(err\) \{\s*accountlessTableLoaded = false;\s*document\.getElementById\('accountless-summary-filter'\)\.innerHTML = ''/);
});
