import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/skladki/skladki.js', import.meta.url), 'utf8');
const personPillSource = readFileSync(new URL('../public/shared/person-pill.js', import.meta.url), 'utf8');
const duesStatusSource = readFileSync(new URL('../public/shared/dues-status.js', import.meta.url), 'utf8');
const summaryFilterSource = readFileSync(new URL('../public/shared/summary-filter.js', import.meta.url), 'utf8');

test('fee category summary adds a decorative Brokuł icon through the shared helper', () => {
  assert.match(source, /categoryPillBroccoliIconHtml\(categoryId, 'category-label'\)/);
});

class Element {
  id: string;
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  href = '';
  disabled = false;
  title = '';
  dataset: Record<string, string> = {};
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Array<(event: any) => unknown>>();
  private children = new Map<string, Element>();

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
  async change(value: string) {
    this.value = value;
    await Promise.all((this.listeners.get('change') ?? []).map((listener) => listener({ target: this })));
  }
  async input() {
    await Promise.all((this.listeners.get('input') ?? []).map((listener) => listener({ target: this })));
  }
  querySelector(selector: string) {
    if (!this.children.has(selector)) this.children.set(selector, new Element(`${this.id}${selector}`));
    return this.children.get(selector)!;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  scrollIntoView() {}
  remove() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'main-content', 'skladki-error',
  'skladka-fee-panel', 'skladki-year-fee-display', 'skladki-year-fee-edit',
  'skladki-year-fee-input', 'skladki-year-fee-duedate-input', 'skladki-year-fee-save',
  'skladki-year-fee-remove', 'skladki-year-fee-history-link', 'skladki-year-creator',
  'skladki-charge-buttons', 'skladki-payment-panel', 'skladki-payment-text', 'skladki-payment-form',
  'skladki-payment-edit-toggle', 'skladki-payment-toggle', 'skladki-payment-box', 'skladki-payment-input', 'skladki-payment-save', 'skladki-payment-cancel',
  'skladki-add-toggle', 'skladki-add-form', 'skladki-add-kind', 'skladki-add-kind-annual',
  'skladki-add-annual-fields', 'skladki-add-extra-fields', 'skladki-add-year', 'skladki-add-name',
  'skladki-add-amount', 'skladki-add-description', 'skladki-add-duedate', 'skladki-add-error',
  'skladki-add-submit', 'skladki-add-cancel', 'skladki-extra-panel', 'skladki-extra-title',
  'skladki-extra-creator', 'skladki-extra-details', 'skladki-extra-history-link', 'skladki-extra-edit',
  'skladki-extra-name-input', 'skladki-extra-amount-input', 'skladki-extra-description-input',
  'skladki-extra-duedate-input', 'skladki-extra-save', 'skladki-extra-delete',
  'summary-content', 'summary-panel', 'skladki-content', 'skladki-table', 'skladki-emeryci',
  'skladki-emeryci-table', 'skladki-emeryci-heading', 'skladki-wpisowe-panel', 'skladki-year-deadline', 'skladki-extra-deadline',
];

function createHarness(yearFee: Record<string, unknown> | null, options: { roster?: Array<Record<string, unknown>>; dues?: Array<Record<string, unknown>>; charges?: Array<Record<string, unknown>>; extraStatuses?: Array<Record<string, unknown>>; paymentInfo?: { text: string } | null } = {}) {
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = {};
  let mutationError: Error | null = null;
  let signIn: (() => Promise<void>) | undefined;
  const roster = options.roster ?? [
    { personId: 'member@example.com', email: 'member@example.com', accountless: false, lastName: 'Member', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'paid' },
  ];
  // Captured here because apiFetch's own `options` parameter (the fetch options) would shadow the
  // harness options inside the closure below.
  const duesFixture = options.dues ?? [];
  const extraStatusFixture = options.extraStatuses ?? [];
  const options_paymentInfo = options.paymentInfo ?? null;
  const options_charges = options.charges ?? [
    { id: `annual-${new Date().getFullYear()}`, kind: 'annual', year: new Date().getFullYear(), name: String(new Date().getFullYear()), createdBy: '', canEdit: false },
  ];
  const context: Record<string, unknown> = {
    URLSearchParams,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Date,
    Number,
    Math,
    String,
    encodeURIComponent,
    window: {
      location: { search: '' },
      confirm: () => true,
      LwCalendar: {
        mountDropdowns: () => ({ refresh() {}, close() {} }),
        datePillHtml: (event: { startDate: string; name: string }, key: string, _side: string, options: { iconOnly?: boolean }) =>
          `<button data-lw-cal-toggle data-key="${key}" data-icon-only="${options.iconOnly === true}" data-date="${event.startDate}">${event.name}</button>`,
      },
      MutationFeedback: {
        confirmed: async ({ execute, apply, rollback }: { execute: () => Promise<unknown>; apply: (result: unknown) => void; rollback?: (error: unknown) => unknown }) => {
          let result: unknown;
          try {
            result = await execute();
          } catch (error) {
            if (rollback) await rollback(error);
            throw error;
          }
          apply(result);
          return result;
        },
      },
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    },
    initSortableTable: () => ({ key: 'section', dir: 'asc', reset() {}, refresh() {} }),
    compareValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    compareDateValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    displayName: (member: { lastName: string }) => member.lastName,
    personSubline: () => null,
    initGoogleSignIn: (config: { onSignedIn: () => Promise<void> }) => { signIn = config.onSignedIn; },
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      apiCalls.push({ url, options });
      if (options.method === 'PUT') {
        if (mutationError) throw mutationError;
        return mutationResult;
      }
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki: true };
      if (url === '/lista-wyjazdowa/dues/charges') {
        return {
          charges: options_charges,
          paymentInfo: options_paymentInfo,
        };
      }
      if (url.startsWith('/lista-wyjazdowa/dues/extra?')) return { statuses: extraStatusFixture };
      if (url === '/lista-wyjazdowa/events') return { events: [] };
      if (url === '/lista-wyjazdowa/roster') return { roster };
      if (url.startsWith('/lista-wyjazdowa/dues?')) return { dues: duesFixture, yearFee };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [], weapons: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };
  vm.runInNewContext(personPillSource, context, { filename: 'person-pill.js' });
  vm.runInNewContext(duesStatusSource, context, { filename: 'dues-status.js' });
  vm.runInNewContext(summaryFilterSource, context, { filename: 'summary-filter.js' });
  vm.runInNewContext(source, context, { filename: 'skladki.js' });
  return {
    elements,
    apiCalls,
    async signIn() { await signIn?.(); },
    setMutationResult(result: unknown) { mutationResult = result; mutationError = null; },
    setMutationError(error: Error) { mutationError = error; },
  };
}

test('year fee: an empty note disables and clears the due-date field and never sends a date', async () => {
  const harness = createHarness(null);
  await harness.signIn();
  const noteInput = harness.elements.get('skladki-year-fee-input')!;
  const dueDateInput = harness.elements.get('skladki-year-fee-duedate-input')!;
  assert.equal(dueDateInput.disabled, true);

  noteInput.value = '100 zł';
  await noteInput.input();
  assert.equal(dueDateInput.disabled, false);

  dueDateInput.value = '2026-10-20';
  noteInput.value = '';
  await noteInput.input();
  assert.equal(dueDateInput.value, '');
  assert.equal(dueDateInput.disabled, true);

  // Even if a date were forced into the now-disabled field, the save guard drops it.
  dueDateInput.value = '2026-10-20';
  await harness.elements.get('skladki-year-fee-save')!.click();
  const put = harness.apiCalls.filter((call) => call.options.method === 'PUT').at(-1);
  assert.deepEqual(JSON.parse(String(put?.options.body)), { note: null });
});

test('year fee: removing clears both fields and sends nulls', async () => {
  const harness = createHarness({ note: '100 zł', dueDate: '2026-10-20' });
  await harness.signIn();
  assert.equal(harness.elements.get('skladki-year-fee-input')!.value, '100 zł');
  assert.equal(harness.elements.get('skladki-year-fee-duedate-input')!.disabled, false);
  assert.equal(harness.elements.get('skladki-year-fee-remove')!.disabled, false);

  harness.setMutationResult({});
  await harness.elements.get('skladki-year-fee-remove')!.click();

  const put = harness.apiCalls.filter((call) => call.options.method === 'PUT').at(-1);
  assert.deepEqual(JSON.parse(String(put?.options.body)), { note: null, dueDate: null });
  assert.equal(harness.elements.get('skladki-year-fee-input')!.value, '');
  assert.equal(harness.elements.get('skladki-year-fee-duedate-input')!.value, '');
  assert.equal(harness.elements.get('skladki-year-fee-duedate-input')!.disabled, true);
  assert.equal(harness.elements.get('skladki-year-fee-remove')!.disabled, true);
});

test('year fee: a failed removal restores the form from the last loaded fee', async () => {
  const harness = createHarness({ note: '100 zł', dueDate: '2026-10-20' });
  await harness.signIn();
  harness.setMutationError(new Error('network'));
  await harness.elements.get('skladki-year-fee-remove')!.click();
  assert.equal(harness.elements.get('skladki-year-fee-input')!.value, '100 zł');
  assert.equal(harness.elements.get('skladki-year-fee-duedate-input')!.value, '2026-10-20');
  assert.equal(harness.elements.get('skladki-year-fee-duedate-input')!.disabled, false);
  assert.equal(harness.elements.get('skladki-year-fee-remove')!.disabled, false);
});

test('an accountless person renders with the marker, no e-mail trigger, and its stored personId-keyed due', async () => {
  const harness = createHarness(null, {
    roster: [
      { personId: 'member@example.com', email: 'member@example.com', accountless: false, lastName: 'Member', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'unpaid', wpisoweStatus: 'paid' },
      { personId: 'person-uuid-1', email: null, accountless: true, lastName: 'Osoba Bez Konta', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'unpaid' },
    ],
    dues: [{ email: 'person-uuid-1', personId: 'person-uuid-1', status: 'paid' }],
  });
  await harness.signIn();
  const tbody = harness.elements.get('skladki-table')!.querySelector('tbody')!;

  assert.match(tbody.innerHTML, /person-uuid-1/, 'the accountless row is keyed by its personId');
  assert.match(tbody.innerHTML, /person-pill-icon/);
  assert.match(tbody.innerHTML, /aria-label="osoba bez konta"/);
  assert.doesNotMatch(tbody.innerHTML, /data-email="null"/, 'no e-mail-keyed profile trigger for a person with no e-mail');
  assert.match(tbody.innerHTML, /data-email="member@example\.com"/, 'the member row keeps its e-mail-keyed profile trigger');
  // The stored due (keyed by the person UUID) is looked up via personId and shown as paid, not
  // defaulted to unpaid - and the audit history deep link is keyed by personId too.
  assert.match(tbody.innerHTML, /data-status="paid"[^>]*data-person-id="person-uuid-1"|data-person-id="person-uuid-1"[^>]*data-status="paid"/);
  assert.match(tbody.innerHTML, /due%3Aperson-uuid-1/);

  // Clicking the roczna coin sends the rekeyed personId PUT.
  await harness.elements.get('skladki-content')!.clickWith({
    closest: (selector: string) => selector === '.lw-skladka-icon[data-kind]'
      ? { dataset: { kind: 'roczna', personId: 'person-uuid-1', status: 'paid' }, title: '', setAttribute() {} }
      : null,
  });
  const put = harness.apiCalls.filter((call) => call.options.method === 'PUT').at(-1);
  assert.match(String(put?.url), /personId=person-uuid-1/);
});

test('wpisowe view: unpaid in the main table, not_applicable in a "Nie dotyczy" table, summary skips not_applicable, badge cycles to the next status', async () => {
  const harness = createHarness(null, {
    roster: [
      { personId: 'a@example.com', email: 'a@example.com', accountless: false, lastName: 'Nieoplacony', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'unpaid' },
      { personId: 'b@example.com', email: 'b@example.com', accountless: false, lastName: 'Oplacony', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'paid' },
      { personId: 'c@example.com', email: 'c@example.com', accountless: false, lastName: 'Dziecko', sectionId: null, categoryId: 'bobo', weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'not_applicable' },
    ],
  });
  await harness.signIn();
  await harness.elements.get('skladki-charge-buttons')!.clickWith({
    closest: (selector: string) => selector === '[data-charge-id]' ? { dataset: { chargeId: 'wpisowe' } } : null,
  });

  const main = harness.elements.get('skladki-table')!.querySelector('tbody')!.innerHTML;
  assert.match(main, /Nieoplacony/);
  assert.doesNotMatch(main, /Oplacony/);
  assert.doesNotMatch(main, /Dziecko/);
  assert.match(main, /data-kind="wpisowe"[^>]*data-status="unpaid"/);

  const notApplicable = harness.elements.get('skladki-emeryci-table')!.querySelector('tbody')!.innerHTML;
  assert.match(notApplicable, /Dziecko/);
  assert.match(notApplicable, /data-status="not_applicable"[^>]*>–</);
  assert.equal(harness.elements.get('skladki-emeryci')!.hidden, false);
  assert.equal(harness.elements.get('skladki-emeryci-heading')!.textContent, 'Nie dotyczy');

  const summary = harness.elements.get('summary-content')!.innerHTML;
  assert.match(summary, /Nieopłacone wpisowe: <strong>1<\/strong> z 2 osób/);
  assert.match(summary, /Nie dotyczy: <strong>1<\/strong> z 3 osób/);

  const control = { dataset: { kind: 'wpisowe', personId: 'a@example.com', status: 'unpaid' }, title: '', textContent: '✕', setAttribute() {} };
  await harness.elements.get('skladki-content')!.clickWith({
    closest: (selector: string) => selector === '.lw-skladka-icon[data-kind]' ? control : null,
  });
  const put = harness.apiCalls.filter((call) => call.options.method === 'PUT').at(-1);
  assert.match(String(put?.url), /\/lista-wyjazdowa\/wpisowe\?personId=a%40example\.com/);
  assert.deepEqual(JSON.parse(String(put?.options.body)), { status: 'paid' });
  assert.equal(control.dataset.status, 'paid');
  assert.equal(control.textContent, '✓');
});


test('charge buttons: Obowiązkowy (Wpisowe, roczne) then Dodatkowe, one pressed, defaulting to the current year', async () => {
  const year = new Date().getFullYear();
  const harness = createHarness(null, {
    charges: [
      { id: `annual-${year}`, kind: 'annual', year, name: String(year), createdBy: 'a@example.com', canEdit: false },
      { id: 'extra-1', kind: 'extra', name: 'Koszulki', amount: '50 zł', description: 'A\nB', dueDate: null, createdBy: 'member@example.com', canEdit: true },
    ],
  });
  await harness.signIn();
  const html = harness.elements.get('skladki-charge-buttons')!.innerHTML;
  const labels = [...html.matchAll(/>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Wpisowe', String(year), 'Koszulki']);
  assert.match(html, new RegExp(`data-charge-id="annual-${year}"[^>]*aria-pressed="true"`));
  assert.match(html, /data-charge-id="extra-1"[^>]*aria-pressed="false"/);
  assert.equal(harness.elements.get('skladki-extra-panel')!.hidden, true);
});

test('extra charge: details, creator, default "nie dotyczy" and status PUT to the extra endpoint', async () => {
  const harness = createHarness(null, {
    charges: [{ id: 'extra-1', kind: 'extra', name: 'Koszulki', amount: '50 zł', description: 'A\nB', dueDate: '2026-12-01', createdBy: 'member@example.com', canEdit: true }],
    extraStatuses: [],
  });
  await harness.signIn();
  // No current-year annual exists, so the first button alphabetically (Koszulki) is selected.
  assert.equal(harness.elements.get('skladki-extra-panel')!.hidden, false);
  assert.equal(harness.elements.get('skladki-extra-title')!.textContent, 'Koszulki');
  assert.match(harness.elements.get('skladki-extra-creator')!.innerHTML, /Założone przez: [\s\S]*data-email="member@example.com"[\s\S]*Member/);
  assert.match(harness.elements.get('skladki-extra-details')!.innerHTML, /Kwota: 50 zł/);
  // The deadline is the shared calendar's icon button, not text in the description.
  assert.doesNotMatch(harness.elements.get('skladki-extra-details')!.innerHTML, /01\.12\.2026|Termin/);
  assert.match(harness.elements.get('skladki-extra-deadline')!.innerHTML, /data-icon-only="true" data-date="2026-12-01"/);
  assert.equal(harness.elements.get('skladki-extra-deadline')!.hidden, false);
  assert.equal(harness.elements.get('skladka-fee-panel')!.hidden, true);
  const tbody = harness.elements.get('skladki-table')!.querySelector('tbody')!.innerHTML;
  assert.match(tbody, /data-kind="roczna"[^>]*data-status="not_applicable"|data-status="not_applicable"[^>]*data-kind="roczna"/);
  assert.doesNotMatch(tbody, /audyt-history-btn/);

  await harness.elements.get('skladki-content')!.clickWith({
    closest: (selector: string) => selector === '.lw-skladka-icon[data-kind]'
      ? { dataset: { kind: 'roczna', personId: 'member@example.com', status: 'not_applicable' }, title: '', setAttribute() {} }
      : null,
  });
  const put = harness.apiCalls.filter((call) => call.options.method === 'PUT').at(-1);
  assert.equal(put?.url, '/lista-wyjazdowa/dues/extra?id=extra-1&personId=member%40example.com');
  assert.deepEqual(JSON.parse(String(put?.options.body)), { status: 'unpaid' });
});

test('extra charge: a viewer who cannot edit sees read-only badges and no edit form', async () => {
  const harness = createHarness(null, {
    charges: [{ id: 'extra-1', kind: 'extra', name: 'Koszulki', amount: null, description: null, dueDate: null, createdBy: 'ktos@example.com', canEdit: false }],
  });
  await harness.signIn();
  assert.equal(harness.elements.get('skladki-extra-edit')!.hidden, true);
  assert.doesNotMatch(harness.elements.get('skladki-table')!.querySelector('tbody')!.innerHTML, /data-kind="roczna"/);
});

test('payment info: shown as plain text to everyone, hidden when empty for the read-only', async () => {
  const withText = createHarness(null, { paymentInfo: { text: 'Konto: 12 3456\n  BLIK: 600' } });
  await withText.signIn();
  assert.equal(withText.elements.get('skladki-payment-panel')!.hidden, false);
  assert.equal(withText.elements.get('skladki-payment-text')!.textContent, 'Konto: 12 3456\n  BLIK: 600');
});

test('year fee: the deadline is a calendar icon on top, not text in the display line', async () => {
  const harness = createHarness({ note: '100 zł', dueDate: '2026-10-20' });
  await harness.signIn();
  assert.equal(harness.elements.get('skladki-year-fee-display')!.textContent.includes('termin'), false);
  assert.match(harness.elements.get('skladki-year-deadline')!.innerHTML, /data-date="2026-10-20"/);
  assert.equal(harness.elements.get('skladki-year-deadline')!.hidden, false);

  const none = createHarness({ note: '100 zł', dueDate: null });
  await none.signIn();
  assert.equal(none.elements.get('skladki-year-deadline')!.hidden, true);
});

test('wpisowe view shows its info box, other views do not', async () => {
  const harness = createHarness(null);
  await harness.signIn();
  assert.equal(harness.elements.get('skladki-wpisowe-panel')!.hidden, true);
  await harness.elements.get('skladki-charge-buttons')!.clickWith({
    closest: (selector: string) => selector === '[data-charge-id]' ? { dataset: { chargeId: 'wpisowe' } } : null,
  });
  assert.equal(harness.elements.get('skladki-wpisowe-panel')!.hidden, false);
  assert.equal(harness.elements.get('skladka-fee-panel')!.hidden, true);
});
