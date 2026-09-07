import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from '../src/firestore.ts';
import { normalizeMemberList, migrateActiveMembers } from './migrate-existing-members.ts';

test('normalizeMemberList parses "email,fullName" pairs, lowercases/trims the email, dedupes, and skips invalid entries', () => {
  const result = normalizeMemberList([
    ' Alice@Example.com , Alice Kowalska ',
    'alice@example.com,Someone Else', // duplicate email - later line ignored
    'not-an-email,Nobody',
    'bob@example.com',
    '',
  ]);
  assert.deepEqual(result.valid, [
    { email: 'alice@example.com', fullName: 'Alice Kowalska' },
    { email: 'bob@example.com', fullName: 'bob@example.com' },
  ]);
  assert.equal(result.duplicatesRemoved, 1);
  assert.deepEqual(result.invalid, ['not-an-email,Nobody']);
});

test('migrateActiveMembers creates a new active doc using the given fullName, not the email', async () => {
  const client = createInMemoryFirestoreClient();
  const result = await migrateActiveMembers(client, [{ email: 'new@example.com', fullName: 'Nowy Członek' }], { dryRun: false });
  assert.equal(result.created, 1);
  const doc = await client.getDoc('members', 'new@example.com') as Record<string, unknown>;
  assert.equal(doc.status, 'active');
  assert.equal(doc.fullName, 'Nowy Członek');
});

test('migrateActiveMembers falls back to the email as fullName when none is given', async () => {
  const client = createInMemoryFirestoreClient();
  await migrateActiveMembers(client, [{ email: 'new@example.com', fullName: 'new@example.com' }], { dryRun: false });
  const doc = await client.getDoc('members', 'new@example.com') as Record<string, unknown>;
  assert.equal(doc.fullName, 'new@example.com');
});

test('migrateActiveMembers only sets status/fullName on an existing self-service profile doc, preserving other fields, and never touches fullName written by a real member', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'existing@example.com', {
    email: 'existing@example.com', fullName: 'Real Person Name', nickname: 'Ex', sectionId: 'sekcja-3',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'old', approvedAt: null, approvedBy: null,
    updatedAt: 'old', updatedBy: 'existing@example.com',
  });
  const result = await migrateActiveMembers(client, [{ email: 'existing@example.com', fullName: 'Wrong Name From Migration' }], { dryRun: false });
  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  const doc = await client.getDoc('members', 'existing@example.com') as Record<string, unknown>;
  assert.equal(doc.status, 'active');
  assert.equal(doc.fullName, 'Real Person Name', 'a real self-service edit must never be overwritten by the migration');
  assert.equal(doc.sectionId, 'sekcja-3');
});

test('migrateActiveMembers corrects a fullName it previously set itself when re-run with a better value', async () => {
  const client = createInMemoryFirestoreClient();
  await migrateActiveMembers(client, [{ email: 'a@example.com', fullName: 'a@example.com' }], { dryRun: false });
  const corrected = await migrateActiveMembers(client, [{ email: 'a@example.com', fullName: 'Prawdziwe Imię' }], { dryRun: false });
  assert.equal(corrected.updated, 1);
  const doc = await client.getDoc('members', 'a@example.com') as Record<string, unknown>;
  assert.equal(doc.fullName, 'Prawdziwe Imię');
  assert.equal(doc.updatedBy, 'migration-script');
});

// Regression test for a real production incident: an earlier version of this script decided
// "safe to overwrite fullName" by checking updatedBy === "migration-script" - but the *original*
// buggy run had already stamped that updatedBy value onto every doc it touched, including ones
// where it correctly left a real member's own fullName alone. A later corrective run then
// treated that stamp as "migration owns this name" and overwrote a real name. The fix checks
// fullName === email instead, which this doc's shape deliberately violates (updatedBy looks
// like the migration script, but fullName is real self-service data) to prove that trap is closed.
test('migrateActiveMembers never overwrites a real fullName just because updatedBy says "migration-script"', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'real@example.com', {
    email: 'real@example.com', fullName: 'Bartias', nickname: 'Bartias', sectionId: 'bydgoszcz',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x',
    approvedBy: 'migration-script', updatedAt: 'x', updatedBy: 'migration-script',
  });
  await migrateActiveMembers(client, [{ email: 'real@example.com', fullName: 'real@example.com' }], { dryRun: false });
  const doc = await client.getDoc('members', 'real@example.com') as Record<string, unknown>;
  assert.equal(doc.fullName, 'Bartias');
});

test('migrateActiveMembers is idempotent - running twice with the same input produces the same end state', async () => {
  const client = createInMemoryFirestoreClient();
  await migrateActiveMembers(client, [{ email: 'a@example.com', fullName: 'A' }, { email: 'b@example.com', fullName: 'B' }], { dryRun: false });
  const secondRun = await migrateActiveMembers(client, [{ email: 'a@example.com', fullName: 'A' }, { email: 'b@example.com', fullName: 'B' }], { dryRun: false });
  assert.equal(secondRun.created, 0);
  assert.equal(secondRun.updated, 2);
  const all = await client.listDocs('members');
  assert.equal(all.length, 2);
});

test('migrateActiveMembers in dry-run mode reports intended changes without writing', async () => {
  const client = createInMemoryFirestoreClient();
  const result = await migrateActiveMembers(client, [{ email: 'a@example.com', fullName: 'A' }], { dryRun: true });
  assert.equal(result.created, 1);
  const doc = await client.getDoc('members', 'a@example.com');
  assert.equal(doc, null);
});
