import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { AuthError, checkAllowlist, checkClaims, decodeJwt, verifyGoogleIdToken, verifyJwtSignature } from './auth.ts';

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeSignedToken(payload: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const headerB64 = base64Url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string };
const testJwk = { kid: 'test-kid', kty: exportedJwk.kty, n: exportedJwk.n, e: exportedJwk.e };

test('decodeJwt rejects a malformed token', () => {
  assert.throws(() => decodeJwt('not-a-jwt'), (err: unknown) => err instanceof AuthError && err.status === 401);
});

test('checkClaims accepts a well-formed, current, verified-email payload and lowercases the email', () => {
  const now = 1_700_000_000;
  const identity = checkClaims(
    { iss: 'https://accounts.google.com', aud: 'client-123', exp: now + 60, email_verified: true, email: 'Alice@Gmail.com', sub: 'sub-1' },
    'client-123',
    now,
  );
  assert.deepEqual(identity, { sub: 'sub-1', email: 'alice@gmail.com' });
});

test('checkClaims includes name and picture when the token carries them', () => {
  const now = 1_700_000_000;
  const identity = checkClaims(
    {
      iss: 'https://accounts.google.com',
      aud: 'client-123',
      exp: now + 60,
      email_verified: true,
      email: 'alice@gmail.com',
      sub: 'sub-1',
      name: 'Alice Kowalski',
      picture: 'https://lh3.googleusercontent.com/a/example',
    },
    'client-123',
    now,
  );
  assert.deepEqual(identity, {
    sub: 'sub-1',
    email: 'alice@gmail.com',
    name: 'Alice Kowalski',
    picture: 'https://lh3.googleusercontent.com/a/example',
  });
});

test('checkClaims omits name and picture when the token lacks them', () => {
  const now = 1_700_000_000;
  const identity = checkClaims(
    { iss: 'https://accounts.google.com', aud: 'client-123', exp: now + 60, email_verified: true, email: 'alice@gmail.com', sub: 'sub-1' },
    'client-123',
    now,
  );
  assert.deepEqual(identity, { sub: 'sub-1', email: 'alice@gmail.com' });
});

test('checkClaims rejects a token issued for a different audience', () => {
  assert.throws(
    () => checkClaims({ iss: 'https://accounts.google.com', aud: 'wrong', exp: 9e9, email_verified: true, email: 'a@b.com', sub: 's' }, 'client-123'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('checkClaims rejects an expired token', () => {
  assert.throws(
    () => checkClaims({ iss: 'https://accounts.google.com', aud: 'client-123', exp: 1, email_verified: true, email: 'a@b.com', sub: 's' }, 'client-123', 1000),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('checkClaims rejects an unverified email', () => {
  assert.throws(
    () => checkClaims({ iss: 'https://accounts.google.com', aud: 'client-123', exp: 9e9, email_verified: false, email: 'a@b.com', sub: 's' }, 'client-123'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('checkClaims rejects an unrecognized issuer', () => {
  assert.throws(
    () => checkClaims({ iss: 'https://evil.example', aud: 'client-123', exp: 9e9, email_verified: true, email: 'a@b.com', sub: 's' }, 'client-123'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('checkAllowlist accepts an allowlisted email', () => {
  const identity = checkAllowlist({ sub: 's', email: 'alice@gmail.com' }, ['alice@gmail.com']);
  assert.equal(identity.email, 'alice@gmail.com');
});

test('checkAllowlist rejects a non-allowlisted email', () => {
  assert.throws(
    () => checkAllowlist({ sub: 's', email: 'mallory@gmail.com' }, ['alice@gmail.com']),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('verifyJwtSignature accepts a token signed with the matching private key', () => {
  const token = makeSignedToken({ sub: 'sub-1' }, privateKey, 'test-kid');
  const decoded = decodeJwt(token);
  assert.equal(verifyJwtSignature(decoded, testJwk), true);
});

test('verifyJwtSignature rejects a tampered payload', () => {
  const token = makeSignedToken({ sub: 'sub-1' }, privateKey, 'test-kid');
  const [headerB64, , signatureB64] = token.split('.');
  const tamperedPayload = base64Url(Buffer.from(JSON.stringify({ sub: 'attacker' })));
  const decoded = decodeJwt(`${headerB64}.${tamperedPayload}.${signatureB64}`);
  assert.equal(verifyJwtSignature(decoded, testJwk), false);
});

test('verifyGoogleIdToken performs full end-to-end verification against an injected JWKS provider', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeSignedToken(
    { iss: 'https://accounts.google.com', aud: 'client-123', exp: now + 60, email_verified: true, email: 'alice@gmail.com', sub: 'sub-1' },
    privateKey,
    'test-kid',
  );
  const identity = await verifyGoogleIdToken(token, 'client-123', async () => [testJwk]);
  assert.deepEqual(identity, { sub: 'sub-1', email: 'alice@gmail.com' });
});

test('verifyGoogleIdToken rejects a token whose kid is not in the JWKS', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeSignedToken(
    { iss: 'https://accounts.google.com', aud: 'client-123', exp: now + 60, email_verified: true, email: 'alice@gmail.com', sub: 'sub-1' },
    privateKey,
    'unknown-kid',
  );
  await assert.rejects(
    verifyGoogleIdToken(token, 'client-123', async () => [testJwk]),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});
