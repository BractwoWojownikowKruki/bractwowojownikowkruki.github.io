import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getDues, listDuesForYear, setDuesPaid, appendDuesAuditEntry, listDuesAuditLog } from './dues.ts';

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

test('appendDuesAuditEntry and listDuesAuditLog, sorted oldest first', async () => {
  const client = createInMemoryFirestoreClient();
  await appendDuesAuditEntry(client, {
    context: 'wpisowe',
    targetMemberEmail: 'ala@example.test',
    eventId: null,
    eventName: null,
    year: null,
    changedBy: 'accountant@example.test',
    changeSummary: 'Oznaczono wpisowe jako opłacone',
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await appendDuesAuditEntry(client, {
    context: 'roczna',
    targetMemberEmail: 'ala@example.test',
    eventId: null,
    eventName: null,
    year: 2027,
    changedBy: 'accountant@example.test',
    changeSummary: 'Oznaczono składkę roczną 2027 jako opłaconą',
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await appendDuesAuditEntry(client, {
    context: 'eventFee',
    targetMemberEmail: null,
    eventId: 'event-1',
    eventName: 'Zjazd wiosenny',
    year: null,
    changedBy: 'accountant@example.test',
    changeSummary: 'Ustawiono składkę wyjazdu „Zjazd wiosenny” na: 50 zł',
  });

  const entries = await listDuesAuditLog(client);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].context, 'wpisowe');
  assert.equal(entries[1].context, 'roczna');
  assert.equal(entries[2].context, 'eventFee');
  assert.ok(entries[0].changedAt < entries[1].changedAt);
  assert.ok(entries[1].changedAt < entries[2].changedAt);
});
