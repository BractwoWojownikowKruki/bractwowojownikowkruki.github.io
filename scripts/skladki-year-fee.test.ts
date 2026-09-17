import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/lista-wyjazdowa/skladki/skladki.js', import.meta.url), 'utf8');

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
  'skladki-year-fee-remove', 'skladki-year-fee-history-link', 'skladki-year-select',
  'summary-content', 'skladki-content', 'skladki-table', 'skladki-emeryci',
  'skladki-emeryci-table',
];

function createHarness(yearFee: Record<string, unknown> | null) {
  const elements = new Map(elementIds.map((id) => [id, new Element(id)]));
  const apiCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  let mutationResult: unknown = {};
  let mutationError: Error | null = null;
  let signIn: (() => Promise<void>) | undefined;
  const roster = [
    { email: 'member@example.com', fullName: 'Member', sectionId: null, categoryId: null, weaponIds: [], equipment: [], duesStatus: 'paid', wpisowePaid: true },
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
    displayName: (member: { fullName: string }) => member.fullName,
    initGoogleSignIn: (config: { onSignedIn: () => Promise<void> }) => { signIn = config.onSignedIn; },
    apiFetch: async (url: string, options: Record<string, unknown>) => {
      apiCalls.push({ url, options });
      if (options.method === 'PUT') {
        if (mutationError) throw mutationError;
        return mutationResult;
      }
      if (url === '/lista-wyjazdowa/my-role') return { canManageSkladki: true };
      if (url === '/lista-wyjazdowa/roster') return { roster };
      if (url.startsWith('/lista-wyjazdowa/dues?')) return { dues: [], yearFee };
      if (url === '/lista-wyjazdowa/lookup-lists') return { sections: [], categories: [], weapons: [] };
      throw new Error(`unexpected request: ${url}`);
    },
  };
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
