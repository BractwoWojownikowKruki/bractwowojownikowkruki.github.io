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

test('in-memory client: seed() pre-populates a doc for test setup', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'admin@example.test', { roles: ['admin'] });
  const doc = await client.getDoc<{ roles: string[] }>('userRoles', 'admin@example.test');
  assert.deepEqual(doc, { roles: ['admin'] });
});
