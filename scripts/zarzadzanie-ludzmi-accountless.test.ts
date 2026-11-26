import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const page = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url), 'utf8');
const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');
const companionAddSource = readFileSync(new URL('../public/shared/companion-add.js', import.meta.url), 'utf8');

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

test('accountless sortable headers use buttons and label the section button accessibly', () => {
  for (const key of ['section', 'name', 'status', 'weapons', 'owner', 'account']) {
    assert.match(page, new RegExp(`data-sort-key="${key}"[^>]*aria-sort="none"[^>]*><button type="button"`));
  }
  assert.match(page, /data-sort-key="section"[^>]*><button type="button" aria-label="Sekcja">S<\/button>/);
});

test('shared sortable-table wiring updates key, direction, and aria-sort on header clicks', () => {
  const source = readFileSync(new URL('../public/shared/sortable-table.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const headers = ['section', 'name'].map((sortKey) => ({
    dataset: { sortKey },
    setAttribute(name: string, value: string) { (this as any)[name] = value; },
  }));
  let clickHandler!: (event: any) => void;
  const table = {
    addEventListener: (_type: string, handler: (event: any) => void) => { clickHandler = handler; },
    querySelectorAll: () => headers,
  };
  let changes = 0;
  const state = context.initSortableTable(table, { defaultKey: 'section', onChange: () => { changes += 1; } });
  const nameButton = { closest: () => headers[1] };
  const clickName = () => clickHandler({ target: { closest: () => nameButton } });

  assert.equal(headers[0]['aria-sort'], 'ascending');
  clickName();
  assert.equal(state.key, 'name');
  assert.equal(state.dir, 'asc');
  assert.equal(headers[0]['aria-sort'], 'none');
  assert.equal(headers[1]['aria-sort'], 'ascending');
  clickName();
  assert.equal(state.dir, 'desc');
  assert.equal(headers[1]['aria-sort'], 'descending');
  assert.equal(changes, 2);
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

test('editing an accountless person keeps and labels its retired category in the form', async () => {
  const harness = createZarzadzanieHarness({
    apiFetch: async (url) => {
      if (url === '/lista-wyjazdowa/persons') return { persons: [] };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [{ id: 'retired', label: 'Gość', retired: true }], weapons: [] };
      if (url === '/admin/person-owners') return { owners: [] };
      return {};
    },
  });
  await harness.signIn({ email: 'ksiegowy@kruki.pl', isAccountant: true, isAdmin: false, isHovding: false });
  (harness.context.openAccountlessForm as (person: Record<string, unknown>) => void)({ personId: 'p1', categoryId: 'retired' });
  assert.equal(harness.getEl('accountless-category').value, 'retired');
  assert.match(harness.getEl('accountless-category').innerHTML, /Gość \(wycofany status\)/);
});

interface ZarzadzanieHarnessOptions {
  apiFetch: (url: string, init?: Record<string, unknown>) => Promise<unknown>;
  whoamiPayload?: Record<string, unknown>;
}

function createZarzadzanieHarness(options: ZarzadzanieHarnessOptions) {
  const elements = new Map<string, any>();
  const summaryFilterCallbacks: Array<() => void> = [];
  const sortableTableStates = new Map<string, { set: (key: string, dir: string) => void }>();
  let signedInCallback: ((payload: Record<string, unknown>) => Promise<void>) | null = null;
  let duplicatePromptMode: 'confirm' | 'cancel' = 'confirm';
  const cancelledDuplicate = Object.freeze({ cancelled: true });

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
      focusCount: 0,
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
      focus: () => { el.focusCount += 1; },
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
    PersonRegistrationPrompt: {
      run: async (execute: (confirmed: boolean) => Promise<unknown>, promptOptions: { fallbackFocus?: () => any } = {}) => {
        try { return await execute(false); } catch (error: any) {
          if (!Array.isArray(error?.duplicateMatches)) throw error;
          if (duplicatePromptMode === 'cancel') {
            promptOptions.fallbackFocus?.()?.focus();
            return cancelledDuplicate;
          }
          return execute(true);
        }
      },
      wasCancelled: (result: unknown) => result === cancelledDuplicate,
    },
    alert: () => {},
    location: { search: '' },
    addEventListener: () => {},
    MutationFeedback: { confirmed: async ({ execute, apply, skipApplyWhen, focusAfterApply }: { execute: () => Promise<any>; apply?: (result: any) => Promise<unknown>; skipApplyWhen?: (result: unknown) => boolean; focusAfterApply?: (result: unknown) => unknown }) => {
      const result = await execute();
      if (skipApplyWhen?.(result)) return result;
      await apply?.(result);
      focusAfterApply?.(result)?.focus?.();
      return result;
    } },
  };
  const documentObj: any = {
    body: { append: () => {} },
    getElementById: (id: string) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const sortableTableSource = readFileSync(new URL('../public/shared/sortable-table.js', import.meta.url), 'utf8');
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

  vm.runInContext(sortableTableSource, context);
  context.initSortableTable = (table: { id: string }, { defaultKey, defaultDir = 'asc', onChange }: { defaultKey: string; defaultDir?: string; onChange: () => void }) => {
    const state = {
      key: defaultKey,
      dir: defaultDir,
      set(key: string, dir: string) {
        state.key = key;
        state.dir = dir;
        onChange();
      },
    };
    sortableTableStates.set(table.id, state);
    return state;
  };
  vm.runInContext(displayNameSource, context);
  vm.runInContext(companionAddSource, context);
  vm.runInContext(profilePanelSource, context);
  vm.runInContext(script, context);

  return {
    context,
    getEl,
    triggerSummaryFilters: () => summaryFilterCallbacks.forEach((cb) => cb()),
    sortTable: (id: string, key: string, dir: string) => {
      const state = sortableTableStates.get(id);
      assert.ok(state, `sortable state for ${id} should be initialized`);
      state.set(key, dir);
    },
    cancelDuplicatePrompt: () => { duplicatePromptMode = 'cancel'; },
    signIn: async (payload = options.whoamiPayload ?? { email: 'ksiegowy@kruki.pl', isAccountant: true, isAdmin: false, isHovding: false }) => {
      assert.ok(signedInCallback, 'initGoogleSignIn must register onSignedIn');
      await signedInCallback(payload);
    },
  };
}

test('accountless table sorts names in both directions and breaks duplicate-name ties by person ID', async () => {
  const harness = createZarzadzanieHarness({
    apiFetch: async (url) => {
      if (url === '/lista-wyjazdowa/persons') {
        return {
          persons: [
            { personId: 'p2', firstName: 'Ada', lastName: 'Nowak', deleted: false },
            { personId: 'p3', firstName: 'Zofia', lastName: 'Kowalska', deleted: false },
            { personId: 'p1', firstName: 'Ada', lastName: 'Nowak', deleted: false },
          ],
        };
      }
      if (url === '/lista-wyjazdowa/sections') return { sections: [] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      return {};
    },
  });

  await harness.signIn({ email: 'admin@kruki.pl', isAccountant: false, isAdmin: true, isHovding: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rowPersonIds = () => [...harness.getEl('accountless-list').innerHTML.matchAll(/<tr data-person-id="([^"]+)"/g)].map((match) => match[1]);

  harness.sortTable('accountless-table', 'name', 'desc');
  assert.deepEqual(rowPersonIds(), ['p3', 'p1', 'p2']);

  harness.sortTable('accountless-table', 'name', 'asc');
  assert.deepEqual(rowPersonIds(), ['p1', 'p2', 'p3']);
});

test('accountless table sorts every value column by its displayed value', async () => {
  const harness = createZarzadzanieHarness({
    apiFetch: async (url) => {
      if (url === '/lista-wyjazdowa/persons') {
        return {
          persons: [
            { personId: 'p1', firstName: 'Zeta', lastName: 'North', sectionId: 'secA', categoryId: 'catB', weaponIds: ['wC'], ownerPersonId: 'owner-c', ownerName: 'Owner C', deleted: true },
            { personId: 'p2', firstName: 'Beta', lastName: 'South', sectionId: 'secC', categoryId: 'catA', weaponIds: ['wA'], ownerPersonId: 'owner-a', ownerName: 'Owner A', deleted: false },
            { personId: 'p3', firstName: 'Ada', lastName: 'West', sectionId: 'secB', categoryId: 'catC', weaponIds: ['wB'], ownerPersonId: 'owner-b', ownerName: 'Owner B', deleted: false },
          ],
        };
      }
      if (url === '/admin/lookup-lists') {
        return {
          sections: [{ id: 'secA', label: 'Alpha' }, { id: 'secB', label: 'Gamma' }, { id: 'secC', label: 'Zulu' }],
          categories: [{ id: 'catA', label: 'Niewiasta' }, { id: 'catB', label: 'Woj' }, { id: 'catC', label: 'Rycerz' }],
          weapons: [{ id: 'wA', label: 'Miecz' }, { id: 'wB', label: 'Tarcza' }, { id: 'wC', label: 'Włócznia' }],
        };
      }
      return {};
    },
  });

  await harness.signIn({ email: 'admin@kruki.pl', isAccountant: false, isAdmin: true, isHovding: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const expectedByKey: Record<string, string[]> = {
    section: ['p1', 'p3', 'p2'],
    name: ['p3', 'p2', 'p1'],
    status: ['p2', 'p3', 'p1'],
    weapons: ['p2', 'p3', 'p1'],
    owner: ['p2', 'p3', 'p1'],
    account: ['p3', 'p2', 'p1'],
  };
  const rowPersonIds = () => [...harness.getEl('accountless-list').innerHTML.matchAll(/<tr data-person-id="([^"]+)"/g)].map((match) => match[1]);

  for (const [key, expected] of Object.entries(expectedByKey)) {
    harness.sortTable('accountless-table', key, 'asc');
    assert.deepEqual(rowPersonIds(), expected, `column ${key} should sort by its displayed value`);
  }
});

test('accountants can load the accountless table without rendering its write actions', async () => {
  const apiCalls: Array<{ url: string; method: string; body?: string }> = [];
  const harness = createZarzadzanieHarness({
    apiFetch: async (url, init = {}) => {
      apiCalls.push({ url, method: String(init.method ?? 'GET'), body: init.body as string | undefined });
      if (url === '/lista-wyjazdowa/persons' && init.method === 'POST') return { person: { personId: 'p2' } };
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
  assert.equal(harness.getEl('accountless-error').hidden, true, 'successful creation must not hide a missing shared category helper');
  assert.equal(harness.getEl('accountless-form-panel').hidden, true, 'successful creation closes the form');
});

test('admin accountless registration cancels without a second request or losing form values', async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const harness = createZarzadzanieHarness({
    apiFetch: async (url, init = {}) => {
      requests.push({ url, method: String(init.method ?? 'GET'), body: init.body as string | undefined });
      if (url === '/lista-wyjazdowa/persons' && init.method === 'POST') {
        throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Anna', lastName: 'Nowak' }] });
      }
      if (url === '/lista-wyjazdowa/persons') return { persons: [] };
      if (url === '/lista-wyjazdowa/sections') return { sections: [{ id: 'sec1', label: 'Drużyna' }] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [{ id: 'woj', label: 'Woj' }] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      if (url === '/lista-wyjazdowa/roster') return { roster: [] };
      return {};
    },
  });
  await harness.signIn({ email: 'admin@kruki.pl', isAccountant: true, isAdmin: true, isHovding: false });
  await harness.getEl('accountless-add-toggle').dispatch('click');
  harness.cancelDuplicatePrompt();
  harness.getEl('accountless-first-name').value = 'Anna';
  harness.getEl('accountless-last-name').value = 'Nowak';
  harness.getEl('accountless-category').value = 'woj';
  harness.getEl('accountless-section-select').value = 'sec1';
  await harness.getEl('accountless-save').dispatch('click');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(harness.getEl('accountless-form-panel').hidden, false);
  assert.equal(harness.getEl('accountless-first-name').value, 'Anna');
  assert.equal(harness.getEl('accountless-error').hidden, true);
  assert.equal(harness.getEl('accountless-ksywka').focusCount, 1);
});

test('accountless row mutations restore focus to a surviving control after the row is re-rendered', async () => {
  const harness = createZarzadzanieHarness({ apiFetch: async () => ({}) });
  const detachedRowAction = { isConnected: false, focusCount: 0, focus() { this.focusCount += 1; } };
  await (harness.context.runAccountlessMutation as (control: unknown, execute: () => Promise<unknown>, refresh: boolean) => Promise<unknown>)(
    detachedRowAction,
    async () => ({}),
    false,
  );
  assert.equal(harness.getEl('accountless-add-toggle').focusCount, 1);
});

test('admin accountless registration retries with duplicateConfirmed after the prompt confirmation', async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const harness = createZarzadzanieHarness({
    apiFetch: async (url, init = {}) => {
      requests.push({ url, method: String(init.method ?? 'GET'), body: init.body as string | undefined });
      if (url === '/lista-wyjazdowa/persons' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (!body.duplicateConfirmed) throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Anna', lastName: 'Nowak' }] });
        return { person: { personId: 'new-person' } };
      }
      if (url === '/lista-wyjazdowa/persons') return { persons: [] };
      if (url === '/lista-wyjazdowa/sections') return { sections: [{ id: 'sec1', label: 'Drużyna' }] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [{ id: 'woj', label: 'Woj' }] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      if (url === '/lista-wyjazdowa/roster') return { roster: [] };
      return {};
    },
  });
  await harness.signIn({ email: 'admin@kruki.pl', isAccountant: true, isAdmin: true, isHovding: false });
  await harness.getEl('accountless-add-toggle').dispatch('click');
  harness.getEl('accountless-first-name').value = 'Anna';
  harness.getEl('accountless-last-name').value = 'Nowak';
  harness.getEl('accountless-category').value = 'woj';
  harness.getEl('accountless-section-select').value = 'sec1';
  await harness.getEl('accountless-save').dispatch('click');
  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(String(posts[1].body)).duplicateConfirmed, true);
  assert.equal(harness.getEl('accountless-error').hidden, true);
  assert.equal(harness.getEl('accountless-form-panel').hidden, true);
});

test('admin accountless registration ignores a second submit while the first request is in flight', async () => {
  let finishPost!: (value: unknown) => void;
  let postCount = 0;
  const harness = createZarzadzanieHarness({
    apiFetch: async (url, init = {}) => {
      if (url === '/lista-wyjazdowa/persons' && init.method === 'POST') {
        postCount += 1;
        return new Promise((resolve) => { finishPost = resolve; });
      }
      if (url === '/lista-wyjazdowa/persons') return { persons: [] };
      if (url === '/lista-wyjazdowa/sections') return { sections: [{ id: 'sec1', label: 'Drużyna' }] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [{ id: 'woj', label: 'Woj' }] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      return {};
    },
  });
  await harness.signIn({ email: 'admin@kruki.pl', isAccountant: true, isAdmin: true, isHovding: false });
  await harness.getEl('accountless-add-toggle').dispatch('click');
  harness.getEl('accountless-first-name').value = 'Anna';
  harness.getEl('accountless-last-name').value = 'Nowak';
  harness.getEl('accountless-category').value = 'woj';
  harness.getEl('accountless-section-select').value = 'sec1';

  const firstSubmit = (harness.context.submitAccountlessForm as () => Promise<void>)();
  assert.equal(harness.getEl('accountless-save').disabled, true);
  await (harness.context.submitAccountlessForm as () => Promise<void>)();
  assert.equal(postCount, 1);
  finishPost({ person: { personId: 'new-person' } });
  await firstSubmit;
  assert.equal(harness.getEl('accountless-save').disabled, false);
});

test('admin accountless registration ignores a second submit while the confirmed retry is in flight', async () => {
  let finishRetry!: (value: unknown) => void;
  const posts: Array<Record<string, unknown>> = [];
  const harness = createZarzadzanieHarness({
    apiFetch: async (url, init = {}) => {
      if (url === '/lista-wyjazdowa/persons' && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (!body.duplicateConfirmed) throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Anna', lastName: 'Nowak' }] });
        return new Promise((resolve) => { finishRetry = resolve; });
      }
      if (url === '/lista-wyjazdowa/persons') return { persons: [] };
      if (url === '/lista-wyjazdowa/sections') return { sections: [{ id: 'sec1', label: 'Drużyna' }] };
      if (url === '/lista-wyjazdowa/categories') return { categories: [{ id: 'woj', label: 'Woj' }] };
      if (url === '/lista-wyjazdowa/weapons') return { weapons: [] };
      return {};
    },
  });
  await harness.signIn({ email: 'admin@kruki.pl', isAccountant: true, isAdmin: true, isHovding: false });
  await harness.getEl('accountless-add-toggle').dispatch('click');
  harness.getEl('accountless-first-name').value = 'Anna';
  harness.getEl('accountless-last-name').value = 'Nowak';
  harness.getEl('accountless-category').value = 'woj';
  harness.getEl('accountless-section-select').value = 'sec1';

  const firstSubmit = (harness.context.submitAccountlessForm as () => Promise<void>)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts.length, 2);
  await (harness.context.submitAccountlessForm as () => Promise<void>)();
  assert.equal(posts.length, 2);
  finishRetry({ person: { personId: 'new-person' } });
  await firstSubmit;
  assert.equal(harness.getEl('accountless-save').disabled, false);
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
