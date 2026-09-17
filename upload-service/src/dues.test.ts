import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getDues, listDuesForYear, saveDues, getDuesYearFee, saveDuesYearFee, normalizeDuesStatus, effectiveDuesStatus, EMERYT_CATEGORY_ID } from './dues.ts';

test('getDues returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getDues(client, 'ala@example.test', 2027), null);
});

test('saveDues creates a record and getDues round-trips it', async () => {
  const client = createInMemoryFirestoreClient();
  const dues = await saveDues(client, 'Ala@Example.test', 2027, { status: 'paid' }, 'accountant@example.test');
  assert.equal(dues.email, 'ala@example.test');
  assert.equal(dues.year, 2027);
  assert.equal(dues.status, 'paid');
  assert.equal(dues.updatedBy, 'accountant@example.test');

  const fetched = await getDues(client, 'ala@example.test', 2027);
  assert.deepEqual(fetched, dues);
});

test('saveDues on an existing record updates status/updatedBy/updatedAt', async () => {
  const client = createInMemoryFirestoreClient();
  await saveDues(client, 'ala@example.test', 2027, { status: 'unpaid' }, 'admin@example.test');
  const updated = await saveDues(client, 'ala@example.test', 2027, { status: 'paid' }, 'accountant@example.test');
  assert.equal(updated.status, 'paid');
  assert.equal(updated.updatedBy, 'accountant@example.test');
});

test('saveDues on an existing record preserves status when fields.status is omitted', async () => {
  const client = createInMemoryFirestoreClient();
  await saveDues(client, 'ala@example.test', 2027, { status: 'paid' }, 'accountant@example.test');
  const touched = await saveDues(client, 'ala@example.test', 2027, {}, 'accountant@example.test');
  assert.equal(touched.status, 'paid');
});

test('normalizeDuesStatus reads the current status field, falls back to legacy paid, and defaults to unpaid', () => {
  assert.equal(normalizeDuesStatus({ status: 'not_applicable' }), 'not_applicable');
  assert.equal(normalizeDuesStatus({ paid: true }), 'paid');
  assert.equal(normalizeDuesStatus({ paid: false }), 'unpaid');
  assert.equal(normalizeDuesStatus({}), 'unpaid');
});

test('getDues/listDuesForYear normalize a legacy paid-only record to the new status field', async () => {
  const client = createInMemoryFirestoreClient();
  await client.setDoc('duesAnnual', 'legacy@example.test_2027', {
    email: 'legacy@example.test', year: 2027, paid: true, updatedBy: 'accountant@example.test', updatedAt: '2027-01-01T00:00:00.000Z',
  });
  const fetched = await getDues(client, 'legacy@example.test', 2027);
  assert.equal(fetched?.status, 'paid');

  const listed = await listDuesForYear(client, 2027);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'paid');
});

test('effectiveDuesStatus defaults an Emeryt with no record to not_applicable, everyone else to unpaid, and an explicit record always wins', () => {
  assert.equal(effectiveDuesStatus(null, EMERYT_CATEGORY_ID), 'not_applicable');
  assert.equal(effectiveDuesStatus(null, 'pelnoprawny'), 'unpaid');
  assert.equal(effectiveDuesStatus(null, null), 'unpaid');
  const doc = { email: 'a@example.test', year: 2027, status: 'paid' as const, updatedBy: 'x', updatedAt: 'x' };
  assert.equal(effectiveDuesStatus(doc, EMERYT_CATEGORY_ID), 'paid');
});

test('getDuesYearFee returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getDuesYearFee(client, 2027), null);
});

test('saveDuesYearFee creates/replaces the shared per-year note and getDuesYearFee round-trips it', async () => {
  const client = createInMemoryFirestoreClient();
  const yearFee = await saveDuesYearFee(client, 2027, { note: '100 zł mężczyźni, 50 zł kobiety' }, 'accountant@example.test');
  assert.equal(yearFee.year, 2027);
  assert.equal(yearFee.note, '100 zł mężczyźni, 50 zł kobiety');
  assert.equal(yearFee.updatedBy, 'accountant@example.test');
  assert.deepEqual(await getDuesYearFee(client, 2027), yearFee);

  const replaced = await saveDuesYearFee(client, 2027, { note: '120 zł' }, 'admin@example.test');
  assert.equal(replaced.note, '120 zł');
  assert.deepEqual(await getDuesYearFee(client, 2027), replaced);

  // A different year has its own independent note.
  assert.equal(await getDuesYearFee(client, 2026), null);
});

test('saveDuesYearFee round-trips dueDate alongside note', async () => {
  const client = createInMemoryFirestoreClient();
  const yearFee = await saveDuesYearFee(client, 2027, { note: '100 zł', dueDate: '2027-03-31' }, 'accountant@example.test');
  assert.equal(yearFee.note, '100 zł');
  assert.equal(yearFee.dueDate, '2027-03-31');
  assert.deepEqual(await getDuesYearFee(client, 2027), yearFee);
});

test('saveDuesYearFee preserves dueDate when only note is provided (partial update)', async () => {
  const client = createInMemoryFirestoreClient();
  await saveDuesYearFee(client, 2027, { note: '100 zł', dueDate: '2027-03-31' }, 'accountant@example.test');
  const touched = await saveDuesYearFee(client, 2027, { note: '120 zł' }, 'accountant@example.test');
  assert.equal(touched.note, '120 zł');
  assert.equal(touched.dueDate, '2027-03-31');
});

test('saveDuesYearFee accepts dueDate: null to explicitly clear it', async () => {
  const client = createInMemoryFirestoreClient();
  await saveDuesYearFee(client, 2027, { note: '100 zł', dueDate: '2027-03-31' }, 'accountant@example.test');
  const cleared = await saveDuesYearFee(client, 2027, { dueDate: null }, 'accountant@example.test');
  assert.equal(cleared.dueDate, null);
  assert.equal(cleared.note, '100 zł');
});

test('listDuesForYear returns only records for the requested year', async () => {
  const client = createInMemoryFirestoreClient();
  await saveDues(client, 'ala@example.test', 2026, { status: 'paid' }, 'accountant@example.test');
  await saveDues(client, 'ala@example.test', 2027, { status: 'unpaid' }, 'accountant@example.test');
  await saveDues(client, 'bea@example.test', 2027, { status: 'paid' }, 'accountant@example.test');

  const for2027 = await listDuesForYear(client, 2027);
  assert.equal(for2027.length, 2);
  assert.ok(for2027.every((d) => d.year === 2027));

  const for2026 = await listDuesForYear(client, 2026);
  assert.equal(for2026.length, 1);
  assert.equal(for2026[0].email, 'ala@example.test');
});
