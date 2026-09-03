import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  AuthError,
  checkReauthFreshness,
  issueSessionToken,
  maybeRenewSessionToken,
  verifySessionToken,
  type SessionSigningKey,
} from './session.ts';

const KEY: SessionSigningKey = { v: 'k1', secret: 'secret' };
const OTHER_KEY: SessionSigningKey = { v: 'k2', secret: 'other-secret' };
const DAY_MS = 24 * 60 * 60 * 1000;
const SLIDING_WINDOW_MS = 14 * DAY_MS;
const MAX_LIFETIME_MS = 30 * DAY_MS;

test('issueSessionToken and verifySessionToken round-trip the same identity', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  const claims = verifySessionToken(token, [KEY], now, MAX_LIFETIME_MS);
  assert.equal(claims.sub, 's1');
  assert.equal(claims.email, 'a@example.com');
  assert.equal(claims.v, 'k1');
  assert.equal(claims.iat, now);
  assert.equal(claims.reauthAt, now);
  assert.equal(claims.exp, now + SLIDING_WINDOW_MS);
  assert.equal(typeof claims.jti, 'string');
  assert.ok(claims.jti.length > 0);
});

test('verifySessionToken accepts an old key still present in the rotation list', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, OTHER_KEY, now, SLIDING_WINDOW_MS);
  const claims = verifySessionToken(token, [KEY, OTHER_KEY], now, MAX_LIFETIME_MS);
  assert.equal(claims.v, 'k2');
});

test('verifySessionToken rejects a token whose key version is not in the list (rotated out)', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, OTHER_KEY, now, SLIDING_WINDOW_MS);
  assert.throws(
    () => verifySessionToken(token, [KEY], now, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionToken rejects a token signed with a different secret under the same key version', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  assert.throws(
    () => verifySessionToken(token, [{ v: 'k1', secret: 'wrong-secret' }], now, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionToken rejects an expired token', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  assert.throws(
    () => verifySessionToken(token, [KEY], now + SLIDING_WINDOW_MS + 1, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionToken rejects a tampered payload', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  const [, signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ v: 'k1', sub: 'attacker', email: 'a@example.com', iat: now, reauthAt: now, exp: now + SLIDING_WINDOW_MS, jti: 'x' }),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.throws(
    () => verifySessionToken(`${forgedPayload}.${signature}`, [KEY], now, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionToken rejects a malformed token', () => {
  assert.throws(
    () => verifySessionToken('not-a-valid-token', [KEY], 1_000_000, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionToken rejects a payload missing required fields', () => {
  const payloadB64 = Buffer.from(JSON.stringify({ v: 'k1', sub: 's1' }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = createHmac('sha256', 'secret').update(payloadB64).digest('base64url');
  assert.throws(
    () => verifySessionToken(`${payloadB64}.${signature}`, [KEY], 1_000_000, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionToken enforces the absolute lifetime cap even if exp claims otherwise', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, MAX_LIFETIME_MS + DAY_MS);
  assert.throws(
    () => verifySessionToken(token, [KEY], now, MAX_LIFETIME_MS),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('maybeRenewSessionToken does not renew before the halfway point of the window', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  const claims = verifySessionToken(token, [KEY], now, MAX_LIFETIME_MS);
  const renewed = maybeRenewSessionToken(claims, KEY, now + SLIDING_WINDOW_MS / 4, SLIDING_WINDOW_MS, MAX_LIFETIME_MS);
  assert.equal(renewed, null);
});

test('maybeRenewSessionToken renews past the halfway point, extending exp but preserving iat/reauthAt/jti', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  const claims = verifySessionToken(token, [KEY], now, MAX_LIFETIME_MS);
  const renewAt = now + SLIDING_WINDOW_MS / 2 + 1;
  const renewed = maybeRenewSessionToken(claims, KEY, renewAt, SLIDING_WINDOW_MS, MAX_LIFETIME_MS);
  assert.ok(renewed);
  assert.equal(renewed!.exp, renewAt + SLIDING_WINDOW_MS);
  const renewedClaims = verifySessionToken(renewed!.token, [KEY], renewAt, MAX_LIFETIME_MS);
  assert.equal(renewedClaims.iat, now);
  assert.equal(renewedClaims.reauthAt, now);
  assert.equal(renewedClaims.jti, claims.jti);
  assert.equal(renewedClaims.exp, renewAt + SLIDING_WINDOW_MS);
});

test('maybeRenewSessionToken caps exp at iat + maxLifetimeMs, never past the absolute cap', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, KEY, now, SLIDING_WINDOW_MS);
  const claims = verifySessionToken(token, [KEY], now, MAX_LIFETIME_MS);
  const renewAt = now + MAX_LIFETIME_MS - DAY_MS;
  const renewed = maybeRenewSessionToken(claims, KEY, renewAt, SLIDING_WINDOW_MS, MAX_LIFETIME_MS);
  assert.ok(renewed);
  assert.equal(renewed!.exp, now + MAX_LIFETIME_MS);
  const renewedClaims = verifySessionToken(renewed!.token, [KEY], renewAt, MAX_LIFETIME_MS);
  assert.equal(renewedClaims.exp, now + MAX_LIFETIME_MS);
});

test('maybeRenewSessionToken returns null once the absolute cap has already been reached', () => {
  const now = 1_000_000;
  const cappedClaims = {
    v: 'k1',
    sub: 's1',
    email: 'a@example.com',
    iat: now,
    reauthAt: now,
    exp: now + MAX_LIFETIME_MS,
    jti: 'stable-jti',
  };
  const renewed = maybeRenewSessionToken(cappedClaims, KEY, now + MAX_LIFETIME_MS - 1, SLIDING_WINDOW_MS, MAX_LIFETIME_MS);
  assert.equal(renewed, null);
});

test('maybeRenewSessionToken re-signs with the current key, migrating a session off a rotated-out key', () => {
  const now = 1_000_000;
  const token = issueSessionToken({ sub: 's1', email: 'a@example.com' }, OTHER_KEY, now, SLIDING_WINDOW_MS);
  const claims = verifySessionToken(token, [KEY, OTHER_KEY], now, MAX_LIFETIME_MS);
  const renewAt = now + SLIDING_WINDOW_MS / 2 + 1;
  const renewed = maybeRenewSessionToken(claims, KEY, renewAt, SLIDING_WINDOW_MS, MAX_LIFETIME_MS);
  const renewedClaims = verifySessionToken(renewed!.token, [KEY], renewAt, MAX_LIFETIME_MS);
  assert.equal(renewedClaims.v, 'k1');
});

test('checkReauthFreshness passes within the freshness window', () => {
  const now = 1_000_000;
  const claims = { v: 'k1', sub: 's1', email: 'a@example.com', iat: now, reauthAt: now, exp: now + SLIDING_WINDOW_MS, jti: 'j1' };
  checkReauthFreshness(claims, now + 29 * 60 * 1000, 30 * 60 * 1000);
});

test('checkReauthFreshness rejects once the freshness window has elapsed since the last real login', () => {
  const now = 1_000_000;
  const claims = { v: 'k1', sub: 's1', email: 'a@example.com', iat: now, reauthAt: now, exp: now + SLIDING_WINDOW_MS, jti: 'j1' };
  assert.throws(
    () => checkReauthFreshness(claims, now + 31 * 60 * 1000, 30 * 60 * 1000),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('checkReauthFreshness stays keyed to reauthAt, not exp, so sliding renewal alone cannot satisfy it', () => {
  // A cookie renewed far into its sliding window (exp is way out) but whose reauthAt is stale
  // must still fail the step-up check - this is the whole point of the separate field.
  const now = 1_000_000;
  const claims = { v: 'k1', sub: 's1', email: 'a@example.com', iat: now, reauthAt: now, exp: now + MAX_LIFETIME_MS, jti: 'j1' };
  assert.throws(
    () => checkReauthFreshness(claims, now + 31 * 60 * 1000, 30 * 60 * 1000),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});
