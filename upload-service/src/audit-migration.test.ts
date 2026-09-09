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

test('a full run migrates a realistic mixed batch across all three legacy collections in one pass, with correct deterministic ids, and a second run is a true no-op', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r1', {
    targetEmail: 'ula@example.test', previousRoles: ['moderator'], newRoles: ['moderator', 'accountant'],
    changedBy: 'admin@example.test', changedAt: '2025-02-01T10:00:00.000Z', changeSummary: 'x',
  });
  firestore.seed('rolesAuditLog', 'r2', {
    targetEmail: 'wojtek@example.test', previousRoles: ['admin', 'accountant'], newRoles: ['admin'],
    changedBy: 'admin@example.test', changedAt: '2025-02-02T10:00:00.000Z', changeSummary: 'x',
  });
  firestore.seed('signupAuditLog', 's1', {
    eventId: 'wolin-2025', targetMemberEmail: 'ula@example.test', changedBy: 'skarbnik@example.test',
    changedAt: '2025-02-03T10:00:00.000Z', changeSummary: 'Oznaczono składkę jako opłaconą',
  });
  firestore.seed('duesAuditLog', 'd1', {
    context: 'wpisowe', targetMemberEmail: 'wojtek@example.test', eventId: null, eventName: null, year: null,
    changedBy: 'skarbnik@example.test', changedAt: '2025-02-04T10:00:00.000Z',
    changeSummary: 'Oznaczono wpisowe jako nieopłacone',
  });
  firestore.seed('duesAuditLog', 'd2', {
    context: 'roczna', targetMemberEmail: 'ula@example.test', eventId: null, eventName: null, year: 2025,
    changedBy: 'skarbnik@example.test', changedAt: '2025-02-05T10:00:00.000Z',
    changeSummary: 'Ustawiono roczną 2025 na: 150 zł',
  });

  const preflight = await preflightAuditMigration(firestore);
  assert.equal(preflight.totalDocuments, 5);
  assert.equal(preflight.canProceed, true);

  const first = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(first.createdCount, 5);
  assert.equal(first.alreadyMigratedCount, 0);

  // Deterministic ids: exactly `migrated:{collection}:{documentId}`, nothing improvised.
  const expectedIds = [
    migratedEventId('rolesAuditLog', 'r1'), migratedEventId('rolesAuditLog', 'r2'),
    migratedEventId('signupAuditLog', 's1'), migratedEventId('duesAuditLog', 'd1'), migratedEventId('duesAuditLog', 'd2'),
  ];
  const stored = await firestore.listDocs<CanonicalAuditEvent>('auditEvents');
  assert.deepEqual(stored.map(d => d.id).sort(), expectedIds.sort());

  // Original timestamp/actor/resource/inferred action preserved per document.
  const r1 = stored.find(d => d.id === migratedEventId('rolesAuditLog', 'r1'))!.data;
  assert.equal(r1.timestamp, '2025-02-01T10:00:00.000Z');
  assert.equal(r1.actor.email, 'admin@example.test');
  assert.equal(r1.resource.key, 'member:ula@example.test');
  assert.equal(r1.action, 'role.granted'); // newRoles grew by one → inferred grant

  const r2 = stored.find(d => d.id === migratedEventId('rolesAuditLog', 'r2'))!.data;
  assert.equal(r2.action, 'role.revoked'); // newRoles shrank by one → inferred revoke

  const s1 = stored.find(d => d.id === migratedEventId('signupAuditLog', 's1'))!.data;
  assert.equal(s1.action, 'dues.event_fee.changed');
  assert.equal(s1.resource.key, 'signup:wolin-2025:ula@example.test');
  assert.equal(s1.actor.email, 'skarbnik@example.test');

  const d1 = stored.find(d => d.id === migratedEventId('duesAuditLog', 'd1'))!.data;
  assert.equal(d1.action, 'dues.entry_fee.changed');
  assert.equal(d1.changes.find(c => c.field === 'paid')?.after, false);

  // A second run against the same source data is a true no-op: nothing created, everything
  // reported already_migrated, and the stored event count is unchanged.
  const second = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(second.createdCount, 0);
  assert.equal(second.alreadyMigratedCount, 5);
  assert.deepEqual(second.rows.map(r => r.action), ['already_migrated', 'already_migrated', 'already_migrated', 'already_migrated', 'already_migrated']);
  const storedAfterSecondRun = await firestore.listDocs('auditEvents');
  assert.equal(storedAfterSecondRun.length, 5);
});

test('migration leaves a missing legacy diff absent rather than fabricating a before value', async () => {
  const firestore = createInMemoryFirestoreClient();
  // signupAuditLog/duesAuditLog entries never carry a "before" state in the legacy schema (only
  // duesAuditLog's role-array delta happens to reconstruct one) - the migration must not invent
  // one just to fill the field.
  firestore.seed('signupAuditLog', 's1', {
    eventId: 'wolin-2025', targetMemberEmail: 'ula@example.test', changedBy: 'skarbnik@example.test',
    changedAt: '2025-02-03T10:00:00.000Z', changeSummary: 'Oznaczono składkę jako opłaconą',
  });
  const report = await migrateAuditLogs(firestore, { dryRun: false });
  assert.equal(report.createdCount, 1);
  const event = await firestore.getDoc<CanonicalAuditEvent>('auditEvents', migratedEventId('signupAuditLog', 's1'));
  assert.ok(event);
  const paidChange = event!.changes.find(c => c.field === 'paid');
  assert.ok(paidChange);
  assert.equal(paidChange!.after, true);
  assert.ok(!('before' in paidChange!), 'a change the legacy document never recorded a prior state for must have no "before" key at all, not before: undefined');
});

test('an all-or-nothing preflight abort holds even when most documents in the batch are well-formed', async () => {
  const firestore = createInMemoryFirestoreClient();
  firestore.seed('rolesAuditLog', 'r-good', {
    targetEmail: 'ula@example.test', previousRoles: [], newRoles: ['moderator'],
    changedBy: 'admin@example.test', changedAt: '2025-01-01T00:00:00.000Z', changeSummary: 'x',
  });
  firestore.seed('duesAuditLog', 'd-good', {
    context: 'wpisowe', targetMemberEmail: 'ula@example.test', eventId: null, eventName: null, year: null,
    changedBy: 'admin@example.test', changedAt: '2025-01-02T00:00:00.000Z', changeSummary: 'Oznaczono wpisowe jako opłacone',
  });
  firestore.seed('signupAuditLog', 's-bad', {
    eventId: 'e1', targetMemberEmail: 'ula@example.test', changedBy: 'admin@example.test',
    changedAt: '2025-01-03T00:00:00.000Z', changeSummary: 'A free-text sentence with no paid/unpaid marker at all',
  });

  const preflight = await preflightAuditMigration(firestore);
  assert.equal(preflight.totalDocuments, 3);
  assert.equal(preflight.okCount, 2);
  assert.equal(preflight.abortCount, 1);
  assert.equal(preflight.canProceed, false);

  await assert.rejects(() => migrateAuditLogs(firestore, { dryRun: false }), /preflight/i);
  // Not even the two well-formed documents are migrated - abort is all-or-nothing.
  assert.deepEqual(await firestore.listDocs('auditEvents'), []);
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
