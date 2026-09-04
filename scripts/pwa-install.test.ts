import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

class FakeElement {
  hidden = false;
  disabled = false;
  textContent = '';
  private readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();

  addEventListener(type: string, listener: (event: { preventDefault(): void }) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  async click() {
    for (const listener of this.listeners.get('click') ?? []) {
      await listener({ preventDefault() {} });
    }
  }
}

type InstallHarness = ReturnType<typeof createHarness>;

function createHarness(options: { standalone?: boolean; ios?: boolean; iPadDesktop?: boolean; manifest?: boolean } = {}) {
  const controls = [new FakeElement(), new FakeElement()];
  const messages = [new FakeElement()];
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  const navigator = {
    standalone: options.standalone ?? false,
    userAgent: options.ios
      ? 'Mozilla/5.0 (iPhone)'
      : options.iPadDesktop
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15'
        : 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    platform: options.iPadDesktop ? 'MacIntel' : 'Linux x86_64',
    maxTouchPoints: options.iPadDesktop ? 5 : 0,
  };
  const window = {
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    matchMedia() {
      return { matches: options.standalone ?? false };
    },
    navigator,
  };
  const document = {
    querySelector(selector: string) {
      if (selector === 'link[rel="manifest"][href="/manifest.webmanifest"]') {
        return options.manifest === false ? null : {};
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-pwa-install]') return controls;
      if (selector === '[data-pwa-install-message]') return messages;
      return [];
    },
  };
  const context = vm.createContext({ window, document, navigator, console });

  return {
    context,
    controls,
    emit: async (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) await listener(event);
    },
    messages,
  };
}

async function loadInstallController(harness: InstallHarness) {
  const source = await readFile(new URL('../public/pwa-install.js', import.meta.url), 'utf8');
  vm.runInContext(source, harness.context, { filename: 'public/pwa-install.js' });
}

test('hides install controls and messages in standalone mode', async () => {
  const harness = createHarness({ standalone: true });

  await loadInstallController(harness);

  assert.ok(harness.controls.every(control => control.hidden));
  assert.ok(harness.messages.every(message => message.hidden));
});

test('reveals controls for an uninstalled browser session', async () => {
  const harness = createHarness();
  harness.controls.forEach(control => { control.hidden = true; });

  await loadInstallController(harness);

  assert.ok(harness.controls.every(control => !control.hidden));
});

test('defers the browser prompt until an install-control click', async () => {
  const harness = createHarness();
  await loadInstallController(harness);
  let prevented = false;
  let prompts = 0;
  await harness.emit('beforeinstallprompt', {
    preventDefault() { prevented = true; },
    prompt() { prompts += 1; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });

  assert.equal(prevented, true);
  assert.equal(prompts, 0);
  await harness.controls[0].click();

  assert.equal(prompts, 1);
});

test('shows exact Safari installation guidance without a deferred event', async () => {
  const harness = createHarness({ ios: true });
  await loadInstallController(harness);

  await harness.controls[0].click();

  assert.equal(harness.messages[0].textContent, 'Udostępnij → Dodaj do ekranu początkowego');
  assert.equal(harness.messages[0].hidden, false);
});

test('shows exact Safari installation guidance for an iPad desktop user agent', async () => {
  const harness = createHarness({ iPadDesktop: true });
  await loadInstallController(harness);

  await harness.controls[0].click();

  assert.equal(harness.messages[0].textContent, 'Udostępnij → Dodaj do ekranu początkowego');
  assert.equal(harness.messages[0].hidden, false);
});

test('keeps install UI inactive on a document without the PWA manifest link', async () => {
  const harness = createHarness({ manifest: false });
  harness.controls.forEach(control => { control.hidden = true; });
  harness.messages.forEach(message => { message.hidden = true; });
  await loadInstallController(harness);

  await harness.controls[0].click();

  assert.ok(harness.controls.every(control => control.hidden));
  assert.ok(harness.messages.every(message => message.hidden));
  assert.ok(harness.messages.every(message => message.textContent === ''));
});

test('clears fallback guidance when the browser later supplies an install prompt', async () => {
  const harness = createHarness();
  await loadInstallController(harness);

  await harness.controls[0].click();
  assert.equal(harness.messages[0].hidden, false);

  await harness.emit('beforeinstallprompt', {
    preventDefault() {},
    prompt() {},
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });

  assert.equal(harness.messages[0].hidden, true);
});

test('uses a deferred prompt only once while two controls are clicked rapidly', async () => {
  const harness = createHarness();
  await loadInstallController(harness);
  let prompts = 0;
  let resolveChoice!: (value: { outcome: string }) => void;
  const userChoice = new Promise<{ outcome: string }>(resolve => { resolveChoice = resolve; });
  await harness.emit('beforeinstallprompt', {
    preventDefault() {},
    prompt() { prompts += 1; },
    userChoice,
  });

  const firstClick = harness.controls[0].click();
  const secondClick = harness.controls[1].click();
  assert.equal(prompts, 1);
  assert.ok(harness.controls.every(control => control.disabled));
  resolveChoice({ outcome: 'dismissed' });
  await Promise.all([firstClick, secondClick]);

  assert.equal(prompts, 1);
  assert.ok(harness.controls.every(control => !control.disabled));
});

test('recovers controls and shows browser guidance when the install prompt rejects', async () => {
  const harness = createHarness();
  await loadInstallController(harness);
  await harness.emit('beforeinstallprompt', {
    preventDefault() {},
    prompt() { return Promise.reject(new Error('prompt unavailable')); },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });

  await harness.controls[0].click();

  assert.ok(harness.controls.every(control => !control.disabled));
  assert.match(harness.messages[0].textContent, /menu przeglądarki/i);
  assert.equal(harness.messages[0].hidden, false);
});

test('keeps controls visible and clears a dismissed deferred prompt', async () => {
  const harness = createHarness();
  await loadInstallController(harness);
  let prompts = 0;
  await harness.emit('beforeinstallprompt', {
    preventDefault() {},
    prompt() { prompts += 1; },
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  });

  await harness.controls[0].click();
  await harness.controls[0].click();

  assert.equal(prompts, 1);
  assert.ok(harness.controls.every(control => !control.hidden));
  assert.match(harness.messages[0].textContent, /menu przeglądarki/i);
  assert.equal(harness.messages[0].hidden, false);
});

test('hides install controls and messages after installation', async () => {
  const harness = createHarness();
  await loadInstallController(harness);

  await harness.emit('appinstalled', {});

  assert.ok(harness.controls.every(control => control.hidden));
  assert.ok(harness.messages.every(message => message.hidden));
});
