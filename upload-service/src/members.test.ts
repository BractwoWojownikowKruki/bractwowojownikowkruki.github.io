import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getMember, listAllMembers, saveMember, setMemberDriveFolderId, recordLastLogin } from './members.ts';

test('getMember returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await getMember(client, 'nobody@example.test');
  assert.equal(member, null);
});

test('saveMember creates a new record with categoryId/driveFolderId defaulted to null', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await saveMember(
    client,
    'Ala@Example.test',
    {
      fullName: 'Ala Kowalska',
      nickname: 'Alka',
      sectionId: 'krakow',
    },
    'Ala@Example.test',
  );
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

  const updated = await saveMember(
    client,
    'ala@example.test',
    {
      fullName: 'Ala Kowalska-Nowak',
      nickname: 'Alka',
      sectionId: 'wroclaw',
    },
    'ala@example.test',
  );

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

  await saveMember(
    client,
    'ala@example.test',
    {
      fullName: 'Ala Kowalska-Nowak',
      nickname: 'Alka',
      sectionId: 'krakow',
    },
    'ala@example.test',
  );

  const stored = await client.getDoc<Record<string, unknown>>('members', 'ala@example.test');
  assert.equal(stored?.someAdminAddedField, 'ustawione ręcznie w konsoli');
  assert.equal(stored?.fullName, 'Ala Kowalska-Nowak');
});

test('saveMember ignores categoryId/driveFolderId even if present on the input object', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await saveMember(
    client,
    'ala@example.test',
    {
      fullName: 'Ala Kowalska',
      nickname: null,
      sectionId: 'krakow',
      // @ts-expect-error - not part of MemberWritableFields, verifying it's structurally rejected
      categoryId: 'blacha',
    },
    'ala@example.test',
  );
  assert.equal(member.categoryId, null);
});

// KRKG-0046: status/appliedAt/approvedAt/approvedBy are membership-lifecycle fields, not
// self-service profile fields - saveMember (used only by the already-active-gated "Mój profil"
// edit) must never reset them, the same structural guarantee categoryId/driveFolderId already had.
test('saveMember preserves an existing status/appliedAt/approvedAt/approvedBy rather than resetting them', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.test', {
    email: 'ala@example.test',
    fullName: 'Ala Kowalska',
    nickname: 'Alka',
    sectionId: 'krakow',
    categoryId: 'blacha',
    driveFolderId: 'drive-folder-123',
    status: 'active',
    appliedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-02T00:00:00.000Z',
    approvedBy: 'admin@example.test',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'ala@example.test',
  });

  const result = await saveMember(
    client,
    'ala@example.test',
    {
      fullName: 'Ala Kowalska-Nowak',
      nickname: 'Alka',
      sectionId: 'wroclaw',
    },
    'ala@example.test',
  );

  assert.equal(result.status, 'active');
  assert.equal(result.appliedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(result.approvedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(result.approvedBy, 'admin@example.test');
  assert.equal(result.fullName, 'Ala Kowalska-Nowak');
});

test('saveMember on a brand-new record defaults to status "active"', async () => {
  const client = createInMemoryFirestoreClient();
  const member = await saveMember(
    client,
    'nowy@example.test',
    {
      fullName: 'Nowy Członek',
      nickname: null,
      sectionId: 'krakow',
    },
    'nowy@example.test',
  );
  assert.equal(member.status, 'active');
  assert.equal(member.email, 'nowy@example.test');
  assert.equal(member.approvedAt, null);
  assert.ok(member.appliedAt);
});

// KRKG-0047: an accountant/admin editing someone else's record (server.ts's
// handleListaWyjazdowaPutMember with ?memberEmail=) must have their own email recorded, not the
// edited member's - unlike self-service, where the two happen to be equal.
test('saveMember records the acting editor as updatedBy, distinct from the edited member', async () => {
  const client = createInMemoryFirestoreClient();
  const updated = await saveMember(
    client,
    'ala@example.test',
    { fullName: 'Ala Kowalska', nickname: 'Alka', sectionId: 'krakow' },
    'ksiegowy@example.test',
  );
  assert.equal(updated.email, 'ala@example.test');
  assert.equal(updated.updatedBy, 'ksiegowy@example.test');
});

test('setMemberDriveFolderId sets driveFolderId on an existing member without touching other fields', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.test', {
    email: 'ala@example.test',
    fullName: 'Ala Kowalska',
    nickname: 'Alka',
    sectionId: 'krakow',
    categoryId: 'blacha',
    driveFolderId: null,
    status: 'active',
    appliedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-02T00:00:00.000Z',
    approvedBy: 'admin@example.test',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'ala@example.test',
  });

  await setMemberDriveFolderId(client, 'ala@example.test', 'folder-xyz');

  const stored = await getMember(client, 'ala@example.test');
  assert.equal(stored?.driveFolderId, 'folder-xyz');
  assert.equal(stored?.fullName, 'Ala Kowalska', 'unrelated fields must survive untouched');
  assert.equal(stored?.categoryId, 'blacha', 'unrelated admin-owned fields must survive untouched');
});

test('setMemberDriveFolderId can clear driveFolderId back to null', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.test', {
    email: 'ala@example.test',
    fullName: 'Ala Kowalska',
    nickname: null,
    sectionId: 'krakow',
    categoryId: null,
    driveFolderId: 'folder-xyz',
    status: 'active',
    appliedAt: 'x',
    approvedAt: null,
    approvedBy: null,
    updatedAt: 'x',
    updatedBy: 'x',
  });

  await setMemberDriveFolderId(client, 'ala@example.test', null);

  const stored = await getMember(client, 'ala@example.test');
  assert.equal(stored?.driveFolderId, null);
});

test('setMemberDriveFolderId throws when the member does not exist', async () => {
  const client = createInMemoryFirestoreClient();
  await assert.rejects(() => setMemberDriveFolderId(client, 'nobody@example.test', 'folder-xyz'));
});

test('recordLastLogin sets lastLoginAt on an existing member without touching other fields', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.test', {
    email: 'ala@example.test',
    fullName: 'Ala Kowalska',
    nickname: 'Alka',
    sectionId: 'krakow',
    categoryId: 'blacha',
    driveFolderId: null,
    status: 'active',
    appliedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-02T00:00:00.000Z',
    approvedBy: 'admin@example.test',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'ala@example.test',
    lastLoginAt: null,
  });

  await recordLastLogin(client, 'ala@example.test');

  const stored = await getMember(client, 'ala@example.test');
  assert.equal(typeof stored?.lastLoginAt, 'string');
  assert.equal(stored?.fullName, 'Ala Kowalska', 'unrelated fields must survive untouched');
});

test('recordLastLogin is a silent no-op when the member does not exist', async () => {
  const client = createInMemoryFirestoreClient();
  await recordLastLogin(client, 'nobody@example.test');
  const stored = await getMember(client, 'nobody@example.test');
  assert.equal(stored, null, 'must not plant a partial member doc for an unrelated Google account');
});

test('listAllMembers returns every member with email populated from the doc id', async () => {
  const client = createInMemoryFirestoreClient();
  await saveMember(client, 'ala@example.test', { fullName: 'Ala Kowalska', nickname: null, sectionId: 'krakow' }, 'ala@example.test');
  await saveMember(client, 'basia@example.test', { fullName: 'Basia Nowak', nickname: null, sectionId: 'wroclaw' }, 'basia@example.test');

  const all = await listAllMembers(client);
  assert.equal(all.length, 2);
  const byEmail = new Map(all.map((m) => [m.email, m]));
  assert.equal(byEmail.get('ala@example.test')?.fullName, 'Ala Kowalska');
  assert.equal(byEmail.get('basia@example.test')?.fullName, 'Basia Nowak');
});
