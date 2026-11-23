import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

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
});

interface ZarzadzanieHarnessOptions {
  apiFetch: (url: string, init?: Record<string, unknown>) => Promise<unknown>;
  whoamiPayload?: Record<string, unknown>;
}

function createZarzadzanieHarness(options: ZarzadzanieHarnessOptions) {
  const elements = new Map<string, any>();
  const summaryFilterCallbacks: Array<() => void> = [];
  let signedInCallback: ((payload: Record<string, unknown>) => Promise<void>) | null = null;

  function makeElement(id: string) {
    const listeners = new Map<string, Array<(e: any) => unknown>>();
    const el: any = {
      id,
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      innerHTML: '',
      textContent: '',
      dataset: {} as Record<string, string>,
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      closest: () => makeElement(`${id}__closest`),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type: string, fn: (e: any) => unknown) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      dispatch: async (type: string, event: Record<string, unknown> = {}) => {
        for (const fn of listeners.get(type) ?? []) {
          await fn({ preventDefault: () => {}, target: el, ...event });
        }
      },
      focus: () => {},
      scrollIntoView: () => {},
    };
    return el;
  }

  function getEl(id: string) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  }

  const windowObj: any = {
    confirm: () => true,
    alert: () => {},
    location: { search: '' },
    addEventListener: () => {},
    MutationFeedback: { confirmed: async ({ execute }: { execute: () => Promise<unknown> }) => execute() },
  };
  const documentObj: any = {
    body: { append: () => {} },
    getElementById: (id: string) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const profilePanelSource = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    initGoogleSignIn: (cfg: { onSignedIn: (payload: Record<string, unknown>) => Promise<void> }) => {
      signedInCallback = cfg.onSignedIn;
    },
    apiFetch: options.apiFetch,
    showReauth: () => {},
    hideReauth: () => {},
    escapeHtml: (s: unknown) => String(s ?? ''),
    escapeAttr: (s: unknown) => String(s ?? ''),
    formatDateTime: (s: unknown) => String(s ?? ''),
    sheetSyncStatusMessage: () => '',
    MutationFeedback: { confirmed: async ({ execute }: { execute: () => Promise<unknown> }) => execute() },
    wireSummaryFilter: (_el: unknown, _filter: unknown, onChange: () => void) => {
      summaryFilterCallbacks.push(onChange);
    },
    initSortableTable: () => ({ sortKey: null, sortDir: 'asc' }),
    LIST_PREFERENCE_KEYS: { adminSummaryFilter: 'adminSummaryFilter' },
    createSummaryFilter: () => ({}),
    renderSummaryFilter: () => '',
    summaryFilterColumns: () => '',
    summaryFilterMatches: () => true,
    summaryFilterPrune: () => {},
    summaryFilterChipHtml: () => '',
    summaryFilterBlockHtml: () => '',
    categoryPillBroccoliIconHtml: () => '',
    sectionAbbr: (s: string) => s,
    personSubline: () => '',
    personPillHtml: ({ name }: { name: string }) => name,
    filterRowsBySummary: (rows: unknown[]) => rows,
    duesStatusLabel: (s: string) => s,
    duesStatusBadgeHtml: (s: string) => s,
  });

  vm.runInContext(profilePanelSource, context);
  vm.runInContext(script, context);

  return {
    context,
    getEl,
    triggerSummaryFilters: () => summaryFilterCallbacks.forEach((cb) => cb()),
    signIn: async (payload = options.whoamiPayload ?? { email: 'ksiegowy@kruki.pl', isAccountant: true, isAdmin: false, isHovding: false }) => {
      assert.ok(signedInCallback, 'initGoogleSignIn must register onSignedIn');
      await signedInCallback(payload);
    },
  };
}

test('accountants can load the accountless table without rendering its write actions', async () => {
  const apiCalls: Array<{ url: string; method: string; body?: string }> = [];
  const harness = createZarzadzanieHarness({
    apiFetch: async (url, init = {}) => {
      apiCalls.push({ url, method: String(init.method ?? 'GET'), body: init.body as string | undefined });
      if (url === '/lista-wyjazdowa/persons') {
        return {
          persons: [
            {
              personId: 'p1',
              firstName: 'Jan',
              lastName: 'Kowalski',
              nickname: 'Janek',
              sectionId: 'sec1',
              categoryId: 'woj',
              weaponIds: ['tarczownik'],
              ownerPersonId: 'owner@kruki.pl',
              ownerName: 'Opiekun',
              deleted: false,
            },
          ],
        };
      }
      if (url === '/lista-wyjazdowa/sections') return { sections: [{ id: 'sec1', label: 'Drużyna' }] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [{ id: 'woj', label: 'Woj' }, { id: 'niewiasta', label: 'Niewiasta' }] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [{ id: 'tarczownik', label: 'Tarcza' }] };
      if (url === '/lista-wyjazdowa/roster') return { roster: [{ personId: 'owner@kruki.pl', kind: 'account', name: 'Opiekun', email: 'owner@kruki.pl' }] };
      if (url === '/lista-wyjazdowa/persons' && init.method === 'POST') return { person: { personId: 'p2' } };
      return {};
    },
  });

  await harness.signIn({ email: 'ksiegowy@kruki.pl', isAccountant: true, isAdmin: false, isHovding: false });
  // Allow background loadAccountless() promise started by onSignedIn to settle.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(harness.getEl('accountless-records-section').hidden, false);
  const rowsHtml = harness.getEl('accountless-list').innerHTML;
  assert.match(rowsHtml, /Kowalski/);
  assert.doesNotMatch(rowsHtml, /accountless-edit/);
  assert.doesNotMatch(rowsHtml, /accountless-detach/);
  assert.doesNotMatch(rowsHtml, /accountless-deactivate/);
  assert.doesNotMatch(rowsHtml, /accountless-purge/);

  // Accountant can submit the add form for an attached person.
  harness.getEl('accountless-first-name').value = 'Anna';
  harness.getEl('accountless-last-name').value = 'Nowak';
  harness.getEl('accountless-category').value = 'woj';
  harness.getEl('accountless-section-select').value = 'sec1';
  harness.getEl('accountless-owner').value = 'owner@kruki.pl';
  await harness.getEl('accountless-save').dispatch('click');

  const postCall = apiCalls.find((c) => c.url === '/lista-wyjazdowa/persons' && c.method === 'POST');
  assert.ok(postCall, 'accountant submission should POST to /lista-wyjazdowa/persons');
});

test('accountless summary filter preserves loading and error rows until the table has loaded', async () => {
  let rejectPersons!: (err: Error) => void;
  const harness = createZarzadzanieHarness({
    apiFetch: async (url) => {
      if (url === '/lista-wyjazdowa/persons') {
        return new Promise((_resolve, reject) => { rejectPersons = reject; });
      }
      if (url === '/lista-wyjazdowa/sections') return { sections: [] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      return {};
    },
  });

  const loadPromise = harness.context.loadAccountless();
  assert.match(harness.getEl('accountless-list').innerHTML, /Ładowanie\.\.\./);
  assert.equal(harness.getEl('accountless-summary-filter').innerHTML, '');

  // Triggering summary filter while loading must not clear the loading row.
  harness.triggerSummaryFilters();
  assert.match(harness.getEl('accountless-list').innerHTML, /Ładowanie\.\.\./);

  rejectPersons(new Error('network down'));
  await loadPromise;
  assert.match(harness.getEl('accountless-list').innerHTML, /Błąd: network down/);

  // Triggering summary filter after error must not overwrite the error row.
  harness.triggerSummaryFilters();
  assert.match(harness.getEl('accountless-list').innerHTML, /Błąd: network down/);
});

test('accountless table load preserves in-progress form and creation-options refresh respects load state', async () => {
  let resolvePersons!: (val: unknown) => void;
  const optionsResolvers: Array<(val: unknown) => void> = [];
  const harness = createZarzadzanieHarness({
    apiFetch: async (url) => {
      if (url === '/lista-wyjazdowa/persons') {
        return new Promise((resolve) => { resolvePersons = resolve; });
      }
      if (url === '/lista-wyjazdowa/sections') {
        return new Promise((resolve) => { optionsResolvers.push(resolve); });
      }
      if (url === '/lista-wyjazdowa/categories') return { categories: [{ id: 'woj', label: 'Woj' }] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      if (url === '/lista-wyjazdowa/roster') return { roster: [] };
      return {};
    },
  });

  // Start both loadAccountless() and loadAccountlessCreationOptions().
  const loadPromise = harness.context.loadAccountless();
  const optionsPromise = harness.context.loadAccountlessCreationOptions();

  // While persons table is still loading, creation options finishing must not overwrite the loading row.
  for (const resolve of optionsResolvers) resolve({ sections: [{ id: 'sec1', label: 'Drużyna' }] });
  await optionsPromise;
  assert.match(harness.getEl('accountless-list').innerHTML, /Ładowanie\.\.\./);

  // Set in-progress form value before loadAccountless() finishes; reloading the table must not reset it.
  harness.getEl('accountless-first-name').value = 'InProgressName';
  resolvePersons({
    persons: [
      { personId: 'p1', firstName: 'Jan', lastName: 'Kowalski', sectionId: 'sec1', categoryId: 'woj', weaponIds: [], deleted: false },
    ],
  });
  await loadPromise;
  assert.equal(harness.getEl('accountless-first-name').value, 'InProgressName');
  assert.match(harness.getEl('accountless-list').innerHTML, /Kowalski/);
});
