import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { AuthError } from './auth.ts';
import { createFirestoreMemberAuthorizer, listActiveMemberEmails } from './membership-authorization.ts';

function seedMember(client: ReturnType<typeof createInMemoryFirestoreClient>, email: string, status: string) {
  client.seed('members', email, { email, status, fullName: 'X', nickname: null, sectionId: 's', categoryId: null, driveFolderId: null, appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x' });
}

test('createFirestoreMemberAuthorizer allows an active member', async () => {
  const client = createInMemoryFirestoreClient();
  seedMember(client, 'alice@example.com', 'active');
  const authorizer = createFirestoreMemberAuthorizer(client);
  await assert.doesNotReject(() => authorizer.authorize({ sub: 's', email: 'alice@example.com' }));
});

test('createFirestoreMemberAuthorizer rejects a pending member with 403', async () => {
  const client = createInMemoryFirestoreClient();
  seedMember(client, 'bob@example.com', 'pending');
  const authorizer = createFirestoreMemberAuthorizer(client);
  await assert.rejects(
    () => authorizer.authorize({ sub: 's', email: 'bob@example.com' }),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('createFirestoreMemberAuthorizer rejects a suspended member with 403', async () => {
  const client = createInMemoryFirestoreClient();
  seedMember(client, 'carol@example.com', 'suspended');
  const authorizer = createFirestoreMemberAuthorizer(client);
  await assert.rejects(
    () => authorizer.authorize({ sub: 's', email: 'carol@example.com' }),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('createFirestoreMemberAuthorizer rejects an unknown email with 403 (not a throw of a different shape)', async () => {
  const client = createInMemoryFirestoreClient();
  const authorizer = createFirestoreMemberAuthorizer(client);
  await assert.rejects(
    () => authorizer.authorize({ sub: 's', email: 'nobody@example.com' }),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('createFirestoreMemberAuthorizer only reads the one document it needs, not the whole collection', async () => {
  const client = createInMemoryFirestoreClient();
  seedMember(client, 'alice@example.com', 'active');
  let listCalls = 0;
  const countingClient: typeof client = {
    ...client,
    listDocs: (...args: Parameters<typeof client.listDocs>) => {
      listCalls++;
      return client.listDocs(...args);
    },
  };
  const authorizer = createFirestoreMemberAuthorizer(countingClient);
  await authorizer.authorize({ sub: 's', email: 'alice@example.com' });
  assert.equal(listCalls, 0, 'authorize() must not call listDocs at all - it should be a single getDoc');
});

test('listActiveMemberEmails returns only active emails (this one legitimately scans the collection, for directory enumeration)', async () => {
  const client = createInMemoryFirestoreClient();
  seedMember(client, 'alice@example.com', 'active');
  seedMember(client, 'bob@example.com', 'pending');
  assert.deepEqual(await listActiveMemberEmails(client), ['alice@example.com']);
});

test('listActiveMemberEmails returns an empty list, not a throw, on a Firestore read failure', async () => {
  const failingClient = { listDocs: async () => { throw new Error('boom'); }, getDoc: async () => null, setDoc: async () => {} };
  assert.deepEqual(await listActiveMemberEmails(failingClient as never), []);
});
