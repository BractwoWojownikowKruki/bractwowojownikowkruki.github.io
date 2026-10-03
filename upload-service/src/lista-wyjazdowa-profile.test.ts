import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getProfile, listAllProfiles, saveProfile, setWpisoweStatus } from './lista-wyjazdowa-profile.ts';

test('getProfile returns null when no record exists', async () => {
  const client = createInMemoryFirestoreClient();
  assert.equal(await getProfile(client, 'nobody@example.test'), null);
});

test('saveProfile creates a record with wpisowePaid defaulted to false', async () => {
  const client = createInMemoryFirestoreClient();
  const profile = await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza', 'wlocznia'],
  });
  assert.deepEqual(profile.weaponIds, ['tarcza', 'wlocznia']);
  assert.equal(profile.wpisowePaid, false);
});

test('saveProfile preserves wpisowePaid on update', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza'],
  });
  client.seed('listaWyjazdowaProfile', 'ala@example.test', { ...created, wpisowePaid: true });

  const updated = await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza', 'topor'],
  });

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
    companions: [],
    wpisowePaid: false,
    someAdminAddedField: 'ustawione ręcznie w konsoli',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin@example.test',
  });

  await saveProfile(client, 'ala@example.test', { weaponIds: ['topor'] });

  const stored = await client.getDoc<Record<string, unknown>>('listaWyjazdowaProfile', 'ala@example.test');
  assert.equal(stored?.someAdminAddedField, 'ustawione ręcznie w konsoli');
  assert.deepEqual(stored?.weaponIds, ['topor']);
});

// Wpisowe is a club due, not a Lista Wyjazdowa feature - whether a member has ever filled in "Mój
// profil" must not gate whether they can be marked as having paid it.
test('setWpisoweStatus creates a profile with empty weaponIds when none exists', async () => {
  const client = createInMemoryFirestoreClient();
  const created = await setWpisoweStatus(client, 'ala@example.test', 'paid', 'accountant@example.test');
  assert.equal(created.wpisoweStatus, 'paid');
  assert.equal(created.wpisowePaid, true);
  assert.deepEqual(created.weaponIds, []);
  assert.equal(created.updatedBy, 'accountant@example.test');

  const stored = await getProfile(client, 'ala@example.test');
  assert.deepEqual(stored, created);
});

test('setWpisoweStatus changes the status, preserving weaponIds', async () => {
  const client = createInMemoryFirestoreClient();
  await saveProfile(client, 'ala@example.test', {
    weaponIds: ['tarcza'],
  });
  const updated = await setWpisoweStatus(client, 'ala@example.test', 'paid', 'accountant@example.test');
  assert.equal(updated?.wpisowePaid, true);
  assert.deepEqual(updated?.weaponIds, ['tarcza']);
  assert.equal(updated?.updatedBy, 'accountant@example.test');
});

test('setWpisoweStatus not_applicable keeps the legacy wpisowePaid false and survives a self-service save', async () => {
  const client = createInMemoryFirestoreClient();
  const set = await setWpisoweStatus(client, 'ala@example.test', 'not_applicable', 'accountant@example.test');
  assert.equal(set.wpisoweStatus, 'not_applicable');
  assert.equal(set.wpisowePaid, false);
  const saved = await saveProfile(client, 'ala@example.test', { weaponIds: ['topor'] });
  assert.equal(saved.wpisoweStatus, 'not_applicable');
  assert.equal((await getProfile(client, 'ala@example.test'))?.wpisoweStatus, 'not_applicable');
});

test('listAllProfiles returns every profile with email populated from the doc id', async () => {
  const client = createInMemoryFirestoreClient();
  await saveProfile(client, 'ala@example.test', { weaponIds: ['tarcza'] });
  await saveProfile(client, 'basia@example.test', { weaponIds: ['topor'] });

  const all = await listAllProfiles(client);
  assert.equal(all.length, 2);
  const byEmail = new Map(all.map((p) => [p.email, p]));
  assert.deepEqual(byEmail.get('ala@example.test')?.weaponIds, ['tarcza']);
  assert.deepEqual(byEmail.get('basia@example.test')?.weaponIds, ['topor']);
});
