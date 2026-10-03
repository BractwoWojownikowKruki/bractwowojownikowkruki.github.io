import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Runs public/auth.js in a minimal fake DOM to cover the shared step-up reauth modal: a 401
// pauses every waiting apiFetch behind one modal, a sign-in resumes them all (showing a saving
// state until the retries finish), and "Anuluj" rejects them all without retrying.

class FakeElement {
  hidden = false;
  textContent = '';
  className = '';
  dataset: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  private children = new Map<string, FakeElement>();
  private html = '';

  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    this.children.clear();
    for (const [, cls, attrs] of value.matchAll(/class="([^"]+)"([^>]*)>/g)) {
      for (const name of cls.split(' ')) {
        const child = new FakeElement();
        child.hidden = /\shidden[\s>]?/.test(` ${attrs} `);
        this.children.set(`.${name}`, child);
      }
    }
  }

  querySelector(selector: string) { return this.children.get(selector) ?? null; }
  addEventListener(type: string, handler: () => void) { this.listeners[type] = handler; }
}

async function loadAuth(responses: Record<string, number[]>, hold: Promise<void> = Promise.resolve()) {
  const source = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  const appended: FakeElement[] = [];
  const calls: string[] = [];
  const context: Record<string, unknown> = {
    console,
    atob,
    setTimeout,
    localStorage: { removeItem() {}, setItem() {} },
    sessionStorage: { setItem() {} },
    document: {
      createElement: () => new FakeElement(),
      getElementById: () => null,
      body: { append: (el: FakeElement) => appended.push(el) },
    },
    fetch: async (url: string, options: { method?: string }) => {
      const path = url.replace('https://api.kruki.org', '');
      calls.push(`${options.method ?? 'GET'} ${path}`);
      const status = responses[path]?.shift() ?? 200;
      if (status === 200) await hold;
      return { ok: status < 400, status, json: async () => ({ path }) };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const modal = () => appended[0];
  return { context: context as Record<string, any>, calls, modal };
}

function googleCredential() {
  const payload = Buffer.from(JSON.stringify({ email: 'jan@example.test' })).toString('base64url');
  return { credential: `header.${payload}.signature` };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};

test('a step-up 401 opens one modal for every waiting action and retries them all after sign-in', async () => {
  let release = noop;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const { context, calls, modal } = await loadAuth({ '/approve': [401], '/reject': [401], '/session/login': [201] }, hold);
  const approve = context.apiFetch('/approve', { method: 'PUT' }, noop, noop);
  const reject = context.apiFetch('/reject', { method: 'PUT' }, noop, noop);
  await flush();

  assert.equal(modal().hidden, false);
  assert.match(modal().innerHTML, /Ze względów bezpieczeństwa musisz ponownie zalogować się, by potwierdzić tożsamość\./);
  assert.match(modal().innerHTML, /Anuluj/);

  await context.handleCredentialResponse(googleCredential());
  assert.equal(modal().querySelector('.reauth-modal-prompt').hidden, true);
  await flush();
  assert.equal(modal().hidden, false, 'the modal stays up, blocking repeat clicks, while the retries run');
  assert.equal(modal().querySelector('.reauth-modal-busy').textContent, 'Zapisywanie…');

  release();

  assert.deepEqual(await approve, { path: '/approve' });
  assert.deepEqual(await reject, { path: '/reject' });
  assert.equal(modal().hidden, true, 'the modal closes once every retry has finished');
  assert.deepEqual(calls, ['PUT /approve', 'PUT /reject', 'POST /session/login', 'PUT /approve', 'PUT /reject']);
});

test('a failed sign-in keeps the modal up with an error instead of retrying', async () => {
  const { context, calls, modal } = await loadAuth({ '/approve': [401], '/session/login': [500] });
  void context.apiFetch('/approve', { method: 'PUT' }, noop, noop);
  await flush();

  await context.handleCredentialResponse(googleCredential());
  assert.equal(modal().hidden, false);
  assert.equal(modal().querySelector('.reauth-modal-error').hidden, false);
  assert.deepEqual(calls, ['PUT /approve', 'POST /session/login']);
});

test('"Anuluj" rejects every waiting action without retrying it', async () => {
  const { context, calls, modal } = await loadAuth({ '/approve': [401], '/reject': [401] });
  const approve = context.apiFetch('/approve', { method: 'PUT' }, noop, noop);
  const reject = context.apiFetch('/reject', { method: 'PUT' }, noop, noop);
  await flush();

  modal().querySelector('.reauth-modal-cancel').listeners.click();
  await assert.rejects(approve, { message: 'Zmiana nie została zapisana.', reauthCancelled: true });
  await assert.rejects(reject, { reauthCancelled: true });
  assert.equal(modal().hidden, true);
  assert.deepEqual(calls, ['PUT /approve', 'PUT /reject']);
});

test('a 401 without reauth handlers rejects straight away, with no modal', async () => {
  const { context, modal } = await loadAuth({ '/gallery-photos/uploaders': [401] });
  await assert.rejects(context.apiFetch('/gallery-photos/uploaders', { method: 'GET' }), { status: 401 });
  assert.equal(modal(), undefined);
});
