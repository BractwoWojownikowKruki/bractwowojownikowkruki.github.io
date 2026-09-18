import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const page = readFileSync(new URL('../public/profil/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/profil/profil.css', import.meta.url), 'utf8');

test('Mój profil has a separate Osoby towarzyszące panel outside the profile form', () => {
  const form = page.match(/<form id="profile-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.doesNotMatch(form, /persons-panel/, 'the persons panel must not be inside the profile form');
  assert.match(page, /<section id="persons-panel">/);
  assert.match(page, /<div id="persons-rows"/);
  assert.match(page, /id="add-person-row"/);
  assert.match(page, /id="persons-error"/);
});

test('Mój profil renders attached people from the roster and writes them through the persons routes', () => {
  assert.match(script, /'\/lista-wyjazdowa\/roster'/);
  assert.match(script, /person\.accountless && \(person\.ownerPersonId \?\? ''\)\.toLowerCase\(\) === owner/);
  assert.match(script, /'\/lista-wyjazdowa\/persons'/);
  assert.match(script, /method: 'POST'/);
  assert.match(script, /method: 'PUT'/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /ownerPersonId: viewerEmail\.toLowerCase\(\)/);
  assert.match(script, /MutationFeedback\.confirmed\(\{/);
});

test('Mój profil person rows carry identity fields and clear/hide weapons for Niewiasta/Bobo', () => {
  assert.match(script, /const NO_WEAPON_CATEGORY_IDS = \['niewiasta', 'bobo'\]/);
  assert.match(script, /name="personWeaponIds"/);
  assert.doesNotMatch(script, /relacja/);
  for (const cls of ['person-ksywka', 'person-first-name', 'person-last-name', 'person-category', 'person-section']) {
    assert.match(script, new RegExp(cls));
  }
  assert.match(css, /\.person-row\s*\{/);
  assert.match(css, /\.person-weapons\[hidden\]\s*\{\s*display:\s*none/);
});
