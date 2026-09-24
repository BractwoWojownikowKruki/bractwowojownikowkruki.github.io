import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { getClientIp, isRateLimited, resetRateLimitForTests } from './rate-limit.ts';

function makeReq(headers: Record<string, string | string[] | undefined>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test('isRateLimited allows requests under the threshold', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    assert.equal(isRateLimited('1.2.3.4', 1000), false);
  }
});

test('isRateLimited blocks once a single IP exceeds the threshold within the window', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    isRateLimited('1.2.3.4', 1000);
  }
  assert.equal(isRateLimited('1.2.3.4', 1000), true);
});

test('isRateLimited tracks IPs independently', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    isRateLimited('1.2.3.4', 1000);
  }
  assert.equal(isRateLimited('5.6.7.8', 1000), false);
});

test('isRateLimited resets once the window has elapsed', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    isRateLimited('1.2.3.4', 1000);
  }
  assert.equal(isRateLimited('1.2.3.4', 1000 + 60_000), false);
});

// KRKG-0108: the LAST entry is the one Google's frontend appends and the caller cannot influence
// - see getClientIp's own comment for how that was confirmed for this deployment.
test('getClientIp uses the last entry, ignoring however many the caller prepends', () => {
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': '9.9.9.9, 46.112.2.10' })), '46.112.2.10');
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 1.1.1.1, 46.112.2.10' })), '46.112.2.10');
});

test('getClientIp trims whitespace around the last entry', () => {
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': '9.9.9.9,  46.112.2.10  ' })), '46.112.2.10');
});

test('getClientIp works with a single-entry header (no proxy chain to strip)', () => {
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': '46.112.2.10' })), '46.112.2.10');
});

test('getClientIp uses the last entry of the last array element for a duplicated header', () => {
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': ['9.9.9.9', '8.8.8.8, 46.112.2.10'] })), '46.112.2.10');
});

test('getClientIp falls back to the raw socket address when there is no header (local/dev)', () => {
  assert.equal(getClientIp(makeReq({}, '127.0.0.1')), '127.0.0.1');
});

test('getClientIp falls back to "unknown" when neither the header nor the socket address exist', () => {
  assert.equal(getClientIp(makeReq({})), 'unknown');
});

// The bypass this batch closes: a caller forging a fresh, distinct first entry on every request
// must not evade the limit by doing so, since the real IP (the last entry) never changes.
test('isRateLimited still blocks a caller who forges a different first X-Forwarded-For entry every request', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    const ip = getClientIp(makeReq({ 'x-forwarded-for': `${i}.${i}.${i}.${i}, 46.112.2.10` }));
    isRateLimited(ip, 1000);
  }
  const ip = getClientIp(makeReq({ 'x-forwarded-for': '255.255.255.255, 46.112.2.10' }));
  assert.equal(isRateLimited(ip, 1000), true);
});

// KRKG-0108 (batch 5 review): a header GFE would never actually send (a trailing comma, or
// whitespace-only) must not become an empty-string rate-limit key shared by every such caller.
test('getClientIp falls back to the socket address when the header\'s last entry is empty', () => {
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': '46.112.2.10, ' }, '127.0.0.1')), '127.0.0.1');
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': ',,' }, '127.0.0.1')), '127.0.0.1');
  assert.equal(getClientIp(makeReq({ 'x-forwarded-for': '   ' }, '127.0.0.1')), '127.0.0.1');
});
