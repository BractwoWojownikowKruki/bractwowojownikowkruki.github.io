import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

type ClickListener = (event: { preventDefault(): void }) => unknown;

class FakeElement {
  className = '';
  disabled = false;
  isConnected = true;
  textContent = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly insertedAfter: FakeElement[] = [];
  private readonly listeners = new Map<string, ClickListener[]>();

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  insertAdjacentElement(position: string, element: FakeElement) {
    assert.equal(position, 'afterend');
    this.insertedAfter.push(element);
    return element;
  }

  addEventListener(type: string, listener: ClickListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  async click() {
    for (const listener of this.listeners.get('click') ?? []) {
      await listener({ preventDefault() {} });
    }
  }
}

function createHarness() {
  const created: FakeElement[] = [];
  const body = new FakeElement('body');
  const context = vm.createContext({
    document: {
      body,
      createElement(tagName: string) {
        const element = new FakeElement(tagName);
        created.push(element);
        return element;
      },
    },
    window: {},
  });

  return { body, context, created };
}

async function loadMutationFeedback(harness: ReturnType<typeof createHarness>) {
  const source = await readFile(new URL('../public/mutation-feedback.js', import.meta.url), 'utf8');
  vm.runInContext(source, harness.context, { filename: 'public/mutation-feedback.js' });
  return (harness.context.window as { MutationFeedback: { confirmed(options: unknown): Promise<void> } }).MutationFeedback;
}

test('shows a bare accessible check only after execute and apply resolve in order', async () => {
  const harness = createHarness();
  const feedback = await loadMutationFeedback(harness);
  const control = new FakeElement('button');
  const order: string[] = [];

  await feedback.confirmed({
    control,
    execute: async () => { order.push('execute'); },
    apply: async () => { order.push('apply'); },
  });

  assert.deepEqual(order, ['execute', 'apply']);
  assert.equal(control.insertedAfter.length, 1);
  const check = control.insertedAfter[0];
  assert.equal(check.tagName, 'span');
  assert.equal(check.textContent, '✓');
  assert.equal(check.className, 'mutation-feedback-check');
  assert.equal(check.attributes.get('role'), 'status');
  assert.equal(check.attributes.get('aria-label'), 'Zapisano');
});

test('rethrows an execute failure after an optional rollback without showing a check', async () => {
  const harness = createHarness();
  const feedback = await loadMutationFeedback(harness);
  const control = new FakeElement('button');
  const expected = new Error('write failed');
  let applied = false;
  let rolledBack = false;

  await assert.rejects(
    feedback.confirmed({
      control,
      execute: async () => { throw expected; },
      apply: async () => { applied = true; },
      rollback: async () => { rolledBack = true; },
    }),
    expected,
  );

  assert.equal(applied, false);
  assert.equal(rolledBack, true);
  assert.equal(control.insertedAfter.length, 0);
});

test('mounts a manual refresh error after apply fails without rolling back or re-running the mutation', async () => {
  const harness = createHarness();
  const feedback = await loadMutationFeedback(harness);
  const control = new FakeElement('button');
  let executes = 0;
  let rollbacks = 0;
  let refreshes = 0;

  await assert.rejects(
    feedback.confirmed({
      control,
      execute: async () => { executes += 1; },
      apply: async () => { throw new Error('local update failed'); },
      rollback: async () => { rollbacks += 1; },
      refreshFragment: async () => { refreshes += 1; },
    }),
    /local update failed/,
  );

  assert.equal(executes, 1);
  assert.equal(rollbacks, 0);
  assert.equal(control.insertedAfter.length, 1);
  const error = control.insertedAfter[0];
  assert.equal(error.className, 'mutation-feedback-error');
  assert.equal(error.attributes.get('role'), 'alert');
  assert.equal(error.children.length, 1);
  const refresh = error.children[0];
  assert.equal(refresh.textContent, 'Odśwież ten fragment');
  await refresh.click();

  assert.equal(refreshes, 1);
  assert.equal(executes, 1);
  assert.equal(rollbacks, 0);
});

test('treats a detached post-apply anchor as a view failure and offers refresh from the document body', async () => {
  const harness = createHarness();
  const feedback = await loadMutationFeedback(harness);
  const control = new FakeElement('button');
  let executes = 0;
  let rollbacks = 0;
  let refreshes = 0;

  await assert.rejects(
    feedback.confirmed({
      control,
      execute: async () => { executes += 1; },
      apply: async () => { control.isConnected = false; },
      rollback: async () => { rollbacks += 1; },
      refreshFragment: async () => { refreshes += 1; },
    }),
    /confirmation anchor is no longer connected/,
  );

  assert.equal(control.insertedAfter.length, 0);
  assert.equal(rollbacks, 0);
  assert.equal(harness.body.children.length, 1);
  const error = harness.body.children[0];
  assert.equal(error.className, 'mutation-feedback-error');
  const refresh = error.children[0];
  await refresh.click();

  assert.equal(refreshes, 1);
  assert.equal(executes, 1);
});

test('footer loads MutationFeedback before the page-specific scripts after partial injection', async () => {
  const [footer, page] = await Promise.all([
    readFile(new URL('../templates/footer.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/galerie/dodaj-zdjecia.html', import.meta.url), 'utf8'),
  ]);

  const injected = page.replace('<!-- PARTIAL:footer -->', footer.trimEnd());
  const feedbackIndex = injected.indexOf('<script src="/mutation-feedback.js"></script>');
  const pageScriptIndex = injected.indexOf('<script src="dodaj-zdjecia.js"></script>');
  assert.ok(feedbackIndex >= 0, 'footer must load the global MutationFeedback helper');
  assert.ok(feedbackIndex < pageScriptIndex, 'MutationFeedback must load before page-specific scripts');
});

test('the shared style defines visible feedback affordances without visible success prose', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.mutation-feedback-check\s*\{[^}]*color:/);
  assert.match(css, /\.mutation-feedback-error\s*\{[^}]*display:/);
});
