import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';

test('in-memory client: getDoc returns null when missing', async () => {
  const client = createInMemoryFirestoreClient();
  const doc = await client.getDoc<{ name: string }>('members', 'a@example.test');
  assert.equal(doc, null);
});

test('in-memory client: setDoc then getDoc round-trips', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('members', 'a@example.test', { name: 'Ala' });
  const doc = await client.getDoc<{ name: string }>('members', 'a@example.test');
  assert.deepEqual(doc, { name: 'Ala' });
});

// Matches the real client's set(..., { merge: true }) - the structural guarantee that a
// self-service write can't delete admin-owned fields it never mentions (design.md §7/§7a).
test('in-memory client: setDoc merges into an existing doc instead of overwriting it', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'a@example.test', { name: 'Ala', categoryId: 'blacha', someAdminOnlyField: 7 });
  await client.setDoc('members', 'a@example.test', { name: 'Ala Nowak' });
  const doc = await client.getDoc<Record<string, unknown>>('members', 'a@example.test');
  assert.deepEqual(doc, { name: 'Ala Nowak', categoryId: 'blacha', someAdminOnlyField: 7 });
});

test('in-memory client: setDoc replaces array fields wholesale, as Firestore merge does', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('listaWyjazdowaProfile', 'a@example.test', { weaponIds: ['tarcza', 'topor'] });
  await client.setDoc('listaWyjazdowaProfile', 'a@example.test', { weaponIds: ['tarcza'] });
  const doc = await client.getDoc<{ weaponIds: string[] }>('listaWyjazdowaProfile', 'a@example.test');
  assert.deepEqual(doc, { weaponIds: ['tarcza'] });
});

test('in-memory client: listDocs returns all docs in a collection with ids', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('members', 'a@example.test', { name: 'Ala' });
  await client.setDoc('members', 'b@example.test', { name: 'Bea' });
  const docs = await client.listDocs<{ name: string }>('members');
  assert.equal(docs.length, 2);
  assert.deepEqual(
    docs.sort((x, y) => x.id.localeCompare(y.id)),
    [
      { id: 'a@example.test', data: { name: 'Ala' } },
      { id: 'b@example.test', data: { name: 'Bea' } },
    ],
  );
});

test('in-memory client: runTransaction reads and writes through the transaction handle, committing to the store', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'a@example.test', { count: 1 });
  const result = await client.runTransaction(async tx => {
    const doc = await tx.getDoc<{ count: number }>('members', 'a@example.test');
    await tx.setDoc('members', 'a@example.test', { count: (doc?.count ?? 0) + 1 });
    return doc?.count;
  });
  assert.equal(result, 1);
  const stored = await client.getDoc<{ count: number }>('members', 'a@example.test');
  assert.equal(stored?.count, 2);
});

// KRKG-0046: the whole reason runTransaction exists - two "concurrent" transactions on the same
// document must run one at a time, never interleaved, so the second sees the first's write.
test('in-memory client: runTransaction serializes concurrent calls instead of interleaving them', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'a@example.test', { count: 0 });
  const increment = () =>
    client.runTransaction(async tx => {
      const doc = await tx.getDoc<{ count: number }>('members', 'a@example.test');
      // Yield a tick between read and write - if transactions interleaved, both would read the
      // same starting count and the final result would be 1, not 2.
      await Promise.resolve();
      await tx.setDoc('members', 'a@example.test', { count: (doc?.count ?? 0) + 1 });
    });
  await Promise.all([increment(), increment()]);
  const stored = await client.getDoc<{ count: number }>('members', 'a@example.test');
  assert.equal(stored?.count, 2);
});

test('in-memory client: runTransaction propagates a thrown error without committing the write', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'a@example.test', { count: 1 });
  await assert.rejects(
    () =>
      client.runTransaction(async tx => {
        await tx.setDoc('members', 'a@example.test', { count: 999 });
        throw new Error('boom');
      }),
    /boom/,
  );
  const stored = await client.getDoc<{ count: number }>('members', 'a@example.test');
  assert.equal(stored?.count, 1, 'a thrown error must discard the transaction\'s writes, not commit them');
});

test('in-memory client: seed() pre-populates a doc for test setup', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'admin@example.test', { roles: ['admin'] });
  const doc = await client.getDoc<{ roles: string[] }>('userRoles', 'admin@example.test');
  assert.deepEqual(doc, { roles: ['admin'] });
});

test('in-memory client: createDoc refuses to overwrite an immutable document', async () => {
  const client = createInMemoryFirestoreClient();
  await client.createDoc('auditEvents', 'audit-1', { action: 'event.created' });
  await assert.rejects(
    () => client.createDoc('auditEvents', 'audit-1', { action: 'event.updated' }),
    /already exists/i,
  );
  assert.deepEqual(await client.getDoc('auditEvents', 'audit-1'), { action: 'event.created' });
});

test('deleteDoc removes a document so getDoc returns null afterwards', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('widgets', 'w1', { name: 'Widget' });
  await client.deleteDoc('widgets', 'w1');
  assert.equal(await client.getDoc('widgets', 'w1'), null);
});

test('deleteDoc inside a transaction only takes effect if the transaction commits', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('widgets', 'w1', { name: 'Widget' });
  await assert.rejects(
    client.runTransaction(async tx => {
      await tx.deleteDoc('widgets', 'w1');
      throw new Error('boom');
    }),
  );
  assert.deepEqual(await client.getDoc('widgets', 'w1'), { name: 'Widget' });
});

test('deleteDoc inside a transaction removes the document once committed', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('widgets', 'w1', { name: 'Widget' });
  await client.runTransaction(async tx => {
    await tx.deleteDoc('widgets', 'w1');
  });
  assert.equal(await client.getDoc('widgets', 'w1'), null);
});

// A delegated review of this plan (reviews/KRKG-0076-plan-review.md, finding #8) caught that a
// naive pendingDeletes implementation would still see the document in the store/pendingWrites at
// createDoc's collision check and wrongly throw "already exists" - these four sequences pin the
// intended delete-then-write and write-then-delete semantics inside one transaction.
test('deleteDoc then createDoc in the same transaction recreates the document (no false collision)', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('widgets', 'w1', { name: 'Old' });
  await client.runTransaction(async tx => {
    await tx.deleteDoc('widgets', 'w1');
    await tx.createDoc('widgets', 'w1', { name: 'New' });
  });
  assert.deepEqual(await client.getDoc('widgets', 'w1'), { name: 'New' });
});

test('deleteDoc then setDoc in the same transaction recreates the document via merge', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('widgets', 'w1', { name: 'Old', extra: 1 });
  await client.runTransaction(async tx => {
    await tx.deleteDoc('widgets', 'w1');
    await tx.setDoc('widgets', 'w1', { name: 'New' });
  });
  // setDoc after a pending delete starts from an empty base (the delete already discarded the
  // prior document within this transaction), not merged with the pre-delete value.
  assert.deepEqual(await client.getDoc('widgets', 'w1'), { name: 'New' });
});

test('setDoc then deleteDoc in the same transaction deletes the document', async () => {
  const client = createInMemoryFirestoreClient();
  await client.runTransaction(async tx => {
    await tx.setDoc('widgets', 'w1', { name: 'New' });
    await tx.deleteDoc('widgets', 'w1');
  });
  assert.equal(await client.getDoc('widgets', 'w1'), null);
});

test('a rolled-back transaction leaves an earlier deleteDoc-then-createDoc sequence with no effect', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('widgets', 'w1', { name: 'Old' });
  await assert.rejects(
    client.runTransaction(async tx => {
      await tx.deleteDoc('widgets', 'w1');
      await tx.createDoc('widgets', 'w1', { name: 'New' });
      throw new Error('boom');
    }),
  );
  assert.deepEqual(await client.getDoc('widgets', 'w1'), { name: 'Old' });
});

test('deleteDoc on a document that does not exist is a harmless no-op', async () => {
  const client = createInMemoryFirestoreClient();
  await client.deleteDoc('widgets', 'does-not-exist');
  assert.equal(await client.getDoc('widgets', 'does-not-exist'), null);
});
