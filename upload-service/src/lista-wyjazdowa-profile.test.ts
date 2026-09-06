import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getProfile, listAllProfiles, saveProfile, setWpisowePaid } from './lista-wyjazdowa-profile.ts';

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

  const stored = await getProfile(client, 'ala@example.test');
  assert.equal(stored?.wpisowePaid, true, 'the stored document must keep wpisowePaid, not just the response');
  assert.deepEqual(stored?.weaponIds, ['tarcza', 'topor'], 'the writable fields must still be replaced wholesale');
});

// Same structural protection as saveMember's: the accountant-owned field is never named in the
// write, so a concurrent accountant toggle (or any admin-added field) survives the member's save.
test('saveProfile leaves fields it does not know about untouched', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('listaWyjazdowaProfile', 'ala@example.test', {
    weaponIds: ['tarcza'],
    equipment: [],
    companions: [],
    wpisowePaid: false,
    someAdminAddedField: 'ustawione ręcznie w konsoli',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin@example.test',
  });

  await saveProfile(client, 'ala@example.test', { weaponIds: ['topor'], equipment: [], companions: [] });

  const stored = await client.getDoc<Record<string, unknown>>('listaWyjazdowaProfile', 'ala@example.test');
  assert.equal(stored?.someAdminAddedField, 'ustawione ręcznie w konsoli');
  assert.deepEqual(stored?.weaponIds, ['topor']);
});

test('setWpisowePaid returns null when no profile exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await setWpisowePaid(client, 'ala@example.test', true, 'accountant@example.test'), null);
});

test('setWpisowePaid toggles paid, preserving weaponIds/equipment/companions', async () => {
  const client = createInMemoryFirestoreClient();
  await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza'],
    equipment: [{ id: '', name: 'Namiot', description: '' }],
    companions: [],
  });
  const updated = await setWpisowePaid(client, 'ala@example.test', true, 'accountant@example.test');
  assert.equal(updated?.wpisowePaid, true);
  assert.deepEqual(updated?.weaponIds, ['tarcza']);
  assert.equal(updated?.equipment[0].name, 'Namiot');
  assert.equal(updated?.updatedBy, 'accountant@example.test');
});

test('listAllProfiles returns every profile with email populated from the doc id', async () => {
  const client = createInMemoryFirestoreClient();
  await saveProfile(client, 'ala@example.test', { weaponIds: ['tarcza'], equipment: [], companions: [] });
  await saveProfile(client, 'basia@example.test', { weaponIds: ['topor'], equipment: [], companions: [] });

  const all = await listAllProfiles(client);
  assert.equal(all.length, 2);
  const byEmail = new Map(all.map((p) => [p.email, p]));
  assert.deepEqual(byEmail.get('ala@example.test')?.weaponIds, ['tarcza']);
  assert.deepEqual(byEmail.get('basia@example.test')?.weaponIds, ['topor']);
});
