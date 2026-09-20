import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  getEventEquipment,
  listAllEventEquipment,
  listEventEquipmentForEvent,
  saveEventEquipment,
} from './event-equipment.ts';

test('saveEventEquipment creates a document on first toggle and updates it on the next', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await saveEventEquipment(client, 'event-1', 'equipment-1', true, 'ala@example.test');
  assert.equal(created.going, true);
  assert.equal(created.eventId, 'event-1');
  assert.equal(created.equipmentId, 'equipment-1');
  assert.equal(created.lastChangedBy, 'ala@example.test');

  const updated = await saveEventEquipment(client, 'event-1', 'equipment-1', false, 'bea@example.test');
  assert.equal(updated.going, false);
  assert.equal(updated.lastChangedBy, 'bea@example.test');

  assert.deepEqual(await getEventEquipment(client, 'event-1', 'equipment-1'), updated);
});

test('getEventEquipment returns null when nothing has been toggled yet', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getEventEquipment(client, 'event-1', 'never-toggled'), null);
});

test('listEventEquipmentForEvent filters to one event only', async () => {
  const client = createInMemoryFirestoreClient();
  await saveEventEquipment(client, 'event-1', 'equipment-1', true, 'ala@example.test');
  await saveEventEquipment(client, 'event-2', 'equipment-1', true, 'ala@example.test');

  const forEvent = await listEventEquipmentForEvent(client, 'event-1');
  assert.equal(forEvent.length, 1);
  assert.equal(forEvent[0].eventId, 'event-1');
});

test('listAllEventEquipment returns every document across every event', async () => {
  const client = createInMemoryFirestoreClient();
  await saveEventEquipment(client, 'event-1', 'equipment-1', true, 'ala@example.test');
  await saveEventEquipment(client, 'event-2', 'equipment-2', true, 'ala@example.test');

  assert.equal((await listAllEventEquipment(client)).length, 2);
});
