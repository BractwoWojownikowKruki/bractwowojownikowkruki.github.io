import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  applyWeaponCategoryRule,
  createPerson,
  detachPerson,
  getPerson,
  hasDomainData,
  linkAccount,
  listPersons,
  probeAccountDomainData,
  resolvePersonId,
  softDeletePerson,
  updatePerson,
  weaponAllowedForCategory,
} from './persons.ts';

const baseFields = {
  ksywka: 'Wilk',
  firstName: 'Jan',
  lastName: 'Kowalski',
  categoryId: 'wojownik',
  sectionId: 'krakow',
  weaponIds: ['tarcza'],
};

test('createPerson generates a personId and defaults account/tombstone fields to null', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');

  assert.ok(person.personId.length > 0, 'a personId must be generated');
  assert.equal(person.email, null);
  assert.equal(person.deletedAt, null);
  assert.equal(person.ownerPersonId, 'opiekun@example.test');
  assert.equal(person.createdBy, 'admin@example.test');
  assert.deepEqual((await getPerson(client, person.personId))?.weaponIds, ['tarcza']);
});

test('weapon rule: Niewiasta and Bobo never keep a weapon list', async () => {
  assert.equal(weaponAllowedForCategory('niewiasta'), false);
  assert.equal(weaponAllowedForCategory('bobo'), false);
  assert.equal(weaponAllowedForCategory('thing'), true);

  assert.deepEqual(
    applyWeaponCategoryRule({ ...baseFields, categoryId: 'niewiasta', weaponIds: ['tarcza'] }).weaponIds,
    [],
  );

  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, { ...baseFields, categoryId: 'bobo' }, null, 'admin@example.test');
  assert.deepEqual(person.weaponIds, []);

  const updated = await updatePerson(client, person.personId, { ...baseFields, categoryId: 'thing' }, 'admin@example.test');
  assert.deepEqual(updated?.weaponIds, ['tarcza']);

  const back = await updatePerson(client, person.personId, { ...baseFields, categoryId: 'bobo' }, 'admin@example.test');
  assert.deepEqual(back?.weaponIds, [], 'switching back to Bobo must clear the weapon again');
});

test('listPersons hides tombstoned people by default and includes them on request', async () => {
  const client = createInMemoryFirestoreClient();
  const kept = await createPerson(client, baseFields, null, 'admin@example.test');
  const removed = await createPerson(client, { ...baseFields, ksywka: 'Cień' }, null, 'admin@example.test');

  const deleted = await softDeletePerson(client, removed.personId, 'admin@example.test');
  assert.ok(deleted?.deletedAt, 'softDeletePerson must stamp deletedAt');

  const current = await listPersons(client);
  assert.deepEqual(current.map((d) => d.id), [kept.personId], 'a tombstoned person must leave current lists');

  const historical = await listPersons(client, { includeDeleted: true });
  assert.equal(historical.length, 2, 'historical reads must still resolve the tombstoned person');
});

test('detachPerson clears the owner and keeps the person otherwise intact', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');

  const detached = await detachPerson(client, person.personId, 'admin@example.test');
  assert.equal(detached?.ownerPersonId, null);
  assert.deepEqual(detached?.weaponIds, ['tarcza'], 'detaching must not touch the person data');
});

test('linkAccount sets the e-mail, clears the owner and refuses a second link', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');

  const linked = await linkAccount(client, person.personId, 'Kasia@Example.test', 'admin@example.test');
  assert.equal(linked?.email, 'kasia@example.test', 'the e-mail must be normalized');
  assert.equal(linked?.ownerPersonId, null, 'a person with an account is never attached to an owner');

  const second = await linkAccount(client, person.personId, 'inny@example.test', 'admin@example.test');
  assert.equal(second, null, 'an already-linked person must be rejected, not overwritten');
});

test('resolvePersonId: a plain member e-mail resolves to itself, case-insensitively', async () => {
  const client = createInMemoryFirestoreClient();
  const resolved = await resolvePersonId(client, 'Ala@Example.test');
  assert.equal(resolved.personId, 'ala@example.test');
  assert.equal(resolved.isAccount, true);
});

test('resolvePersonId: a linked account resolves to the person UUID, not the e-mail', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  await linkAccount(client, person.personId, 'kasia@example.test', 'admin@example.test');
  client.seed('members', 'kasia@example.test', { status: 'active', linkedPersonId: person.personId });

  const resolved = await resolvePersonId(client, 'kasia@example.test');
  assert.equal(resolved.personId, person.personId);
  assert.equal(resolved.isAccount, true, 'it is still an account, just mapped onto the person');
});

test('resolvePersonId: an existing person UUID resolves to itself and is not treated as an account', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, null, 'admin@example.test');

  const resolved = await resolvePersonId(client, person.personId);
  assert.equal(resolved.personId, person.personId);
  assert.equal(resolved.isAccount, false);
});

test('hasDomainData flags an account that already owns profile data, signups or dues', async () => {
  assert.equal(hasDomainData({ hasProfileData: false, hasSignups: false, hasAnnualDues: false }), false);
  assert.equal(hasDomainData({ hasProfileData: true, hasSignups: false, hasAnnualDues: false }), true);
  assert.equal(hasDomainData({ hasProfileData: false, hasSignups: true, hasAnnualDues: false }), true);
  assert.equal(hasDomainData({ hasProfileData: false, hasSignups: false, hasAnnualDues: true }), true);
});

test('probeAccountDomainData: empty profile document alone does not count as domain data', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('listaWyjazdowaProfile', 'kasia@example.test', {
    weaponIds: [],
    equipment: [],
    wpisowePaid: false,
  });

  const probe = await probeAccountDomainData(client, 'kasia@example.test');
  assert.deepEqual(probe, { hasProfileData: false, hasSignups: false, hasAnnualDues: false });
});

test('probeAccountDomainData: a non-attending signup still blocks linking', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('signups', 'event-1_kasia@example.test', { eventId: 'event-1', memberEmail: 'kasia@example.test', attending: false });

  const probe = await probeAccountDomainData(client, 'kasia@example.test');
  assert.equal(probe.hasSignups, true);
});

test('probeAccountDomainData: dues from any year block linking', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('duesAnnual', 'kasia@example.test_2026', { status: 'paid' });

  const probe = await probeAccountDomainData(client, 'kasia@example.test');
  assert.equal(probe.hasAnnualDues, true);
});
