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
