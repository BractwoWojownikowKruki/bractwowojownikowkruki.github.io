import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, checkSubmissionOwnership, issueSubmissionToken, verifySubmissionToken } from './submission.ts';

test('issueSubmissionToken and verifySubmissionToken round-trip the same claims', () => {
  const exp = Date.now() + 60_000;
  const token = issueSubmissionToken({ folderId: 'f1', sub: 's1', exp }, 'secret');
  const claims = verifySubmissionToken(token, 'secret');
  assert.deepEqual(claims, { folderId: 'f1', sub: 's1', exp });
});

test('verifySubmissionToken rejects a token signed with a different secret', () => {
  const token = issueSubmissionToken({ folderId: 'f1', sub: 's1', exp: Date.now() + 60_000 }, 'secret');
  assert.throws(
    () => verifySubmissionToken(token, 'other-secret'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySubmissionToken rejects an expired token', () => {
  const token = issueSubmissionToken({ folderId: 'f1', sub: 's1', exp: Date.now() - 1 }, 'secret');
  assert.throws(
    () => verifySubmissionToken(token, 'secret'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySubmissionToken rejects a payload tampered after signing', () => {
  const token = issueSubmissionToken({ folderId: 'f1', sub: 's1', exp: Date.now() + 60_000 }, 'secret');
  const [, signature] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ folderId: 'f2', sub: 's1', exp: Date.now() + 60_000 }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.throws(
    () => verifySubmissionToken(`${forgedPayload}.${signature}`, 'secret'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySubmissionToken rejects a malformed token', () => {
  assert.throws(
    () => verifySubmissionToken('not-a-valid-token', 'secret'),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('checkSubmissionOwnership rejects a folderId mismatch', () => {
  assert.throws(
    () => checkSubmissionOwnership({ folderId: 'f1', sub: 's1', exp: Date.now() + 1000 }, 'f2', 's1'),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('checkSubmissionOwnership rejects a subject mismatch (different uploader)', () => {
  assert.throws(
    () => checkSubmissionOwnership({ folderId: 'f1', sub: 's1', exp: Date.now() + 1000 }, 'f1', 's2'),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('checkSubmissionOwnership accepts a matching folder and subject', () => {
  checkSubmissionOwnership({ folderId: 'f1', sub: 's1', exp: Date.now() + 1000 }, 'f1', 's1');
});
