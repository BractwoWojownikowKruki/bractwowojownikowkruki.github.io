import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/index.html', import.meta.url), 'utf8');
const eventEditFormSource = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');
const lwFriendlyUrlSource = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
const lwNavSource = readFileSync(new URL('../public/shared/lw-nav.js', import.meta.url), 'utf8');
const duesStatusSource = readFileSync(new URL('../public/shared/dues-status.js', import.meta.url), 'utf8');
const summaryFilterSource = readFileSync(new URL('../public/shared/summary-filter.js', import.meta.url), 'utf8');

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
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }
  setAttribute() {}
  scrollIntoView() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'not-found-panel', 'main-content', 'lw-error',
  'skladka-fee-display', 'skladka-fee-edit-toggle', 'skladka-fee-edit', 'skladka-fee-input', 'skladka-fee-duedate-input',
  'skladka-fee-save', 'skladka-fee-remove', 'summary-content', 'summary-panel', 'roster-panel', 'roster-table',
  'roster-content', 'roster-filter-niezgloszeni', 'roster-filter-zgloszeni', 'event-title',
  'event-meta', 'event-description', 'event-edit-toggle', 'event-edit-panel', 'event-history-link',
  'skladka-fee-history-link', 'lw-inline-existing-select', 'lw-inline-new-name',
  'lw-inline-new-category', 'event-equipment-panel', 'event-equipment-table', 'event-equipment-table-wrap', 'event-equipment-disabled-note', 'event-equipment-summary', 'equipment-controls', 'equipment-filter-niezgloszone', 'equipment-filter-zgloszone', 'event-date-pill', 'event-date-wrap', 'event-calendar-popover', 'skladka-fee-duedate-pill', 'event-description-panel',
  'event-equipment-content', 'lw-nav-container', 'event-share-button', 'event-share-button-text',
];

function createHarness(items: Array<Record<string, unknown>>, eventOverrides: Record<string, unknown> = {}, signupRows: Array<Record<string, unknown>> = []) {
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
      addEventListener: () => {},
    },
    initGoogleSignIn: (config: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { signIn = config.onSignedIn; },
    initSortableTable: () => ({ key: 'section', dir: 'asc' }),
    compareValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    compareDateValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    displayName: (person: { lastName?: string; email?: string }) => person.lastName ?? person.email ?? '',
    personSubline: () => null,
    personPillHtml: ({ name }: { name: string }) => `<span>${name}</span>`,
    equipmentPillHtml: ({ id, description }: { id: string; description: string | null }, fallback?: string) => `<button data-equipment-trigger data-equipment-id="${id}">${description || fallback}</button>`,
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      calls.push({ url, options });
      if (options.method === 'PUT') return { item: { eventId: 'e1', equipmentId: 'tent-1', going: true, lastChangedBy: 'viewer@example.com', lastChangedAt: '2026-09-20T20:00:00.000Z' } };
      if (url === '/lista-wyjazdowa/events') return { events: [{ id: 'e1', name: 'Wyjazd', startDate: '2026-10-10', status: 'active', ...eventOverrides }] };
      if (url.startsWith('/lista-wyjazdowa/roster?')) return { roster: [{ personId: 'owner@example.com', email: 'owner@example.com', lastName: 'Właściciel', firstName: '', accountless: false, sectionId: 'krakow', categoryId: 'kandydat', weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'paid' }] };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups: signupRows };
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki: false, canManagePeople: false };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [{ id: 'krakow', label: 'Kraków' }], categories: [{ id: 'kandydat', label: 'Kandydat' }], weapons: [], equipmentCategories: [{ id: 'tent', label: 'Namiot' }, { id: 'namiot', label: 'Namiot', groupId: 'budowle' }, { id: 'wiata', label: 'Wiata', groupId: 'budowle' }, { id: 'stol', label: 'Stół', groupId: 'meble' }, { id: 'garnek', label: 'Garnek', groupId: 'kuchnia' }], equipmentGroups: [{ id: 'budowle', label: 'Budowle' }, { id: 'meble', label: 'Meble' }, { id: 'kuchnia', label: 'Kuchnia' }] };
      if (url.startsWith('/lista-wyjazdowa/event-equipment?')) return { items };
      throw new Error(`unexpected request: ${url}`);
    },
  };
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(lwNavSource, context, { filename: 'lw-nav.js' });
  vm.runInNewContext(duesStatusSource, context, { filename: 'dues-status.js' });
  vm.runInNewContext(summaryFilterSource, context, { filename: 'summary-filter.js' });
  vm.runInNewContext(source, context, { filename: 'wyjazd.js' });
  const setEquipmentFilter = (notGoing: boolean, going: boolean) => {
    elements.get('equipment-filter-niezgloszone')!.checked = notGoing;
    elements.get('equipment-filter-zgloszone')!.checked = going;
    elements.get('equipment-filter-zgloszone')!.fire('change');
  };
  return { elements, calls, setEquipmentFilter, signIn: async () => signIn?.({ email: 'viewer@example.com' }) };
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
  harness.setEquipmentFilter(true, true);

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

test('Wyjazd equipment shows a private item under its owner\'s current section, not the stored one', async () => {
  // The owner (roster: krakow) moved section after the item was saved with sectionId 'warszawa'.
  const harness = createHarness([{
    id: 'old-tent', categoryId: 'tent', sectionId: 'warszawa', belongsToPersonId: 'owner@example.com',
    description: 'Stary namiot', going: false,
  }]);
  await harness.signIn();
  harness.setEquipmentFilter(true, true);
  const equipment = harness.elements.get('event-equipment-content')!;
  assert.match(equipment.innerHTML, /<tr data-section="krakow">/);
  assert.match(equipment.innerHTML, /class="czl-section-cell"[^>]*>KRK<\/td>/);
});

test('Wyjazd page hides the equipment table and shows a note when the event has noCampEquipment', async () => {
  const harness = createHarness([], { noCampEquipment: true });
  await harness.signIn();
  assert.equal(harness.elements.get('event-equipment-table-wrap')!.hidden, true);
  assert.equal(harness.elements.get('event-equipment-disabled-note')!.hidden, false);
});

test('Wyjazd page tallies what is going per category (Krucza architektura, Meble, Kuchnia) and in the headcount line', async () => {
  const item = (id: string, categoryId: string, going: boolean) => ({ id, categoryId, sectionId: 'krakow', belongsToPersonId: null, description: id, going });
  const harness = createHarness([
    item('g1', 'garnek', true), item('s1', 'stol', true), item('n1', 'namiot', true), item('n2', 'namiot', true),
    item('n3', 'namiot', true), item('w1', 'wiata', true), item('w2', 'wiata', true), item('n4', 'namiot', false),
  ]);
  await harness.signIn();
  const summary = harness.elements.get('event-equipment-summary')!.innerHTML;
  assert.match(summary, /Krucza architektura/);
  assert.doesNotMatch(summary, /Budowle/);
  assert.ok(summary.indexOf('Krucza architektura') < summary.indexOf('Meble') && summary.indexOf('Meble') < summary.indexOf('Kuchnia'));
  assert.match(summary, /Namiot<span class="lw-summary-badge">3<\/span>/);
  assert.match(summary, /Wiata<span class="lw-summary-badge">2<\/span>/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /os\., 3 namioty, 2 wiaty/);
});

test('Wyjazd headcount line says 0 namiotów, 0 wiat without equipment, and nothing with noCampEquipment', async () => {
  const none = createHarness([]);
  await none.signIn();
  assert.match(none.elements.get('summary-content')!.innerHTML, /os\., 0 namiotów, 0 wiat/);
  const off = createHarness([], { noCampEquipment: true });
  await off.signIn();
  assert.doesNotMatch(off.elements.get('summary-content')!.innerHTML, /namiot/);
});

test('Wyjazd date pill, deadline pill with days left, and equipment category filter', async () => {
  const d = new Date();
  const iso = (offset: number) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const item = (id: string, categoryId: string) => ({ id, categoryId, sectionId: 'krakow', belongsToPersonId: null, description: id, going: true });
  const harness = createHarness([item('n1', 'namiot'), item('g1', 'garnek')], { skladkaFee: '50 zł', dueDate: iso(5) });
  await harness.signIn();
  assert.match(harness.elements.get('event-date-pill')!.innerHTML, /10\.10\.2026/);
  assert.match(harness.elements.get('skladka-fee-duedate-pill')!.innerHTML, /termin<\/small> \d\d\.\d\d\.\d{4} <span class="lw-deadline-days">\(za 5 dni\)/);
  assert.equal(harness.elements.get('skladka-fee-duedate-pill')!.hidden, false);
  const table = harness.elements.get('event-equipment-content')!;
  assert.match(table.innerHTML, /n1/);
  assert.match(table.innerHTML, /g1/);
});

test('Wyjazd equipment checkboxes: Zgłoszone by default, Niezgłoszone on request, both, or neither', async () => {
  const item = (id: string, going: boolean) => ({ id, categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: id, going });
  const harness = createHarness([item('item-go', true), item('item-stay', false)]);
  await harness.signIn();
  const table = harness.elements.get('event-equipment-content')!;
  assert.match(table.innerHTML, /item-go/);
  assert.doesNotMatch(table.innerHTML, /item-stay/);
  harness.setEquipmentFilter(true, false);
  assert.doesNotMatch(table.innerHTML, /item-go/);
  assert.match(table.innerHTML, /item-stay/);
  harness.setEquipmentFilter(true, true);
  assert.match(table.innerHTML, /item-go/);
  assert.match(table.innerHTML, /item-stay/);
  harness.setEquipmentFilter(false, false);
  assert.match(table.innerHTML, /Brak sprzętu dla wybranych filtrów/);
});

test('Wyjazd deadline pill: green once the viewer paid, red when unpaid past the deadline, neutral otherwise', async () => {
  const past = '2020-01-01';
  const paid = createHarness([], { skladkaFee: '50 zł', dueDate: past }, [{ memberEmail: 'viewer@example.com', attending: true, skladkaStatus: 'paid' }]);
  await paid.signIn();
  assert.equal(paid.elements.get('skladka-fee-duedate-pill')!.dataset.state, 'paid');
  assert.match(paid.elements.get('skladka-fee-duedate-pill')!.innerHTML, /✓/);
  assert.doesNotMatch(paid.elements.get('skladka-fee-duedate-pill')!.innerHTML, /opłacona<\/|· opłacona/);
  const unpaid = createHarness([], { skladkaFee: '50 zł', dueDate: past }, [{ memberEmail: 'viewer@example.com', attending: true, skladkaStatus: 'unpaid' }]);
  await unpaid.signIn();
  assert.equal(unpaid.elements.get('skladka-fee-duedate-pill')!.dataset.state, 'unpaid-overdue');
  assert.match(unpaid.elements.get('skladka-fee-duedate-pill')!.innerHTML, /✗ ☠☠/);
  const notAttending = createHarness([], { skladkaFee: '50 zł', dueDate: past });
  await notAttending.signIn();
  assert.equal(notAttending.elements.get('skladka-fee-duedate-pill')!.dataset.state, 'neutral');
});
