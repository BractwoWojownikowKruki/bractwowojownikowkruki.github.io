import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from '../src/firestore.ts';
import { clearPrivateEquipmentSections } from './clear-private-equipment-sections.ts';

test('clearPrivateEquipmentSections nulls the section of private items only, and is idempotent', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('equipment', 'team', { categoryId: 'namiot', sectionId: 'krakow', belongsToPersonId: null, description: 'drużynowy' });
  client.seed('equipment', 'private', { categoryId: 'namiot', sectionId: 'warszawa', belongsToPersonId: 'ala@example.test', description: 'prywatny' });

  const report = await clearPrivateEquipmentSections(client);
  assert.equal(report.privateItemsCleared, 1);
  assert.deepEqual(report.sampleIds, ['private']);

  const team = await client.getDoc<Record<string, unknown>>('equipment', 'team');
  const priv = await client.getDoc<Record<string, unknown>>('equipment', 'private');
  assert.equal(team?.sectionId, 'krakow', 'drużynowy equipment keeps its section');
  assert.equal(priv?.sectionId, null);
  assert.equal(priv?.description, 'prywatny', 'other fields survive');

  const second = await clearPrivateEquipmentSections(client);
  assert.equal(second.privateItemsCleared, 0);
});
