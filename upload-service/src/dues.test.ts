import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getDues, listDuesForYear, setDuesPaid } from './dues.ts';

test('getDues returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getDues(client, 'ala@example.test', 2027), null);
});

test('setDuesPaid creates a record and getDues round-trips it', async () => {
  const client = createInMemoryFirestoreClient();
  const dues = await setDuesPaid(client, 'Ala@Example.test', 2027, true, 'accountant@example.test');
  assert.equal(dues.email, 'ala@example.test');
  assert.equal(dues.year, 2027);
  assert.equal(dues.paid, true);
  assert.equal(dues.updatedBy, 'accountant@example.test');

  const fetched = await getDues(client, 'ala@example.test', 2027);
  assert.deepEqual(fetched, dues);
});

test('setDuesPaid on an existing record updates paid/updatedBy/updatedAt', async () => {
  const client = createInMemoryFirestoreClient();
  await setDuesPaid(client, 'ala@example.test', 2027, false, 'admin@example.test');
  const updated = await setDuesPaid(client, 'ala@example.test', 2027, true, 'accountant@example.test');
  assert.equal(updated.paid, true);
  assert.equal(updated.updatedBy, 'accountant@example.test');
});

test('listDuesForYear returns only records for the requested year', async () => {
  const client = createInMemoryFirestoreClient();
  await setDuesPaid(client, 'ala@example.test', 2026, true, 'accountant@example.test');
  await setDuesPaid(client, 'ala@example.test', 2027, false, 'accountant@example.test');
  await setDuesPaid(client, 'bea@example.test', 2027, true, 'accountant@example.test');

  const for2027 = await listDuesForYear(client, 2027);
  assert.equal(for2027.length, 2);
  assert.ok(for2027.every((d) => d.year === 2027));

  const for2026 = await listDuesForYear(client, 2026);
  assert.equal(for2026.length, 1);
  assert.equal(for2026[0].email, 'ala@example.test');
});
