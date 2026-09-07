import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { AuthError } from './auth.ts';
import { applyForMembership, applyAdminTransition, listMembersByStatus } from './membership.ts';

test('applyForMembership creates a pending record when no doc exists', async () => {
  const client = createInMemoryFirestoreClient();
  const record = await applyForMembership(client, 'Bob@Example.com', { fullName: 'Bob', nickname: null, sectionId: 'sekcja-1' });
  assert.equal(record.status, 'pending');
  assert.equal(record.email, 'bob@example.com');
  assert.ok(record.appliedAt);
  assert.equal(record.approvedAt, null);
});

test('applyForMembership updates fields but keeps appliedAt when re-submitting while pending', async () => {
  const client = createInMemoryFirestoreClient();
  const first = await applyForMembership(client, 'bob@example.com', { fullName: 'Bob', nickname: null, sectionId: 'sekcja-1' });
  const second = await applyForMembership(client, 'bob@example.com', { fullName: 'Bob Two', nickname: 'Bobby', sectionId: 'sekcja-2' });
  assert.equal(second.status, 'pending');
  assert.equal(second.fullName, 'Bob Two');
  assert.equal(second.appliedAt, first.appliedAt);
});

test('applyForMembership rejects with 409 when the caller is already active', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'carol@example.com', {
    email: 'carol@example.com', fullName: 'Carol', nickname: null, sectionId: 'sekcja-1',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'y', approvedBy: 'admin@example.com',
    updatedAt: 'z', updatedBy: 'carol@example.com',
  });
  await assert.rejects(
    () => applyForMembership(client, 'carol@example.com', { fullName: 'Carol', nickname: null, sectionId: 'sekcja-1' }),
    (err: unknown) => err instanceof AuthError && err.status === 409,
  );
});

test('applyForMembership rejects with 409 when the caller is suspended', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'dave@example.com', {
    email: 'dave@example.com', fullName: 'Dave', nickname: null, sectionId: 'sekcja-1',
    categoryId: null, driveFolderId: null, status: 'suspended', appliedAt: 'x', approvedAt: 'y', approvedBy: 'admin@example.com',
    updatedAt: 'z', updatedBy: 'dave@example.com',
  });
  await assert.rejects(
    () => applyForMembership(client, 'dave@example.com', { fullName: 'Dave', nickname: null, sectionId: 'sekcja-1' }),
    (err: unknown) => err instanceof AuthError && err.status === 409,
  );
});

test('applyForMembership allows re-applying from rejected, resetting to pending with a fresh appliedAt', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'eve@example.com', {
    email: 'eve@example.com', fullName: 'Eve', nickname: null, sectionId: 'sekcja-1',
    categoryId: null, driveFolderId: null, status: 'rejected', appliedAt: '2020-01-01T00:00:00.000Z',
    approvedAt: null, approvedBy: null, updatedAt: '2020-01-01T00:00:00.000Z', updatedBy: 'admin@example.com',
  });
  const record = await applyForMembership(client, 'eve@example.com', { fullName: 'Eve', nickname: null, sectionId: 'sekcja-1' });
  assert.equal(record.status, 'pending');
  assert.notEqual(record.appliedAt, '2020-01-01T00:00:00.000Z');
});

test('applyForMembership allows re-applying from removed', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'frank@example.com', {
    email: 'frank@example.com', fullName: 'Frank', nickname: null, sectionId: 'sekcja-1',
    categoryId: null, driveFolderId: null, status: 'removed', appliedAt: 'x', approvedAt: 'y', approvedBy: 'admin@example.com',
    updatedAt: 'z', updatedBy: 'admin@example.com',
  });
  const record = await applyForMembership(client, 'frank@example.com', { fullName: 'Frank', nickname: null, sectionId: 'sekcja-1' });
  assert.equal(record.status, 'pending');
});

test('applyAdminTransition approves a pending member, setting approvedAt/approvedBy', async () => {
  const client = createInMemoryFirestoreClient();
  await applyForMembership(client, 'grace@example.com', { fullName: 'Grace', nickname: null, sectionId: 'sekcja-1' });
  const record = await applyAdminTransition(client, 'grace@example.com', 'approve', 'admin@example.com');
  assert.equal(record.status, 'active');
  assert.equal(record.approvedBy, 'admin@example.com');
  assert.ok(record.approvedAt);
});

test('applyAdminTransition rejects an approve on a non-pending member', async () => {
  const client = createInMemoryFirestoreClient();
  await assert.rejects(
    () => applyAdminTransition(client, 'nobody@example.com', 'approve', 'admin@example.com'),
    (err: unknown) => err instanceof AuthError && err.status === 409,
  );
});

test('applyAdminTransition suspends an active member and reactivate brings them back', async () => {
  const client = createInMemoryFirestoreClient();
  await applyForMembership(client, 'henry@example.com', { fullName: 'Henry', nickname: null, sectionId: 'sekcja-1' });
  await applyAdminTransition(client, 'henry@example.com', 'approve', 'admin@example.com');
  const suspended = await applyAdminTransition(client, 'henry@example.com', 'suspend', 'admin@example.com');
  assert.equal(suspended.status, 'suspended');
  const reactivated = await applyAdminTransition(client, 'henry@example.com', 'reactivate', 'admin@example.com');
  assert.equal(reactivated.status, 'active');
});

test('applyAdminTransition removes from active or suspended', async () => {
  const client = createInMemoryFirestoreClient();
  await applyForMembership(client, 'iris@example.com', { fullName: 'Iris', nickname: null, sectionId: 'sekcja-1' });
  await applyAdminTransition(client, 'iris@example.com', 'approve', 'admin@example.com');
  const removed = await applyAdminTransition(client, 'iris@example.com', 'remove', 'admin@example.com');
  assert.equal(removed.status, 'removed');
});

test('applyAdminTransition never deletes the document', async () => {
  const client = createInMemoryFirestoreClient();
  await applyForMembership(client, 'jack@example.com', { fullName: 'Jack', nickname: null, sectionId: 'sekcja-1' });
  await applyAdminTransition(client, 'jack@example.com', 'reject', 'admin@example.com');
  const docs = await client.listDocs('members');
  assert.equal(docs.length, 1);
  assert.equal((docs[0].data as { status: string }).status, 'rejected');
});

test('listMembersByStatus filters correctly', async () => {
  const client = createInMemoryFirestoreClient();
  await applyForMembership(client, 'kate@example.com', { fullName: 'Kate', nickname: null, sectionId: 'sekcja-1' });
  await applyForMembership(client, 'liam@example.com', { fullName: 'Liam', nickname: null, sectionId: 'sekcja-1' });
  await applyAdminTransition(client, 'liam@example.com', 'approve', 'admin@example.com');
  const pending = await listMembersByStatus(client, 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].email, 'kate@example.com');
});
