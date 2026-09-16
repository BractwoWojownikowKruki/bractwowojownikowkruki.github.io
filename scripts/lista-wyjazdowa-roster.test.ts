import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');

class Element {
  id: string;
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  href = '';
  disabled = false;
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
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  scrollIntoView() {}
}

const elementIds = [
  'lw-checking', 'signed-out-panel', 'forbidden-panel', 'main-content', 'lw-error',
  'skladka-fee-display', 'skladka-fee-edit', 'skladka-fee-input', 'skladka-fee-duedate-input',
  'skladka-fee-save', 'roster-panel', 'summary-content', 'equipment-companions-content',
  'roster-table', 'roster-content', 'roster-filter-toggle', 'roster-filter-label', 'event-title', 'event-meta',
  'cancel-event-btn', 'restore-event-btn', 'event-history-link', 'skladka-fee-history-link',
];

function createHarness(event: Record<string, unknown>) {
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = null;
  let mutationError: Error | null = null;
  let signIn: ((identity: { email: string }) => Promise<void>) | undefined;
  const roster = [
    { email: 'signed@example.com', fullName: 'Signed', sectionId: null, categoryId: null, weaponIds: [], equipment: [], companions: [], duesStatus: 'paid', wpisowePaid: true },
    { email: 'viewer@example.com', fullName: 'Viewer', sectionId: null, categoryId: null, weaponIds: [], equipment: [], companions: [], duesStatus: 'paid', wpisowePaid: true },
    { email: 'other@example.com', fullName: 'Other', sectionId: null, categoryId: null, weaponIds: [], equipment: [], companions: [], duesStatus: 'paid', wpisowePaid: true },
  ];
  const signups = [{ memberEmail: 'signed@example.com', attending: true, skladkaPaid: false, equipmentIds: [], companionIds: [] }];
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
        confirmed: async ({ execute, apply }: { execute: () => Promise<unknown>; apply: (result: unknown) => void }) => {
          if (mutationError) throw mutationError;
          const result = await execute();
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
      if (options.method === 'PUT') return mutationResult;
      if (url === '/lista-wyjazdowa/events') return { events: [event] };
      if (url === '/lista-wyjazdowa/roster') return { roster };
      if (url.startsWith('/lista-wyjazdowa/signups?')) return { signups };
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki: true };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [], weapons: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };
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

test('roster toggle changes only the local filter and preserves the signed-in viewer', async () => {
  const harness = createHarness(event(null));
  await harness.signIn();
  const roster = harness.elements.get('roster-content')!;
  assert.match(roster.innerHTML, /signed@example\.com/, harness.elements.get('lw-error')!.textContent);
  assert.match(roster.innerHTML, /viewer@example\.com/);
  assert.doesNotMatch(roster.innerHTML, /other@example\.com/);

  const requestsBeforeToggle = harness.apiCalls.length;
  await harness.elements.get('roster-filter-toggle')!.click();
  assert.equal(harness.elements.get('roster-filter-label')!.textContent, 'Wszyscy');
  assert.equal(harness.elements.get('roster-filter-toggle')!.getAttribute('aria-pressed'), 'true');
  assert.match(roster.innerHTML, /other@example\.com/);
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
