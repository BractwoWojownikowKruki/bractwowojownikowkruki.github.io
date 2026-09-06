import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  listAllSignups,
  listSignupsForEvent,
  getSignup,
  saveSignup,
  setSkladkaPaid,
  appendAuditLogEntry,
  listAuditLogForEvent,
} from './signups.ts';

test('getSignup returns null when no signup exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getSignup(client, 'event-1', 'ala@example.test'), null);
});

test('saveSignup creates a signup with skladkaPaid defaulted to false', async () => {
  const client = createInMemoryFirestoreClient();
  const signup = await saveSignup(
    client,
    'event-1',
    'Ala@Example.test',
    { attending: true, equipmentIds: ['eq-1'], companionIds: [] },
    'ala@example.test',
  );
  assert.equal(signup.eventId, 'event-1');
  assert.equal(signup.memberEmail, 'ala@example.test');
  assert.equal(signup.attending, true);
  assert.deepEqual(signup.equipmentIds, ['eq-1']);
  assert.equal(signup.skladkaPaid, false);
  assert.equal(signup.lastChangedBy, 'ala@example.test');

  const fetched = await getSignup(client, 'event-1', 'ala@example.test');
  assert.deepEqual(fetched, signup);
});

test('saveSignup preserves skladkaPaid across an unrelated update', async () => {
  const client = createInMemoryFirestoreClient();
  await saveSignup(client, 'event-1', 'ala@example.test', { attending: true, equipmentIds: [], companionIds: [] }, 'ala@example.test');
  client.seed('signups', 'event-1_ala@example.test', {
    eventId: 'event-1',
    memberEmail: 'ala@example.test',
    attending: true,
    equipmentIds: [],
    companionIds: [],
    skladkaPaid: true,
    lastChangedBy: 'ala@example.test',
    lastChangedAt: '2027-01-01T00:00:00.000Z',
  });

  const updated = await saveSignup(client, 'event-1', 'ala@example.test', { attending: false, equipmentIds: [], companionIds: [] }, 'inny@example.test');
  assert.equal(updated.skladkaPaid, true, 'skladkaPaid must survive a self-service signup edit untouched');
  assert.equal(updated.lastChangedBy, 'inny@example.test', 'lastChangedBy always reflects who actually made this write, per the open-edit model');
});

test('setSkladkaPaid returns null when no signup exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await setSkladkaPaid(client, 'event-1', 'ala@example.test', true, 'accountant@example.test'), null);
});

test('setSkladkaPaid toggles paid, preserving attending/equipment/companions', async () => {
  const client = createInMemoryFirestoreClient();
  await saveSignup(client, 'event-1', 'ala@example.test', { attending: true, equipmentIds: ['eq-1'], companionIds: [] }, 'ala@example.test');
  const updated = await setSkladkaPaid(client, 'event-1', 'ala@example.test', true, 'accountant@example.test');
  assert.equal(updated?.skladkaPaid, true);
  assert.equal(updated?.attending, true);
  assert.deepEqual(updated?.equipmentIds, ['eq-1']);
  assert.equal(updated?.lastChangedBy, 'accountant@example.test');
});

test('listAllSignups and listSignupsForEvent', async () => {
  const client = createInMemoryFirestoreClient();
  await saveSignup(client, 'event-1', 'ala@example.test', { attending: true, equipmentIds: [], companionIds: [] }, 'ala@example.test');
  await saveSignup(client, 'event-2', 'bea@example.test', { attending: true, equipmentIds: [], companionIds: [] }, 'bea@example.test');

  const all = await listAllSignups(client);
  assert.equal(all.length, 2);

  const forEvent1 = await listSignupsForEvent(client, 'event-1');
  assert.equal(forEvent1.length, 1);
  assert.equal(forEvent1[0].memberEmail, 'ala@example.test');
});

test('appendAuditLogEntry and listAuditLogForEvent, sorted oldest first', async () => {
  const client = createInMemoryFirestoreClient();
  await appendAuditLogEntry(client, {
    eventId: 'event-1',
    targetMemberEmail: 'ala@example.test',
    changedBy: 'ala@example.test',
    changeSummary: 'Zgłoszono udział',
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await appendAuditLogEntry(client, {
    eventId: 'event-1',
    targetMemberEmail: 'ala@example.test',
    changedBy: 'bea@example.test',
    changeSummary: 'Wycofano zgłoszenie udziału',
  });
  await appendAuditLogEntry(client, {
    eventId: 'event-2',
    targetMemberEmail: 'bea@example.test',
    changedBy: 'bea@example.test',
    changeSummary: 'Zgłoszono udział',
  });

  const entries = await listAuditLogForEvent(client, 'event-1');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].changeSummary, 'Zgłoszono udział');
  assert.equal(entries[1].changeSummary, 'Wycofano zgłoszenie udziału');
  assert.ok(entries[0].changedAt < entries[1].changedAt);
});
