import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/profile-panel.js', import.meta.url), 'utf8');

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}

class FakeElement {
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  parent: FakeElement | null = null;
  isConnected = false;
  private html = '';
  private children = new Map<string, FakeElement>();
  private groups = new Map<string, FakeElement[]>();
  private appended: FakeElement[] = [];
  private listeners = new Map<string, Array<(event: any) => unknown>>();

  constructor(private readonly selector = '') {}

  get innerHTML() { return this.html; }
  get firstElementChild() { return this.children.get('.profile-drawer') ?? null; }
  set innerHTML(value: string) {
    this.html = value;
    this.children.clear();
    if (value.includes('profile-drawer-content')) {
      this.addChild('.profile-drawer', new FakeElement('.profile-drawer'));
      const drawer = this.children.get('.profile-drawer')!;
      drawer.addChild('.profile-drawer-content', new FakeElement('.profile-drawer-content'));
      drawer.addChild('.profile-drawer-close', new FakeElement('.profile-drawer-close'));
      drawer.addChild('.profile-drawer-backdrop', new FakeElement('.profile-drawer-backdrop'));
    }
    if (value.includes('data-profile-edit="identity"')) this.addChild('[data-profile-edit="identity"]', new FakeElement('[data-profile-edit="identity"]'));
    if (value.includes('profile-identity-form')) {
      const section = this.addChild('.profile-identity-section', new FakeElement('.profile-identity-section'));
      const form = section.addChild('.profile-identity-form', new FakeElement('.profile-identity-form'));
      const inputValue = (name: string) => value.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? '';
      const selectedValue = (name: string) => value.match(new RegExp(`name="${name}"[\\s\\S]*?<option value="([^"]*)" selected`))?.[1] ?? '';
      form.elements = {
        firstName: { value: inputValue('firstName') }, lastName: { value: inputValue('lastName') }, nickname: { value: inputValue('nickname') },
        sectionId: { value: selectedValue('sectionId') }, categoryId: { value: selectedValue('categoryId') },
      };
      form.addChild('.profile-identity-save', new FakeElement('.profile-identity-save'));
    }
    if (value.includes('profile-weapons-form')) {
      const section = this.addChild('.profile-weapons-section', new FakeElement('.profile-weapons-section'));
      const form = section.addChild('.profile-weapons-form', new FakeElement('.profile-weapons-form'));
      const weaponIds = [...value.matchAll(/name="weaponIds" value="([^"]*)"( checked)?/g)]
        .map((match) => Object.assign(new FakeElement(), { value: match[1], checked: Boolean(match[2]) }));
      form.groups.set('input[name="weaponIds"]:checked', weaponIds.filter((input) => input.checked));
      form.addChild('.profile-weapons-save', new FakeElement('.profile-weapons-save'));
    }
    if (value.includes('profile-dues-form')) {
      const section = this.addChild('.profile-dues-section', new FakeElement('.profile-dues-section'));
      const form = section.addChild('.profile-dues-form', new FakeElement('.profile-dues-form'));
      form.elements = { wpisowePaid: { checked: value.includes('name="wpisowePaid" checked') }, duesStatus: { value: value.match(/name="duesStatus"[\s\S]*?<option value="([^"]*)" selected/)?.[1] ?? 'unpaid' } } as any;
      const entry = form.addChild('[data-profile-dues-save="wpisowe"]', new FakeElement('[data-profile-dues-save="wpisowe"]'));
      entry.dataset.profileDuesSave = 'wpisowe';
      const annual = form.addChild('[data-profile-dues-save="annual"]', new FakeElement('[data-profile-dues-save="annual"]'));
      annual.dataset.profileDuesSave = 'annual';
    }
  }

  // HTMLFormElement's named controls are the only form API used by the drawer save path.
  elements: Record<string, { value?: string; checked?: boolean }> = {};

  addChild(selector: string, child: FakeElement) {
    child.parent = this;
    child.isConnected = this.isConnected;
    this.children.set(selector, child);
    return child;
  }
  append(child: FakeElement) { child.isConnected = true; this.appended.push(child); }
  querySelector(selector: string) {
    if (this.children.has(selector)) return this.children.get(selector)!;
    for (const child of this.children.values()) {
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    for (const child of this.appended) {
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  querySelectorAll(selector: string) { return this.groups.get(selector) ?? []; }
  closest(selector: string) {
    if (this.selector === selector) return this;
    if (selector === '[data-profile-dues-save]' && this.dataset.profileDuesSave) return this;
    return this.parent?.closest(selector) ?? null;
  }
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  focus() {}
}

function createHarness() {
  const listeners = new Map<string, Array<(event: any) => unknown>>();
  const body = new FakeElement('body');
  body.isConnected = true;
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const profile = {
    firstName: 'Jan', lastName: 'Kowalski', nickname: 'Janko', sectionId: 'kruki', categoryId: 'wojownik',
    sectionLabel: 'Kruki', categoryLabel: 'Wojownik', weapons: [], weaponIds: ['tarcza'], photos: [], pendingPhotos: [],
    published: false, wpisowePaid: true, duesStatus: 'paid', duesYear: 2026,
    editor: { canEditIdentity: true, canEditWeapons: true, canEditDues: true, lookupLists: { sections: [{ id: 'kruki', label: 'Kruki' }], categories: [{ id: 'wojownik', label: 'Wojownik' }], weapons: [{ id: 'tarcza', label: 'Tarcza' }] } },
  };
  const document = {
    body,
    activeElement: new FakeElement(),
    createElement: () => new FakeElement(),
    addEventListener: (type: string, listener: (event: any) => unknown) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    async dispatch(type: string, target: FakeElement) {
      for (const listener of listeners.get(type) ?? []) await listener({ target, preventDefault() {} });
    },
  };
  const context: Record<string, unknown> = {
    document,
    window: {
      MutationFeedback: { confirmed: async ({ execute, apply }: { execute: () => Promise<unknown>; apply: (result: unknown) => Promise<void> }) => apply(await execute()) },
    },
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      apiCalls.push({ url, options });
      return url.startsWith('/lista-wyjazdowa/person-profile?') ? { profile } : profile;
    },
    categoryPillBroccoliIconHtml: () => '',
    displayName: (item: { nickname?: string; firstName?: string; lastName?: string }) => item.nickname || `${item.firstName} ${item.lastName}`,
    encodeURIComponent,
    String,
    Array,
    Map,
    Object,
    JSON,
  };
  vm.runInNewContext(source, context, { filename: 'profile-panel.js' });
  return { apiCalls, document, window: context.window as { ProfilePanel: { open(email: string): Promise<void> } } };
}

test('identity-capable profile drawer submits the edited member identity through its target-specific PUT route', async () => {
  const harness = createHarness();
  await harness.window.ProfilePanel.open('jan@example.test');

  const edit = harness.document.body.querySelector('[data-profile-edit="identity"]');
  assert.ok(edit, 'an identity-capable response exposes the Edit action');
  await harness.document.dispatch('click', edit);

  const form = harness.document.body.querySelector('.profile-identity-form');
  assert.ok(form, 'Edit swaps the read-only action for the identity form');
  form.elements.firstName.value = 'Janusz';
  await harness.document.dispatch('submit', form);
  await new Promise((resolve) => setImmediate(resolve));

  const put = harness.apiCalls.find((call) => call.options.method === 'PUT');
  assert.equal(put?.url, '/admin/members/profile');
  assert.equal(put?.options.method, 'PUT');
  assert.equal((put?.options.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(put?.options.body)), {
    email: 'jan@example.test', firstName: 'Janusz', lastName: 'Kowalski', nickname: 'Janko', sectionId: 'kruki', categoryId: 'wojownik',
  });
  assert.equal(harness.apiCalls.filter((call) => call.url.startsWith('/member-profile?')).length, 2, 'a successful PUT refreshes the open drawer');
});

test('capability-gated weapons and dues controls use their distinct PUT bodies and refresh the drawer', async () => {
  const harness = createHarness();
  await harness.window.ProfilePanel.open('jan@example.test');

  const weapons = harness.document.body.querySelector('.profile-weapons-form');
  assert.ok(weapons);
  await harness.document.dispatch('submit', weapons);
  await new Promise((resolve) => setImmediate(resolve));

  const weaponsPut = harness.apiCalls.find((call) => call.url === '/admin/members/weapons');
  assert.ok(weaponsPut, JSON.stringify(harness.apiCalls));
  assert.deepEqual(JSON.parse(String(weaponsPut?.options.body)), { email: 'jan@example.test', weaponIds: ['tarcza'] });

  const entryFee = harness.document.body.querySelector('[data-profile-dues-save="wpisowe"]');
  assert.ok(entryFee);
  await harness.document.dispatch('click', entryFee);
  await new Promise((resolve) => setImmediate(resolve));
  const entryFeePut = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/wpisowe?personId=jan%40example.test');
  assert.deepEqual(JSON.parse(String(entryFeePut?.options.body)), { paid: true });

  const annual = harness.document.body.querySelector('[data-profile-dues-save="annual"]');
  assert.ok(annual);
  await harness.document.dispatch('click', annual);
  await new Promise((resolve) => setImmediate(resolve));
  const annualPut = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/dues?personId=jan%40example.test&year=2026');
  assert.deepEqual(JSON.parse(String(annualPut?.options.body)), { status: 'paid' });
  assert.equal(harness.apiCalls.filter((call) => call.url.startsWith('/member-profile?')).length, 4, 'each successful write reloads the drawer');
});

test('accountless person weapons save preserves the complete person record and reloads by person id', async () => {
  const harness = createHarness();
  const trigger = new FakeElement('[data-profile-trigger]');
  trigger.dataset.personId = 'person-42';
  await harness.document.dispatch('click', trigger);
  await new Promise((resolve) => setImmediate(resolve));

  const weapons = harness.document.body.querySelector('.profile-weapons-form');
  assert.ok(weapons);
  await harness.document.dispatch('submit', weapons);
  await new Promise((resolve) => setImmediate(resolve));

  const put = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/persons' && call.options.method === 'PUT');
  assert.ok(put, JSON.stringify(harness.apiCalls));
  assert.deepEqual(JSON.parse(String(put.options.body)), {
    personId: 'person-42', ksywka: 'Janko', firstName: 'Jan', lastName: 'Kowalski', categoryId: 'wojownik', sectionId: 'kruki', weaponIds: ['tarcza'],
  });
  assert.equal(harness.apiCalls.filter((call) => call.url === '/lista-wyjazdowa/person-profile?personId=person-42').length, 2, 'the write refreshes via the person-keyed profile endpoint');
});
