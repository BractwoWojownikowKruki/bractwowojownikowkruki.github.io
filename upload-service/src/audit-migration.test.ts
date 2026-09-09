import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { migratedEventId, migrateAuditLogs, preflightAuditMigration } from './audit-migration.ts';
import type { CanonicalAuditEvent } from './audit.ts';

test('migratedEventId is deterministic from (collection, documentId) alone', () => {
  assert.equal(migratedEventId('rolesAuditLog', 'doc-1'), migratedEventId('rolesAuditLog', 'doc-1'));
  assert.notEqual(migratedEventId('rolesAuditLog', 'doc-1'), migratedEventId('rolesAuditLog', 'doc-2'));
  assert.notEqual(migratedEventId('rolesAuditLog', 'doc-1'), migratedEventId('duesAuditLog', 'doc-1'));
});

test('preflight reports one ok row per well-formed legacy document across all three collections', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r1', {
    targetEmail: 'ula@example.test', previousRoles: [], newRoles: ['moderator'],
    changedBy: 'admin@example.test', changedAt: '2025-01-01T00:00:00.000Z', changeSummary: 'x',
  });
  firestore.seed('signupAuditLog', 's1', {
    eventId: 'e1', targetMemberEmail: 'ula@example.test', changedBy: 'admin@example.test',
    changedAt: '2025-01-02T00:00:00.000Z', changeSummary: 'Oznaczono składkę jako opłaconą',
  });
  firestore.seed('duesAuditLog', 'd1', {
    context: 'roczna', targetMemberEmail: 'ula@example.test', eventId: null, eventName: null, year: 2025,
    changedBy: 'admin@example.test', changedAt: '2025-01-03T00:00:00.000Z',
    changeSummary: 'Oznaczono składkę roczną 2025 jako opłaconą',
  });

  const report = await preflightAuditMigration(firestore);
  assert.equal(report.totalDocuments, 3);
  assert.equal(report.okCount, 3);
  assert.equal(report.abortCount, 0);
  assert.equal(report.canProceed, true);
  assert.deepEqual(
    report.rows.map(r => [r.collection, r.documentId, r.parseStatus]).sort(),
    [['duesAuditLog', 'd1', 'ok'], ['rolesAuditLog', 'r1', 'ok'], ['signupAuditLog', 's1', 'ok']],
  );
});

test('preflight aborts (canProceed: false) on an unparseable document and never writes anything', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('signupAuditLog', 's-bad', {
    eventId: 'e1', targetMemberEmail: 'ula@example.test', changedBy: 'admin@example.test',
    changedAt: '2025-01-02T00:00:00.000Z', changeSummary: 'A free-text sentence with no paid/unpaid marker at all',
  });
  const report = await preflightAuditMigration(firestore);
  assert.equal(report.canProceed, false);
  assert.equal(report.rows[0].parseStatus, 'unparseable');
  assert.ok(report.rows[0].reason);

  await assert.rejects(() => migrateAuditLogs(firestore, { dryRun: false }), /preflight/i);
  assert.deepEqual(await firestore.listDocs('auditEvents'), []);
});

test('preflight aborts on a document whose data is an array (multi-entry shape this migration does not support)', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r-multi', [{ targetEmail: 'a@example.test' }, { targetEmail: 'b@example.test' }]);
  const report = await preflightAuditMigration(firestore);
  assert.equal(report.canProceed, false);
  assert.equal(report.rows[0].parseStatus, 'multi_event');
});

test('dry-run migration reports "would_create" for every ok row and writes nothing', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r1', {
    targetEmail: 'ula@example.test', previousRoles: [], newRoles: ['moderator'],
    changedBy: 'admin@example.test', changedAt: '2025-01-01T00:00:00.000Z', changeSummary: 'x',
  });
  const report = await migrateAuditLogs(firestore, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.createdCount, 0);
  assert.equal(report.rows[0].action, 'would_create');
  assert.deepEqual(await firestore.listDocs('auditEvents'), []);
});

test('a real (non-dry-run) migration creates one canonical event per legacy document, preserving the historical timestamp', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r1', {
    targetEmail: 'ula@example.test', previousRoles: [], newRoles: ['moderator'],
    changedBy: 'admin@example.test', changedAt: '2025-01-01T00:00:00.000Z', changeSummary: 'x',
  });
  const report = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(report.createdCount, 1);
  assert.equal(report.rows[0].action, 'created');
  const id = migratedEventId('rolesAuditLog', 'r1');
  const event = await firestore.getDoc<CanonicalAuditEvent>('auditEvents', id);
  assert.ok(event);
  assert.equal(event!.timestamp, '2025-01-01T00:00:00.000Z');
  assert.equal(event!.action, 'role.granted');
  assert.equal(event!.resource.key, 'member:ula@example.test');
});

test('migration is idempotent: running it twice against the same source data creates nothing the second time', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r1', {
    targetEmail: 'ula@example.test', previousRoles: [], newRoles: ['moderator'],
    changedBy: 'admin@example.test', changedAt: '2025-01-01T00:00:00.000Z', changeSummary: 'x',
  });
  const first = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(first.createdCount, 1);
  const second = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(second.createdCount, 0);
  assert.equal(second.alreadyMigratedCount, 1);
  assert.equal((await firestore.listDocs('auditEvents')).length, 1);
});

test('duesAuditLog eventFee entries never store the raw fee description text, only a digest/length', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('duesAuditLog', 'd-fee', {
    context: 'eventFee', targetMemberEmail: null, eventId: 'wolin-2026', eventName: 'Wolin 2026', year: null,
    changedBy: 'admin@example.test', changedAt: '2025-06-01T00:00:00.000Z',
    changeSummary: 'Ustawiono składkę wyjazdu „Wolin 2026” na: 100 zł za osobę, płatne do 1 maja',
  });
  const report = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(report.createdCount, 1);
  const event = await firestore.getDoc<CanonicalAuditEvent>('auditEvents', migratedEventId('duesAuditLog', 'd-fee'));
  assert.ok(event);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('100 zł'));
  assert.equal(event!.changes.find(c => c.field === 'feeLength')?.after, '100 zł za osobę, płatne do 1 maja'.length);
});
