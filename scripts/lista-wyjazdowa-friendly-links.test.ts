import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/lista-wyjazdowa.js', import.meta.url), 'utf8');
const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');
const companionAddSource = readFileSync(new URL('../public/shared/companion-add.js', import.meta.url), 'utf8');
const eventEditFormSource = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');
const lwFriendlyUrlSource = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
const lwNavSource = readFileSync(new URL('../public/shared/lw-nav.js', import.meta.url), 'utf8');

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
  classList = {
    list: new Set<string>(),
    add(this: { list: Set<string> }, c: string) { this.list.add(c); },
    remove(this: { list: Set<string> }, c: string) { this.list.delete(c); },
    contains(this: { list: Set<string> }, c: string) { return this.list.has(c); },
  };
  private listeners = new Map<string, Array<(event: any) => unknown>>();

  constructor(id: string) { this.id = id; }
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async clickWith(target: unknown) {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target })));
  }
}

// The page's delegated click handler only reads closest(...) + dataset off the event target, so a
// minimal stub drives it without a real DOM tree (the harness deliberately has none).
function clickTarget(selector: string, dataset: Record<string, string> = {}) {
  const classList = { list: new Set<string>(), add(c: string) { this.list.add(c); }, remove(c: string) { this.list.delete(c); } };
  return { closest: (query: string) => (query === selector ? { dataset, classList } : null), classList };
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'no-profile-panel', 'events-panel',
  'events-list', 'toggle-past-events', 'events-error', 'lw-nav-container', 'lw-nav-add',
  'lw-page-title', 'add-event-form', 'add-event-error',
];

const events = [
  { id: 'e1', name: 'Wolin', startDate: '2027-01-01', status: 'active', viewerAttending: false, attendingCount: 0 },
  { id: 'e2', name: 'Wolin "Żarłoczny"', startDate: '2027-06-15', status: 'active', viewerAttending: false, attendingCount: 0 },
];

function createHarness() {
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;
  let shareCall: { title: string; url: string } | null = null;

  const context: Record<string, unknown> = {
    URLSearchParams, Map, Set, Object, Array, JSON, Date, encodeURIComponent, String,
    window: {
      location: { search: '' },
      navigator: undefined,
      MutationFeedback: { confirmed: async () => {} },
    },
    navigator: { share: async (data: { title: string; url: string }) => { shareCall = data; } },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    },
    initGoogleSignIn: (config: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { signIn = config.onSignedIn; },
    apiFetch: async (url: string) => {
      if (url === '/lista-wyjazdowa/events') return { events };
      if (url === '/lista-wyjazdowa/roster') return { roster: [] };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [], weapons: [] };
      if (url === '/lista-wyjazdowa/member') return { member: { categoryId: 'kandydat' } };
      if (url === '/lista-wyjazdowa/profile') return { profile: { wpisowePaid: true } };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };

  vm.runInNewContext(displayNameSource, context, { filename: 'display-name.js' });
  vm.runInNewContext(companionAddSource, context, { filename: 'companion-add.js' });
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(lwNavSource, context, { filename: 'lw-nav.js' });
  vm.runInNewContext(source, context, { filename: 'lista-wyjazdowa.js' });

  return {
    elements,
    async signIn() { await signIn?.({ email: 'viewer@example.com' }); },
    getShareCall: () => shareCall,
  };
}

test('each event row links to the friendly ?do= URL, not the legacy ?eventId=', async () => {
  const harness = createHarness();
  await harness.signIn();
  const listHtml = harness.elements.get('events-list')!.innerHTML;
  assert.match(listHtml, /href="https:\/\/www\.kruki\.org\/lista-wyjazdowa\/wyjazd\/\?do=2027-01-01-wolin"/);
  assert.doesNotMatch(listHtml, /eventId=/);
});

test('a quote in the event name never reaches the href attribute (slugify strips it)', async () => {
  const harness = createHarness();
  await harness.signIn();
  const listHtml = harness.elements.get('events-list')!.innerHTML;
  assert.match(listHtml, /href="https:\/\/www\.kruki\.org\/lista-wyjazdowa\/wyjazd\/\?do=2027-06-15-wolin-zarloczny"/);
  assert.match(listHtml, /data-event-id="e2"/);
});

test('each row has its own "Udostępnij" share button wired to shareEvent()', async () => {
  const harness = createHarness();
  await harness.signIn();
  const listHtml = harness.elements.get('events-list')!.innerHTML;
  assert.match(listHtml, /class="lw-edit-toggle lw-edit-toggle--icon lw-event-share-button" data-event-id="e1"/);
});

test('clicking the share button shares the correct event via the Web Share API', async () => {
  const harness = createHarness();
  await harness.signIn();
  const target = clickTarget('.lw-event-share-button', { eventId: 'e1' });
  await harness.elements.get('events-list')!.clickWith(target);
  assert.deepEqual(harness.getShareCall(), { title: 'Wolin', url: 'https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=2027-01-01-wolin' });
});
