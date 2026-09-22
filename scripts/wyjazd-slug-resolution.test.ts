import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const eventEditFormSource = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');
const lwFriendlyUrlSource = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
const lwNavSource = readFileSync(new URL('../public/shared/lw-nav.js', import.meta.url), 'utf8');

class Element {
  hidden = false;
  textContent = '';
  innerHTML = '';
  href = '';
  disabled = false;
  checked = false;
  value = '';
  dataset: Record<string, string> = {};
  private listeners = new Map<string, Array<(event: any) => unknown>>();

  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  setAttribute() {}
  scrollIntoView() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'not-found-panel', 'main-content', 'lw-error',
  'skladka-fee-display', 'skladka-fee-edit-toggle', 'skladka-fee-edit', 'skladka-fee-input', 'skladka-fee-duedate-input',
  'skladka-fee-save', 'skladka-fee-remove', 'summary-content', 'roster-panel', 'roster-table',
  'roster-content', 'roster-filter-niezgloszeni', 'roster-filter-zgloszeni', 'event-title',
  'event-meta', 'event-edit-toggle', 'event-edit-panel', 'event-history-link',
  'skladka-fee-history-link', 'lw-inline-existing-select', 'lw-inline-new-name',
  'lw-inline-new-category', 'event-equipment-panel', 'event-equipment-table',
  'event-equipment-content', 'lw-nav-container', 'event-share-button', 'event-share-button-text',
];

const events = [
  { id: 'e1', name: 'Wolin', startDate: '2026-01-01', status: 'active' },
  { id: 'e2', name: 'Wolin Żarłoczny', startDate: '2026-06-15', status: 'active' },
];

function createHarness(search: string) {
  const elements = new Map(elementIds.map(id => [id, new Element()]));
  elements.get('roster-filter-zgloszeni')!.checked = true;
  const calls: Array<{ url: string }> = [];
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;
  const context: Record<string, unknown> = {
    URLSearchParams, Map, Set, Object, Array, JSON, Date, encodeURIComponent, String,
    window: {
      location: { search },
      confirm: () => true,
      MutationFeedback: {
        confirmed: async ({ execute, apply }: { execute: () => Promise<unknown>; apply: (result: unknown) => void }) => apply(await execute()),
      },
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    },
    initGoogleSignIn: (config: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { signIn = config.onSignedIn; },
    initSortableTable: () => ({ key: 'section', dir: 'asc' }),
    compareValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    compareDateValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    displayName: (person: { lastName?: string; email?: string }) => person.lastName ?? person.email ?? '',
    personSubline: () => null,
    personPillHtml: ({ name }: { name: string }) => `<span>${name}</span>`,
    apiFetch: async (url: string) => {
      calls.push({ url });
      if (url === '/lista-wyjazdowa/events') return { events };
      if (url.startsWith('/lista-wyjazdowa/roster?')) return { roster: [] };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups: [] };
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki: false, canManagePeople: false };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [], weapons: [], equipmentCategories: [] };
      if (url.startsWith('/lista-wyjazdowa/event-equipment?')) return { items: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(lwNavSource, context, { filename: 'lw-nav.js' });
  vm.runInNewContext(source, context, { filename: 'wyjazd.js' });
  return { elements, calls, signIn: async () => signIn?.({ email: 'viewer@example.com' }) };
}

test('a friendly ?do= slug resolves to the matching event before loadAll() runs', async () => {
  const harness = createHarness('?do=2026-01-01-wolin');
  await harness.signIn();
  assert.equal(harness.elements.get('event-title')!.textContent, 'Wolin');
  assert.ok(harness.elements.get('not-found-panel')!.hidden);
  assert.ok(harness.elements.get('main-content')!.hidden === false);
  assert.ok(harness.calls.some(c => c.url.startsWith('/lista-wyjazdowa/roster?eventId=e1')));
});

test('an unmatched ?do= slug shows the not-found panel and never calls loadAll()', async () => {
  const harness = createHarness('?do=2099-01-01-nieistniejacy-wyjazd');
  await harness.signIn();
  assert.ok(harness.elements.get('not-found-panel')!.hidden === false);
  assert.ok(harness.elements.get('main-content')!.hidden);
  assert.ok(!harness.calls.some(c => c.url.startsWith('/lista-wyjazdowa/roster?')));
});

test('the legacy ?eventId= param still works and skips slug resolution', async () => {
  const harness = createHarness('?eventId=e2');
  await harness.signIn();
  assert.equal(harness.elements.get('event-title')!.textContent, 'Wolin Żarłoczny');
  assert.ok(harness.elements.get('not-found-panel')!.hidden);
  // Only one /lista-wyjazdowa/events call - the legacy path never needs the extra resolution fetch.
  assert.equal(harness.calls.filter(c => c.url === '/lista-wyjazdowa/events').length, 1);
});
