import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from '../src/firestore.ts';
import { removeLegacyCompanionFields } from './remove-legacy-companions.ts';

test('removeLegacyCompanionFields drops the legacy fields and keeps everything else', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('listaWyjazdowaProfile', 'ala@example.test', {
    weaponIds: ['tarcza'],
    equipment: [{ id: 'e1', name: 'Namiot', description: '' }],
    companions: [{ id: 'c1', name: 'Jaś (syn)' }],
    wpisowePaid: true,
  });
  client.seed('signups', 'event-1_ala@example.test', {
    eventId: 'event-1',
    memberEmail: 'ala@example.test',
    attending: true,
    equipmentIds: ['e1'],
    companionIds: ['c1'],
    skladkaPaid: true,
  });
  client.seed('signups', 'event-1_bea@example.test', {
    eventId: 'event-1',
    memberEmail: 'bea@example.test',
    attending: false,
    equipmentIds: [],
    skladkaPaid: false,
  });

  const report = await removeLegacyCompanionFields(client);
  assert.equal(report.profilesWithCompanions, 1);
  assert.equal(report.signupsWithCompanionIds, 1);
  assert.deepEqual(report.sampleProfileIds, ['ala@example.test']);
  assert.deepEqual(report.sampleSignupIds, ['event-1_ala@example.test']);

  const profile = await client.getDoc<Record<string, unknown>>('listaWyjazdowaProfile', 'ala@example.test');
  assert.equal('companions' in (profile ?? {}), false, 'the legacy field must be gone');
  assert.deepEqual(profile?.weaponIds, ['tarcza'], 'other fields must survive');
  assert.equal(profile?.wpisowePaid, true, 'other fields must survive');

  const signup = await client.getDoc<Record<string, unknown>>('signups', 'event-1_ala@example.test');
  assert.equal('companionIds' in (signup ?? {}), false, 'the legacy field must be gone');
  assert.equal(signup?.attending, true, 'other fields must survive');
  assert.equal(signup?.skladkaPaid, true, 'other fields must survive');

  const untouched = await client.getDoc<Record<string, unknown>>('signups', 'event-1_bea@example.test');
  assert.equal(untouched?.attending, false);
});

test('removeLegacyCompanionFields is idempotent', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('listaWyjazdowaProfile', 'ala@example.test', { weaponIds: [], equipment: [], companions: [] });
  client.seed('signups', 'event-1_ala@example.test', { eventId: 'event-1', attending: true, companionIds: [] });

  const first = await removeLegacyCompanionFields(client);
  assert.equal(first.profilesWithCompanions, 1);
  assert.equal(first.signupsWithCompanionIds, 1);

  const second = await removeLegacyCompanionFields(client);
  assert.equal(second.profilesWithCompanions, 0, 'a second run must find nothing to do');
  assert.equal(second.signupsWithCompanionIds, 0);
  assert.deepEqual(second.sampleProfileIds, []);
  assert.deepEqual(second.sampleSignupIds, []);
});
