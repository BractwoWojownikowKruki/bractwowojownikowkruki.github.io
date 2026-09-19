import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  applyPersonMerge,
  applyWeaponCategoryRule,
  createPerson,
  detachPerson,
  getPerson,
  listPersons,
  mergePersonIntoAccount,
  personDisplayName,
  planPersonMerge,
  resolvePersonId,
  softDeletePerson,
  updatePerson,
  validatePersonFields,
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

const accountEmail = 'kasia@example.test';

function seedAccount(
  client: ReturnType<typeof createInMemoryFirestoreClient>,
  overrides: Record<string, unknown> = {},
): void {
  client.seed('members', accountEmail, {
    email: accountEmail,
    fullName: 'Kasia Nowak',
    nickname: 'Kasia',
    sectionId: 'warszawa',
    categoryId: 'thing',
    status: 'active',
    ...overrides,
  });
}

test('createPerson generates a personId and defaults account/tombstone/merge fields to null', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');

  assert.ok(person.personId.length > 0, 'a personId must be generated');
  assert.equal(person.email, null);
  assert.equal(person.deletedAt, null);
  assert.equal(person.mergedInto, null);
  assert.equal(person.ownerPersonId, 'opiekun@example.test');
  assert.equal(person.createdBy, 'admin@example.test');
  assert.deepEqual((await getPerson(client, person.personId))?.weaponIds, ['tarcza']);
});

test('validatePersonFields rejects a missing category or section at runtime', () => {
  assert.throws(() => validatePersonFields({ ...baseFields, categoryId: '' }), /Kategoria osoby jest wymagana/);
  assert.throws(() => validatePersonFields({ ...baseFields, categoryId: '   ' }), /Kategoria osoby jest wymagana/);
  assert.throws(() => validatePersonFields({ ...baseFields, sectionId: '' }), /Sekcja osoby jest wymagana/);
  assert.doesNotThrow(() => validatePersonFields(baseFields));
});

test('createPerson and updatePerson both enforce the category/section rule', async () => {
  const client = createInMemoryFirestoreClient();
  await assert.rejects(() => createPerson(client, { ...baseFields, sectionId: '' }, null, 'admin@example.test'), /Sekcja/);

  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  await assert.rejects(() => updatePerson(client, person.personId, { ...baseFields, categoryId: '' }, 'admin@example.test'), /Kategoria/);
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

test('personDisplayName tolerates a person created with no names at all', () => {
  assert.equal(personDisplayName({ firstName: 'Jan', lastName: 'Kowalski' }), 'Jan Kowalski');
  assert.equal(personDisplayName({ firstName: 'Jan', lastName: '' }), 'Jan');
  assert.equal(personDisplayName({ firstName: '', lastName: '' }), null);
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

test('resolvePersonId: an existing person resolves to kind "person"', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, null, 'admin@example.test');

  const resolved = await resolvePersonId(client, person.personId);
  assert.equal(resolved.kind, 'person');
  assert.equal(resolved.personId, person.personId);
});

test('resolvePersonId: an account resolves to the lowercased e-mail', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);

  const resolved = await resolvePersonId(client, 'Kasia@Example.test');
  assert.equal(resolved.kind, 'account');
  assert.equal(resolved.personId, accountEmail);
});

test('resolvePersonId: an allowlisted member with no members document still resolves to the e-mail', async () => {
  const client = createInMemoryFirestoreClient();

  // Deliberately no members/{email} document: existence for the account branch is the caller's
  // allowlist check, not this resolver - see ResolvedPerson's own comment.
  const resolved = await resolvePersonId(client, 'Ala@Example.test');
  assert.equal(resolved.kind, 'account');
  assert.equal(resolved.personId, 'ala@example.test');
});

test('resolvePersonId: an unknown value falls to the account branch, which the caller must allowlist-check', async () => {
  const client = createInMemoryFirestoreClient();

  const unknownUuid = await resolvePersonId(client, 'nie-istnieje-0000');
  assert.equal(unknownUuid.kind, 'account', 'an unknown UUID is not an existing person, so it lands in the account branch');
  assert.equal(unknownUuid.personId, 'nie-istnieje-0000', 'and is what the caller will reject via the allowlist (404)');
});

test('merge: the person becomes a normal member keyed by the account e-mail', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client, { fullName: '', nickname: null, sectionId: '', categoryId: null });
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');
  const eventId = 'event-1';

  client.seed('signups', `${eventId}_${person.personId}`, {
    eventId,
    memberEmail: person.personId,
    attending: true,
    skladkaPaid: false,
  });
  client.seed('duesAnnual', `${person.personId}_2026`, { email: person.personId, year: 2026, status: 'paid' });
  client.seed('listaWyjazdowaProfile', person.personId, { weaponIds: ['tarcza'], wpisowePaid: false });

  const result = await mergePersonIntoAccount(client, person.personId, 'Kasia@Example.test', 'admin@example.test');
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const merged = await getPerson(client, person.personId);
  assert.equal(merged?.mergedInto, accountEmail, 'the retired UUID must point at the account e-mail');
  assert.ok(merged?.deletedAt, 'a merged person must be tombstoned so it leaves current lists');
  assert.equal(merged?.ownerPersonId, null, 'a member never keeps an owner');

  const member = await client.getDoc<Record<string, unknown>>('members', accountEmail);
  assert.equal(member?.fullName, 'Jan Kowalski', 'the person fills the account name when it is empty');
  assert.equal(member?.nickname, 'Wilk');
  assert.equal(member?.sectionId, 'krakow');
  assert.equal(member?.categoryId, 'wojownik');

  const movedSignup = await client.getDoc<{ memberEmail: string }>('signups', `${eventId}_${accountEmail}`);
  assert.equal(movedSignup?.memberEmail, accountEmail, 'the moved signup must be keyed and stamped with the account');
  assert.equal(await client.getDoc('signups', `${eventId}_${person.personId}`), null);

  const movedDues = await client.getDoc<{ email: string }>('duesAnnual', `${accountEmail}_2026`);
  assert.equal(movedDues?.email, accountEmail);
  assert.equal(await client.getDoc('duesAnnual', `${person.personId}_2026`), null);

  const movedProfile = await client.getDoc<{ weaponIds: string[] }>('listaWyjazdowaProfile', accountEmail);
  assert.deepEqual(movedProfile?.weaponIds, ['tarcza'], 'the person weapons become the account weapons');
  assert.equal(await client.getDoc('listaWyjazdowaProfile', person.personId), null);

  const current = await listPersons(client);
  assert.deepEqual(current, [], 'a merged person is not a live accountless person any more');

  const resolved = await resolvePersonId(client, person.personId);
  assert.equal(resolved.kind, 'account');
  assert.equal(resolved.personId, accountEmail, 'the retired UUID must resolve to the account');
});

test('merge: the account wins every conflict and only has blanks filled', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');
  const eventId = 'event-1';

  client.seed('signups', `${eventId}_${person.personId}`, { eventId, memberEmail: person.personId, attending: true });
  client.seed('signups', `${eventId}_${accountEmail}`, { eventId, memberEmail: accountEmail, attending: false });
  client.seed('duesAnnual', `${person.personId}_2026`, { email: person.personId, year: 2026, status: 'paid' });
  client.seed('duesAnnual', `${accountEmail}_2026`, { email: accountEmail, year: 2026, status: 'unpaid' });
  client.seed('listaWyjazdowaProfile', person.personId, { weaponIds: ['tarcza'], wpisowePaid: false });
  client.seed('listaWyjazdowaProfile', accountEmail, { weaponIds: ['miecz'], wpisowePaid: true });

  const result = await mergePersonIntoAccount(client, person.personId, accountEmail, 'admin@example.test');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outcome.droppedSignups, [`${eventId}_${person.personId}`]);
  assert.deepEqual(result.outcome.droppedDues, [`${person.personId}_2026`]);
  assert.deepEqual(result.outcome.memberFilled, [], 'a fully populated account has no blanks to fill');

  const member = await client.getDoc<Record<string, unknown>>('members', accountEmail);
  assert.equal(member?.fullName, 'Kasia Nowak', 'the account identity is never overwritten');
  assert.equal(member?.sectionId, 'warszawa');

  const signup = await client.getDoc<{ attending: boolean }>('signups', `${eventId}_${accountEmail}`);
  assert.equal(signup?.attending, false, 'the account signup survives');
  assert.equal(await client.getDoc('signups', `${eventId}_${person.personId}`), null);

  const dues = await client.getDoc<{ status: string }>('duesAnnual', `${accountEmail}_2026`);
  assert.equal(dues?.status, 'unpaid', 'the account dues survive');
  assert.equal(await client.getDoc('duesAnnual', `${person.personId}_2026`), null);

  const profile = await client.getDoc<{ weaponIds: string[]; wpisowePaid: boolean }>('listaWyjazdowaProfile', accountEmail);
  assert.deepEqual(profile?.weaponIds, ['miecz'], 'the account weapons win over the person weapons');
  assert.equal(profile?.wpisowePaid, true);
  assert.equal(await client.getDoc('listaWyjazdowaProfile', person.personId), null);
});

test('merge recomputes blanks and the profile at apply time, so a newer account value is never overwritten', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client, { fullName: '', nickname: null, sectionId: '', categoryId: null });
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');
  client.seed('listaWyjazdowaProfile', person.personId, { weaponIds: ['tarcza'], wpisowePaid: false });

  const planned = await planPersonMerge(client, person.personId, accountEmail);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;

  // The account fills its own identity and weapons after planning, but before the merge is applied
  // (the same window a transaction retry opens up). Those newer values must survive.
  await client.setDoc('members', accountEmail, { fullName: 'Kasia Nowak', nickname: 'Kasia', sectionId: 'warszawa', categoryId: 'thing' });
  await client.setDoc('listaWyjazdowaProfile', accountEmail, { weaponIds: ['miecz'], wpisowePaid: false });

  const applied = await client.runTransaction((tx) => applyPersonMerge(tx, planned.plan, 'admin@example.test'));
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.deepEqual(applied.outcome.memberFilled, [], 'a now-populated account has no blanks left to fill');

  const member = await client.getDoc<Record<string, unknown>>('members', accountEmail);
  assert.equal(member?.fullName, 'Kasia Nowak', 'the newer account name must survive');
  assert.equal(member?.sectionId, 'warszawa');

  const profile = await client.getDoc<{ weaponIds: string[] }>('listaWyjazdowaProfile', accountEmail);
  assert.deepEqual(profile?.weaponIds, ['miecz'], 'the newer account weapons must survive');
});

test('merge refuses an unknown person or account, and a second merge of the same person', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);

  assert.deepEqual(await mergePersonIntoAccount(client, 'nie-ma-takiej-osoby', accountEmail, 'admin@example.test'), {
    ok: false,
    reason: 'person_not_found',
  });

  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  assert.deepEqual(await mergePersonIntoAccount(client, person.personId, 'brak-konta@example.test', 'admin@example.test'), {
    ok: false,
    reason: 'account_not_found',
  });

  assert.equal((await mergePersonIntoAccount(client, person.personId, accountEmail, 'admin@example.test')).ok, true);
  assert.deepEqual(await mergePersonIntoAccount(client, person.personId, accountEmail, 'admin@example.test'), {
    ok: false,
    reason: 'person_already_merged',
  });
});

test('planPersonMerge reports errors as values so a caller can map them to HTTP statuses', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);

  assert.deepEqual(await planPersonMerge(client, 'nie-ma-takiej-osoby', accountEmail), { ok: false, reason: 'person_not_found' });

  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  assert.deepEqual(await planPersonMerge(client, person.personId, 'brak-konta@example.test'), { ok: false, reason: 'account_not_found' });
});
