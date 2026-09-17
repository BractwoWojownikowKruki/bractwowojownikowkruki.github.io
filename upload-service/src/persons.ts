import { randomUUID } from 'node:crypto';
import { AuthError } from './auth.ts';
import type { FirestoreDoc, FirestoreLikeClient } from './firestore.ts';
import { getMember, type MemberDoc } from './members.ts';

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
const MEMBERS_COLLECTION = 'members';

/**
 * Niewiasta and Bobo never carry a weapon (KRKG-0087 design, section A) - enforced here so every
 * caller (server routes, quick-add) gets the same rule instead of repeating it. Changing a
 * person's category to one of these clears their weapon list.
 */
const NO_WEAPON_CATEGORY_IDS = ['niewiasta', 'bobo'];

export function weaponAllowedForCategory(categoryId: string): boolean {
  return !NO_WEAPON_CATEGORY_IDS.includes(categoryId);
}

/**
 * Runtime validation of the fields the model requires (KRKG-0087 plan, batch 1 step 1): a person
 * always has a category and a section. TypeScript's required properties do not stop a request body
 * from carrying empty strings, so this is checked at runtime, not just in the type.
 *
 * Whether a name is required, and in which combination (ksywka alone vs first+last), is still an
 * open question in the design, so names are deliberately not validated here.
 */
export function validatePersonFields(fields: PersonWritableFields): void {
  if (!fields.categoryId?.trim()) throw new AuthError('Kategoria osoby jest wymagana.', 400);
  if (!fields.sectionId?.trim()) throw new AuthError('Sekcja osoby jest wymagana.', 400);
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

/**
 * The result of keying an incoming value. Deliberately a discriminated union so a caller cannot
 * accidentally treat an account as an accountless person or the other way round.
 *
 * The `account` branch is **not** an existence check: a valid club member may have no
 * `members/{email}` document at all (anyone who never opened "Mój profil"), so treating a missing
 * member document as "not found" would reject real members. Existence for this branch is the
 * caller's live member-allowlist check (the same one the signup route already performs), and that
 * check is what produces a 404 for an unknown value - including an unknown UUID, which lands here
 * because it is not an existing `persons/{value}` document.
 */
export type ResolvedPerson =
  | { kind: 'person'; personId: string; person: PersonDoc }
  | { kind: 'account'; personId: string; linkedPersonId: string | null };

/**
 * The single place that decides what a `personId` is (KRKG-0087 plan, "Kontrakt tożsamości").
 *
 * Deliberately **no format heuristics**: we never inspect the value for an "@". Resolution is a
 * document lookup - an existing `persons/{value}` is an accountless person; anything else is
 * treated as an account key and mapped through `members/{email}.linkedPersonId`, so an e-mail of
 * a linked account still lands on that person's UUID.
 */
export async function resolvePersonId(client: FirestoreLikeClient, value: string): Promise<ResolvedPerson> {
  const person = await getPerson(client, value);
  if (person) return { kind: 'person', personId: person.personId, person };
  const email = value.toLowerCase();
  const member = await getMember(client, email);
  return { kind: 'account', personId: member?.linkedPersonId ?? email, linkedPersonId: member?.linkedPersonId ?? null };
}

export async function createPerson(
  client: FirestoreWriteContext,
  fields: PersonWritableFields,
  ownerPersonId: string | null,
  createdBy: string,
): Promise<PersonDoc> {
  validatePersonFields(fields);
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
  validatePersonFields(fields);
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

export type LinkAccountResult =
  | { ok: true; person: PersonDoc }
  | { ok: false; reason: 'person_not_found' | 'already_linked' | 'account_not_found' | 'account_has_data' };

/**
 * Gives an accountless person an account (KRKG-0087 design, section D). This is the only linking
 * entry point, and it enforces every documented guard itself so no caller can skip one:
 *
 * - the account must have **no domain data** (checked before the transaction - the probe needs a
 *   collection scan, which a Firestore transaction cannot do),
 * - the person's `email` must still be empty (re-read inside the transaction, which is what makes
 *   two concurrent admins safe: the loser sees the value already set and is rejected),
 * - the account's `members/{email}` document must exist, because the reverse mapping has to be
 *   written for the resolver to find the person from the e-mail.
 *
 * Both sides are written in one transaction - `persons/{personId}.email` plus
 * `members/{email}.linkedPersonId` - and attaching an account also clears `ownerPersonId`, since
 * the attachment is exactly what makes someone an "osoba towarzysząca" (a person with an account
 * is never attached). The audit entry is the caller's job, in the same transaction.
 */
export async function linkAccount(
  client: FirestoreLikeClient,
  personId: string,
  accountEmail: string,
  linkedBy: string,
): Promise<LinkAccountResult> {
  const email = accountEmail.toLowerCase();
  if (hasDomainData(await probeAccountDomainData(client, email))) {
    return { ok: false, reason: 'account_has_data' };
  }
  return client.runTransaction(async (tx) => {
    const person = await tx.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
    if (!person) return { ok: false, reason: 'person_not_found' };
    if (person.email) return { ok: false, reason: 'already_linked' };
    const member = await tx.getDoc<MemberDoc>(MEMBERS_COLLECTION, email);
    if (!member) return { ok: false, reason: 'account_not_found' };
    const now = new Date().toISOString();
    const writable = { email, ownerPersonId: null, updatedBy: linkedBy, updatedAt: now };
    await tx.setDoc(PERSONS_COLLECTION, personId, writable);
    await tx.setDoc(MEMBERS_COLLECTION, email, { linkedPersonId: personId, updatedBy: linkedBy, updatedAt: now });
    return { ok: true, person: { ...person, ...writable } };
  });
}
