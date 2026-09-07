import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from '../src/firestore.ts';
import { normalizeEmailList, migrateActiveMembers } from './migrate-existing-members.ts';

test('normalizeEmailList lowercases, trims, dedupes, and skips invalid entries', () => {
  const result = normalizeEmailList([' Alice@Example.com ', 'alice@example.com', 'not-an-email', 'bob@example.com', '']);
  assert.deepEqual(result.valid, ['alice@example.com', 'bob@example.com']);
  assert.equal(result.duplicatesRemoved, 1);
  assert.deepEqual(result.invalid, ['not-an-email']);
});

test('migrateActiveMembers creates a new active doc for an email with no existing record', async () => {
  const client = createInMemoryFirestoreClient();
  const result = await migrateActiveMembers(client, ['new@example.com'], { dryRun: false });
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  const doc = await client.getDoc('members', 'new@example.com');
  assert.equal((doc as { status: string }).status, 'active');
});

test('migrateActiveMembers only sets status on an existing profile doc, preserving other fields', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'existing@example.com', {
    email: 'existing@example.com', fullName: 'Existing Person', nickname: 'Ex', sectionId: 'sekcja-3',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'old', approvedAt: null, approvedBy: null,
    updatedAt: 'old', updatedBy: 'existing@example.com',
  });
  const result = await migrateActiveMembers(client, ['existing@example.com'], { dryRun: false });
  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  const doc = await client.getDoc('members', 'existing@example.com') as Record<string, unknown>;
  assert.equal(doc.status, 'active');
  assert.equal(doc.fullName, 'Existing Person');
  assert.equal(doc.sectionId, 'sekcja-3');
});

test('migrateActiveMembers is idempotent - running twice produces the same end state', async () => {
  const client = createInMemoryFirestoreClient();
  await migrateActiveMembers(client, ['a@example.com', 'b@example.com'], { dryRun: false });
  const secondRun = await migrateActiveMembers(client, ['a@example.com', 'b@example.com'], { dryRun: false });
  assert.equal(secondRun.created, 0);
  assert.equal(secondRun.updated, 2);
  const all = await client.listDocs('members');
  assert.equal(all.length, 2);
});

test('migrateActiveMembers in dry-run mode reports intended changes without writing', async () => {
  const client = createInMemoryFirestoreClient();
  const result = await migrateActiveMembers(client, ['a@example.com'], { dryRun: true });
  assert.equal(result.created, 1);
  const doc = await client.getDoc('members', 'a@example.com');
  assert.equal(doc, null);
});
