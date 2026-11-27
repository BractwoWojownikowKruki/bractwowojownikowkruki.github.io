import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const styles = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const adminScript = readFileSync(new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url), 'utf8');
const profileScript = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');
const profilePanel = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');
const duesStatusSource = readFileSync(new URL('../public/shared/dues-status.js', import.meta.url), 'utf8');

function makeStubElement(id = '') {
  const listeners = new Map<string, Array<(e: any) => unknown>>();
  const childrenBySelector = new Map<string, any[]>();
  return {
    id,
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    href: '',
    innerHTML: '',
    textContent: '',
    dataset: {} as Record<string, string>,
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    closest: () => makeStubElement(`${id}__closest`),
    querySelector: () => null,
    querySelectorAll: (sel: string) => childrenBySelector.get(sel) ?? [],
    setQuerySelectorAll: (sel: string, items: any[]) => childrenBySelector.set(sel, items),
    addEventListener: (type: string, fn: (e: any) => unknown) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatch: async (type: string, event: Record<string, unknown> = {}) => {
      for (const fn of listeners.get(type) ?? []) {
        await fn({ preventDefault: () => {}, target: {}, ...event });
      }
    },
    focus: () => {},
    scrollIntoView: () => {},
  };
}

test('shared field text-input styles exclude checkboxes', () => {
  assert.match(styles, /\.field input:not\(\[type="checkbox"\]\)/);
});

test('accountless and member weapon controls are hidden for non-combat categories', async () => {
  // 1. zarzadzanie-ludzmi.js: updateAccountlessWeaponState & weaponCheckboxesHtml
  const adminElements = new Map<string, any>();
  const getAdminEl = (id: string) => {
    if (!adminElements.has(id)) adminElements.set(id, makeStubElement(id));
    return adminElements.get(id);
  };
  const weaponCb = { checked: true, value: 'tarczownik' };
  getAdminEl('accountless-weapons').setQuerySelectorAll('.accountless-weapon-checkbox', [weaponCb]);

  const adminCtx = vm.createContext({
    window: { confirm: () => true, alert: () => {}, location: { search: '' }, addEventListener: () => {} },
    document: { body: { append: () => {} }, getElementById: getAdminEl, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    console,
    URLSearchParams,
    initGoogleSignIn: () => {},
    apiFetch: async () => ({}),
    showReauth: () => {},
    hideReauth: () => {},
    escapeHtml: (s: unknown) => String(s ?? ''),
    escapeAttr: (s: unknown) => String(s ?? ''),
    formatDateTime: (s: unknown) => String(s ?? ''),
    sheetSyncStatusMessage: () => '',
    MutationFeedback: { confirmed: async ({ execute }: { execute: () => Promise<unknown> }) => execute() },
    wireSummaryFilter: () => {},
    initSortableTable: () => ({}),
    LIST_PREFERENCE_KEYS: { adminSummaryFilter: 'adminSummaryFilter' },
    createSummaryFilter: () => ({}),
    renderSummaryFilter: () => '',
    filterRowsBySummary: (r: unknown[]) => r,
    duesStatusLabel: (s: string) => s,
    duesStatusBadgeHtml: (s: string) => s,
  });
  vm.runInContext(profilePanel, adminCtx);
  vm.runInContext(adminScript, adminCtx);

  getAdminEl('accountless-category').value = 'niewiasta';
  adminCtx.updateAccountlessWeaponState();
  assert.equal(getAdminEl('accountless-weapon-field').hidden, true);
  assert.equal(weaponCb.checked, false);

  weaponCb.checked = true;
  getAdminEl('accountless-category').value = 'bobo';
  adminCtx.updateAccountlessWeaponState();
  assert.equal(getAdminEl('accountless-weapon-field').hidden, true);
  assert.equal(weaponCb.checked, false);

  getAdminEl('accountless-category').value = 'woj';
  adminCtx.updateAccountlessWeaponState();
  assert.equal(getAdminEl('accountless-weapon-field').hidden, false);

  const weapons = [{ id: 'tarczownik', label: 'Tarcza', retired: false }];
  assert.equal(adminCtx.weaponCheckboxesHtml('a@b.pl', weapons, ['tarczownik'], 'bobo'), '');
  assert.match(adminCtx.weaponCheckboxesHtml('a@b.pl', weapons, ['tarczownik'], 'woj'), /type="checkbox"/);

  // 2. profil.js: hides #weapons-panel for non-combat categories and checks saved weapons for combat
  const profileElements = new Map<string, any>();
  const getProfileEl = (id: string) => {
    if (!profileElements.has(id)) profileElements.set(id, makeStubElement(id));
    return profileElements.get(id);
  };
  const profileForm = getProfileEl('profile-form');
  profileForm.sectionId = makeStubElement('sectionId');
  profileForm.lastName = makeStubElement('lastName');
  profileForm.firstName = makeStubElement('firstName');
  profileForm.nickname = makeStubElement('nickname');
  let profileSignedIn: ((identity: { email: string }) => Promise<void>) | null = null;
  let memberCategory = 'niewiasta';
  const profileWeaponCheckboxes = [{ value: 'tarczownik', checked: false, disabled: false }];

  const profileCtx = vm.createContext({
    window: { confirm: () => true, alert: () => {}, location: { search: '' }, addEventListener: () => {} },
    document: {
      body: { append: () => {} },
      getElementById: getProfileEl,
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel === '#weapons-checkboxes input[name="weaponIds"]' ? profileWeaponCheckboxes : []),
      addEventListener: () => {},
    },
    console,
    URLSearchParams,
    Notification: { permission: 'default' },
    navigator: {},
    initGoogleSignIn: (cfg: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { profileSignedIn = cfg.onSignedIn; },
    apiFetch: async (url: string) => {
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [{ id: 's1', label: 'S1' }], categories: [{ id: 'niewiasta', label: 'Niewiasta' }, { id: 'woj', label: 'Woj' }], weapons };
      if (url === '/lista-wyjazdowa/profile/photo') return {};
      if (url === '/lista-wyjazdowa/member') return { member: { firstName: 'A', lastName: 'B', sectionId: 's1', categoryId: memberCategory } };
      if (url === '/lista-wyjazdowa/profile') return { profile: { weaponIds: ['tarczownik'] } };
      if (url.startsWith('/lista-wyjazdowa/dues/mine')) return { wpisoweStatus: 'paid', duesStatus: 'paid' };
      if (url === '/lista-wyjazdowa/roster') return { roster: [] };
      if (url === '/equipment') return { equipment: [] };
      return {};
    },
    renderDuesStatus: () => {},
    initNotificationSettings: async () => {},
    escapeHtml: (s: unknown) => String(s ?? ''),
    escapeAttr: (s: unknown) => String(s ?? ''),
  });
  vm.runInContext(profilePanel, profileCtx);
  vm.runInContext(profileScript, profileCtx);

  await profileSignedIn!({ email: 'test@kruki.pl' });
  assert.equal(getProfileEl('weapons-panel').hidden, true);
  assert.equal(profileWeaponCheckboxes[0].checked, false);

  memberCategory = 'woj';
  await profileSignedIn!({ email: 'test@kruki.pl' });
  assert.equal(getProfileEl('weapons-panel').hidden, false);
  assert.equal(profileWeaponCheckboxes[0].checked, true);

  // 3. profile-panel.js: shared drawer editor hides weapons form for niewiasta/bobo and renders it for woj
  for (const [categoryId, expectWeapons] of [['niewiasta', false], ['bobo', false], ['woj', true]] as const) {
    const contentEl = makeStubElement('content');
    const closeEl = makeStubElement('close');
    const statusEl = makeStubElement('status');
    const backdropEl = makeStubElement('backdrop');
    const drawerEl = makeStubElement('drawer');
    drawerEl.querySelector = (sel: string) => {
      if (sel === '.profile-drawer-content') return contentEl;
      if (sel === '.profile-drawer-close') return closeEl;
      if (sel === '.profile-drawer-status') return statusEl;
      if (sel === '.profile-drawer-backdrop') return backdropEl;
      return null;
    };
    const wrapperEl = { innerHTML: '', firstElementChild: drawerEl };
    const docClickListeners: Array<(e: any) => unknown> = [];
    const panelCtx = vm.createContext({
      window: { location: { search: '' }, addEventListener: () => {} },
      document: {
        activeElement: null,
        body: { append: () => {} },
        createElement: () => wrapperEl,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (type: string, fn: (e: any) => unknown) => {
          if (type === 'click') docClickListeners.push(fn);
        },
      },
      console,
      URLSearchParams,
      apiFetch: async (url: string) => {
        if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [{ id: 's1', label: 'S1' }], categories: [{ id: categoryId, label: categoryId }], weapons };
        return {
          email: 'a@b.pl',
          firstName: 'A',
          lastName: 'B',
          sectionId: 's1',
          categoryId,
          weaponIds: ['tarczownik'],
          weapons: ['Tarcza'],
          photos: [],
          pendingPhotos: [],
          equipment: [],
          editor: {
            canEditIdentity: true,
            canEditWeapons: true,
            canEditDues: false,
            lookupLists: { sections: [{ id: 's1', label: 'S1' }], categories: [{ id: categoryId, label: categoryId }], weapons },
          },
        };
      },
      escapeHtml: (s: unknown) => String(s ?? ''),
      escapeAttr: (s: unknown) => String(s ?? ''),
      displayName: (p: { firstName?: string }) => p.firstName ?? '',
      duesStatusLabel: (s: string) => s,
      duesStatusBadgeHtml: (s: string) => s,
    });
    vm.runInContext(duesStatusSource, panelCtx);
    vm.runInContext(profilePanel, panelCtx);
    await panelCtx.window.ProfilePanel.open('a@b.pl');
    for (const fn of docClickListeners) {
      await fn({
        target: {
          closest: (sel: string) => (sel === '[data-profile-edit="editor"]' ? { dataset: { profileEdit: 'editor' } } : null),
        },
      });
    }
    if (expectWeapons) {
      assert.match(contentEl.innerHTML, /profile-weapons-form/);
      assert.match(contentEl.innerHTML, /value="tarczownik" checked/);
    } else {
      assert.doesNotMatch(contentEl.innerHTML, /profile-weapons-form/);
    }
  }
});

test('accountless form validates the fields required by the person API', async () => {
  const elements = new Map<string, any>();
  const getEl = (id: string) => {
    if (!elements.has(id)) elements.set(id, makeStubElement(id));
    return elements.get(id);
  };
  let postCalled = false;
  const ctx = vm.createContext({
    window: { confirm: () => true, alert: () => {}, location: { search: '' }, addEventListener: () => {}, MutationFeedback: { confirmed: async ({ execute }: { execute: () => Promise<unknown> }) => execute() } },
    document: { body: { append: () => {} }, getElementById: getEl, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
    console,
    URLSearchParams,
    initGoogleSignIn: () => {},
    apiFetch: async (_url: string, init: Record<string, unknown> = {}) => {
      if (init.method === 'POST') postCalled = true;
      return {};
    },
    showReauth: () => {},
    hideReauth: () => {},
    escapeHtml: (s: unknown) => String(s ?? ''),
    escapeAttr: (s: unknown) => String(s ?? ''),
    formatDateTime: (s: unknown) => String(s ?? ''),
    sheetSyncStatusMessage: () => '',
    MutationFeedback: { confirmed: async ({ execute }: { execute: () => Promise<unknown> }) => execute() },
    wireSummaryFilter: () => {},
    initSortableTable: () => ({}),
    LIST_PREFERENCE_KEYS: { adminSummaryFilter: 'adminSummaryFilter' },
    createSummaryFilter: () => ({}),
    renderSummaryFilter: () => '',
    filterRowsBySummary: (r: unknown[]) => r,
    duesStatusLabel: (s: string) => s,
    duesStatusBadgeHtml: (s: string) => s,
  });
  vm.runInContext(profilePanel, ctx);
  vm.runInContext(adminScript, ctx);

  // Each required field missing independently must show validation error and avoid POSTing.
  const requiredDefaults: Record<string, string> = {
    'accountless-first-name': 'Jan',
    'accountless-last-name': 'Kowalski',
    'accountless-category': 'woj',
    'accountless-section-select': 's1',
  };
  for (const missingId of Object.keys(requiredDefaults)) {
    for (const [id, val] of Object.entries(requiredDefaults)) {
      getEl(id).value = id === missingId ? '' : val;
    }
    getEl('accountless-error').hidden = true;
    getEl('accountless-error').textContent = '';
    await ctx.submitAccountlessForm();

    assert.equal(postCalled, false, `POST should not fire when ${missingId} is missing`);
    assert.equal(getEl('accountless-error').hidden, false);
    assert.equal(getEl('accountless-error').textContent, 'Imię, nazwisko, kategoria i sekcja są wymagane.');
  }
});
