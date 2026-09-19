import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  listAllSignups,
  listSignupsForEvent,
  getSignup,
  saveSignup,
  setSkladkaPaid,
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
    { attending: true },
    'ala@example.test',
  );
  assert.equal(signup.eventId, 'event-1');
  assert.equal(signup.memberEmail, 'ala@example.test');
  assert.equal(signup.attending, true);
  assert.equal(signup.skladkaPaid, false);
  assert.equal(signup.lastChangedBy, 'ala@example.test');
  assert.ok(signup.statusChangedAt);
  assert.match(signup.statusChangedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const fetched = await getSignup(client, 'event-1', 'ala@example.test');
  assert.deepEqual(fetched, signup);
});

test('saveSignup preserves skladkaPaid across an unrelated update', async () => {
  const client = createInMemoryFirestoreClient();
  await saveSignup(client, 'event-1', 'ala@example.test', { attending: true }, 'ala@example.test');
  client.seed('signups', 'event-1_ala@example.test', {
    eventId: 'event-1',
    memberEmail: 'ala@example.test',
    attending: true,
    skladkaPaid: true,
    lastChangedBy: 'ala@example.test',
    lastChangedAt: '2027-01-01T00:00:00.000Z',
  });

  const updated = await saveSignup(client, 'event-1', 'ala@example.test', { attending: false }, 'inny@example.test');
  assert.equal(updated.skladkaPaid, true, 'skladkaPaid must survive a self-service signup edit untouched');
  assert.equal(updated.lastChangedBy, 'inny@example.test', 'lastChangedBy always reflects who actually made this write, per the open-edit model');
});

test('saveSignup updates statusChangedAt when attending changes', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('signups', 'event-1_ala@example.test', {
    eventId: 'event-1',
    memberEmail: 'ala@example.test',
    attending: true,
    companionIds: [],
    skladkaPaid: false,
    lastChangedBy: 'ala@example.test',
    lastChangedAt: '2027-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
  });

  const updated = await saveSignup(client, 'event-1', 'ala@example.test', { attending: false }, 'inny@example.test');

  assert.ok(updated.statusChangedAt);
  assert.notEqual(updated.statusChangedAt, '2026-01-01T00:00:00.000Z');
  assert.match(updated.statusChangedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('saveSignup preserves statusChangedAt when attending does not change', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('signups', 'event-1_ala@example.test', {
    eventId: 'event-1',
    memberEmail: 'ala@example.test',
    attending: true,
    companionIds: [],
    skladkaPaid: false,
    lastChangedBy: 'ala@example.test',
    lastChangedAt: '2027-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
  });

  const updated = await saveSignup(client, 'event-1', 'ala@example.test', { attending: true }, 'inny@example.test');

  assert.equal(updated.statusChangedAt, '2026-01-01T00:00:00.000Z');
});

test('setSkladkaPaid returns null when no signup exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await setSkladkaPaid(client, 'event-1', 'ala@example.test', true, 'accountant@example.test'), null);
});

test('setSkladkaPaid toggles paid, preserving attending', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await saveSignup(client, 'event-1', 'ala@example.test', { attending: true }, 'ala@example.test');
  const updated = await setSkladkaPaid(client, 'event-1', 'ala@example.test', true, 'accountant@example.test');
  assert.equal(updated?.skladkaPaid, true);
  assert.equal(updated?.attending, true);
  assert.equal(updated?.lastChangedBy, 'accountant@example.test');
  assert.equal(updated?.statusChangedAt, created.statusChangedAt);
});

test('listAllSignups and listSignupsForEvent', async () => {
  const client = createInMemoryFirestoreClient();
  await saveSignup(client, 'event-1', 'ala@example.test', { attending: true }, 'ala@example.test');
  await saveSignup(client, 'event-2', 'bea@example.test', { attending: true }, 'bea@example.test');

  const all = await listAllSignups(client);
  assert.equal(all.length, 2);

  const forEvent1 = await listSignupsForEvent(client, 'event-1');
  assert.equal(forEvent1.length, 1);
  assert.equal(forEvent1[0].memberEmail, 'ala@example.test');
});
