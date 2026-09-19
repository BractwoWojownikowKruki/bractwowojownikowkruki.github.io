import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sprzet-obozowy/sprzet-obozowy.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/sprzet-obozowy/index.html', import.meta.url), 'utf8');
const personPillSource = readFileSync(new URL('../public/shared/person-pill.js', import.meta.url), 'utf8');
const sortableTableSource = readFileSync(new URL('../public/shared/sortable-table.js', import.meta.url), 'utf8');
const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');

// Same minimal DOM stub shape as scripts/lista-wyjazdowa-roster.test.ts's harness - the page's
// delegated click handlers only read closest(...)/dataset off the event target and getElementById
// off `document`, so a real DOM tree is never needed to drive them.
class Element {
  id: string;
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  private listeners = new Map<string, Array<(event: any) => unknown>>();

  constructor(id: string) { this.id = id; }
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async click() {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target: this })));
  }
  async clickWith(target: unknown) {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target })));
  }
  async change() {
    await Promise.all((this.listeners.get('change') ?? []).map((listener) => listener({ target: this })));
  }
  async input() {
    await Promise.all((this.listeners.get('input') ?? []).map((listener) => listener({ target: this })));
  }
  async submit() {
    await Promise.all((this.listeners.get('submit') ?? []).map((listener) => listener({ target: this, preventDefault: () => {} })));
  }
  reset() { this.value = ''; }
  focus() {}
  querySelectorAll() { return []; }
}

const elementIds = [
  'sprzet-checking', 'signed-out-panel', 'forbidden-panel', 'main-content',
  'equipment-add-toggle', 'equipment-add-form', 'equipment-add-cancel', 'equipment-add-submit', 'equipment-add-error',
  'equipment-add-editing-id', 'equipment-add-category', 'equipment-add-section',
  'equipment-owner-mode-team', 'equipment-owner-mode-private', 'equipment-add-owner-wrap', 'equipment-add-owner',
  'equipment-owner-datalist', 'equipment-add-description',
  'equipment-team-table', 'equipment-team-table-body', 'equipment-private-table', 'equipment-private-table-body',
  'equipment-tables',
];

const equipmentCategories = [{ id: 'namiot', label: 'Namiot', retired: false }];
const sections = [
  { id: 'krakow', label: 'Kraków', retired: false },
  { id: 'warszawa', label: 'Warszawa', retired: false },
];

const teamItem = { id: 'eq-team-1', categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'Namiot 4-osobowy', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'ala@example.com', canEdit: true, canDelete: true };
const privateItem = { id: 'eq-private-1', categoryId: 'namiot', sectionId: 'warszawa', belongsToPersonId: 'person-uuid-1', description: 'Namiot 2-osobowy', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'ala@example.com', canEdit: true, canDelete: true };

function createHarness() {
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  // Mirrors index.html's defaults: the add form and the owner field start hidden, and Drużyna
  // starts selected - applyMode() only runs on a 'change' event, so without this the harness
  // would start in a state the real page (HTML `hidden`/`checked` attributes) never actually has.
  elements.get('equipment-add-form')!.hidden = true;
  elements.get('equipment-add-owner-wrap')!.hidden = true;
  elements.get('equipment-owner-mode-team')!.checked = true;
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = null;
  let mutationError: Error | null = null;
  let signIn: (() => Promise<void>) | undefined;

  const members = [
    { email: 'ala@example.com', fullName: 'Ala Kowalska', nickname: null, sectionId: 'krakow', sectionLabel: 'Kraków', categoryId: 'wojownik', categoryLabel: 'Wojownik' },
  ];
  const roster = [
    { personId: 'ala@example.com', accountless: false, email: 'ala@example.com', fullName: 'Ala Kowalska', nickname: null, sectionId: 'krakow', categoryId: 'wojownik' },
    { personId: 'person-uuid-1', accountless: true, email: null, fullName: 'Młody', nickname: null, sectionId: 'warszawa', categoryId: 'kandydat' },
  ];

  const context: Record<string, unknown> = {
    URLSearchParams,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Date,
    encodeURIComponent,
    window: {
      confirm: () => true,
      alert: () => {},
      MutationFeedback: {
        confirmed: async ({ execute, apply, rollback }: { execute: () => Promise<unknown>; apply: (result: unknown) => void; rollback?: (error: unknown) => unknown }) => {
          let result: unknown;
          try {
            result = await execute();
          } catch (error) {
            if (rollback) await rollback(error);
            throw error;
          }
          await apply(result);
        },
      },
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    },
    apiFetch: async (url: string, options: Record<string, unknown> = {}) => {
      apiCalls.push({ url, options });
      if (options.method === 'PUT' || options.method === 'POST' || options.method === 'DELETE') {
        if (mutationError) throw mutationError;
        return mutationResult;
      }
      if (url === '/equipment') return { equipment: [teamItem, privateItem] };
      if (url === '/members/directory') return { members };
      if (url === '/lista-wyjazdowa/roster') return { roster };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections, categories: [], weapons: [], equipmentCategories };
      throw new Error(`unexpected request: ${url}`);
    },
    initGoogleSignIn: (config: { onSignedIn: () => Promise<void> }) => { signIn = config.onSignedIn; },
  };
  vm.runInNewContext(sortableTableSource, context, { filename: 'sortable-table.js' });
  vm.runInNewContext(displayNameSource, context, { filename: 'display-name.js' });
  vm.runInNewContext(personPillSource, context, { filename: 'person-pill.js' });
  vm.runInNewContext(source, context, { filename: 'sprzet-obozowy.js' });
  return {
    context,
    elements,
    apiCalls,
    async signIn() { await signIn?.(); },
    setMutationResult(result: unknown) { mutationResult = result; mutationError = null; },
    setMutationError(error: Error) { mutationError = error; },
  };
}

test('the page wires up the shared script include order and reuses sortable-table.js/person-pill.js', () => {
  assert.match(indexHtml, /shared\/sortable-table\.js/);
  assert.match(indexHtml, /shared\/person-pill\.js/);
  assert.match(indexHtml, /shared\/profile-panel\.js/);
  assert.match(source, /personPillHtml\(/);
  assert.match(source, /data-profile-trigger/);
});

test('splitEquipmentByOwnership groups by belongsToPersonId, null meaning drużyna/team-owned', () => {
  const harness = createHarness();
  const splitEquipmentByOwnership = harness.context.splitEquipmentByOwnership as (items: unknown[]) => { team: unknown[]; private: unknown[] };
  const { team, private: privateItems } = splitEquipmentByOwnership([teamItem, privateItem]);
  assert.deepEqual(team, [teamItem]);
  assert.deepEqual(privateItems, [privateItem]);
});

test('splitEquipmentByOwnership returns empty groups for an empty list', () => {
  const harness = createHarness();
  const splitEquipmentByOwnership = harness.context.splitEquipmentByOwnership as (items: unknown[]) => { team: unknown[]; private: unknown[] };
  // Compared by length, not assert.deepEqual against a literal {team:[],private:[]}: the function
  // runs inside the vm sandbox's own realm, so an empty array/object it builds internally is not
  // reference-equal to one built in this file's (host) realm even when structurally identical.
  const result = splitEquipmentByOwnership([]);
  assert.equal(result.team.length, 0);
  assert.equal(result.private.length, 0);
});

test('filterOwnerCandidates matches by displayName substring, case- and locale-insensitively, and returns nothing for a blank query', () => {
  const harness = createHarness();
  const filterOwnerCandidates = harness.context.filterOwnerCandidates as (roster: unknown[], query: string) => unknown[];
  const roster = [
    { fullName: 'Ala Kowalska', nickname: null, email: 'ala@example.com' },
    { fullName: 'Młody', nickname: null, email: null },
  ];
  // Same cross-realm caveat as above: compare by length, not against a host-realm [] literal.
  assert.equal(filterOwnerCandidates(roster, '').length, 0);
  assert.equal(filterOwnerCandidates(roster, '   ').length, 0);
  assert.deepEqual(filterOwnerCandidates(roster, 'ala'), [roster[0]]);
  assert.deepEqual(filterOwnerCandidates(roster, 'MŁODY'), [roster[1]]);
  assert.deepEqual(filterOwnerCandidates(roster, 'kowal'), [roster[0]]);
  assert.deepEqual(filterOwnerCandidates(roster, 'nikt-taki'), []);
});

test('signing in loads both endpoints and splits equipment into the team and private tables', async () => {
  const harness = createHarness();
  await harness.signIn();
  const teamBody = harness.elements.get('equipment-team-table-body')!;
  const privateBody = harness.elements.get('equipment-private-table-body')!;
  assert.match(teamBody.innerHTML, /Namiot 4-osobowy/);
  assert.doesNotMatch(teamBody.innerHTML, /Namiot 2-osobowy/);
  assert.match(privateBody.innerHTML, /Namiot 2-osobowy/);
  assert.doesNotMatch(privateBody.innerHTML, /Namiot 4-osobowy/);
});

test('the private table renders the owner as a person pill wired to the shared profile panel, marking an accountless owner', async () => {
  const harness = createHarness();
  await harness.signIn();
  const privateBody = harness.elements.get('equipment-private-table-body')!;
  assert.match(privateBody.innerHTML, /data-profile-trigger/);
  assert.match(privateBody.innerHTML, /data-person-id="person-uuid-1"/);
  assert.match(privateBody.innerHTML, /person-pill-icon/, 'the accountless owner carries the "osoba bez konta" marker');
  assert.match(privateBody.innerHTML, />Młody</);
});

test('an unresolved owner (e.g. a purged person) falls back to the raw id instead of being hidden', async () => {
  const harness = createHarness();
  harness.context.apiFetch = async (url: string, options: Record<string, unknown> = {}) => {
    if (url === '/equipment') return { equipment: [{ ...privateItem, belongsToPersonId: 'gone-uuid' }] };
    if (url === '/members/directory') return { members: [] };
    if (url === '/lista-wyjazdowa/roster') return { roster: [] };
    if (url === '/lista-wyjazdowa/lookup-lists') return { sections, categories: [], weapons: [], equipmentCategories };
    throw new Error(`unexpected request: ${url}`);
  };
  await harness.signIn();
  const privateBody = harness.elements.get('equipment-private-table-body')!;
  assert.match(privateBody.innerHTML, /gone-uuid/);
});

test('empty equipment lists render the "brak" placeholder row in each table', async () => {
  const harness = createHarness();
  harness.context.apiFetch = async (url: string, options: Record<string, unknown> = {}) => {
    if (url === '/equipment') return { equipment: [] };
    if (url === '/members/directory') return { members: [] };
    if (url === '/lista-wyjazdowa/roster') return { roster: [] };
    if (url === '/lista-wyjazdowa/lookup-lists') return { sections, categories: [], weapons: [], equipmentCategories };
    throw new Error(`unexpected request: ${url}`);
  };
  await harness.signIn();
  assert.match(harness.elements.get('equipment-team-table-body')!.innerHTML, /Brak sprzętu drużynowego/);
  assert.match(harness.elements.get('equipment-private-table-body')!.innerHTML, /Brak sprzętu prywatnego/);
});

test('switching the add form to Prywatny reveals the owner field, and picking a known owner auto-fills and disables Sekcja', async () => {
  const harness = createHarness();
  await harness.signIn();
  const ownerWrap = harness.elements.get('equipment-add-owner-wrap')!;
  const teamRadio = harness.elements.get('equipment-owner-mode-team')!;
  const privateRadio = harness.elements.get('equipment-owner-mode-private')!;
  const ownerInput = harness.elements.get('equipment-add-owner')!;
  const sectionSelect = harness.elements.get('equipment-add-section')!;

  assert.equal(ownerWrap.hidden, true, 'team mode starts with the owner field hidden');

  teamRadio.checked = false;
  privateRadio.checked = true;
  await privateRadio.change();
  assert.equal(ownerWrap.hidden, false, 'switching to Prywatny reveals the owner field');
  assert.equal(sectionSelect.disabled, false, 'Sekcja stays editable until an owner is actually picked');

  ownerInput.value = 'Młody';
  await ownerInput.input();
  assert.equal(sectionSelect.disabled, true, 'Sekcja is disabled once a known owner is picked');
  assert.equal(sectionSelect.value, 'warszawa', "Sekcja auto-fills from the owner's own sectionId");
  const datalist = harness.elements.get('equipment-owner-datalist')!;
  assert.match(datalist.innerHTML, /Młody/, 'typing narrows the datalist to the matching candidate');
  assert.doesNotMatch(datalist.innerHTML, /Ala Kowalska/, 'typing narrows the datalist away from non-matching candidates');

  ownerInput.value = 'nikt taki';
  await ownerInput.input();
  assert.equal(sectionSelect.disabled, false, 'an unresolved owner re-enables Sekcja');
  assert.equal(datalist.innerHTML, '', 'no match narrows the datalist down to nothing');

  teamRadio.checked = true;
  privateRadio.checked = false;
  await teamRadio.change();
  assert.equal(ownerWrap.hidden, true, 'switching back to Drużyna hides the owner field');
  assert.equal(sectionSelect.disabled, false, 'switching back to Drużyna re-enables Sekcja');
  assert.equal(ownerInput.value, '', 'switching back to Drużyna clears the owner field');
});

test('adding a team item posts to /equipment with belongsToPersonId null and appends it to the team table', async () => {
  const harness = createHarness();
  await harness.signIn();
  const categorySelect = harness.elements.get('equipment-add-category')!;
  const sectionSelect = harness.elements.get('equipment-add-section')!;
  const description = harness.elements.get('equipment-add-description')!;
  categorySelect.value = 'namiot';
  sectionSelect.value = 'krakow';
  description.value = 'Nowy namiot';
  const newItem = { id: 'eq-team-2', categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'Nowy namiot', createdAt: '2026-01-02T00:00:00.000Z', createdBy: 'ala@example.com', canEdit: true, canDelete: true };
  harness.setMutationResult({ equipment: newItem });

  await harness.elements.get('equipment-add-form')!.submit();

  const post = harness.apiCalls.find((call) => call.url === '/equipment' && call.options.method === 'POST');
  assert.deepEqual(JSON.parse(String(post?.options.body)), { categoryId: 'namiot', sectionId: 'krakow', description: 'Nowy namiot', belongsToPersonId: null });
  assert.match(harness.elements.get('equipment-team-table-body')!.innerHTML, /Nowy namiot/);
});

// Regression test (review finding, task-3 fix round): neither POST nor PUT /equipment's response
// carries canEdit/canDelete - only GET /equipment's list handler synthesizes them (server.ts's
// handleListEquipment, always true). Without locally merging { canEdit: true, canDelete: true }
// onto the saved item before pushing/replacing it in `equipment`, a freshly-added (or just-edited)
// item would render with no edit/delete buttons (equipmentActionsHtml gates both on
// item.canEdit/item.canDelete) until the page reloads.
test('a freshly-added item gets working edit/delete buttons immediately, even though the mutation response omits canEdit/canDelete', async () => {
  const harness = createHarness();
  await harness.signIn();
  const categorySelect = harness.elements.get('equipment-add-category')!;
  const sectionSelect = harness.elements.get('equipment-add-section')!;
  const description = harness.elements.get('equipment-add-description')!;
  categorySelect.value = 'namiot';
  sectionSelect.value = 'krakow';
  description.value = 'Bez uprawnień w odpowiedzi';
  // Mirrors the real server response shape (server.ts's handleAddEquipment/handleUpdateEquipment):
  // no canEdit/canDelete fields at all.
  harness.setMutationResult({ equipment: { id: 'eq-team-3', categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'Bez uprawnień w odpowiedzi', createdAt: '2026-01-03T00:00:00.000Z', createdBy: 'ala@example.com' } });

  await harness.elements.get('equipment-add-form')!.submit();

  const teamBody = harness.elements.get('equipment-team-table-body')!;
  assert.match(teamBody.innerHTML, /Bez uprawnień w odpowiedzi/);
  assert.match(teamBody.innerHTML, /data-edit-id="eq-team-3"/, 'the freshly-added item must render its edit button right away, not only after a reload');
  assert.match(teamBody.innerHTML, /data-delete-id="eq-team-3"/, 'the freshly-added item must render its delete button right away, not only after a reload');
});

test('submitting Prywatny mode without picking a real owner is rejected client-side with no request sent', async () => {
  const harness = createHarness();
  await harness.signIn();
  harness.elements.get('equipment-owner-mode-team')!.checked = false;
  harness.elements.get('equipment-owner-mode-private')!.checked = true;
  harness.elements.get('equipment-add-owner')!.value = 'ktoś kogo nie ma';
  harness.elements.get('equipment-add-category')!.value = 'namiot';
  harness.elements.get('equipment-add-section')!.value = 'krakow';

  const before = harness.apiCalls.length;
  await harness.elements.get('equipment-add-form')!.submit();

  assert.equal(harness.apiCalls.length, before, 'no request is sent when the owner text does not resolve to a real person');
  assert.equal(harness.elements.get('equipment-add-error')!.hidden, false);
});

test('deleting an item sends DELETE with its id and removes it from its table', async () => {
  const harness = createHarness();
  await harness.signIn();
  harness.setMutationResult({});

  await harness.elements.get('equipment-tables')!.clickWith({
    closest: (selector: string) => (selector === '[data-delete-id]' ? { dataset: { deleteId: 'eq-team-1' } } : null),
  });

  const del = harness.apiCalls.find((call) => call.options.method === 'DELETE');
  assert.equal(del?.url, '/equipment?id=eq-team-1');
  assert.doesNotMatch(harness.elements.get('equipment-team-table-body')!.innerHTML, /Namiot 4-osobowy/);
});
