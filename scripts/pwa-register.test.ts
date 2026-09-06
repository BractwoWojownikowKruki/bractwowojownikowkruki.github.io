import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

type EventListener = (event?: unknown) => unknown;

function createHarness(options: {
  controllerAtStart?: boolean;
  registerRejects?: boolean;
  updateRejects?: boolean;
  secureContext?: boolean;
  serviceWorkerAvailable?: boolean;
} = {}) {
  const windowListeners = new Map<string, EventListener[]>();
  const serviceWorkerListeners = new Map<string, EventListener[]>();
  const callLog: string[] = [];
  let reloads = 0;

  const registration = {
    update: async () => {
      callLog.push('update');
      if (options.updateRejects) throw new Error('update failed');
    },
  };

  const serviceWorker = options.serviceWorkerAvailable === false
    ? undefined
    : {
        controller: options.controllerAtStart ? {} : null,
        addEventListener(type: string, listener: EventListener) {
          serviceWorkerListeners.set(type, [...(serviceWorkerListeners.get(type) ?? []), listener]);
        },
        register: async (path: string, registerOptions: { updateViaCache?: string }) => {
          callLog.push(`register:${path}:${registerOptions.updateViaCache}`);
          if (options.registerRejects) throw new Error('register failed');
          return registration;
        },
      };
  const navigator = options.serviceWorkerAvailable === false ? {} : { serviceWorker };

  const window = {
    addEventListener(type: string, listener: EventListener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    isSecureContext: options.secureContext ?? true,
    location: {
      reload() {
        reloads += 1;
        callLog.push('reload');
      },
    },
    navigator,
  };

  const context = vm.createContext({
    console,
    location: window.location,
    navigator,
    window,
  });

  return {
    callLog,
    context,
    emit: async (type: string, event?: unknown) => {
      for (const listener of windowListeners.get(type) ?? []) await listener(event);
    },
    emitServiceWorker: async (type: string, event?: unknown) => {
      for (const listener of serviceWorkerListeners.get(type) ?? []) await listener(event);
    },
    get reloads() {
      return reloads;
    },
    serviceWorker,
  };
}

async function loadRegisterScript(harness: ReturnType<typeof createHarness>) {
  const source = await readFile(new URL('../public/pwa-register.js', import.meta.url), 'utf8');
  vm.runInContext(source, harness.context, { filename: 'public/pwa-register.js' });
}

function settle() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

test('reloads once after a controllerchange when the page started under service worker control', async () => {
  const harness = createHarness({ controllerAtStart: true });
  await loadRegisterScript(harness);

  await harness.emit('load');
  await settle();

  assert.deepEqual(harness.callLog, ['register:/service-worker.js:none', 'update']);

  await harness.emitServiceWorker('controllerchange');
  await harness.emitServiceWorker('controllerchange');

  assert.equal(harness.reloads, 1);
  assert.deepEqual(harness.callLog, ['register:/service-worker.js:none', 'update', 'reload']);
});

test('does not reload on the first installation flow', async () => {
  const harness = createHarness();
  await loadRegisterScript(harness);

  await harness.emit('load');
  await settle();
  await harness.emitServiceWorker('controllerchange');

  assert.equal(harness.reloads, 0);
  assert.deepEqual(harness.callLog, ['register:/service-worker.js:none', 'update']);
});

test('swallows register failures without reloading', async () => {
  const harness = createHarness({ registerRejects: true });
  await loadRegisterScript(harness);

  await assert.doesNotReject(harness.emit('load'));
  await settle();

  assert.equal(harness.reloads, 0);
  assert.deepEqual(harness.callLog, ['register:/service-worker.js:none']);
});

test('swallows update failures without reloading', async () => {
  const harness = createHarness({ updateRejects: true });
  await loadRegisterScript(harness);

  await assert.doesNotReject(harness.emit('load'));
  await settle();

  assert.equal(harness.reloads, 0);
  assert.deepEqual(harness.callLog, ['register:/service-worker.js:none', 'update']);
});

test('keeps the early exits for insecure contexts and missing service workers', async () => {
  const insecureHarness = createHarness({ secureContext: false });
  await loadRegisterScript(insecureHarness);
  await insecureHarness.emit('load');
  await settle();
  assert.deepEqual(insecureHarness.callLog, []);

  const noWorkerHarness = createHarness({ serviceWorkerAvailable: false });
  await loadRegisterScript(noWorkerHarness);
  await noWorkerHarness.emit('load');
  await settle();
  assert.deepEqual(noWorkerHarness.callLog, []);
});
