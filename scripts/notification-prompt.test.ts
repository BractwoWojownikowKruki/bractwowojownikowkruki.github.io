import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/notification-prompt.js', import.meta.url), 'utf8');
const footer = readFileSync(new URL('../templates/footer.html', import.meta.url), 'utf8');

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function memoryStorage(initial: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

type Harness = {
  helpers: Record<string, any>;
  context: Record<string, any>;
  listeners: Record<string, Array<() => void>>;
  initCalls: Array<Record<string, any>>;
  apiCalls: string[];
  shown: number;
};

// Loads notification-prompt.js into a vm context. Its only top-level effect is a DOMContentLoaded
// listener, so the stubs below record the bootstrap and let each test drive the flow by hand.
function load(options: {
  storage?: Storage;
  pathname?: string;
  apiFetch?: (path: string) => Promise<unknown>;
  now?: number;
} = {}): Harness {
  const listeners: Record<string, Array<() => void>> = {};
  const initCalls: Array<Record<string, any>> = [];
  const apiCalls: string[] = [];
  const harness = {} as Harness;
  const context: Record<string, any> = {
    localStorage: options.storage,
    location: { pathname: options.pathname ?? '/aktualnosci/' },
    document: {
      addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
      removeEventListener: () => {},
    },
    initGoogleSignIn: (config: Record<string, any>) => { initCalls.push(config); },
    apiFetch: async (path: string) => {
      apiCalls.push(path);
      return options.apiFetch ? options.apiFetch(path) : undefined;
    },
    Date: { now: () => options.now ?? NOW },
    Number,
    String,
    Array,
    Boolean,
    Error,
    Promise,
    console,
  };
  vm.runInNewContext(
    `${source}\n;globalThis.__h = { readNotificationPromptLastShown, writeNotificationPromptLastShown, isNotificationPromptDue, hasNoNotificationsEnabled, checkNotificationPrompt, NOTIFICATION_PROMPT_KEY };`,
    context,
    { filename: 'notification-prompt.js' },
  );
  harness.helpers = context.__h;
  harness.context = context;
  harness.listeners = listeners;
  harness.initCalls = initCalls;
  harness.apiCalls = apiCalls;
  harness.shown = 0;
  context.showNotificationPrompt = () => { harness.shown += 1; };
  return harness;
}

const NO_NOTIFICATIONS = { emailEnabled: false, push: { publicKey: 'k', eligible: true, endpoints: [] } };

test('the pop-up is due when it was never shown, or the last showing is two weeks old', () => {
  const h = load().helpers;
  assert.equal(h.isNotificationPromptDue(null, NOW), true);
  assert.equal(h.isNotificationPromptDue(NOW - TWO_WEEKS_MS + 1, NOW), false);
  assert.equal(h.isNotificationPromptDue(NOW - TWO_WEEKS_MS, NOW), true);
  assert.equal(h.isNotificationPromptDue(NOW - 60_000, NOW), false);
});

test('a timestamp in the future (clock moved back) does not hide the pop-up', () => {
  const h = load().helpers;
  assert.equal(h.isNotificationPromptDue(NOW + TWO_WEEKS_MS, NOW), true);
});

test('the last-shown time round-trips through localStorage as a plain number', () => {
  const storage = memoryStorage();
  const h = load({ storage }).helpers;
  h.writeNotificationPromptLastShown(NOW);
  assert.equal(storage.map.get(h.NOTIFICATION_PROMPT_KEY), String(NOW));
  assert.equal(h.readNotificationPromptLastShown(), NOW);
});

test('a missing, corrupt, or throwing storage reads as never shown and never throws on write', () => {
  const throwing: Storage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  const missing = load({ storage: memoryStorage() }).helpers;
  assert.equal(missing.readNotificationPromptLastShown(), null);

  const corrupt = load({ storage: memoryStorage({ kruki_notification_prompt_last_shown: 'nie-liczba' }) }).helpers;
  assert.equal(corrupt.readNotificationPromptLastShown(), null);

  for (const storage of [undefined, throwing]) {
    const h = load({ storage }).helpers;
    assert.equal(h.readNotificationPromptLastShown(), null);
    assert.doesNotThrow(() => h.writeNotificationPromptLastShown(NOW));
  }
});

test('only a member with e-mail switched off and no push device counts as having no notifications', () => {
  const h = load().helpers;
  assert.equal(h.hasNoNotificationsEnabled(NO_NOTIFICATIONS), true);
  assert.equal(h.hasNoNotificationsEnabled({ emailEnabled: true, push: { endpoints: [] } }), false);
  assert.equal(h.hasNoNotificationsEnabled({ emailEnabled: false, push: { endpoints: ['https://push.example/abc'] } }), false);
  // The server default is "on", so a response without the flag must not count as switched off.
  assert.equal(h.hasNoNotificationsEnabled({ push: { endpoints: [] } }), false);
  // Malformed responses fail closed - no pop-up.
  assert.equal(h.hasNoNotificationsEnabled({ emailEnabled: false }), false);
  assert.equal(h.hasNoNotificationsEnabled({ emailEnabled: false, push: { endpoints: 'x' } }), false);
  assert.equal(h.hasNoNotificationsEnabled(null), false);
});

test('a member with no notifications and no recent showing gets the pop-up once, and the showing is recorded', async () => {
  const storage = memoryStorage();
  const h = load({ storage, apiFetch: async () => NO_NOTIFICATIONS });
  await h.helpers.checkNotificationPrompt();
  assert.deepEqual(h.apiCalls, ['/profile/notifications']);
  assert.equal(h.shown, 1);
});

test('a showing from less than two weeks ago skips the settings request and the pop-up', async () => {
  const storage = memoryStorage({ kruki_notification_prompt_last_shown: String(NOW - TWO_WEEKS_MS + 1000) });
  const h = load({ storage, apiFetch: async () => NO_NOTIFICATIONS });
  await h.helpers.checkNotificationPrompt();
  assert.deepEqual(h.apiCalls, []);
  assert.equal(h.shown, 0);
});

test('a member who has a push device or e-mail on gets no pop-up and no timestamp', async () => {
  for (const settings of [
    { emailEnabled: true, push: { endpoints: [] } },
    { emailEnabled: false, push: { endpoints: ['https://push.example/abc'] } },
  ]) {
    const storage = memoryStorage();
    const h = load({ storage, apiFetch: async () => settings });
    await h.helpers.checkNotificationPrompt();
    assert.equal(h.shown, 0);
    assert.equal(storage.map.has(h.helpers.NOTIFICATION_PROMPT_KEY), false);
  }
});

test('a failed settings request (no session, network) stays quiet and records nothing', async () => {
  const storage = memoryStorage();
  const h = load({ storage, apiFetch: async () => { throw new Error('HTTP 401'); } });
  await assert.doesNotReject(h.helpers.checkNotificationPrompt());
  assert.equal(h.shown, 0);
  assert.equal(storage.map.has(h.helpers.NOTIFICATION_PROMPT_KEY), false);
});

test('the profile page itself never shows the pop-up or fetches the settings', async () => {
  const h = load({ pathname: '/profil/', storage: memoryStorage(), apiFetch: async () => NO_NOTIFICATIONS });
  await h.helpers.checkNotificationPrompt();
  assert.deepEqual(h.apiCalls, []);
  assert.equal(h.shown, 0);
});

test('the bootstrap wires the member whoami check on DOMContentLoaded, with the same path nav.js uses', () => {
  const h = load();
  assert.equal(h.initCalls.length, 0, 'nothing runs before the parser finishes classic scripts');
  for (const fn of h.listeners.DOMContentLoaded ?? []) fn();
  assert.equal(h.initCalls.length, 1);
  assert.equal(h.initCalls[0].whoamiPath, '/wojownicy-upload/whoami');
  assert.equal(JSON.stringify(h.initCalls[0].buttonIds), '[]');
  assert.equal(typeof h.initCalls[0].onSignedIn, 'function');
});

test('the footer partial loads the pop-up on every page', () => {
  assert.match(footer, /<script src="\/shared\/notification-prompt\.js"><\/script>/);
});
