import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeopleSyncTrigger } from './people-sync.ts';

function setup(status = 204) {
  const calls: { url: string; body: unknown }[] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const trigger = createPeopleSyncTrigger({
    token: 'tok',
    repo: 'o/r',
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status });
    }) as typeof fetch,
    now: () => t,
    log: m => logs.push(m),
  });
  return { trigger, calls, logs, advance: (ms: number) => (t += ms) };
}

test('dispatches sync-people-photos.yml on main with the debounce input', async () => {
  const { trigger, calls } = setup();
  await trigger.request();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/actions/workflows/sync-people-photos.yml/dispatches');
  assert.deepEqual(calls[0].body, { ref: 'main', inputs: { debounce_seconds: '120' } });
});

test('a burst of requests dispatches once per interval', async () => {
  const { trigger, calls, advance } = setup();
  await trigger.request();
  await trigger.request();
  advance(30_000);
  await trigger.request();
  assert.equal(calls.length, 1);
  advance(40_000);
  await trigger.request();
  assert.equal(calls.length, 2);
});

test('never throws: HTTP errors and network failures are only logged', async () => {
  const bad = setup(403);
  await bad.trigger.request();
  assert.match(bad.logs[0], /HTTP 403/);

  const failing = createPeopleSyncTrigger({
    token: 't',
    repo: 'o/r',
    fetchImpl: (async () => {
      throw new Error('boom');
    }) as typeof fetch,
    log: () => {},
  });
  await failing.request();
});
