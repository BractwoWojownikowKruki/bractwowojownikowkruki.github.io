import { randomUUID } from 'node:crypto';
import { AuthError } from './auth.ts';
import type { FirestoreDoc, FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';
import { getMember, type MemberDoc } from './members.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

/**
 * A person who has no account on the site (KRKG-0087). This is not a separate "kind" of person:
 * it is the same person record a member has, minus the account. `personId` is the canonical,
 * opaque key for every domain record (profile, signup, dues, audit); for a member it equals the
 * e-mail, for a person without an account it is a generated UUID. `email` is an optional attribute
 * used only for signing in - it is never the key of domain data.
 *
 * `mergedInto` is the one thing that retires a UUID: when this person is merged with a real
 * account (see `planPersonMerge`/`applyPersonMerge`), it becomes a normal member keyed by the
 * account e-mail and this field records the e-mail it was merged into. A merged person is also
 * tombstoned (`deletedAt`), so it leaves every current list while audit and history still resolve
 * its old UUID through this field.
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
  /** Set only by a merge: the account e-mail this person became. Never cleared. */
  mergedInto?: string | null;
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
const PROFILES_COLLECTION = 'listaWyjazdowaProfile';
const SIGNUPS_COLLECTION = 'signups';
const DUES_COLLECTION = 'duesAnnual';

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
 * open question in the design, so names are deliberately not validated here. Callers that render
 * a person's name must therefore tolerate a missing one (see `personDisplayName`).
 */
export function validatePersonFields(fields: PersonWritableFields): void {
  if (!fields.categoryId?.trim()) throw new AuthError('Kategoria osoby jest wymagana.', 400);
  if (!fields.sectionId?.trim()) throw new AuthError('Sekcja osoby jest wymagana.', 400);
}

/** Applies the category/weapon rule to a writable field set. */
export function applyWeaponCategoryRule(fields: PersonWritableFields): PersonWritableFields {
  return weaponAllowedForCategory(fields.categoryId) ? fields : { ...fields, weaponIds: [] };
}

/**
 * The name to display for a person whose record may carry no names at all - quick-add creates a
 * person with only a ksywka, category and section, and names are filled in later on the profile.
 * Kept here so the roster and every future read share one tolerant implementation instead of
 * each calling `.trim()` on a possibly-absent field.
 */
export function personDisplayName(person: Pick<PersonDoc, 'firstName' | 'lastName'>): string | null {
  const parts = [person.firstName, person.lastName].filter((part) => (part ?? '').trim());
  const name = parts.join(' ').trim();
  return name || null;
}

export async function getPerson(client: FirestoreLikeClient, personId: string): Promise<PersonDoc | null> {
  return client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
}

/**
 * Every person without an account. Tombstoned people (deleted or merged) are excluded by default:
 * current lists (roster without an eventId, pickers, dropdowns) must not show them. Pass
 * `includeDeleted` for historical reads, which resolve a person that has been removed.
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
  | { kind: 'account'; personId: string };

/**
 * The single place that decides what a `personId` is (KRKG-0087 plan, "Kontrakt tożsamości").
 *
 * Deliberately **no format heuristics**: we never inspect the value for an "@". Resolution is a
 * document lookup - an existing `persons/{value}` is an accountless person; anything else is
 * treated as an account key. A **merged** person resolves to the account e-mail it became, so a
 * historical reference to the retired UUID still lands on the live member.
 */
export async function resolvePersonId(client: FirestoreLikeClient, value: string): Promise<ResolvedPerson> {
  const person = await getPerson(client, value);
  if (person) {
    if (person.mergedInto) return { kind: 'account', personId: person.mergedInto };
    return { kind: 'person', personId: person.personId, person };
  }
  return { kind: 'account', personId: value.toLowerCase() };
}

/**
 * Creates an accountless person. `personId` is normally generated here, but a caller that must
 * know the id before the write - e.g. to name the audit resource key in the same transaction -
 * may pass one in.
 */
export async function createPerson(
  client: FirestoreWriteContext,
  fields: PersonWritableFields,
  ownerPersonId: string | null,
  createdBy: string,
  personId: string = randomUUID(),
): Promise<PersonDoc> {
  validatePersonFields(fields);
  const now = new Date().toISOString();
  const normalized = applyWeaponCategoryRule(fields);
  const doc: PersonDoc = {
    personId,
    ...normalized,
    ownerPersonId,
    email: null,
    deletedAt: null,
    mergedInto: null,
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

/** Tombstone: the record stays resolvable for history and audit, but leaves every current list.
 * KRKG-0091: it is also detached from its owner, so a deactivated companion no longer belongs to
 * anyone (and cannot be added to a trip from the owner's row). */
export async function softDeletePerson(
  client: FirestoreWriteContext,
  personId: string,
  deletedBy: string,
): Promise<PersonDoc | null> {
  const existing = await client.getDoc<PersonDoc>(PERSONS_COLLECTION, personId);
  if (!existing) return null;
  const writable = { deletedAt: new Date().toISOString(), deletedBy, ownerPersonId: null };
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

// ---------------------------------------------------------------------------------------------
// Merging an accountless person into a real account (KRKG-0087 design, "Scalenie konta").
//
// The scenario: Jan existed as Maria's osoba towarzysząca, then registered his own account.
// The admin merges the two, and Jan becomes a normal member keyed by his account e-mail - there
// is never a state with a live "member" and a live "person" for the same human.
//
// The merge is split in two so the caller can run the writes inside its own audited transaction:
//
//   planPersonMerge(client, ...)  - reads everything outside a transaction (Firestore
//                                   transactions cannot scan collections) and returns the moves.
//   applyPersonMerge(tx, plan, ..) - performs them inside the transaction, re-checking the
//                                   person is still mergeable and letting the account win every
//                                   conflict (the account's own document is never overwritten by
//                                   the person's; the person only fills blanks and moves docs).
//
// `mergePersonIntoAccount` is the convenience wrapper for callers that do not need a custom
// transaction (tests, scripts).
// ---------------------------------------------------------------------------------------------

/** The profile fields the merge combines. Mirrors listaWyjazdowaProfile's shape without importing it. */
interface PersonMergeProfile {
  weaponIds: string[];
  equipment: Array<{ id: string; name: string; description: string }>;
  wpisowePaid: boolean;
}

/** One document that moves from the person's key to the account's key. */
export interface PersonMergeDocMove {
  collection: typeof SIGNUPS_COLLECTION | typeof DUES_COLLECTION;
  fromId: string;
  toId: string;
  /** The identity field rewritten to the account key on the moved document. */
  keyField: 'memberEmail' | 'email';
  data: Record<string, unknown>;
}

/** The member identity fields a merge may fill from the person; a value the account already has wins. */
export type MemberIdentityFills = Partial<Pick<MemberDoc, 'fullName' | 'nickname' | 'sectionId' | 'categoryId'>>;

export interface PersonMergePlan {
  personId: string;
  accountEmail: string;
  /**
   * Documents to move, computed from a collection scan (which a transaction cannot do). Everything
   * else - which identity fields are still blank and what the merged profile should contain - is
   * deliberately NOT baked in here: `applyPersonMerge` recomputes it inside the transaction, so a
   * retry or a concurrent account edit can never let the person overwrite a newer account value.
   */
  moves: PersonMergeDocMove[];
}

export type PersonMergeReason = 'person_not_found' | 'person_already_merged' | 'account_not_found';

export type PersonMergePlanResult = { ok: true; plan: PersonMergePlan } | { ok: false; reason: PersonMergeReason };

export interface PersonMergeOutcome {
  personId: string;
  accountEmail: string;
  /** The person's display label at merge time, for the audit resource (ksywka, else the personId). */
  personDisplay: string;
  /** The person's owner before the merge, so the audit can record the change (it becomes null). */
  previousOwnerPersonId: string | null;
  /** Document ids written at the account key. */
  movedSignups: string[];
  movedDues: string[];
  /** Document ids deleted because the account already had its own (the account wins). */
  droppedSignups: string[];
  droppedDues: string[];
  profileWritten: boolean;
  /** Names of the member identity fields the person filled in. */
  memberFilled: string[];
}

export type PersonMergeApplyResult =
  | { ok: true; outcome: PersonMergeOutcome; person: PersonDoc }
  | { ok: false; reason: PersonMergeReason };

function isBlank(value: string | null | undefined): boolean {
  return !value || !value.trim();
}

/**
 * Reads the current state and works out which documents a merge would move. It only plans the
 * collection scan (signups, annual dues), which a transaction cannot do; the identity/profile
 * decisions are made by `applyPersonMerge` against the state at commit time. Errors are values, not
 * exceptions, so a caller can turn `person_not_found` into its own 404 without catching.
 */
export async function planPersonMerge(
  client: FirestoreLikeClient,
  personId: string,
  accountEmail: string,
): Promise<PersonMergePlanResult> {
  const email = accountEmail.toLowerCase();
  const person = await getPerson(client, personId);
  if (!person) return { ok: false, reason: 'person_not_found' };
  if (person.mergedInto) return { ok: false, reason: 'person_already_merged' };

  const member = await getMember(client, email);
  if (!member) return { ok: false, reason: 'account_not_found' };

  const personKey = person.personId.toLowerCase();
  const [signups, dues] = await Promise.all([
    client.listDocs<Record<string, unknown>>(SIGNUPS_COLLECTION),
    client.listDocs<Record<string, unknown>>(DUES_COLLECTION),
  ]);

  const moves: PersonMergeDocMove[] = [];
  for (const doc of signups) {
    if (!doc.id.toLowerCase().endsWith(`_${personKey}`)) continue;
    const eventId = String(doc.data.eventId ?? doc.id.slice(0, doc.id.length - personKey.length - 1));
    moves.push({ collection: SIGNUPS_COLLECTION, fromId: doc.id, toId: `${eventId}_${email}`, keyField: 'memberEmail', data: doc.data });
  }
  for (const doc of dues) {
    if (!doc.id.toLowerCase().startsWith(`${personKey}_`)) continue;
    const year = doc.id.slice(personKey.length + 1);
    moves.push({ collection: DUES_COLLECTION, fromId: doc.id, toId: `${email}_${year}`, keyField: 'email', data: doc.data });
  }

  return { ok: true, plan: { personId: person.personId, accountEmail: email, moves } };
}

/**
 * Performs a planned merge inside the given transaction. Re-reads the person, the account and both
 * profiles so every decision is made against the state at commit time - a concurrent merge cannot
 * double-apply (the loser sees `mergedInto` already set and is rejected), and a retry or a
 * concurrent account edit cannot be overwritten by the person. Every conflict is resolved in the
 * account's favour: a document that already exists at the account key wins and the person's copy is
 * deleted, and the account's own identity/profile values are never replaced by the person's.
 */
export async function applyPersonMerge(
  tx: FirestoreTransaction,
  plan: PersonMergePlan,
  mergedBy: string,
): Promise<PersonMergeApplyResult> {
  const person = await tx.getDoc<PersonDoc>(PERSONS_COLLECTION, plan.personId);
  if (!person) return { ok: false, reason: 'person_not_found' };
  if (person.mergedInto) return { ok: false, reason: 'person_already_merged' };
  const member = await tx.getDoc<MemberDoc>(MEMBERS_COLLECTION, plan.accountEmail);
  if (!member) return { ok: false, reason: 'account_not_found' };

  const now = new Date().toISOString();
  const outcome: PersonMergeOutcome = {
    personId: plan.personId,
    accountEmail: plan.accountEmail,
    personDisplay: person.ksywka || person.personId,
    previousOwnerPersonId: person.ownerPersonId ?? null,
    movedSignups: [],
    movedDues: [],
    droppedSignups: [],
    droppedDues: [],
    profileWritten: false,
    memberFilled: [],
  };

  for (const move of plan.moves) {
    const target = await tx.getDoc<Record<string, unknown>>(move.collection, move.toId);
    if (target) {
      await tx.deleteDoc(move.collection, move.fromId);
      (move.collection === SIGNUPS_COLLECTION ? outcome.droppedSignups : outcome.droppedDues).push(move.fromId);
      continue;
    }
    await tx.setDoc(move.collection, move.toId, { ...move.data, [move.keyField]: plan.accountEmail });
    await tx.deleteDoc(move.collection, move.fromId);
    (move.collection === SIGNUPS_COLLECTION ? outcome.movedSignups : outcome.movedDues).push(move.toId);
  }

  // Identity and profile decisions are recomputed here, inside the transaction, from the documents
  // as they are right now - never from the pre-transaction plan. A retry (Firestore may re-run the
  // callback after contention) or a concurrent account edit must never let the person overwrite a
  // newer account value, so "the account wins" has to be decided against the current state.
  const memberFills: MemberIdentityFills = {};
  const personName = personDisplayName(person);
  if (isBlank(member.fullName) && personName) memberFills.fullName = personName;
  if (isBlank(member.nickname) && person.ksywka?.trim()) memberFills.nickname = person.ksywka;
  if (isBlank(member.sectionId) && person.sectionId?.trim()) memberFills.sectionId = person.sectionId;
  if (member.categoryId == null && person.categoryId) memberFills.categoryId = person.categoryId;

  const personProfileKey = plan.personId.toLowerCase();
  const personProfile = await tx.getDoc<PersonMergeProfile>(PROFILES_COLLECTION, personProfileKey);
  const accountProfile = await tx.getDoc<PersonMergeProfile>(PROFILES_COLLECTION, plan.accountEmail);
  let mergedProfile: PersonMergeProfile | null = null;
  if (accountProfile || personProfile) {
    // The account wins wherever it has a value; the person only supplies what the account lacks.
    mergedProfile = {
      weaponIds: accountProfile?.weaponIds?.length ? accountProfile.weaponIds : (person.weaponIds ?? []),
      equipment: accountProfile?.equipment?.length ? accountProfile.equipment : (personProfile?.equipment ?? []),
      wpisowePaid: accountProfile ? accountProfile.wpisowePaid : (personProfile?.wpisowePaid ?? false),
    };
  }
  if (mergedProfile) {
    await tx.setDoc(PROFILES_COLLECTION, plan.accountEmail, { ...mergedProfile, updatedBy: mergedBy, updatedAt: now });
    outcome.profileWritten = true;
  }
  if (personProfile) {
    await tx.deleteDoc(PROFILES_COLLECTION, personProfileKey);
  }

  if (Object.keys(memberFills).length > 0) {
    await tx.setDoc(MEMBERS_COLLECTION, plan.accountEmail, { ...memberFills, updatedBy: mergedBy, updatedAt: now });
    outcome.memberFilled = Object.keys(memberFills);
  }

  const writable = {
    mergedInto: plan.accountEmail,
    ownerPersonId: null,
    deletedAt: now,
    deletedBy: mergedBy,
    updatedBy: mergedBy,
    updatedAt: now,
  };
  await tx.setDoc(PERSONS_COLLECTION, plan.personId, writable);
  return { ok: true, outcome, person: { ...person, ...writable } };
}

/**
 * Convenience wrapper for callers that do not need to write the audit entry in the same
 * transaction (tests, scripts). The server route uses `planPersonMerge` + `applyPersonMerge`
 * directly so its audit event commits atomically with the merge.
 */
export async function mergePersonIntoAccount(
  client: FirestoreLikeClient,
  personId: string,
  accountEmail: string,
  mergedBy: string,
): Promise<PersonMergeApplyResult> {
  const planned = await planPersonMerge(client, personId, accountEmail);
  if (!planned.ok) return planned;
  return client.runTransaction((tx) => applyPersonMerge(tx, planned.plan, mergedBy));
}
