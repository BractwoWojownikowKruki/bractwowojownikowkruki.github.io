import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { listEvents, getEvent, createEvent, updateEvent } from './events.ts';

test('listEvents returns [] when no events exist', async () => {
  const client = createInMemoryFirestoreClient();
  assert.deepEqual(await listEvents(client), []);
});

test('createEvent creates an active event with createdBy/createdAt stamped', async () => {
  const client = createInMemoryFirestoreClient();
  const event = await createEvent(client, { name: 'Zjazd wiosenny', startDate: '2027-05-01' }, 'organizer@example.test');
  assert.equal(event.name, 'Zjazd wiosenny');
  assert.equal(event.startDate, '2027-05-01');
  assert.equal(event.status, 'active');
  assert.equal(event.createdBy, 'organizer@example.test');
  assert.ok(event.id.length > 0);
  assert.ok(event.createdAt.length > 0);

  const fetched = await getEvent(client, event.id);
  assert.deepEqual(fetched, event);
});

test('listEvents returns every created event', async () => {
  const client = createInMemoryFirestoreClient();
  await createEvent(client, { name: 'A', startDate: '2027-01-01' }, 'a@example.test');
  await createEvent(client, { name: 'B', startDate: '2027-02-01' }, 'b@example.test');
  const events = await listEvents(client);
  assert.equal(events.length, 2);
});

test('getEvent returns null for an unknown id', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getEvent(client, 'nope'), null);
});

test('updateEvent returns null for an unknown id and does not create one', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await updateEvent(client, 'nope', { name: 'X' }), null);
  assert.deepEqual(await listEvents(client), []);
});

test('createEvent defaults skladkaFee to null', async () => {
  const client = createInMemoryFirestoreClient();
  const event = await createEvent(client, { name: 'Zjazd', startDate: '2027-05-01' }, 'organizer@example.test');
  assert.equal(event.skladkaFee, null);
});

test('updateEvent can set and clear skladkaFee without touching other fields', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await createEvent(client, { name: 'Zjazd', startDate: '2027-05-01' }, 'organizer@example.test');
  const withFee = await updateEvent(client, created.id, { skladkaFee: '50 zł' });
  assert.equal(withFee?.skladkaFee, '50 zł');
  assert.equal(withFee?.name, 'Zjazd');
  const cleared = await updateEvent(client, created.id, { skladkaFee: null });
  assert.equal(cleared?.skladkaFee, null);
});

test('updateEvent applies only the given fields, preserving the rest', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await createEvent(client, { name: 'Zjazd', startDate: '2027-05-01' }, 'organizer@example.test');

  const renamed = await updateEvent(client, created.id, { name: 'Zjazd wiosenny 2027' });
  assert.equal(renamed?.name, 'Zjazd wiosenny 2027');
  assert.equal(renamed?.startDate, '2027-05-01');
  assert.equal(renamed?.status, 'active');
  assert.equal(renamed?.createdBy, 'organizer@example.test', 'createdBy must survive an unrelated field update untouched');

  const cancelled = await updateEvent(client, created.id, { status: 'cancelled' });
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.name, 'Zjazd wiosenny 2027', 'name must survive a status-only update untouched');

  const restored = await updateEvent(client, created.id, { status: 'active' });
  assert.equal(restored?.status, 'active');
});
