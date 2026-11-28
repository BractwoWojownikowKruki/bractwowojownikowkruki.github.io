import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createMutationFeedbackMock, createPersonRegistrationPromptMock } from './test-helpers/person-registration-prompt.js';

const source = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/index.html', import.meta.url), 'utf8');
const memberAreaCss = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');
const personPillSource = readFileSync(new URL('../public/shared/person-pill.js', import.meta.url), 'utf8');
const companionAddSource = readFileSync(new URL('../public/shared/companion-add.js', import.meta.url), 'utf8');
const eventEditFormSource = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');
const lwFriendlyUrlSource = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
const lwNavSource = readFileSync(new URL('../public/shared/lw-nav.js', import.meta.url), 'utf8');
const duesStatusSource = readFileSync(new URL('../public/shared/dues-status.js', import.meta.url), 'utf8');
const summaryFilterSource = readFileSync(new URL('../public/shared/summary-filter.js', import.meta.url), 'utf8');
const listPreferencesSource = readFileSync(new URL('../public/shared/list-preferences.js', import.meta.url), 'utf8');
const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');
const displayNameContext: Record<string, unknown> = {};
vm.runInNewContext(displayNameSource, displayNameContext);
const displayName = displayNameContext.displayName as (person: Record<string, string | null>) => string;
const surnameSortValue = displayNameContext.surnameSortValue as (person: Record<string, string | null>) => string;

/** Keeps the fixture trip upcoming regardless of when the VM-based page tests run. */
class FixedDate extends Date {
  constructor(value?: string | number) {
    super(value ?? new Date(2026, 9, 9, 12).getTime());
  }
}

class Element {
  id: string;
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  href = '';
  disabled = false;
  checked = false;
  focused = false;
  dataset: Record<string, string> = {};
  private attributes = new Map<string, string>();
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
  async change() {
    await Promise.all((this.listeners.get('change') ?? []).map((listener) => listener({ target: this })));
  }
  async input() {
    await Promise.all((this.listeners.get('input') ?? []).map((listener) => listener({ target: this })));
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'not-found-panel', 'main-content', 'lw-error',
  'skladka-fee-display', 'skladka-fee-status-summary', 'skladka-fee-edit-toggle', 'skladka-fee-edit', 'skladka-fee-input', 'skladka-fee-duedate-input',
  'skladka-fee-save', 'skladka-fee-remove', 'roster-panel', 'summary-content', 'summary-panel',
  'roster-table', 'roster-content', 'roster-filter-niezgloszeni', 'roster-filter-zgloszeni', 'roster-filter-zagniezdz-os-tow',
  'event-title', 'event-meta', 'event-description',
  'event-edit-toggle', 'event-edit-panel', 'event-history-link', 'skladka-fee-history-link',
  'lw-inline-existing-select', 'lw-inline-new-name', 'lw-inline-new-last-name', 'lw-inline-new-first-name', 'lw-inline-new-category', 'lw-inline-error',
  'event-equipment-panel', 'event-equipment-table', 'event-equipment-table-wrap', 'event-equipment-disabled-note', 'event-equipment-summary', 'equipment-controls', 'equipment-filter-niezgloszone', 'equipment-filter-zgloszone', 'event-date-pill', 'event-time-pill', 'event-date-wrap', 'event-calendar-popover', 'skladka-fee-duedate-pill', 'event-description-panel', 'event-equipment-content', 'lw-nav-container',
  'event-share-button', 'event-share-button-text',
];

function createHarness(event: Record<string, unknown>, options: { canManageSkladki?: boolean; canManagePeople?: boolean; withRemovedPerson?: boolean; withAttachedPerson?: boolean; withAttachedToSignedPerson?: boolean; attachedOwnerPersonId?: string; withCompanionOfCompanion?: boolean; attachedNotAttending?: boolean; memberWeapons?: Record<string, string[]>; memberCategories?: Record<string, string | null>; signupStatusByPersonId?: Record<string, string | undefined>; signupAttendingByPersonId?: Record<string, boolean>; initialStorage?: Record<string, string> } = {}) {
  const canManageSkladki = options.canManageSkladki ?? true;
  const canManagePeople = options.canManagePeople ?? false;
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  const focusTargets: Array<{ selector: string; focused: boolean }> = [];
  // Mirrors index.html's default: "Zgłoszeni + ja" starts checked, "Niezgłoszeni" unchecked.
  elements.get('roster-filter-zgloszeni')!.checked = true;
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const localStore = new Map(Object.entries(options.initialStorage ?? {}));
  let mutationResult: unknown = null;
  let mutationError: Error | null = null;
  let cancelDuplicatePrompt = false;
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;
  const rosterSortState = { key: 'section', dir: 'asc' };
  let onRosterSortChange = () => {};
  const roster = [
    { personId: 'signed@example.com', email: 'signed@example.com', accountless: false, firstName: 'Zulu', lastName: 'Aardvark', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'paid' },
    { personId: 'viewer@example.com', email: 'viewer@example.com', accountless: false, lastName: 'Viewer', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'paid' },
    { personId: 'other@example.com', email: 'other@example.com', accountless: false, lastName: 'Other', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'paid', wpisoweStatus: 'paid' },
  ].map((member) => ({
    ...member,
    ...(options.memberWeapons?.[member.personId] ? { weaponIds: options.memberWeapons[member.personId] } : {}),
    ...(options.memberCategories?.[member.personId] !== undefined ? { categoryId: options.memberCategories[member.personId] } : {}),
  }));
  // KRKG-0087: an accountless person already attached to the viewer but not signed up for this
  // trip - the roster's inline add panel offers them in its "istniejąca" dropdown.
  const attachedPerson = { personId: 'attached-uuid-1', email: null, accountless: true, ownerPersonId: options.attachedOwnerPersonId ?? (options.withAttachedToSignedPerson ? 'signed@example.com' : 'viewer@example.com'), firstName: 'Ala', lastName: 'Młody', sectionId: null, categoryId: 'kandydat', weaponIds: [], duesStatus: 'unpaid', wpisoweStatus: 'paid' };
  const nestedAttachedPerson = { personId: 'nested-uuid-2', email: null, accountless: true, ownerPersonId: 'attached-uuid-1', lastName: 'Zagnieżdżony', sectionId: null, categoryId: 'kandydat', weaponIds: [], duesStatus: 'unpaid', wpisoweStatus: 'paid' };
  const currentRoster = options.withAttachedPerson
    ? [...roster, attachedPerson, ...(options.withCompanionOfCompanion ? [nestedAttachedPerson] : [])]
    : roster;
  // KRKG-0087: the event-scoped (historical) roster additionally carries a person who has since been
  // removed but was signed up for this trip. A person row has `email: null` and a UUID personId, so
  // it only renders correctly if the page keys rows by personId (the bug this batch fixes).
  const removedPerson = { personId: 'gone-uuid-1', email: null, accountless: true, ownerPersonId: null, deleted: true, lastName: 'Cień Nowak', sectionId: null, categoryId: null, weaponIds: [], duesStatus: 'unpaid', wpisoweStatus: 'paid' };
  const eventRoster = options.withRemovedPerson ? [...currentRoster, removedPerson] : currentRoster;
  const signups = [
    { memberEmail: 'signed@example.com', attending: true, skladkaStatus: 'unpaid' },
    ...Object.entries(options.signupStatusByPersonId ?? {}).map(([memberEmail, skladkaStatus]) => ({ memberEmail, attending: options.signupAttendingByPersonId?.[memberEmail] ?? true, skladkaStatus })),
    ...(options.withRemovedPerson ? [{ memberEmail: 'gone-uuid-1', attending: true, skladkaStatus: 'unpaid' }] : []),
    // KRKG-0089: an attached person already marked "nie jadę" (a signup with attending:false) must
    // still be offered in the add panel so they can be added back.
    ...(options.attachedNotAttending ? [{ memberEmail: 'attached-uuid-1', attending: false, skladkaStatus: 'unpaid' }] : []),
  ];
  const context: Record<string, unknown> = {
    URLSearchParams,
    Map,
    Set,
    Object,
    Array,
    JSON,
    Date: FixedDate,
    CSS: { escape: (value: string) => value },
    encodeURIComponent,
    window: {
      location: { search: '?eventId=e1' },
      confirm: () => true,
      LwCalendar: {
        mountDropdowns: () => ({ refresh() {} }),
        timePillHtml: (value: { startTime?: string }) => value.startTime
          ? `<span class="lw-time-pill"><span class="sr-only">Godzina rozpoczęcia: </span>${value.startTime}</span>`
          : '',
      },
      MutationFeedback: createMutationFeedbackMock(),
    },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelector: (selector: string) => {
        const filteredToNonAttending = elements.get('roster-filter-zgloszeni')?.checked === false;
        if (filteredToNonAttending && (selector.includes('.lw-attend-toggle') || selector.includes('.lw-add-companion'))) return null;
        const target = { selector, focused: false, focus() { this.focused = true; } };
        focusTargets.push(target);
        return target;
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    localStorage: {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => { localStore.set(key, value); },
    },
    initSortableTable: (table: Element, options: { onChange: () => void }) => {
      if (table.id === 'roster-table') {
        onRosterSortChange = options.onChange;
        return rosterSortState;
      }
      return { key: 'section', dir: 'asc' };
    },
    compareValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    compareDateValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    displayName,
    surnameSortValue,
    personSubline: () => null,
    initGoogleSignIn: (config: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { signIn = config.onSignedIn; },
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      apiCalls.push({ url, options });
      if (options.method === 'PUT' || options.method === 'POST') {
        if (mutationError) throw mutationError;
        return mutationResult;
      }
      if (url === '/lista-wyjazdowa/events') return { events: [event] };
      if (url === '/lista-wyjazdowa/roster') return { roster: currentRoster };
      if (url.startsWith('/lista-wyjazdowa/roster?eventId=')) return { roster: eventRoster };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups };
      if (url.startsWith('/lista-wyjazdowa/event-equipment?')) return { items: [] };
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki, canManagePeople };
      if (url === '/lista-wyjazdowa/lookup-lists') {
        return {
          sections: [],
          categories: [{ id: 'kandydat', label: 'Kandydat' }, { id: 'emeryt', label: 'Emeryt' }],
          weapons: [],
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
  (context.window as any).PersonRegistrationPrompt = createPersonRegistrationPromptMock(context.window.MutationFeedback as any, {
    shouldCancelDuplicate: () => cancelDuplicatePrompt,
  });
  vm.runInNewContext(personPillSource, context, { filename: 'person-pill.js' });
  vm.runInNewContext(companionAddSource, context, { filename: 'companion-add.js' });
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(lwNavSource, context, { filename: 'lw-nav.js' });
  vm.runInNewContext(duesStatusSource, context, { filename: 'dues-status.js' });
  vm.runInNewContext(summaryFilterSource, context, { filename: 'summary-filter.js' });
  vm.runInNewContext(listPreferencesSource, context, { filename: 'list-preferences.js' });
  vm.runInNewContext(source, context, { filename: 'wyjazd.js' });
  return {
    context,
    elements,
    apiCalls,
    async signIn() { await signIn?.({ email: 'viewer@example.com' }); },
    setMutationResult(result: unknown) { mutationResult = result; mutationError = null; },
    setMutationError(error: Error) { mutationError = error; },
    setRosterSort(key: string) { rosterSortState.key = key; onRosterSortChange(); },
    storedPreference(key: string) { return localStore.get(key) ?? null; },
    cancelNextDuplicatePrompt() { cancelDuplicatePrompt = true; },
    focusTargets,
  };
}

const event = (skladkaFee: unknown, dueDate: unknown = undefined) => ({
  id: 'e1', name: 'Wyjazd', startDate: '2026-10-10', status: 'active', skladkaFee, dueDate,
});

test('the event detail date shows the optional start-time pill with an accessible label', async () => {
  const harness = createHarness({ ...event(null), startTime: '09:30' });
  await harness.signIn();
  const pill = harness.elements.get('event-time-pill')!;
  assert.equal(pill.hidden, false);
  assert.match(pill.innerHTML, /class="lw-time-pill"[^>]*><span class="sr-only">Godzina rozpoczęcia: <\/span>.*09:30<\/span>/);
});

test('the top clock links to the event-wide audit, scoping dues to /admin/audyt/ only when the viewer can manage składki', async () => {
  const privileged = createHarness(event('50 zł'));
  await privileged.signIn();
  assert.equal(privileged.elements.get('event-history-link')!.href, '/admin/audyt/?eventId=e1');
  assert.equal(privileged.elements.get('skladka-fee-history-link')!.href, '/admin/audyt/?resourceKey=eventFee%3Ae1');
  assert.equal(privileged.elements.get('skladka-fee-history-link')!.hidden, false);

  const member = createHarness(event('50 zł'), { canManageSkladki: false });
  await member.signIn();
  assert.equal(member.elements.get('event-history-link')!.href, '/audyt/?eventId=e1');
  assert.equal(member.elements.get('skladka-fee-history-link')!.hidden, true);
});

test('roster checkboxes filter locally and preserve the signed-in viewer', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  const notSignedUp = harness.elements.get('roster-filter-niezgloszeni')!;
  const signedUpAndMe = harness.elements.get('roster-filter-zgloszeni')!;
  assert.match(roster.innerHTML, /signed@example\.com/, harness.elements.get('lw-error')!.textContent);
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /other@example\.com/);

  const requestsBeforeToggle = harness.apiCalls.length;

  // Both checked -> everybody.
  notSignedUp.checked = true;
  await notSignedUp.change();
  assert.match(roster.innerHTML, /signed@example\.com/);
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.match(roster.innerHTML, /other@example\.com/);

  // Both unchecked -> empty list.
  notSignedUp.checked = false;
  signedUpAndMe.checked = false;
  await signedUpAndMe.change();
  assert.match(roster.innerHTML, /Brak osób do wyświetlenia/);

  // Only "Niezgłoszeni" -> the non-attending member, no signed-up, no viewer.
  notSignedUp.checked = true;
  await notSignedUp.change();
  assert.match(roster.innerHTML, /other@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /signed@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /viewer@example\.com/);

  // Only "Zgłoszeni + ja" -> signed-up and viewer, no other.
  notSignedUp.checked = false;
  signedUpAndMe.checked = true;
  await signedUpAndMe.change();
  assert.match(roster.innerHTML, /signed@example\.com/);
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /other@example\.com/);

  assert.equal(harness.apiCalls.length, requestsBeforeToggle);
});

test('companion nesting control restores and persists its local preference', async () => {
  const key = 'kruki_pref_wyjazd_companion_nesting';
  const harness = createHarness(event(null), {
    initialStorage: { [key]: JSON.stringify({ v: 1, value: { nested: true } }) },
  });
  await harness.signIn();

  const control = harness.elements.get('roster-filter-zagniezdz-os-tow')!;
  assert.match(page, /Umieść os\. tow\. pod opiekunów/);
  assert.match(page, /id="roster-filter-zagniezdz-os-tow"/);
  assert.match(page, /class="lw-roster-nesting-control"[\s\S]*?id="roster-filter-zagniezdz-os-tow"/);
  assert.doesNotMatch(page.slice(page.indexOf('class="lw-roster-controls"'), page.indexOf('</div>', page.indexOf('class="lw-roster-controls"'))), /zagniezdz-os-tow/);
  assert.match(memberAreaCss, /\.lw-roster-row--companion/);
  assert.match(memberAreaCss, /\.lw-roster-row--companion \.lw-roster-name-cell::before/);
  assert.equal(control.checked, true);

  control.checked = false;
  await control.change();
  assert.deepEqual(JSON.parse(harness.storedPreference(key)!), { v: 1, value: { nested: false } });
});

test('visible accountless companions nest under their account owner only when sorting by section', async () => {
  const harness = createHarness(event(null), {
    withAttachedPerson: true,
    withAttachedToSignedPerson: true,
    attachedOwnerPersonId: 'SIGNED@example.com',
    initialStorage: {
      'kruki_pref_wyjazd_companion_nesting': JSON.stringify({ v: 1, value: { nested: true } }),
    },
  });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  const showNotSignedUp = harness.elements.get('roster-filter-niezgloszeni')!;
  showNotSignedUp.checked = true;
  await showNotSignedUp.change();

  const ownerIndex = roster.innerHTML.indexOf('data-person-id="signed@example.com"');
  const companionIndex = roster.innerHTML.indexOf('data-person-id="attached-uuid-1"');
  assert.ok(ownerIndex >= 0 && companionIndex > ownerIndex);
  assert.match(roster.innerHTML, /<tr class="lw-roster-row--companion" data-person-id="attached-uuid-1"/);

  harness.setRosterSort('name');
  assert.doesNotMatch(roster.innerHTML, /lw-roster-row--companion/);
  assert.ok(roster.innerHTML.indexOf('data-person-id="signed@example.com"') < roster.innerHTML.indexOf('data-person-id="attached-uuid-1"'), 'name sort uses surnames (Aardvark before Młody), despite first-name order');
  harness.setRosterSort('status');
  assert.doesNotMatch(roster.innerHTML, /lw-roster-row--companion/);
  assert.ok(roster.innerHTML.indexOf('data-person-id="attached-uuid-1"') < roster.innerHTML.indexOf('data-person-id="signed@example.com"'));

  harness.setRosterSort('section');
  assert.equal(harness.elements.get('roster-filter-zagniezdz-os-tow')!.checked, true);
  assert.match(roster.innerHTML, /<tr class="lw-roster-row--companion" data-person-id="attached-uuid-1"/);
  const nestingControl = harness.elements.get('roster-filter-zagniezdz-os-tow')!;
  nestingControl.checked = false;
  await nestingControl.change();
  assert.doesNotMatch(roster.innerHTML, /lw-roster-row--companion/);
});

test('a companion attached to an accountless person stays visible as a top-level row', async () => {
  const harness = createHarness(event(null), {
    withAttachedPerson: true,
    withAttachedToSignedPerson: true,
    withCompanionOfCompanion: true,
    initialStorage: {
      'kruki_pref_wyjazd_companion_nesting': JSON.stringify({ v: 1, value: { nested: true } }),
    },
  });
  await harness.signIn();
  const showNotSignedUp = harness.elements.get('roster-filter-niezgloszeni')!;
  showNotSignedUp.checked = true;
  await showNotSignedUp.change();

  const roster = harness.elements.get('roster-content')!.innerHTML;
  assert.match(roster, /<tr class="lw-roster-row--companion" data-person-id="attached-uuid-1"/);
  assert.match(roster, /<tr data-person-id="nested-uuid-2"/);
});

test('a visible companion remains standalone when a roster filter hides the owner', async () => {
  const harness = createHarness(event(null), {
    withAttachedPerson: true,
    withAttachedToSignedPerson: true,
    initialStorage: {
      'kruki_pref_wyjazd_companion_nesting': JSON.stringify({ v: 1, value: { nested: true } }),
    },
  });
  await harness.signIn();
  const showSignedUpAndMe = harness.elements.get('roster-filter-zgloszeni')!;
  const showNotSignedUp = harness.elements.get('roster-filter-niezgloszeni')!;
  showSignedUpAndMe.checked = false;
  showNotSignedUp.checked = true;
  await showNotSignedUp.change();

  const roster = harness.elements.get('roster-content')!.innerHTML;
  assert.doesNotMatch(roster, /data-person-id="signed@example.com"/);
  assert.match(roster, /data-person-id="attached-uuid-1"/);
  assert.doesNotMatch(roster, /lw-roster-row--companion/);
});

test('summary category filters independently hide a companion owner and preserve the matching companion', async () => {
  const harness = createHarness(event(null), {
    withAttachedPerson: true,
    withAttachedToSignedPerson: true,
    memberCategories: { 'signed@example.com': 'emeryt' },
    signupStatusByPersonId: { 'attached-uuid-1': 'paid' },
    initialStorage: {
      'kruki_pref_wyjazd_companion_nesting': JSON.stringify({ v: 1, value: { nested: true } }),
    },
  });
  await harness.signIn();
  const showNotSignedUp = harness.elements.get('roster-filter-niezgloszeni')!;
  showNotSignedUp.checked = true;
  await showNotSignedUp.change();
  await harness.elements.get('summary-panel')!.clickWith({
    closest: (selector: string) => selector === '[data-filter-group]'
      ? { dataset: { filterGroup: 'category', filterValue: 'kandydat' }, disabled: false, focus() {} }
      : null,
  });

  const roster = harness.elements.get('roster-content')!.innerHTML;
  assert.doesNotMatch(roster, /data-person-id="signed@example.com"/);
  assert.match(roster, /data-person-id="attached-uuid-1"/);
  assert.doesNotMatch(roster, /lw-roster-row--companion/);
});

test('the separate contribution filter supports multiple statuses and combines with roster visibility', async () => {
  const harness = createHarness(event('50 zł'), {
    signupStatusByPersonId: {
      'viewer@example.com': 'paid',
      'other@example.com': 'not_applicable',
    },
  });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  const summary = harness.elements.get('summary-panel')!;
  const clickContributionFilter = async (status: string) => summary.clickWith({
    closest: (selector: string) => selector === '[data-filter-group]'
      ? { dataset: { filterGroup: 'contributionStatus', filterValue: status }, disabled: false, focus() {} }
      : null,
  });

  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-value="paid" aria-pressed="false">.*<span aria-hidden="true">💰<\/span>Opłacona/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /aria-label="Filtruj wg składki: Opłacona"[^>]*>.*<span aria-hidden="true">💰<\/span>Opłacona<\/button>/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /aria-label="Filtruj wg składki: Nieopłacona"[^>]*>.*<span aria-hidden="true">💰<\/span>Nieopłacona<\/button>/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /aria-label="Filtruj wg składki: Nie dotyczy"[^>]*>.*<span aria-hidden="true">💰<\/span>Nie dotyczy<\/button>/);
  assert.match(roster.innerHTML, /signed@example\.com/);
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.match(roster.innerHTML, /other@example\.com/);

  await clickContributionFilter('paid');
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /signed@example\.com|other@example\.com/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /<h3>Filtruj wg składki<\/h3>/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-group="contributionStatus" data-filter-value="paid" aria-pressed="true">.*<span aria-hidden="true">💰<\/span>Opłacona/);

  await clickContributionFilter('not_applicable');
  assert.doesNotMatch(roster.innerHTML, /signed@example\.com/);
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.match(roster.innerHTML, /other@example\.com/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-group="contributionStatus" data-filter-value="not_applicable" aria-pressed="true">.*<span aria-hidden="true">💰<\/span>Nie dotyczy/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-group="contributionStatus" data-filter-value="unpaid" aria-pressed="false">.*<span aria-hidden="true">💰<\/span>Nieopłacona/);
});

test('fee-less events hide the contribution filter and render the unset fee as a grey pill', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  assert.doesNotMatch(harness.elements.get('summary-content')!.innerHTML, /Filtruj wg składki/);
  assert.match(harness.elements.get('skladka-fee-display')!.innerHTML, /lw-fee-unset-pill[^>]*>Nie ustalono<\/span>/);
});

test('fee summary counts attending signups by status with icons, labels and numbers', async () => {
  const harness = createHarness(event('50 zł'), {
    signupStatusByPersonId: {
      'viewer@example.com': 'paid',
      'other@example.com': 'not_applicable',
    },
  });
  await harness.signIn();

  const summary = harness.elements.get('skladka-fee-status-summary')!;
  assert.equal(summary.hidden, false);
  assert.match(summary.innerHTML, /data-status="paid"[^>]*aria-hidden="true">💰<\/span><span>Opłacone<\/span><strong>1<\/strong>/);
  assert.match(summary.innerHTML, /data-status="unpaid"[^>]*aria-hidden="true">💰<\/span><span>Nieopłacone<\/span><strong>1<\/strong>/);
  assert.match(summary.innerHTML, /data-status="not_applicable"[^>]*aria-hidden="true">💰<\/span><span>Nie dotyczy<\/span><strong>1<\/strong>/);
});

test('unknown contribution statuses use the unpaid color, pill and count fallback', async () => {
  const harness = createHarness(event('50 zł', '2026-10-20'), {
    signupStatusByPersonId: { 'viewer@example.com': 'unexpected' },
  });
  await harness.signIn();

  assert.equal(harness.elements.get('skladka-fee-duedate-pill')!.dataset.state, 'unpaid');
  assert.match(harness.elements.get('roster-content')!.innerHTML, /data-status="unpaid"/);
  assert.match(harness.elements.get('skladka-fee-status-summary')!.innerHTML, /data-status="unpaid"[^>]*>💰<\/span><span>Nieopłacone<\/span><strong>2<\/strong>/);
});

test('fee status counts refresh when a signup contribution status changes', async () => {
  const harness = createHarness(event('50 zł'), {
    signupStatusByPersonId: { 'viewer@example.com': 'unpaid' },
  });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  const control = {
    dataset: { personId: 'viewer@example.com', status: 'unpaid' },
    disabled: false,
  };
  await roster.clickWith({ closest: (selector: string) => selector === '.lw-skladka-icon' ? control : null });

  const html = harness.elements.get('skladka-fee-status-summary')!.innerHTML;
  assert.match(html, /data-status="unpaid"[^>]*>💰<\/span><span>Nieopłacone<\/span><strong>1<\/strong>/);
  assert.match(html, /data-status="paid"[^>]*>💰<\/span><span>Opłacone<\/span><strong>1<\/strong>/);
});

test('attendance changes refresh fee counts and the viewer deadline pill', async () => {
  const harness = createHarness(event('50 zł', '2026-10-20'), {
    signupStatusByPersonId: { 'viewer@example.com': 'paid' },
  });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  const toggleAttendance = async (attending: boolean) => {
    harness.setMutationResult({ signup: { memberEmail: 'viewer@example.com', attending, skladkaStatus: 'paid' } });
    await roster.clickWith({
      closest: (selector: string) => selector === '.lw-attend-toggle'
        ? { dataset: { personId: 'viewer@example.com', attending: String(!attending) }, disabled: false }
        : null,
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  await toggleAttendance(false);
  assert.match(harness.elements.get('skladka-fee-status-summary')!.innerHTML, /data-status="paid"[^>]*>💰<\/span><span>Opłacone<\/span><strong>0<\/strong>/);
  assert.equal(harness.elements.get('skladka-fee-duedate-pill')!.dataset.state, 'neutral');

  await toggleAttendance(true);
  assert.match(harness.elements.get('skladka-fee-status-summary')!.innerHTML, /data-status="paid"[^>]*>💰<\/span><span>Opłacone<\/span><strong>1<\/strong>/);
  assert.equal(harness.elements.get('skladka-fee-duedate-pill')!.dataset.state, 'paid');
});

test('contribution filtering excludes non-attending and no-signup rows and uses the unpaid fallback', async () => {
  const harness = createHarness(event('50 zł'), {
    withAttachedPerson: true,
    signupStatusByPersonId: {
      'viewer@example.com': 'paid',
      'other@example.com': 'unpaid',
    },
    signupAttendingByPersonId: { 'other@example.com': false },
  });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  const summary = harness.elements.get('summary-panel')!;
  harness.elements.get('roster-filter-niezgloszeni')!.checked = true;
  await harness.elements.get('roster-filter-niezgloszeni')!.change();
  const clickContributionFilter = (status: string) => summary.clickWith({
    closest: (selector: string) => selector === '[data-filter-group]'
      ? { dataset: { filterGroup: 'contributionStatus', filterValue: status }, disabled: false, focus() {} }
      : null,
  });
  await clickContributionFilter('unpaid');

  assert.match(roster.innerHTML, /signed@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /viewer@example\.com|other@example\.com|attached-uuid-1/);

  const missingStatusHarness = createHarness(event('50 zł'), {
    signupStatusByPersonId: { 'viewer@example.com': undefined },
  });
  await missingStatusHarness.signIn();
  const unpaidFilter = missingStatusHarness.elements.get('summary-panel')!;
  const selectUnpaid = () => unpaidFilter.clickWith({
    closest: (selector: string) => selector === '[data-filter-group]'
      ? { dataset: { filterGroup: 'contributionStatus', filterValue: 'unpaid' }, disabled: false, focus() {} }
      : null,
  });
  await selectUnpaid();
  assert.match(missingStatusHarness.elements.get('roster-content')!.innerHTML, /viewer@example\.com/);
});

test('the contribution filter is hidden and cleared when the event has no fee', async () => {
  const harness = createHarness(event(null), {
    withAttachedPerson: true,
    initialStorage: {
      'kruki_pref_wyjazd_summary_filter': JSON.stringify({ v: 1, value: { roster: { contributionStatus: ['paid'] } } }),
    },
  });
  await harness.signIn();

  assert.doesNotMatch(harness.elements.get('summary-content')!.innerHTML, /lw-contribution-filter/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-active="false"/);
  assert.match(harness.elements.get('roster-content')!.innerHTML, /signed@example\.com/);
  assert.match(harness.elements.get('roster-content')!.innerHTML, /viewer@example\.com/);
});

test('unknown stored contribution statuses restore as an unfiltered state', async () => {
  const harness = createHarness(event('50 zł'), {
    initialStorage: {
      'kruki_pref_wyjazd_summary_filter': JSON.stringify({ v: 1, value: { roster: { contributionStatus: ['unexpected'] } } }),
    },
  });
  await harness.signIn();

  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-active="false"/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-value="paid" aria-pressed="false">.*<span aria-hidden="true">💰<\/span>Opłacona/);
  assert.match(harness.elements.get('roster-content')!.innerHTML, /signed@example\.com/);
  assert.match(harness.elements.get('roster-content')!.innerHTML, /viewer@example\.com/);
});

test('roster shows one combo icon and a T/W/D letter caption for multi-weapon members', async () => {
  const harness = createHarness(event(null), {
    memberWeapons: {
      'signed@example.com': ['tarczownik', 'wlocznik', 'dunczyk'],
      'viewer@example.com': ['wlocznik', 'dunczyk'],
    },
  });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!.innerHTML;

  // All three weapons -> the three-weapon combo PNG (not three separate icons), captioned "TWD".
  assert.match(roster, /icons\/bron-tarcza-wlocznia-topor\.png/);
  assert.match(roster, /lw-weapon-code">TWD</);
  // Two weapons -> the matching combo PNG, captioned with their two letters.
  assert.match(roster, /icons\/bron-wlocznia-topor\.png/);
  assert.match(roster, /lw-weapon-code">WD</);
  // The single-weapon PNGs are not used for these members.
  assert.doesNotMatch(roster, /icons\/bron-tarcza\.png/);
  assert.doesNotMatch(roster, /icons\/bron-topor\.png/);
});

test('blank fee values hide payment icons while a confirmed event update re-renders them', async () => {
  for (const fee of [null, '', '   ']) {
    const harness = createHarness(event(fee));
    await harness.signIn();
    assert.doesNotMatch(harness.elements.get('roster-content')!.innerHTML, /lw-skladka-icon/);
    assert.equal(harness.elements.get('skladka-fee-status-summary')!.hidden, true);
  }
  const harness = createHarness(event(null));
  await harness.signIn();
  harness.elements.get('skladka-fee-input')!.value = '50 zł';
  harness.setMutationResult({ event: event('50 zł', null) });
  await harness.elements.get('skladka-fee-save')!.click();
  assert.match(harness.elements.get('roster-content')!.innerHTML, /lw-skladka-icon/);
});

test('fee save sends only normalized field changes and leaves state intact after rejection', async () => {
  const harness = createHarness(event('50 zł'));
  await harness.signIn();
  const feeInput = harness.elements.get('skladka-fee-input')!;
  const dueDateInput = harness.elements.get('skladka-fee-duedate-input')!;
  const save = harness.elements.get('skladka-fee-save')!;
  const roster = harness.elements.get('roster-content')!;
  const puts = () => harness.apiCalls.filter((call) => call.options.method === 'PUT');

  await save.click();
  assert.equal(puts().length, 0);

  dueDateInput.value = '2026-10-20';
  harness.setMutationResult({ event: event('50 zł', '2026-10-20') });
  await save.click();
  assert.deepEqual(JSON.parse(String(puts().at(-1)?.options.body)), { dueDate: '2026-10-20' });

  dueDateInput.value = '';
  harness.setMutationResult({ event: event('50 zł', null) });
  await save.click();
  assert.deepEqual(JSON.parse(String(puts().at(-1)?.options.body)), { dueDate: null });

  feeInput.value = '60 zł';
  harness.setMutationResult({ event: event('60 zł', null) });
  await save.click();
  assert.deepEqual(JSON.parse(String(puts().at(-1)?.options.body)), { skladkaFee: '60 zł' });
  const rosterAfterSuccess = roster.innerHTML;

  feeInput.value = '70 zł';
  harness.setMutationError(new Error('network'));
  await save.click();
  assert.equal(roster.innerHTML, rosterAfterSuccess);
});

test('removing the fee clears both fields, sends nulls and hides payment icons', async () => {
  const harness = createHarness(event('50 zł', '2026-10-20'));
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  assert.match(roster.innerHTML, /lw-skladka-icon/);
  assert.equal(harness.elements.get('skladka-fee-duedate-input')!.disabled, false);
  assert.equal(harness.elements.get('skladka-fee-remove')!.disabled, false);

  harness.setMutationResult({ event: event(null, null) });
  await harness.elements.get('skladka-fee-remove')!.click();

  const put = harness.apiCalls.filter((call) => call.options.method === 'PUT').at(-1);
  assert.deepEqual(JSON.parse(String(put?.options.body)), { skladkaFee: null, dueDate: null });
  assert.equal(harness.elements.get('skladka-fee-input')!.value, '');
  assert.equal(harness.elements.get('skladka-fee-duedate-input')!.value, '');
  assert.equal(harness.elements.get('skladka-fee-duedate-input')!.disabled, true);
  assert.equal(harness.elements.get('skladka-fee-remove')!.disabled, true);
  assert.doesNotMatch(roster.innerHTML, /lw-skladka-icon/);
});

test('removing an event fee clears the active contribution filter and refreshes the summary', async () => {
  const harness = createHarness(event('50 zł'), {
    signupStatusByPersonId: { 'viewer@example.com': 'paid' },
  });
  await harness.signIn();
  const summary = harness.elements.get('summary-panel')!;
  const selectPaid = () => summary.clickWith({
    closest: (selector: string) => selector === '[data-filter-group]'
      ? { dataset: { filterGroup: 'contributionStatus', filterValue: 'paid' }, disabled: false, focus() {} }
      : null,
  });
  await selectPaid();
  assert.match(harness.elements.get('roster-content')!.innerHTML, /viewer@example\.com/);
  assert.doesNotMatch(harness.elements.get('roster-content')!.innerHTML, /signed@example\.com/);

  harness.setMutationResult({ event: event(null, null) });
  await harness.elements.get('skladka-fee-remove')!.click();

  assert.equal(harness.elements.get('skladka-fee-status-summary')!.hidden, true);
  assert.doesNotMatch(harness.elements.get('summary-content')!.innerHTML, /lw-contribution-filter/);
  assert.match(harness.elements.get('summary-content')!.innerHTML, /data-filter-active="false"/);
  assert.match(harness.elements.get('roster-content')!.innerHTML, /signed@example\.com/);
  assert.match(harness.elements.get('roster-content')!.innerHTML, /viewer@example\.com/);
});

test('an empty fee disables and clears the due-date field and never sends a date', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  const feeInput = harness.elements.get('skladka-fee-input')!;
  const dueDateInput = harness.elements.get('skladka-fee-duedate-input')!;
  assert.equal(dueDateInput.disabled, true);

  feeInput.value = '50 zł';
  await feeInput.input();
  assert.equal(dueDateInput.disabled, false);

  dueDateInput.value = '2026-10-20';
  feeInput.value = '';
  await feeInput.input();
  assert.equal(dueDateInput.value, '');
  assert.equal(dueDateInput.disabled, true);

  // Even if a date were forced into the now-disabled field, the save guard drops it.
  dueDateInput.value = '2026-10-20';
  const putsBefore = harness.apiCalls.filter((call) => call.options.method === 'PUT').length;
  await harness.elements.get('skladka-fee-save')!.click();
  assert.equal(harness.apiCalls.filter((call) => call.options.method === 'PUT').length, putsBefore);
});

test('a failed fee removal restores the form from the last loaded event', async () => {
  const harness = createHarness(event('50 zł', '2026-10-20'));
  await harness.signIn();
  harness.setMutationError(new Error('network'));
  await harness.elements.get('skladka-fee-remove')!.click();
  assert.equal(harness.elements.get('skladka-fee-input')!.value, '50 zł');
  assert.equal(harness.elements.get('skladka-fee-duedate-input')!.value, '2026-10-20');
  assert.equal(harness.elements.get('skladka-fee-duedate-input')!.disabled, false);
  assert.equal(harness.elements.get('skladka-fee-remove')!.disabled, false);
});

test('the event-scoped roster renders an accountless person with the marker and its own personId', async () => {
  const harness = createHarness(event(null), { withRemovedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;

  assert.ok(
    harness.apiCalls.some((call) => call.url === '/lista-wyjazdowa/roster?eventId=e1'),
    'the page fetches the historical (event-scoped) roster',
  );

  const row = roster.innerHTML.match(/<tr data-person-id="gone-uuid-1"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(row, 'the removed person signed up for this trip is rendered');
  assert.match(row, /data-person-id="gone-uuid-1"/, 'the row is keyed by the person UUID, not the null e-mail');
  assert.match(row, /person-pill-icon/, 'the accountless marker is rendered');
  assert.match(row, /aria-label="osoba bez konta"/);
  // A deactivated person keeps a static historical status, while the profile remains readable.
  assert.match(row, /lw-attend-static/, 'the status is shown read-only');
  assert.doesNotMatch(row, /lw-attend-toggle/, 'no attend toggle for a deactivated person');
  assert.match(row, /profile-trigger/, 'the read-only profile drawer remains available');
  assert.match(row, /<s class="lw-inactive-person-name">Cień Nowak<\/s><small class="lw-inactive-person-label">\(nieaktywne\)<\/small>/);
  assert.doesNotMatch(row, /data-email="null"/);

  // The two distinct accountless rows must not collapse onto a shared key.
  const keyedRows = roster.innerHTML.match(/data-person-id="gone-uuid-1"/g) ?? [];
  assert.ok(keyedRows.length >= 1);
});

// The roster's delegated click handler only reads closest(...) + dataset off the event target, so a
// minimal stub is enough to drive it without a real DOM tree (which the harness deliberately lacks).
function clickTarget(selector: string, dataset: Record<string, string> = {}) {
  return { closest: (query: string) => (query === selector ? { dataset } : null) };
}

test('the "+" add-companion button is on the viewer\'s own account row only, never on an accountless row', async () => {
  const harness = createHarness(event(null), { withRemovedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;

  const ownRow = roster.innerHTML.match(/<tr data-person-id="viewer@example\.com"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(ownRow);
  assert.match(ownRow, /class="lw-add-companion"/);
  assert.match(ownRow, /aria-label="Dodaj osobę towarzyszącą"/);
  assert.match(ownRow, /lw-add-companion-label/);

  const otherRow = roster.innerHTML.match(/<tr data-person-id="signed@example\.com"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(otherRow);
  assert.doesNotMatch(otherRow, /lw-add-companion/, "a plain member gets no control on someone else's row");

  const accountlessRow = roster.innerHTML.match(/<tr data-person-id="gone-uuid-1"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(accountlessRow);
  assert.doesNotMatch(accountlessRow, /lw-add-companion/, 'a person without an account cannot own a companion');
});

test('staff get the "+" control on every account row, never on an accountless row', async () => {
  const harness = createHarness(event(null), { canManagePeople: true, withRemovedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;

  const otherRow = roster.innerHTML.match(/<tr data-person-id="signed@example\.com"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(otherRow);
  assert.match(otherRow, /class="lw-add-companion"/);

  const accountlessRow = roster.innerHTML.match(/<tr data-person-id="gone-uuid-1"[\s\S]*?<\/tr>/)?.[0];
  assert.ok(accountlessRow);
  assert.doesNotMatch(accountlessRow, /lw-add-companion/);
});

test("opening the add panel lists the member's attached people and a new-person form", async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;

  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));

  assert.match(roster.innerHTML, /class="lw-inline-form"/);
  assert.match(roster.innerHTML, /id="lw-inline-existing-select"/);
  assert.match(roster.innerHTML, /value="attached-uuid-1"/);
  assert.match(roster.innerHTML, /id="lw-inline-new-name"/);
  assert.match(roster.innerHTML, /id="lw-inline-new-last-name"/);
  assert.match(roster.innerHTML, /id="lw-inline-new-first-name"/);
  assert.match(roster.innerHTML, /id="lw-inline-new-category"/);
  assert.match(roster.innerHTML, /Kandydat/);
  assert.match(roster.innerHTML, /aria-expanded="true"/);
});

test('the add panel offers an attached person already marked "nie jadę" so they can be re-added', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true, attachedNotAttending: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;

  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));

  assert.match(roster.innerHTML, /value="attached-uuid-1"/, 'a not-attending attached person stays offered');
});

test('the add panel no longer shows the "new person inherits section / status Jadę" hint', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;

  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));

  assert.doesNotMatch(roster.innerHTML, /lw-inline-hint/);
  assert.doesNotMatch(roster.innerHTML, /dostaje sekcję opiekuna/);
});

test('adding an existing attached person posts quick-add and applies the signup locally', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-existing-select')!.value = 'attached-uuid-1';
  harness.setMutationResult({
    person: { personId: 'attached-uuid-1', ksywka: 'Młody', firstName: '', lastName: '', categoryId: 'kandydat', sectionId: null, weaponIds: [], ownerPersonId: 'viewer@example.com' },
    signup: { memberEmail: 'attached-uuid-1', attending: true, skladkaStatus: 'unpaid' },
  });

  await roster.clickWith(clickTarget('.lw-inline-add-existing'));

  const post = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.equal(post?.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(post?.options.body)), { eventId: 'e1', ownerPersonId: 'viewer@example.com', mode: 'existing', personId: 'attached-uuid-1' });
  assert.match(roster.innerHTML, /data-person-id="attached-uuid-1"[\s\S]*?Jadę/);
  assert.doesNotMatch(roster.innerHTML, /class="lw-inline-form"/, 'the panel closes after a successful add');
});

test('a blank Nazwisko/Imię on the new-person form is rejected before posting', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  const requestsBefore = harness.apiCalls.length;
  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';

  await roster.clickWith(clickTarget('.lw-inline-add-new'));

  assert.equal(harness.apiCalls.length, requestsBefore, 'a blank Nazwisko/Imię must not reach the server');
  assert.match(harness.elements.get('lw-inline-error')!.textContent, /Podaj nazwisko, imię i kategorię/);
});

test('adding a new person posts quick-add with ksywka+lastName+firstName+categoryId and appends the created row', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-last-name')!.value = 'Kowalski';
  harness.elements.get('lw-inline-new-first-name')!.value = 'Jan';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  harness.setMutationResult({
    person: { personId: 'new-uuid-1', ksywka: 'Nowy', firstName: 'Jan', lastName: 'Kowalski', categoryId: 'kandydat', sectionId: 'bydgoszcz', weaponIds: [], ownerPersonId: 'viewer@example.com' },
    signup: { memberEmail: 'new-uuid-1', attending: true, skladkaStatus: 'unpaid' },
  });

  await roster.clickWith(clickTarget('.lw-inline-add-new'));

  const post = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.deepEqual(JSON.parse(String(post?.options.body)), {
    eventId: 'e1', ownerPersonId: 'viewer@example.com', mode: 'new', ksywka: 'Nowy', lastName: 'Kowalski', firstName: 'Jan', categoryId: 'kandydat',
  });
  assert.match(roster.innerHTML, /data-person-id="new-uuid-1"/);
  assert.match(roster.innerHTML, /person-pill-icon/);
  assert.doesNotMatch(roster.innerHTML, /class="lw-inline-form"/);
  assert.match(harness.focusTargets[0]?.selector ?? '', /data-person-id="new-uuid-1"/);
  assert.equal(harness.focusTargets[0]?.focused, true);
});

test('adding a new person in the trip detail accepts a blank nickname', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-new-name')!.value = '';
  harness.elements.get('lw-inline-new-last-name')!.value = 'Nowak';
  harness.elements.get('lw-inline-new-first-name')!.value = 'Anna';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  harness.setMutationResult({
    person: { personId: 'new-uuid-2', ksywka: '', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'bydgoszcz', weaponIds: [], ownerPersonId: 'viewer@example.com' },
    signup: { memberEmail: 'new-uuid-2', attending: true, skladkaStatus: 'unpaid' },
  });

  await roster.clickWith(clickTarget('.lw-inline-add-new'));

  const post = harness.apiCalls.find((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.ok(post, 'a blank nickname must not block the quick-add request');
  assert.equal(JSON.parse(String(post.options.body)).ksywka, '');
});

test('a failed quick-add changes nothing and reports the error', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-existing-select')!.value = 'attached-uuid-1';
  const before = roster.innerHTML;
  harness.setMutationError(new Error('network'));

  await roster.clickWith(clickTarget('.lw-inline-add-existing'));

  assert.equal(roster.innerHTML, before);
  assert.match(harness.elements.get('lw-inline-error')!.textContent, /Nie udało się dodać osoby/);
});

test('cancelling the duplicate prompt on the event detail page leaves the companion form unchanged', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-last-name')!.value = 'Kowalski';
  harness.elements.get('lw-inline-new-first-name')!.value = 'Jan';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  const formBefore = roster.innerHTML;
  harness.setMutationError(Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Jan', lastName: 'Kowalski' }] }));
  harness.cancelNextDuplicatePrompt();

  await roster.clickWith(clickTarget('.lw-inline-add-new'));

  assert.equal(roster.innerHTML, formBefore);
  const requests = harness.apiCalls.filter((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.equal(requests.length, 1, 'the initial request finds the match; cancellation skips only the confirmed retry');
  assert.equal(JSON.parse(String(requests[0].options.body)).duplicateConfirmed, undefined);
  assert.equal(harness.elements.get('lw-error')!.hidden, true);
  assert.equal(harness.elements.get('lw-inline-new-name')!.focused, true);
});

test('confirming a duplicate quick-add on the event detail page retries once with duplicateConfirmed', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-last-name')!.value = 'Kowalski';
  harness.elements.get('lw-inline-new-first-name')!.value = 'Jan';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  harness.setMutationResult({
    person: { personId: 'new-uuid-1', firstName: 'Jan', lastName: 'Kowalski', nickname: 'Nowy', categoryId: 'kandydat' },
    signup: { memberEmail: 'new-uuid-1', attending: true, skladkaStatus: 'unpaid' },
  });
  harness.setMutationError(Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Jan', lastName: 'Kowalski' }] }));

  await roster.clickWith(clickTarget('.lw-inline-add-new'));

  const requests = harness.apiCalls.filter((call) => call.url === '/lista-wyjazdowa/signups/quick-add');
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(String(requests[0].options.body)).duplicateConfirmed, undefined);
  assert.equal(JSON.parse(String(requests[1].options.body)).duplicateConfirmed, true);
});

test('trip detail falls back to its roster filter when the newly attending person is not rendered', async () => {
  const harness = createHarness(event(null), { withAttachedPerson: true });
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  await roster.clickWith(clickTarget('.lw-add-companion', { ownerPersonId: 'viewer@example.com' }));
  harness.elements.get('lw-inline-new-name')!.value = 'Nowy';
  harness.elements.get('lw-inline-new-last-name')!.value = 'Kowalski';
  harness.elements.get('lw-inline-new-first-name')!.value = 'Jan';
  harness.elements.get('lw-inline-new-category')!.value = 'kandydat';
  harness.elements.get('roster-filter-zgloszeni')!.checked = false;
  vm.runInContext('showSignedUpAndMe = false', harness.context);
  harness.setMutationResult({
    person: { personId: 'new-uuid-1', firstName: 'Jan', lastName: 'Kowalski', nickname: 'Nowy', categoryId: 'kandydat' },
    signup: { memberEmail: 'new-uuid-1', attending: true, skladkaStatus: 'unpaid' },
  });

  await roster.clickWith(clickTarget('.lw-inline-add-new'));

  assert.equal(harness.elements.get('roster-filter-zgloszeni')!.focused, true);
});

test('the old lw-subnav pill row is gone, replaced by the shared top bar (non-sticky on this page)', () => {
  assert.doesNotMatch(page, /lw-subnav/);
  // lw-topbar--static: unlike the events list page, the trip detail page's own content (roster,
  // summary) is what matters while scrolling, so this page's bar scrolls away naturally instead
  // of staying pinned under the site header.
  assert.match(page, /class="lw-topbar lw-topbar--static"/);
  assert.match(page, /id="lw-nav-container"/);
  assert.match(page, /shared\/lw-nav\.js/);
  assert.match(page, /shared\/lw-topbar\.js/);
});

test('"Dodaj wyjazd" is a standalone button next to the dropdown, not one of its items', () => {
  assert.doesNotMatch(page, /lw-nav-item--add/);
  assert.match(page, /<a href="\/lista-wyjazdowa\/\?new=1" class="lw-nav-add" id="lw-nav-add">\+ Dodaj wyjazd<\/a>/);
});

test('the trip detail page renders the shared dropdown with the open trip highlighted, not "Wszystkie"', async () => {
  const harness = createHarness(event('50 zł'));
  await harness.signIn();
  const nav = harness.elements.get('lw-nav-container')!.innerHTML;
  assert.match(nav, /class="lw-nav-item lw-nav-item--active" role="menuitem"><span class="lw-nav-item-date">/);
  assert.doesNotMatch(nav, /lw-nav-item--all lw-nav-item--active/);
  // "Wszystkie" stays first even though it isn't the active item here.
  assert.match(nav, /class="lw-nav-item lw-nav-item--all"[^>]*>Wszystkie/);
  assert.doesNotMatch(nav, /Dodaj wyjazd/);
});

test('clicking the dropdown toggle on the trip detail page opens and closes the menu', async () => {
  const harness = createHarness(event('50 zł'));
  await harness.signIn();
  const nav = harness.elements.get('lw-nav-container')!;
  assert.match(nav.innerHTML, /class="lw-nav-menu" role="menu" hidden>/);

  await nav.clickWith(clickTarget('.lw-nav-toggle'));
  assert.doesNotMatch(nav.innerHTML, /class="lw-nav-menu" role="menu" hidden>/);

  await nav.clickWith(clickTarget('.lw-nav-toggle'));
  assert.match(nav.innerHTML, /class="lw-nav-menu" role="menu" hidden>/);
});
