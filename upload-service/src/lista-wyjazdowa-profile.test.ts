import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getProfile, saveProfile } from './lista-wyjazdowa-profile.ts';

test('getProfile returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getProfile(client, 'nobody@example.test'), null);
});

test('saveProfile creates a record with wpisowePaid defaulted to false', async () => {
  const client = createInMemoryFirestoreClient();
  const profile = await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza', 'wlocznia'],
    equipment: [{ id: '', name: 'Namiot', description: '4-osobowy' }],
    companions: [{ id: '', name: 'Jaś (syn)' }],
  });
  assert.deepEqual(profile.weaponIds, ['tarcza', 'wlocznia']);
  assert.equal(profile.wpisowePaid, false);
  assert.equal(profile.equipment[0].name, 'Namiot');
  assert.ok(profile.equipment[0].id.length > 0, 'a blank id must be generated');
  assert.ok(profile.companions[0].id.length > 0, 'a blank id must be generated');
});

test('saveProfile preserves existing equipment/companion ids and wpisowePaid on update', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza'],
    equipment: [{ id: '', name: 'Namiot', description: '' }],
    companions: [],
  });
  client.seed('listaWyjazdowaProfile', 'ala@example.test', { ...created, wpisowePaid: true });

  const updated = await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza', 'topor'],
    equipment: [{ id: created.equipment[0].id, name: 'Namiot 6-osobowy', description: '' }],
    companions: [],
  });

  assert.equal(updated.equipment[0].id, created.equipment[0].id, 'existing id must be kept, not regenerated');
  assert.equal(updated.wpisowePaid, true, 'wpisowePaid must survive a self-service edit untouched');
});
