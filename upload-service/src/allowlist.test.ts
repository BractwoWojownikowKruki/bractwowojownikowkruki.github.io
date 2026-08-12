import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSheetAllowlist, parseAllowlistCsv } from './allowlist.ts';

test('parseAllowlistCsv skips the header row and returns trimmed, lowercased emails', () => {
  const csv = 'Email\nAlice@Gmail.com\nbob@example.com\n';
  assert.deepEqual(parseAllowlistCsv(csv), ['alice@gmail.com', 'bob@example.com']);
});

test('parseAllowlistCsv ignores blank lines and surrounding whitespace', () => {
  const csv = 'Email\n  alice@gmail.com  \n\n\nbob@example.com\n';
  assert.deepEqual(parseAllowlistCsv(csv), ['alice@gmail.com', 'bob@example.com']);
});

test('parseAllowlistCsv returns an empty list when only the header is present', () => {
  assert.deepEqual(parseAllowlistCsv('Email\n'), []);
});

function fakeResponse(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test('getEmails fetches and caches within the TTL, calling fetchImpl only once', async () => {
  let calls = 0;
  let now = 1000;
  const allowlist = createSheetAllowlist({
    url: 'https://example.com/csv',
    ttlMs: 5000,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(200, 'Email\nalice@gmail.com\n');
    },
  });

  assert.deepEqual(await allowlist.getEmails(), ['alice@gmail.com']);
  now += 1000;
  assert.deepEqual(await allowlist.getEmails(), ['alice@gmail.com']);
  assert.equal(calls, 1);
});

test('getEmails refetches once the TTL has expired', async () => {
  let calls = 0;
  let now = 1000;
  const allowlist = createSheetAllowlist({
    url: 'https://example.com/csv',
    ttlMs: 5000,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(200, 'Email\nalice@gmail.com\n');
    },
  });

  await allowlist.getEmails();
  now += 5001;
  await allowlist.getEmails();
  assert.equal(calls, 2);
});

test('getEmails returns an empty list and does not throw when the fetch rejects', async () => {
  const allowlist = createSheetAllowlist({
    url: 'https://example.com/csv',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.deepEqual(await allowlist.getEmails(), []);
});

test('getEmails returns an empty list on a non-OK HTTP status', async () => {
  const allowlist = createSheetAllowlist({
    url: 'https://example.com/csv',
    fetchImpl: async () => fakeResponse(404, 'not found'),
  });
  assert.deepEqual(await allowlist.getEmails(), []);
});

test('getEmails fails closed on refetch failure even though a previous fetch had succeeded', async () => {
  let now = 1000;
  let shouldFail = false;
  const allowlist = createSheetAllowlist({
    url: 'https://example.com/csv',
    ttlMs: 5000,
    now: () => now,
    fetchImpl: async () => {
      if (shouldFail) throw new Error('transient outage');
      return fakeResponse(200, 'Email\nalice@gmail.com\n');
    },
  });

  assert.deepEqual(await allowlist.getEmails(), ['alice@gmail.com']);
  now += 5001;
  shouldFail = true;
  assert.deepEqual(await allowlist.getEmails(), []);
});
