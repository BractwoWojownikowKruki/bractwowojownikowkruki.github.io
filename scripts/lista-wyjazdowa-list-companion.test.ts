import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/lista-wyjazdowa.js', import.meta.url), 'utf8');
const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');
const companionAddSource = readFileSync(new URL('../public/shared/companion-add.js', import.meta.url), 'utf8');
const eventEditFormSource = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');
const lwNavSource = readFileSync(new URL('../public/shared/lw-nav.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/lista-wyjazdowa/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');

class Element {
  id: string;
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  href = '';
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  classList = { toggle: () => {} };
  private listeners = new Map<string, Array<(event: any) => unknown>>();

  constructor(id: string) { this.id = id; }
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async click() {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target: this })));
  }
  async clickWith(target: unknown, eventProps: Record<string, unknown> = {}) {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target, ...eventProps })));
  }
  async dispatch(type: string, event: Record<string, unknown> = {}) {
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener({ preventDefault: () => {}, target: this, ...event })));
  }
  scrollIntoView() {}
}

// add-event-form's submit handler reads form.name/startDate/description.value and
// form.querySelector('button[type="submit"]'), and calls form.reset() - a plain Element stub
// doesn't offer any of that, so this narrow subclass adds just enough to drive it.
class FormElement extends Element {
  name = { value: '' };
  startDate = { value: '' };
  description = { value: '' };
  reset() { this.name.value = ''; this.startDate.value = ''; this.description.value = ''; }
  querySelector(selector: string) { return selector === 'button[type="submit"]' ? new Element('submit-btn') : null; }
}

// The page's delegated click handler only reads closest(...) + dataset off the event target, so a
// minimal stub drives it without a real DOM tree (the harness deliberately has none).
function clickTarget(selector: string, dataset: Record<string, string> = {}) {
  return { closest: (query: string) => (query === selector ? { dataset } : null) };
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'no-profile-panel', 'events-panel',
  'events-list', 'toggle-past-events', 'events-error', 'lw-nav-container', 'lw-nav-add',
  'lw-page-title', 'add-event-form', 'add-event-error',
  // Rendered into #events-list's innerHTML in the real DOM; the stub can't parse that, so the
  // panel's controls are looked up directly by id.
  'lw-inline-existing-select', 'lw-inline-new-name', 'lw-inline-new-last-name', 'lw-inline-new-first-name', 'lw-inline-new-category',
];

interface HarnessOptions {
  viewerAttending?: boolean;
  withAttachedPerson?: boolean;
  hiddenMember?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const viewerAttending = options.viewerAttending ?? true;
  const elements = new Map(elementIds.map((id) => [id, id === 'add-event-form' ? new FormElement(id) : new Element(id)]));
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = null;
  let mutationError: Error | null = null;
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;

  const events = [
    { id: 'e1', name: 'Wyjazd Letni', startDate: '2027-05-01', status: 'active', viewerAttending, attendingCount: 2 },
  ];
  const roster = [
    { personId: 'viewer@example.com', email: 'viewer@example.com', accountless: false, lastName: 'Viewer', firstName: '', sectionId: null, categoryId: null, weaponIds: [] },
    ...(options.withAttachedPerson
      ? [{ personId: 'attached-uuid-1', email: null, accountless: true, ownerPersonId: 'viewer@example.com', lastName: 'Młody', firstName: '', sectionId: null, categoryId: 'kandydat', weaponIds: [] }]
      : []),
  ];

  const hiddenMember = options.hiddenMember === true;
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
      location: { search: '' },
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
        },
      },
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    },
    initGoogleSignIn: (config: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { signIn = config.onSignedIn; },
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      apiCalls.push({ url, options });
      if (options.method === 'PUT' || options.method === 'POST') {
        if (mutationError) throw mutationError;
        return mutationResult;
      }
      if (url === '/lista-wyjazdowa/events') return { events };
      if (url === '/lista-wyjazdowa/roster') return { roster };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [{ id: 'kandydat', label: 'Kandydat' }], weapons: [] };
      if (url === '/lista-wyjazdowa/member') return { member: { categoryId: 'kandydat', ...(hiddenMember ? { hidden: true } : {}) } };
      if (url === '/lista-wyjazdowa/profile') return { profile: { wpisowePaid: true } };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };

  vm.runInNewContext(displayNameSource, context, { filename: 'display-name.js' });
  vm.runInNewContext(companionAddSource, context, { filename: 'companion-add.js' });
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(lwNavSource, context, { filename: 'lw-nav.js' });
  vm.runInNewContext(source, context, { filename: 'lista-wyjazdowa.js' });

  return {
    elements,
    apiCalls,
    async signIn() { await signIn?.({ email: 'viewer@example.com' }); },
    setMutationResult(result: unknown) { mutationResult = result; mutationError = null; },
    setMutationError(error: Error) { mutationError = error; },
  };
}

test('the events list shows the add-companion control next to the toggle only while attending', async () => {
  const attending = createHarness({ viewerAttending: true });
  await attending.signIn();
  const listHtml = attending.elements.get('events-list')!.innerHTML;
  assert.match(listHtml, /class="lw-add-companion"/);
  assert.match(listHtml, /data-event-id="e1"/);
  assert.match(listHtml, /data-owner-person-id="viewer@example\.com"/);
  assert.match(listHtml, /aria-label="Dodaj osobę towarzyszącą"/);

  const notAttending = createHarness({ viewerAttending: false });
  await notAttending.signIn();
  assert.doesNotMatch(notAttending.elements.get('events-list')!.innerHTML, /lw-add-companion/);
});

test('a hidden member gets no add-companion control even while attending', async () => {
  const harness = createHarness({ viewerAttending: true, hiddenMember: true });
  await harness.signIn();
  assert.doesNotMatch(harness.elements.get('events-list')!.innerHTML, /lw-add-companion/);
});

test('tapping + lazy-loads the roster/categories/signups and opens the shared panel', async () => {
  const harness = createHarness({ withAttachedPerson: true });
  await harness.signIn();
  const list = harness.elements.get('events-list')!;
  const requestsBefore = harness.apiCalls.length;

  await list.clickWith(clickTarget('.lw-add-companion', { eventId: 'e1', ownerPersonId: 'viewer@example.com' }));

  const requested = harness.apiCalls.slice(requestsBefore).map((call) => call.url);
  assert.ok(requested.includes('/lista-wyjazdowa/roster'));
  assert.ok(requested.includes('/lista-wyjazdowa/lookup-lists'));
  assert.ok(requested.includes('/lista-wyjazdowa/signups?eventId=e1'));

  assert.match(list.innerHTML, /class="lw-inline-form lw-event-inline-form"/);
  assert.match(list.innerHTML, /id="lw-inline-existing-select"/);
  assert.match(list.innerHTML, /value="attached-uuid-1"/);
  assert.match(list.innerHTML, /id="lw-inline-new-category"/);
  assert.match(list.innerHTML, /Kandydat/);
});

test('adding an existing companion posts quick-add, closes the panel and bumps the count', async () => {
  const harness = createHarness({ withAttachedPerson: true });
  await harness.signIn();
  const list = harness.elements.get('events-list')!;
  await list.clickWith(clickTarget('.lw-add-companion', { eventId: 'e1', ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-existing-select')!.value = 'attached-uuid-1';
  harness.setMutationResult({
    person: { personId: 'attached-uuid-1', ksywka: 'Młody', categoryId: 'kandydat', sectionId: null, weaponIds: [], ownerPersonId: 'viewer@example.com' },
    signup: { memberEmail: 'attached-uuid-1', attending: true, skladkaPaid: false },
  });

  await list.clickWith(clickTarget('.lw-inline-add-existing'));

  const post = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.equal(post?.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(post?.options.body)), { eventId: 'e1', ownerPersonId: 'viewer@example.com', mode: 'existing', personId: 'attached-uuid-1' });
  assert.doesNotMatch(list.innerHTML, /lw-inline-form/);
  assert.match(list.innerHTML, /3 os\./);
});

// KRKG-0103: quick-add's "new person" path now requires Nazwisko/Imię alongside Ksywka - it used
// to create a person with only a ksywka.
test('adding a new companion requires ksywka, nazwisko, imię and kategoria before posting', async () => {
  const harness = createHarness();
  await harness.signIn();
  const list = harness.elements.get('events-list')!;
  await list.clickWith(clickTarget('.lw-add-companion', { eventId: 'e1', ownerPersonId: 'viewer@example.com' }));
  const requestsBefore = harness.apiCalls.length;

  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-last-name')!.value = '';
  harness.elements.get('lw-inline-new-first-name')!.value = '';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  await list.clickWith(clickTarget('.lw-inline-add-new'));

  assert.equal(harness.apiCalls.length, requestsBefore, 'a blank Nazwisko/Imię must not reach the server');
  assert.match(harness.elements.get('events-error')!.textContent, /Podaj ksywkę, nazwisko, imię/);
});

test('adding a new companion posts quick-add with ksywka+lastName+firstName+categoryId', async () => {
  const harness = createHarness();
  await harness.signIn();
  const list = harness.elements.get('events-list')!;
  await list.clickWith(clickTarget('.lw-add-companion', { eventId: 'e1', ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-last-name')!.value = 'Kowalski';
  harness.elements.get('lw-inline-new-first-name')!.value = 'Jan';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  harness.setMutationResult({
    person: { personId: 'new-uuid-1', ksywka: 'Nowy', lastName: 'Kowalski', firstName: 'Jan', categoryId: 'kandydat', sectionId: null, weaponIds: [], ownerPersonId: 'viewer@example.com' },
    signup: { memberEmail: 'new-uuid-1', attending: true, skladkaPaid: false },
  });

  await list.clickWith(clickTarget('.lw-inline-add-new'));

  const post = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.equal(post?.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(post?.options.body)), {
    eventId: 'e1', ownerPersonId: 'viewer@example.com', mode: 'new', ksywka: 'Nowy', lastName: 'Kowalski', firstName: 'Jan', categoryId: 'kandydat',
  });
  assert.doesNotMatch(list.innerHTML, /lw-inline-form/);
  assert.match(list.innerHTML, /3 os\./);
});

test('a failed quick-add keeps the panel open and reports the error', async () => {
  const harness = createHarness({ withAttachedPerson: true });
  await harness.signIn();
  const list = harness.elements.get('events-list')!;
  await list.clickWith(clickTarget('.lw-add-companion', { eventId: 'e1', ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-existing-select')!.value = 'attached-uuid-1';
  const panelBefore = list.innerHTML;
  harness.setMutationError(new Error('network'));

  await list.clickWith(clickTarget('.lw-inline-add-existing'));

  assert.equal(list.innerHTML, panelBefore);
  assert.match(harness.elements.get('events-error')!.textContent, /Nie udało się dodać osoby/);
});

test('toggling to "Jadę" reveals the + and keeps the toggle track', async () => {
  const harness = createHarness({ viewerAttending: false });
  await harness.signIn();
  const list = harness.elements.get('events-list')!;
  assert.doesNotMatch(list.innerHTML, /lw-add-companion/);
  harness.setMutationResult({ signup: { memberEmail: 'viewer@example.com', attending: true, skladkaPaid: false } });

  await list.clickWith(clickTarget('.lw-attend-toggle', { eventId: 'e1', attending: 'false' }));

  assert.match(list.innerHTML, /lw-attend-toggle-track/);
  assert.match(list.innerHTML, /Jadę/);
  assert.match(list.innerHTML, /class="lw-add-companion"/);
  assert.match(list.innerHTML, /3 os\./);
});

test('the events list page loads the shared companion scripts and styles its inline panel', () => {
  assert.match(page, /shared\/display-name\.js/);
  assert.match(page, /shared\/companion-add\.js/);
  assert.match(css, /\.lw-event-row \.lw-inline-form\s*\{[^}]*flex:\s*1 1 100%/);
  assert.match(css, /\.lw-event-row \.lw-inline-form-inner\s*\{[^}]*padding-left:\s*0/);
});

test('KRKG-0101: the toggle and companion control share an action strip on mobile', () => {
  // The toggle + companion button are wrapped in .lw-event-actions in lista-wyjazdowa.js, so the
  // row's mobile column layout keeps the two controls on one line.
  assert.match(
    source,
    /<div class="lw-event-actions">\s*<button type="button" class="lw-attend-toggle"[\s\S]*?\$\{addCompanionHtml\}\s*\$\{editToggleHtml\}\s*<\/div>/,
  );
  assert.match(css, /\.lw-event-actions\s*\{[^}]*display:\s*flex/);
  // On the all-events list the mobile label is shown again (the base rule hides it for the roster).
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.lw-event-row \.lw-add-companion-label\s*\{[^}]*display:\s*inline/);
});

test('KRKG-0101: plus/figure and figure/name gaps are pulled tight', () => {
  assert.match(css, /\.lw-add-companion\s*\{[^}]*gap:\s*0;/);
  assert.match(css, /\.lw-add-companion-icon\s*\{[^}]*margin-left:\s*-0\.18rem/);
  assert.match(css, /\.lw-add-companion-label\s*\{[^}]*margin-left:\s*-0\.14rem/);
  assert.match(css, /\.person-pill-icon\s*\{[^}]*margin-right:\s*-0\.08rem/);
});

test('a newly created event shows 0 os. instead of undefined os. before the next reload', async () => {
  // POST /lista-wyjazdowa/events returns the bare event doc - no attendingCount/viewerAttending/
  // viewerSkladkaPaid, since those are only computed by the GET /events join against signups.
  const harness = createHarness();
  await harness.signIn();
  harness.setMutationResult({ event: { id: 'e2', name: 'Nowy wyjazd', startDate: '2027-09-01', status: 'active', createdBy: 'viewer@example.com', createdAt: '2027-01-01T00:00:00.000Z', description: null, skladkaFee: null, dueDate: null } });

  const form = harness.elements.get('add-event-form')!;
  await form.dispatch('submit');
  if (!harness.elements.get('add-event-error')!.hidden) {
    throw new Error(`submit failed: ${harness.elements.get('add-event-error')!.textContent}`);
  }

  const listHtml = harness.elements.get('events-list')!.innerHTML;
  assert.match(listHtml, /Nowy wyjazd/);
  assert.match(listHtml, /0 os\./);
  assert.doesNotMatch(listHtml, /undefined os\./);
});

test('the old lw-subnav pill row is gone, replaced by the shared sticky top bar', () => {
  assert.doesNotMatch(page, /lw-subnav/);
  assert.match(page, /class="lw-topbar"/);
  assert.match(page, /id="lw-nav-container"/);
  assert.match(page, /shared\/lw-nav\.js/);
  assert.match(page, /shared\/lw-topbar\.js/);
});

test('"Dodaj wyjazd" is a standalone button next to the dropdown, not one of its items', () => {
  assert.doesNotMatch(page, /lw-nav-item--add/);
  assert.match(page, /<a href="\?new=1" class="lw-nav-add" id="lw-nav-add">\+ Dodaj wyjazd<\/a>/);
});

test('signing in renders the dropdown with "Wszystkie" active and no specific trip open', async () => {
  const harness = createHarness();
  await harness.signIn();
  const nav = harness.elements.get('lw-nav-container')!.innerHTML;
  assert.match(nav, /class="lw-nav-item lw-nav-item--all lw-nav-item--active"[^>]*>Wszystkie/);
  assert.match(nav, /Wyjazd Letni/);
  assert.doesNotMatch(nav, /Dodaj wyjazd/);
});

test('clicking the dropdown toggle opens the menu and toggles it back closed', async () => {
  const harness = createHarness();
  await harness.signIn();
  const nav = harness.elements.get('lw-nav-container')!;
  assert.match(nav.innerHTML, /class="lw-nav-menu" role="menu" hidden>/);

  await nav.clickWith({ closest: (q: string) => (q === '.lw-nav-toggle' ? {} : null) });
  assert.doesNotMatch(nav.innerHTML, /class="lw-nav-menu" role="menu" hidden>/);

  await nav.clickWith({ closest: (q: string) => (q === '.lw-nav-toggle' ? {} : null) });
  assert.match(nav.innerHTML, /class="lw-nav-menu" role="menu" hidden>/);
});

test('clicking the standalone "+ Dodaj wyjazd" button reveals the inline form in place, no navigation', async () => {
  const harness = createHarness();
  await harness.signIn();
  const addBtn = harness.elements.get('lw-nav-add')!;
  const form = harness.elements.get('add-event-form')!;
  const title = harness.elements.get('lw-page-title')!;
  form.hidden = true; // matches the real markup's default `hidden` attribute

  let defaultPrevented = false;
  await addBtn.clickWith(addBtn, { preventDefault: () => { defaultPrevented = true; } });

  assert.equal(defaultPrevented, true);
  assert.equal(form.hidden, false);
  assert.equal(title.textContent, 'Dodaj wyjazd');
  assert.equal(harness.elements.get('events-list')!.hidden, true);
});
