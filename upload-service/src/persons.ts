import { randomUUID } from 'node:crypto';
import type { FirestoreDoc, FirestoreLikeClient } from './firestore.ts';
import { getMember } from './members.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

/**
 * A person who has no account on the site (KRKG-0087). This is not a separate "kind" of person:
 * it is the same person record a member has, minus the account. `personId` is the canonical,
 * opaque key for every domain record (profile, signup, dues, audit); for a member it equals the
 * e-mail, for a person without an account it is a generated UUID. `email` is an optional attribute
 * used only for signing in - it is never the key of domain data.
 */
export interface PersonDoc {
  personId: string;
  ksywka: string;
  firstName: string;
  lastName: string;
  categoryId: string;
  sectionId: string;
  weaponIds: string[];
  /** The person this one is attached to (their "opiekun"), or null when unattached. */
  ownerPersonId: string | null;
  /** Account e-mail once this person has one; null while they have no account. */
  email: string | null;
  /** Set by softDeletePerson. A tombstoned person disappears from current lists but stays
   * resolvable for history and audit. Never cleared. */
  deletedAt: string | null;
  createdAt: string;
  createdBy: string;
  /** Present on every write after creation; mirrors the other domain documents' audit columns. */
  updatedAt?: string;
  updatedBy?: string;
  deletedBy?: string;
}

export interface PersonWritableFields {
  ksywka: string;
  firstName: string;
  lastName: string;
  categoryId: string;
  sectionId: string;
  weaponIds: string[];
}

const PERSONS_COLLECTION = 'persons';

/**
 * Niewiasta and Bobo never carry a weapon (KRKG-0087 design, section A) - enforced here so every
 * caller (server routes, quick-add, migration of legacy data) gets the same rule instead of
 * repeating it. Changing a person's category to one of these clears their weapon list.
 */
const NO_WEAPON_CATEGORY_IDS = ['niewiasta', 'bobo'];

export function weaponAllowedForCategory(categoryId: string): boolean {
  return !NO_WEAPON_CATEGORY_IDS.includes(categoryId);
}

/** Applies the category/weapon rule to a writable field set. */
export function applyWeaponCategoryRule(fields: PersonWritableFields): PersonWritableFields {
  return weaponAllowedForCategory(fields.categoryId) ? fields : { ...fields, weaponIds: [] };
}

export async function getPerson(client: FirestoreLikeClient, personId: string): Promise<PersonDoc | null> {
  return client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
}

/**
 * Every person without an account. Tombstoned people are excluded by default: current lists
 * (roster without an eventId, pickers, dropdowns) must not show them. Pass `includeDeleted` for
 * historical reads, which resolve a person that has been removed.
 */
export async function listPersons(
  client: FirestoreLikeClient,
  options: { includeDeleted?: boolean } = {},
): Promise<FirestoreDoc<PersonDoc>[]> {
  const docs = await client.listDocs<PersonDoc>(PERSONS_COLLECTION);
  return options.includeDeleted ? docs : docs.filter((d) => !d.data.deletedAt);
}

export interface ResolvedPerson {
  personId: string;
  /** True when the incoming value named an account (e-mail key), false for an accountless person. */
  isAccount: boolean;
  person: PersonDoc | null;
}

/**
 * The single place that decides what a `personId` is (KRKG-0087 plan, "Kontrakt tożsamości").
 *
 * Deliberately **no format heuristics**: we never inspect the value for an "@". Resolution is a
 * document lookup - an existing `persons/{value}` is an accountless person; anything else is
 * treated as an account key and mapped through `members/{email}.linkedPersonId`, so an e-mail of
 * a linked account still lands on that person's UUID. A member who never saved a profile has no
 * `members/{email}` document, so the e-mail itself is the fallback key.
 */
export async function resolvePersonId(client: FirestoreLikeClient, value: string): Promise<ResolvedPerson> {
  const person = await getPerson(client, value);
  if (person) return { personId: person.personId, isAccount: false, person };
  const email = value.toLowerCase();
  const member = await getMember(client, email);
  return { personId: member?.linkedPersonId ?? email, isAccount: true, person: null };
}

export async function createPerson(
  client: FirestoreWriteContext,
  fields: PersonWritableFields,
  ownerPersonId: string | null,
  createdBy: string,
): Promise<PersonDoc> {
  const now = new Date().toISOString();
  const personId = randomUUID();
  const normalized = applyWeaponCategoryRule(fields);
  const doc: PersonDoc = {
    personId,
    ...normalized,
    ownerPersonId,
    email: null,
    deletedAt: null,
    createdAt: now,
    createdBy,
  };
  await client.setDoc(PERSONS_COLLECTION, personId, doc);
  return doc;
}

export async function updatePerson(
  client: FirestoreWriteContext,
  personId: string,
  fields: PersonWritableFields,
  updatedBy: string,
): Promise<PersonDoc | null> {
  const existing = await client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
  if (!existing) return null;
  const normalized = applyWeaponCategoryRule(fields);
  const writable = { ...normalized, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(PERSONS_COLLECTION, personId, writable);
  return { ...existing, ...writable };
}

/** Tombstone: the record stays resolvable for history and audit, but leaves every current list. */
export async function softDeletePerson(
  client: FirestoreWriteContext,
  personId: string,
  deletedBy: string,
): Promise<PersonDoc | null> {
  const existing = await client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
  if (!existing) return null;
  const writable = { deletedAt: new Date().toISOString(), deletedBy };
  await client.setDoc(PERSONS_COLLECTION, personId, writable);
  return { ...existing, ...writable };
}

/** Removes the attachment to an owner; the person stays as an independent, accountless person. */
export async function detachPerson(
  client: FirestoreWriteContext,
  personId: string,
  updatedBy: string,
): Promise<PersonDoc | null> {
  const existing = await client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
  if (!existing) return null;
  const writable = { ownerPersonId: null, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(PERSONS_COLLECTION, personId, writable);
  return { ...existing, ...writable };
}

/**
 * Gives an accountless person an account (KRKG-0087 design, section D). Callers must run this
 * inside a transaction together with the audit entry: the guard fields are read here so a second,
 * concurrent admin sees the already-set value and is rejected instead of double-linking.
 *
 * Attaching an account also clears `ownerPersonId` - a person with an account is never "attached"
 * to an owner (the attachment is what makes someone an osoba towarzysząca).
 */
export async function linkAccount(
  client: FirestoreWriteContext,
  personId: string,
  accountEmail: string,
  linkedBy: string,
): Promise<PersonDoc | null> {
  const existing = await client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
  if (!existing) return null;
  if (existing.email) return null;
  const writable = {
    email: accountEmail.toLowerCase(),
    ownerPersonId: null,
    updatedBy: linkedBy,
    updatedAt: new Date().toISOString(),
  };
  await client.setDoc(PERSONS_COLLECTION, personId, writable);
  return { ...existing, ...writable };
}

/**
 * "No domain data" test used by account linking (design D). A fresh registration account has no
 * profile with weapons/equipment/wpisowe, no signup for any event (regardless of attending) and no
 * annual dues for any year; anything else means the account already owns data and must not be
 * silently merged into an existing person record.
 */
export interface DomainDataProbe {
  hasProfileData: boolean;
  hasSignups: boolean;
  hasAnnualDues: boolean;
}

export function hasDomainData(probe: DomainDataProbe): boolean {
  return probe.hasProfileData || probe.hasSignups || probe.hasAnnualDues;
}

export async function probeAccountDomainData(
  client: FirestoreLikeClient,
  personId: string,
): Promise<DomainDataProbe> {
  const key = personId.toLowerCase();
  const [profile, signups, dues] = await Promise.all([
    client.getDoc<{ weaponIds?: string[]; equipment?: unknown[]; wpisowePaid?: boolean }>(
      'listaWyjazdowaProfile',
      key,
    ),
    client.listDocs<unknown>('signups'),
    client.listDocs<unknown>('duesAnnual'),
  ]);
  return {
    hasProfileData: Boolean(
      profile &&
        ((profile.weaponIds?.length ?? 0) > 0 ||
          (profile.equipment?.length ?? 0) > 0 ||
          profile.wpisowePaid === true),
    ),
    // Both collections identify the person in the document id (signups: `{eventId}_{personId}`,
    // duesAnnual: `{personId}_{year}`), which is exactly the canonical key - matching on the id
    // keeps this probe independent of any stored field name.
    hasSignups: signups.some((d) => d.id.toLowerCase().endsWith(`_${key}`)),
    hasAnnualDues: dues.some((d) => d.id.toLowerCase().startsWith(`${key}_`)),
  };
}
