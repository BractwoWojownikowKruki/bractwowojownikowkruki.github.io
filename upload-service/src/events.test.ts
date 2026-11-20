import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { withStrictTransactionOrdering } from './strict-transactions.ts';
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

test('createEvent defaults description to null, or stores it when given', async () => {
  const client = createInMemoryFirestoreClient();
  const bare = await createEvent(client, { name: 'Zjazd', startDate: '2027-05-01' }, 'organizer@example.test');
  assert.equal(bare.description, null);
  const withDescription = await createEvent(client, { name: 'Zlot', startDate: '2027-06-01', description: 'Zbiórka o 9:00, link: https://example.test' }, 'organizer@example.test');
  assert.equal(withDescription.description, 'Zbiórka o 9:00, link: https://example.test');
});

test('updateEvent can set and clear description without touching other fields', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await createEvent(client, { name: 'Zjazd', startDate: '2027-05-01' }, 'organizer@example.test');
  const withDescription = await updateEvent(client, created.id, { description: 'Nowy opis' });
  assert.equal(withDescription?.description, 'Nowy opis');
  assert.equal(withDescription?.name, 'Zjazd');
  const cleared = await updateEvent(client, created.id, { description: null });
  assert.equal(cleared?.description, null);
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

test('updateEvent sets dueDate independently of skladkaFee', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await createEvent(client, { name: 'Zlot', startDate: '2027-06-12' }, 'admin@example.test');
  const updated = await updateEvent(client, created.id, { dueDate: '2027-06-01' });
  assert.equal(updated?.dueDate, '2027-06-01');
  assert.equal(updated?.skladkaFee, null);
});

test('createEvent defaults noCampEquipment to false and updateEvent can toggle it', async () => {
  const client = createInMemoryFirestoreClient();
  const event = await createEvent(client, { name: 'A', startDate: '2027-01-01' }, 'a@example.test');
  assert.equal(event.noCampEquipment, false);
  const updated = await updateEvent(client, event.id, { noCampEquipment: true });
  assert.equal(updated?.noCampEquipment, true);
  assert.equal((await getEvent(client, event.id))?.noCampEquipment, true);
  const created = await createEvent(client, { name: 'B', startDate: '2027-01-02', noCampEquipment: true }, 'a@example.test');
  assert.equal(created.noCampEquipment, true);
});

test('createEvent defaults the link fields to null and updateEvent can set and clear them', async () => {
  const client = createInMemoryFirestoreClient();
  const event = await createEvent(client, { name: 'A', startDate: '2027-01-01' }, 'a@example.test');
  assert.equal(event.mapUrl, null);
  assert.equal(event.discordUrl, null);
  const updated = await updateEvent(client, event.id, { mapUrl: 'https://maps.app.goo.gl/x', discordUrl: 'https://discord.com/channels/1/2' });
  assert.equal(updated?.mapUrl, 'https://maps.app.goo.gl/x');
  assert.equal((await getEvent(client, event.id))?.discordUrl, 'https://discord.com/channels/1/2');
  assert.equal((await updateEvent(client, event.id, { mapUrl: null }))?.mapUrl, null);
});

// KRKG-132: active events are unique by startDate + slugified name (the friendly-URL slug).
test('eventSlug mirrors the browser friendly-URL slug (public/shared/lw-friendly-url.js)', async () => {
  const { eventSlug, slugifyEventName } = await import('./events.ts');
  assert.equal(slugifyEventName('Wolin – Zlot Żółwia 2027!'), 'wolin-zlot-zolwia-2027');
  assert.equal(eventSlug({ startDate: '2027-05-01', name: '  Łódź  ' }), '2027-05-01-lodz');
});

test('friendly-URL slug logic is identical on server and in the browser module', async () => {
  const { readFileSync } = await import('node:fs');
  const { eventSlug } = await import('./events.ts');
  const source = readFileSync(new URL('../../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
  const sandbox: { window: { LwFriendlyUrl?: { eventSlug(e: { startDate: string; name: string }): string } } } = { window: {} };
  new Function('window', source)(sandbox.window);
  for (const name of ['Volin', 'Zjazd wiosenny', 'Żółć & gęślą', 'a--b  c', 'Ąę Ćś Ńó Źż Łl', '2027 / rajd']) {
    const event = { startDate: '2027-05-01', name };
    assert.equal(eventSlug(event), sandbox.window.LwFriendlyUrl!.eventSlug(event), name);
  }
});

test('createEventUniqueSlug rejects a second active event with the same date and name', async () => {
  const { createEventUniqueSlug, EventSlugConflictError } = await import('./events.ts');
  const client = withStrictTransactionOrdering(createInMemoryFirestoreClient());
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Volin', startDate: '2027-05-01' }, 'a@example.test', 'id-1'));
  await assert.rejects(
    client.runTransaction(tx => createEventUniqueSlug(tx, { name: ' volin ', startDate: '2027-05-01' }, 'b@example.test', 'id-2')),
    EventSlugConflictError,
  );
  assert.equal((await listEvents(client)).length, 1);
  // Same name, different date is a different trip.
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Volin', startDate: '2028-05-01' }, 'b@example.test', 'id-3'));
  assert.equal((await listEvents(client)).length, 2);
});

test('updateEventUniqueSlug: cancelling frees the slug, restoring is refused while it is taken', async () => {
  const { createEventUniqueSlug, updateEventUniqueSlug, EventSlugConflictError } = await import('./events.ts');
  const client = withStrictTransactionOrdering(createInMemoryFirestoreClient());
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Volin', startDate: '2027-05-01' }, 'a@example.test', 'id-1'));
  await client.runTransaction(tx => updateEventUniqueSlug(tx, 'id-1', { status: 'cancelled' }));
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Volin', startDate: '2027-05-01' }, 'b@example.test', 'id-2'));
  await assert.rejects(client.runTransaction(tx => updateEventUniqueSlug(tx, 'id-1', { status: 'active' })), EventSlugConflictError);
  assert.equal((await getEvent(client, 'id-1'))?.status, 'cancelled');
});

test('updateEventUniqueSlug rejects a rename or redate onto another active event', async () => {
  const { createEventUniqueSlug, updateEventUniqueSlug, EventSlugConflictError } = await import('./events.ts');
  const client = withStrictTransactionOrdering(createInMemoryFirestoreClient());
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Volin', startDate: '2027-05-01' }, 'a@example.test', 'id-1'));
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Wolin', startDate: '2027-05-01' }, 'a@example.test', 'id-2'));
  await assert.rejects(client.runTransaction(tx => updateEventUniqueSlug(tx, 'id-2', { name: 'Volin' })), EventSlugConflictError);
  // Moving away frees the old slug.
  await client.runTransaction(tx => updateEventUniqueSlug(tx, 'id-1', { startDate: '2027-06-01' }));
  await client.runTransaction(tx => updateEventUniqueSlug(tx, 'id-2', { name: 'Volin' }));
  assert.equal((await getEvent(client, 'id-2'))?.name, 'Volin');
});

test('a stale slug lock (owner gone or moved on) does not block a new event', async () => {
  const { createEventUniqueSlug } = await import('./events.ts');
  const client = withStrictTransactionOrdering(createInMemoryFirestoreClient());
  await client.setDoc('eventSlugLocks', '2027-05-01-volin', { eventId: 'ghost' });
  await client.runTransaction(tx => createEventUniqueSlug(tx, { name: 'Volin', startDate: '2027-05-01' }, 'a@example.test', 'id-1'));
  assert.equal((await listEvents(client)).length, 1);
});
