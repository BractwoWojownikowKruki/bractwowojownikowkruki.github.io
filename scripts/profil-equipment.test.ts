import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const page = readFileSync(new URL('../public/profil/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/profil/profil.css', import.meta.url), 'utf8');

// Minimal DOM stub - just enough for profil.js's top-level (module-load-time) statements to run
// without throwing, so the function declarations below it (equipmentForOwner, equipmentItemHtml,
// personEquipmentInnerHtml, ...) become callable properties of the vm context. Nothing here drives
// a real sign-in/initForm pass (that would additionally need document.createElement + working
// querySelector on ad-hoc-built subtrees for addPersonRow/renderPersons, which profil.js has never
// had a vm harness for - see profil-persons.test.ts's own regex-only approach for the same reason).
class Element {
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  disabled = false;
  checked = false;
  files: unknown[] = [];
  dataset: Record<string, string> = {};
  addEventListener() {}
}

function createContext() {
  const elements = new Map<string, Element>();
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
    },
    window: {},
    apiFetch: async () => { throw new Error('apiFetch should not be called by loading the script'); },
    initGoogleSignIn: () => {},
    Cropper: class {},
    URL: { createObjectURL: () => '' },
    URLSearchParams,
    Map,
    Array,
    JSON,
    Date,
    encodeURIComponent,
  };
  vm.runInNewContext(script, context, { filename: 'profil.js' });
  return context;
}

const equipmentA = { id: 'eq-1', categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: 'ala@example.com', description: 'Duży namiot', canEdit: true, canDelete: true };
const equipmentB = { id: 'eq-2', categoryId: 'wiata', sectionId: 'warszawa', belongsToPersonId: 'person-uuid-1', description: null, canEdit: true, canDelete: false };

test('equipmentForOwner filters the full equipment list to one owner\'s items, by belongsToPersonId', () => {
  const context = createContext();
  const equipmentForOwner = context.equipmentForOwner as (equipment: unknown[], ownerId: string) => unknown[];
  assert.deepEqual(equipmentForOwner([equipmentA, equipmentB], 'ala@example.com'), [equipmentA]);
  assert.deepEqual(equipmentForOwner([equipmentA, equipmentB], 'person-uuid-1'), [equipmentB]);
  assert.deepEqual(equipmentForOwner([equipmentA, equipmentB], 'nobody@example.com'), []);
});

test('equipmentForOwner returns nothing for an empty equipment list', () => {
  const context = createContext();
  const equipmentForOwner = context.equipmentForOwner as (equipment: unknown[], ownerId: string) => unknown[];
  assert.deepEqual(equipmentForOwner([], 'ala@example.com'), []);
});

test('equipmentItemHtml renders a delete button only when the item is deletable, and shows the description when present', () => {
  const context = createContext();
  const equipmentItemHtml = context.equipmentItemHtml as (item: unknown) => string;
  const withDelete = equipmentItemHtml(equipmentA);
  assert.match(withDelete, /person-equipment-delete/);
  assert.match(withDelete, /data-equipment-id="eq-1"/);
  assert.match(withDelete, /Duży namiot/);

  const withoutDelete = equipmentItemHtml(equipmentB);
  assert.doesNotMatch(withoutDelete, /person-equipment-delete/);
});

test('personEquipmentInnerHtml shows a "Brak." hint for an empty list and a <ul> of items otherwise, plus the add controls', () => {
  const context = createContext();
  const personEquipmentInnerHtml = context.personEquipmentInnerHtml as (items: unknown[]) => string;
  const empty = personEquipmentInnerHtml([]);
  assert.match(empty, /Brak\./);
  assert.doesNotMatch(empty, /<ul/);
  assert.match(empty, /person-equipment-add-btn/);
  assert.match(empty, /person-equipment-category/);
  assert.match(empty, /person-equipment-description/);

  const withItems = personEquipmentInnerHtml([equipmentA]);
  assert.match(withItems, /<ul class="person-equipment-list">/);
  assert.match(withItems, /data-equipment-id="eq-1"/);
});

test('the old free-text equipment rows (addEquipmentRow/readEquipmentRows/fillRows) and their call sites are gone', () => {
  assert.doesNotMatch(script, /function addEquipmentRow/);
  assert.doesNotMatch(script, /function readEquipmentRows/);
  assert.doesNotMatch(script, /function fillRows/);
  assert.doesNotMatch(script, /add-equipment-row/);
  assert.doesNotMatch(script, /equipment-rows/);
  assert.doesNotMatch(script, /readEquipmentRows\(/);
});

test('the old equipment HTML containers (rows list + "Dodaj sprzęt" button + fieldset) are removed from the template', () => {
  assert.doesNotMatch(page, /id="equipment-rows"/);
  assert.doesNotMatch(page, /id="add-equipment-row"/);
  assert.doesNotMatch(page, />Sprzęt obozowy</);
});

test('the new "Namioty i wiaty" mini-list has its own panel outside #profile-form, matching #persons-panel\'s pattern', () => {
  const form = page.match(/<form id="profile-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.doesNotMatch(form, /own-equipment/, 'the own-equipment mini-list must not be inside the profile form (it saves immediately, not via Zapisz profil)');
  assert.match(page, /<section id="own-equipment-panel">/);
  assert.match(page, /<div id="own-equipment" class="person-equipment">/);
  assert.match(page, />Namioty i wiaty</);
});

test('GET /equipment is fetched alongside member/profile/roster in initForm\'s Promise.all', () => {
  const initForm = script.match(/async function initForm\(lookupLists\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(initForm);
  assert.match(initForm, /apiFetch\('\/equipment', \{ method: 'GET' \}/);
  assert.match(initForm, /Promise\.all\(\[[\s\S]*?apiFetch\('\/equipment'/);
});

test('equipment add/delete are wired as their own immediate POST/DELETE /equipment calls, not bundled into the profile submit', () => {
  // The profile PUT body (weaponIds only) no longer references equipment at all.
  const putProfileBody = script.match(/'\/lista-wyjazdowa\/profile',[\s\S]*?\);/)?.[0];
  assert.ok(putProfileBody);
  assert.doesNotMatch(putProfileBody, /equipment/i);

  // addPersonEquipmentItem/deletePersonEquipmentItem call apiFetch('/equipment', ...) directly,
  // each wrapped in its own MutationFeedback.confirmed - not inside the submit handler's execute.
  assert.match(script, /async function addPersonEquipmentItem\([\s\S]*?apiFetch\(\s*'\/equipment',/);
  assert.match(script, /async function deletePersonEquipmentItem\([\s\S]*?apiFetch\(`\/equipment\?id=\$\{encodeURIComponent\(itemId\)\}`, \{ method: 'DELETE' \}/);
  assert.match(script, /MutationFeedback\.confirmed\(\{/);

  // Wired from a delegated click listener on the mini-list container, not the form's submit event.
  assert.match(script, /function wireEquipmentMiniList\(container, ownerId, getSectionId\) \{/);
  assert.match(script, /container\.addEventListener\('click', \(event\) => \{/);
});

test('own equipment uses the member\'s own identity/sectionId; a companion row uses the person\'s own identity/sectionId', () => {
  assert.match(script, /wireEquipmentMiniList\(document\.getElementById\('own-equipment'\), viewerEmail\.toLowerCase\(\), \(\) => ownerSectionId\)/);
  assert.match(script, /wireEquipmentMiniList\(row\.querySelector\('\.person-equipment'\), person\.personId, \(\) => person\.sectionId\)/);
});

test('a brand-new (unsaved) companion row has no equipment mini-list - there is no personId to attach items to yet', () => {
  const addPersonRow = script.match(/function addPersonRow\(container, person = null\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(addPersonRow);
  assert.match(addPersonRow, /\$\{person \? `[\s\S]*?person-equipment[\s\S]*?` : ''\}/);
});

test('CSS defines the mini-list item/list/delete-button classes referenced by the templates', () => {
  assert.match(css, /\.person-equipment-list\s*\{/);
  assert.match(css, /\.person-equipment-item\s*\{/);
  assert.match(css, /\.person-equipment-item \.person-equipment-delete\s*\{/);
});
