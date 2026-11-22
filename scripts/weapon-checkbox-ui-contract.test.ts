import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const adminScript = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url), 'utf8');
const profileScript = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');
const profilePanel = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');

test('shared field text-input styles exclude checkboxes', () => {
  assert.match(styles, /\.field input:not\(\[type="checkbox"\]\)/);
});

test('accountless and member weapon controls are hidden for non-combat categories', () => {
  assert.match(adminScript, /accountless-weapon-field[\s\S]*?hidden = !allowed/);
  assert.match(adminScript, /function weaponCheckboxesHtml\(email, weapons, currentWeaponIds, categoryId\)[\s\S]*?ACCOUNT_NO_WEAPON_CATEGORY_IDS\.includes\(categoryId\)/);
  assert.match(profileScript, /memberCategoryId[\s\S]*?NO_WEAPON_CATEGORY_IDS\.includes\(memberCategoryId\)[\s\S]*?weapons-panel/);
  assert.match(profileScript, /if \(profile && canMemberUseWeapons\) \{[\s\S]*?profile\.weaponIds\.includes\(cb\.value\)/);
  assert.match(profilePanel, /function profileWeaponsFormHtml\(profile\)[\s\S]*?NO_WEAPON_CATEGORY_IDS\.includes\(profile\.categoryId\)/);
});

test('accountless form validates the fields required by the person API', () => {
  assert.match(adminScript, /if \(!fields\.firstName \|\| !fields\.lastName \|\| !fields\.categoryId \|\| !fields\.sectionId\)/);
  assert.match(adminScript, /Imię, nazwisko, kategoria i sekcja są wymagane\./);
});
