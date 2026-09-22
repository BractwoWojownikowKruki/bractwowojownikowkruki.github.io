import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/index.html', import.meta.url), 'utf8');
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
  async clickWith(target: unknown) {
    await Promise.all((this.listeners.get('click') ?? []).map(listener => listener({ target })));
  }
  setAttribute() {}
  scrollIntoView() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'not-found-panel', 'main-content', 'lw-error',
  'skladka-fee-display', 'skladka-fee-edit-toggle', 'skladka-fee-edit', 'skladka-fee-input', 'skladka-fee-duedate-input',
  'skladka-fee-save', 'skladka-fee-remove', 'summary-content', 'roster-panel', 'roster-table',
  'roster-content', 'roster-filter-niezgloszeni', 'roster-filter-zgloszeni', 'event-title',
  'event-meta', 'event-description', 'event-edit-toggle', 'event-edit-panel', 'event-history-link',
  'skladka-fee-history-link', 'lw-inline-existing-select', 'lw-inline-new-name',
  'lw-inline-new-category', 'event-equipment-panel', 'event-equipment-table',
  'event-equipment-content', 'lw-nav-container', 'event-share-button', 'event-share-button-text',
];

function createHarness(items: Array<Record<string, unknown>>) {
  const elements = new Map(elementIds.map(id => [id, new Element()]));
  elements.get('roster-filter-zgloszeni')!.checked = true;
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;
  const context: Record<string, unknown> = {
    URLSearchParams, Map, Set, Object, Array, JSON, Date, encodeURIComponent,
    window: {
      location: { search: '?eventId=e1' },
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
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      calls.push({ url, options });
      if (options.method === 'PUT') return { item: { eventId: 'e1', equipmentId: 'tent-1', going: true, lastChangedBy: 'viewer@example.com', lastChangedAt: '2026-09-20T20:00:00.000Z' } };
      if (url === '/lista-wyjazdowa/events') return { events: [{ id: 'e1', name: 'Wyjazd', startDate: '2026-10-10', status: 'active' }] };
      if (url.startsWith('/lista-wyjazdowa/roster?')) return { roster: [{ personId: 'owner@example.com', email: 'owner@example.com', lastName: 'Właściciel', firstName: '', accountless: false, sectionId: 'krakow', categoryId: 'kandydat', weaponIds: [], duesStatus: 'paid', wpisowePaid: true }] };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups: [] };
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki: false, canManagePeople: false };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [{ id: 'krakow', label: 'Kraków' }], categories: [{ id: 'kandydat', label: 'Kandydat' }], weapons: [], equipmentCategories: [{ id: 'tent', label: 'Namiot' }] };
      if (url.startsWith('/lista-wyjazdowa/event-equipment?')) return { items };
      throw new Error(`unexpected request: ${url}`);
    },
  };
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(lwNavSource, context, { filename: 'lw-nav.js' });
  vm.runInNewContext(source, context, { filename: 'wyjazd.js' });
  return { elements, calls, signIn: async () => signIn?.({ email: 'viewer@example.com' }) };
}

test('Wyjazd page loads, renders and locally toggles event equipment', async () => {
  assert.match(html, /id="event-equipment-panel"/);
  assert.match(html, /id="event-equipment-table"/);
  assert.match(html, /<th scope="col" class="czl-section-cell" data-sort-key="section" aria-sort="none" title="Sekcja"><button type="button">S<\/button><\/th>/);
  assert.match(html, /<th scope="col" data-sort-key="category" aria-sort="none"><button type="button">Kategoria<\/button><\/th>/);
  assert.match(html, /<th scope="col" data-sort-key="owner" aria-sort="none"><button type="button">Właściciel<\/button><\/th>/);
  assert.match(html, /<th scope="col" data-sort-key="going" aria-sort="none"><button type="button">Jedzie\?<\/button><\/th>[\s\S]*<th scope="col">Opis<\/th>/);
  const harness = createHarness([{
    id: 'tent-1', categoryId: 'tent', sectionId: 'krakow', belongsToPersonId: 'owner@example.com', description: 'Duży namiot', going: false,
  }]);
  await harness.signIn();

  const equipment = harness.elements.get('event-equipment-content')!;
  assert.match(equipment.innerHTML, /class="czl-section-cell"[^>]*>KRK<\/td>/);
  assert.match(equipment.innerHTML, /Namiot/);
  assert.match(equipment.innerHTML, /Właściciel/);
  assert.match(equipment.innerHTML, /data-profile-trigger data-email="owner@example.com"/);
  assert.match(equipment.innerHTML, /class="lw-attend-toggle"/);
  assert.match(equipment.innerHTML, /Nie jedzie/);
  assert.ok(harness.calls.some(call => call.url.startsWith('/lista-wyjazdowa/event-equipment?eventId=e1')));

  const button = {
    dataset: { equipmentId: 'tent-1', going: 'false' }, disabled: false,
    innerHTML: '<span class="lw-attend-toggle-track" aria-hidden="true"></span>Nie jedzie',
    setAttribute: (name: string, value: string) => { (button as any)[name] = value; },
    closest: (selector: string) => selector === '.lw-attend-toggle' ? button : null,
  };
  await equipment.clickWith(button);
  await new Promise(resolve => setTimeout(resolve, 0));
  const put = harness.calls.find(call => call.options.method === 'PUT');
  assert.equal(put?.url, '/lista-wyjazdowa/event-equipment?eventId=e1&equipmentId=tent-1');
  assert.deepEqual(JSON.parse(String(put?.options.body)), { going: true });
  assert.match(button.innerHTML, /Jedzie/);
  assert.equal(button['aria-pressed'], 'true');
  assert.equal(button.dataset.going, 'true');
  assert.match(equipment.innerHTML, /Namiot/);
  assert.match(equipment.innerHTML, /Właściciel/);
  assert.match(equipment.innerHTML, /Duży namiot/);
});

test('Wyjazd page shows an empty state when no equipment exists', async () => {
  const harness = createHarness([]);
  await harness.signIn();
  assert.match(harness.elements.get('event-equipment-content')!.innerHTML, /Brak sprzętu obozowego/);
});

test('Wyjazd equipment uses Kruki for team-owned items', async () => {
  const harness = createHarness([{
    id: 'team-tent', categoryId: 'tent', sectionId: 'krakow', belongsToPersonId: null,
    description: 'Namiot drużynowy', going: true,
  }]);
  await harness.signIn();
  const equipment = harness.elements.get('event-equipment-content')!;
  assert.match(equipment.innerHTML, />Kruki<\/td>/);
});
