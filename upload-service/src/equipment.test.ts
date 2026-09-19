import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  buildEquipmentDoc,
  validateEquipmentFields,
  InvalidEquipmentError,
  saveEquipmentInTransaction,
  updateEquipmentInTransaction,
  deleteEquipmentInTransaction,
  getEquipmentInTransaction,
  listEquipment,
} from './equipment.ts';

test('buildEquipmentDoc builds a doc with a generated id and lowercased createdBy', () => {
  const doc = buildEquipmentDoc(
    { categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: '4-osobowy' },
    'Jan@Example.com',
  );
  assert.ok(doc.id);
  assert.equal(doc.createdBy, 'jan@example.com');
  assert.equal(doc.belongsToPersonId, null);
  assert.equal(doc.description, '4-osobowy');
});

test('validateEquipmentFields rejects a missing categoryId', () => {
  assert.throws(
    () => validateEquipmentFields({ categoryId: '', sectionId: 'krakow', belongsToPersonId: null, description: '' }),
    InvalidEquipmentError,
  );
});

test('validateEquipmentFields rejects a missing sectionId', () => {
  assert.throws(
    () => validateEquipmentFields({ categoryId: 'namiot', sectionId: '', belongsToPersonId: null, description: '' }),
    InvalidEquipmentError,
  );
});

test('validateEquipmentFields rejects an over-long description', () => {
  assert.throws(
    () => validateEquipmentFields({ categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'a'.repeat(501) }),
    InvalidEquipmentError,
  );
});

test('save/get/update/delete round-trip in a transaction', async () => {
  const client = createInMemoryFirestoreClient();
  const doc = buildEquipmentDoc({ categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'a' }, 'a@b.com');
  await client.runTransaction((tx) => saveEquipmentInTransaction(tx, doc));

  const fetched = await client.runTransaction((tx) => getEquipmentInTransaction(tx, doc.id));
  assert.deepEqual(fetched, doc);

  const updated = await client.runTransaction((tx) =>
    updateEquipmentInTransaction(tx, doc, { categoryId: 'wiata', sectionId: 'krakow', belongsToPersonId: 'osoba@example.com', description: 'zmieniony' }, 'editor@example.com'),
  );
  assert.equal(updated.categoryId, 'wiata');
  assert.equal(updated.belongsToPersonId, 'osoba@example.com');
  assert.equal(updated.updatedBy, 'editor@example.com');

  await client.runTransaction((tx) => deleteEquipmentInTransaction(tx, doc.id));
  const afterDelete = await client.runTransaction((tx) => getEquipmentInTransaction(tx, doc.id));
  assert.equal(afterDelete, null);
});

test('listEquipment sorts newest first and respects the limit', async () => {
  const client = createInMemoryFirestoreClient();
  const older = buildEquipmentDoc({ categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'stary' }, 'a@b.com');
  older.createdAt = '2020-01-01T00:00:00.000Z';
  const newer = buildEquipmentDoc({ categoryId: 'wiata', sectionId: 'krakow', belongsToPersonId: null, description: 'nowy' }, 'a@b.com');
  newer.createdAt = '2025-01-01T00:00:00.000Z';
  await client.runTransaction(async (tx) => {
    await saveEquipmentInTransaction(tx, older);
    await saveEquipmentInTransaction(tx, newer);
  });
  const listed = await listEquipment(client);
  assert.deepEqual(listed.map((d) => d.id), [newer.id, older.id]);
});
