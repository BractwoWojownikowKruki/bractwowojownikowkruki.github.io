import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const personPillSource = readFileSync(new URL('../public/shared/person-pill.js', import.meta.url), 'utf8');

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
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Array<(event: any) => unknown>>();

  constructor(id: string) { this.id = id; }
  addEventListener(type: string, listener: (event: any) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async click() {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target: this })));
  }
  async change() {
    await Promise.all((this.listeners.get('change') ?? []).map((listener) => listener({ target: this })));
  }
  async input() {
    await Promise.all((this.listeners.get('input') ?? []).map((listener) => listener({ target: this })));
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  scrollIntoView() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'main-content', 'lw-error',
  'skladka-fee-display', 'skladka-fee-edit', 'skladka-fee-input', 'skladka-fee-duedate-input',
  'skladka-fee-save', 'skladka-fee-remove', 'roster-panel', 'summary-content', 'equipment-companions-content',
  'roster-table', 'roster-content', 'roster-filter-niezgloszeni', 'roster-filter-zgloszeni',
  'event-title', 'event-meta',
  'cancel-event-btn', 'restore-event-btn', 'event-history-link', 'skladka-fee-history-link',
];

function createHarness(event: Record<string, unknown>, options: { canManageSkladki?: boolean } = {}) {
  const canManageSkladki = options.canManageSkladki ?? true;
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  // Mirrors index.html's default: "Zgłoszeni + ja" starts checked, "Niezgłoszeni" unchecked.
  elements.get('roster-filter-zgloszeni')!.checked = true;
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = null;
  let mutationError: Error | null = null;
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;
  const roster = [
    { personId: 'signed@example.com', email: 'signed@example.com', accountless: false, fullName: 'Signed', sectionId: null, categoryId: null, weaponIds: [], equipment: [], duesStatus: 'paid', wpisowePaid: true },
    { personId: 'viewer@example.com', email: 'viewer@example.com', accountless: false, fullName: 'Viewer', sectionId: null, categoryId: null, weaponIds: [], equipment: [], duesStatus: 'paid', wpisowePaid: true },
    { personId: 'other@example.com', email: 'other@example.com', accountless: false, fullName: 'Other', sectionId: null, categoryId: null, weaponIds: [], equipment: [], duesStatus: 'paid', wpisowePaid: true },
  ];
  const signups = [{ memberEmail: 'signed@example.com', attending: true, skladkaPaid: false, equipmentIds: [] }];
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
      location: { search: '?eventId=e1' },
      confirm: () => true,
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
    initSortableTable: () => ({ key: 'section', dir: 'asc' }),
    compareValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    compareDateValues: (a: unknown, b: unknown) => String(a).localeCompare(String(b)),
    displayName: (member: { fullName: string }) => member.fullName,
    initGoogleSignIn: (config: { onSignedIn: (identity: { email: string }) => Promise<void> }) => { signIn = config.onSignedIn; },
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      apiCalls.push({ url, options });
      if (options.method === 'PUT') {
        if (mutationError) throw mutationError;
        return mutationResult;
      }
      if (url === '/lista-wyjazdowa/events') return { events: [event] };
      if (url.startsWith('/lista-wyjazdowa/roster')) return { roster };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups };
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [], weapons: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };
  vm.runInNewContext(personPillSource, context, { filename: 'person-pill.js' });
  vm.runInNewContext(source, context, { filename: 'wyjazd.js' });
  return {
    elements,
    apiCalls,
    async signIn() { await signIn?.({ email: 'viewer@example.com' }); },
    setMutationResult(result: unknown) { mutationResult = result; mutationError = null; },
    setMutationError(error: Error) { mutationError = error; },
  };
}

const event = (skladkaFee: unknown, dueDate: unknown = undefined) => ({
  id: 'e1', name: 'Wyjazd', startDate: '2026-10-10', status: 'active', skladkaFee, dueDate,
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

test('blank fee values hide payment icons while a confirmed event update re-renders them', async () => {
  for (const fee of [null, '', '   ']) {
    const harness = createHarness(event(fee));
    await harness.signIn();
    assert.doesNotMatch(harness.elements.get('roster-content')!.innerHTML, /lw-skladka-icon/);
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
