import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getMember, saveMember } from './members.ts';

test('getMember returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await getMember(client, 'nobody@example.test');
  assert.equal(member, null);
});

test('saveMember creates a new record with categoryId/driveFolderId defaulted to null', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await saveMember(client, 'Ala@Example.test', {
    fullName: 'Ala Kowalska',
    nickname: 'Alka',
    sectionId: 'krakow',
  });
  assert.equal(member.fullName, 'Ala Kowalska');
  assert.equal(member.categoryId, null);
  assert.equal(member.driveFolderId, null);
  assert.equal(member.updatedBy, 'ala@example.test');

  const stored = await getMember(client, 'ala@example.test');
  assert.deepEqual(stored, member);
});

test('saveMember on an existing record preserves categoryId and driveFolderId', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.test', {
    fullName: 'Ala Kowalska',
    nickname: 'Alka',
    sectionId: 'krakow',
    categoryId: 'blacha',
    driveFolderId: 'drive-folder-123',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'ala@example.test',
  });

  const updated = await saveMember(client, 'ala@example.test', {
    fullName: 'Ala Kowalska-Nowak',
    nickname: 'Alka',
    sectionId: 'wroclaw',
  });

  assert.equal(updated.fullName, 'Ala Kowalska-Nowak');
  assert.equal(updated.sectionId, 'wroclaw');
  assert.equal(updated.categoryId, 'blacha', 'categoryId must survive a self-service edit untouched');
  assert.equal(updated.driveFolderId, 'drive-folder-123', 'driveFolderId must survive a self-service edit untouched');

  const stored = await getMember(client, 'ala@example.test');
  assert.equal(stored?.categoryId, 'blacha', 'the stored document must keep categoryId, not just the response');
  assert.equal(stored?.driveFolderId, 'drive-folder-123');
});

// The protection is structural, not copy-forward: saveMember never names the admin-owned fields
// in its write, and the merging setDoc leaves them alone. That also covers fields this codebase
// does not model at all - an admin editing the document directly in the Firestore console
// (design.md §2's admin workflow) must not have their work erased by the member's next save.
test('saveMember leaves fields it does not know about untouched', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.test', {
    fullName: 'Ala Kowalska',
    nickname: 'Alka',
    sectionId: 'krakow',
    categoryId: 'blacha',
    driveFolderId: null,
    someAdminAddedField: 'ustawione ręcznie w konsoli',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin@example.test',
  });

  await saveMember(client, 'ala@example.test', {
    fullName: 'Ala Kowalska-Nowak',
    nickname: 'Alka',
    sectionId: 'krakow',
  });

  const stored = await client.getDoc<Record<string, unknown>>('members', 'ala@example.test');
  assert.equal(stored?.someAdminAddedField, 'ustawione ręcznie w konsoli');
  assert.equal(stored?.fullName, 'Ala Kowalska-Nowak');
});

test('saveMember ignores categoryId/driveFolderId even if present on the input object', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await saveMember(client, 'ala@example.test', {
    fullName: 'Ala Kowalska',
    nickname: null,
    sectionId: 'krakow',
    // @ts-expect-error - not part of MemberWritableFields, verifying it's structurally rejected
    categoryId: 'blacha',
  });
  assert.equal(member.categoryId, null);
});
