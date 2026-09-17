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

function seedAccount(client: ReturnType<typeof createInMemoryFirestoreClient>): void {
  client.seed('members', accountEmail, { email: accountEmail, status: 'active' });
}

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

test('linkAccount writes both sides of the mapping and clears the owner', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);
  const person = await createPerson(client, baseFields, 'opiekun@example.test', 'admin@example.test');

  const result = await linkAccount(client, person.personId, 'Kasia@Example.test', 'admin@example.test');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.person.email, accountEmail, 'the e-mail must be normalized');
  assert.equal(result.person.ownerPersonId, null, 'a person with an account is never attached to an owner');

  const storedPerson = await getPerson(client, person.personId);
  assert.equal(storedPerson?.email, accountEmail, 'the person document itself must carry the account');

  // The reverse mapping is written by the linking operation itself - not by the test - because the
  // resolver depends on it to find the person from the e-mail.
  const storedMember = await client.getDoc<{ linkedPersonId?: string }>('members', accountEmail);
  assert.equal(storedMember?.linkedPersonId, person.personId, 'members/{email}.linkedPersonId must be written');
});

test('linkAccount refuses a second link on an already-linked person', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);
  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  assert.equal((await linkAccount(client, person.personId, accountEmail, 'admin@example.test')).ok, true);

  const second = await linkAccount(client, person.personId, accountEmail, 'admin@example.test');
  assert.deepEqual(second, { ok: false, reason: 'already_linked' });
});

test('linkAccount refuses when the person or the account does not exist', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);

  assert.deepEqual(await linkAccount(client, 'nie-ma-takiej-osoby', accountEmail, 'admin@example.test'), {
    ok: false,
    reason: 'person_not_found',
  });

  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  assert.deepEqual(await linkAccount(client, person.personId, 'brak-konta@example.test', 'admin@example.test'), {
    ok: false,
    reason: 'account_not_found',
  });
});

test('linkAccount refuses an account that already owns domain data, for each category', async () => {
  const cases: Array<[string, (c: ReturnType<typeof createInMemoryFirestoreClient>) => void]> = [
    ['profile with weapons', (c) => c.seed('listaWyjazdowaProfile', accountEmail, { weaponIds: ['tarcza'], equipment: [], wpisowePaid: false })],
    ['profile with equipment', (c) => c.seed('listaWyjazdowaProfile', accountEmail, { weaponIds: [], equipment: [{ id: 'e1', name: 'Namiot', description: '' }], wpisowePaid: false })],
    ['profile with wpisowe paid', (c) => c.seed('listaWyjazdowaProfile', accountEmail, { weaponIds: [], equipment: [], wpisowePaid: true })],
    ['a non-attending signup', (c) => c.seed('signups', `event-1_${accountEmail}`, { eventId: 'event-1', attending: false })],
    ['annual dues', (c) => c.seed('duesAnnual', `${accountEmail}_2026`, { status: 'paid' })],
  ];

  for (const [label, seed] of cases) {
    const client = createInMemoryFirestoreClient();
    seedAccount(client);
    seed(client);
    const person = await createPerson(client, baseFields, null, 'admin@example.test');

    assert.deepEqual(
      await linkAccount(client, person.personId, accountEmail, 'admin@example.test'),
      { ok: false, reason: 'account_has_data' },
      `linking must be refused for: ${label}`,
    );
    assert.equal((await getPerson(client, person.personId))?.email, null, `the person must stay unlinked: ${label}`);
  }
});

test('resolvePersonId: an existing person resolves to kind "person"', async () => {
  const client = createInMemoryFirestoreClient();
  const person = await createPerson(client, baseFields, null, 'admin@example.test');

  const resolved = await resolvePersonId(client, person.personId);
  assert.equal(resolved.kind, 'person');
  assert.equal(resolved.personId, person.personId);
});

test('resolvePersonId: a member with a members document but no link resolves to the lowercased e-mail', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);

  const resolved = await resolvePersonId(client, 'Kasia@Example.test');
  assert.equal(resolved.kind, 'account');
  assert.equal(resolved.personId, accountEmail);
  assert.equal(resolved.kind === 'account' ? resolved.linkedPersonId : 'x', null);
});

test('resolvePersonId: an allowlisted member with no members document still resolves to the e-mail', async () => {
  const client = createInMemoryFirestoreClient();

  // Deliberately no members/{email} document: existence for the account branch is the caller's
  // allowlist check, not this resolver - see ResolvedPerson's own comment.
  const resolved = await resolvePersonId(client, 'Ala@Example.test');
  assert.equal(resolved.kind, 'account');
  assert.equal(resolved.personId, 'ala@example.test');
});

test('resolvePersonId: a linked account resolves to the person UUID written by linkAccount', async () => {
  const client = createInMemoryFirestoreClient();
  seedAccount(client);
  const person = await createPerson(client, baseFields, null, 'admin@example.test');
  await linkAccount(client, person.personId, accountEmail, 'admin@example.test');

  const resolved = await resolvePersonId(client, accountEmail);
  assert.equal(resolved.kind, 'account');
  assert.equal(resolved.personId, person.personId, 'a linked account must map onto its person UUID');
  assert.equal(resolved.kind === 'account' ? resolved.linkedPersonId : null, person.personId);
});

test('resolvePersonId: an unknown value falls to the account branch, which the caller must allowlist-check', async () => {
  const client = createInMemoryFirestoreClient();

  const unknownUuid = await resolvePersonId(client, 'nie-istnieje-0000');
  assert.equal(unknownUuid.kind, 'account', 'an unknown UUID is not an existing person, so it lands in the account branch');
  assert.equal(unknownUuid.personId, 'nie-istnieje-0000', 'and is what the caller will reject via the allowlist (404)');
});

test('hasDomainData flags an account that already owns profile data, signups or dues', () => {
  assert.equal(hasDomainData({ hasProfileData: false, hasSignups: false, hasAnnualDues: false }), false);
  assert.equal(hasDomainData({ hasProfileData: true, hasSignups: false, hasAnnualDues: false }), true);
  assert.equal(hasDomainData({ hasProfileData: false, hasSignups: true, hasAnnualDues: false }), true);
  assert.equal(hasDomainData({ hasProfileData: false, hasSignups: false, hasAnnualDues: true }), true);
});

test('probeAccountDomainData: an empty profile document alone does not count as domain data', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('listaWyjazdowaProfile', accountEmail, { weaponIds: [], equipment: [], wpisowePaid: false });

  const probe = await probeAccountDomainData(client, accountEmail);
  assert.deepEqual(probe, { hasProfileData: false, hasSignups: false, hasAnnualDues: false });
});

test('probeAccountDomainData: each profile field alone counts as domain data', async () => {
  const seeds = [
    { weaponIds: ['tarcza'], equipment: [], wpisowePaid: false },
    { weaponIds: [], equipment: [{ id: 'e1', name: 'Namiot', description: '' }], wpisowePaid: false },
    { weaponIds: [], equipment: [], wpisowePaid: true },
  ];
  for (const stored of seeds) {
    const client = createInMemoryFirestoreClient();
    client.seed('listaWyjazdowaProfile', accountEmail, stored);
    assert.equal((await probeAccountDomainData(client, accountEmail)).hasProfileData, true, JSON.stringify(stored));
  }
});

test('probeAccountDomainData: a non-attending signup still blocks linking', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('signups', `event-1_${accountEmail}`, { eventId: 'event-1', memberEmail: accountEmail, attending: false });

  const probe = await probeAccountDomainData(client, accountEmail);
  assert.equal(probe.hasSignups, true);
});

test('probeAccountDomainData: dues from any year block linking', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('duesAnnual', `${accountEmail}_2026`, { status: 'paid' });

  const probe = await probeAccountDomainData(client, accountEmail);
  assert.equal(probe.hasAnnualDues, true);
});
