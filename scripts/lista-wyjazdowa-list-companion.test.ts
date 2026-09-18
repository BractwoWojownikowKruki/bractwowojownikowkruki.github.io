import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/lista-wyjazdowa.js', import.meta.url), 'utf8');
const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');
const companionAddSource = readFileSync(new URL('../public/shared/companion-add.js', import.meta.url), 'utf8');
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
  scrollIntoView() {}
}

// The page's delegated click handler only reads closest(...) + dataset off the event target, so a
// minimal stub drives it without a real DOM tree (the harness deliberately has none).
function clickTarget(selector: string, dataset: Record<string, string> = {}) {
  return { closest: (query: string) => (query === selector ? { dataset } : null) };
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'no-profile-panel', 'events-panel',
  'events-list', 'toggle-past-events', 'events-error', 'lw-subnav-list', 'lw-subnav-add',
  'lw-page-title', 'add-event-form', 'add-event-error',
  // Rendered into #events-list's innerHTML in the real DOM; the stub can't parse that, so the
  // panel's controls are looked up directly by id.
  'lw-inline-existing-select', 'lw-inline-new-name', 'lw-inline-new-category',
];

interface HarnessOptions {
  viewerAttending?: boolean;
  withAttachedPerson?: boolean;
  hiddenMember?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const viewerAttending = options.viewerAttending ?? true;
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = null;
  let mutationError: Error | null = null;
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;

  const events = [
    { id: 'e1', name: 'Wyjazd Letni', startDate: '2027-05-01', status: 'active', viewerAttending, attendingCount: 2 },
  ];
  const roster = [
    { personId: 'viewer@example.com', email: 'viewer@example.com', accountless: false, fullName: 'Viewer', sectionId: null, categoryId: null, weaponIds: [], equipment: [] },
    ...(options.withAttachedPerson
      ? [{ personId: 'attached-uuid-1', email: null, accountless: true, ownerPersonId: 'viewer@example.com', fullName: 'Młody', sectionId: null, categoryId: 'kandydat', weaponIds: [], equipment: [] }]
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
      if (url === '/lista-wyjazdowa/profile') return { profile: { equipment: [], wpisowePaid: true } };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups: [] };
      if (url.startsWith('/lista-wyjazdowa/signups/mine?')) return { signup: null };
      throw new Error(`unexpected request: ${url}`);
    },
  };

  vm.runInNewContext(displayNameSource, context, { filename: 'display-name.js' });
  vm.runInNewContext(companionAddSource, context, { filename: 'companion-add.js' });
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
    signup: { memberEmail: 'attached-uuid-1', attending: true, skladkaPaid: false, equipmentIds: [] },
  });

  await list.clickWith(clickTarget('.lw-inline-add-existing'));

  const post = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.equal(post?.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(post?.options.body)), { eventId: 'e1', ownerPersonId: 'viewer@example.com', mode: 'existing', personId: 'attached-uuid-1' });
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
  harness.setMutationResult({ signup: { memberEmail: 'viewer@example.com', attending: true, skladkaPaid: false, equipmentIds: [] } });

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
