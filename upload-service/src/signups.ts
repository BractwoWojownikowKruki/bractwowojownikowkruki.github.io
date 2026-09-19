import type { FirestoreDoc, FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

/**
 * A member's status and selections for one event, including separate timestamps for general
 * document edits and actual attending-status changes so the roster can show the latter reliably.
 *
 * The legacy `companionIds` field lived here until KRKG-0087 - companions are now real person
 * records with their own signups (`persons.ts`), so an event signup no longer references anybody
 * else's companion list.
 */
export interface SignupDoc {
  eventId: string;
  memberEmail: string;
  attending: boolean;
  skladkaPaid: boolean;
  lastChangedBy: string;
  lastChangedAt: string;
  /** Time of the last actual attending-status change; absent on legacy documents. */
  statusChangedAt?: string;
}

export interface SignupWritableFields {
  attending: boolean;
}

export interface AuditLogEntry {
  eventId: string;
  targetMemberEmail: string;
  changedBy: string;
  changedAt: string;
  changeSummary: string;
}

const SIGNUPS_COLLECTION = 'signups';

function signupId(eventId: string, email: string): string {
  return `${eventId}_${email.toLowerCase()}`;
}

export async function listAllSignups(client: FirestoreLikeClient): Promise<FirestoreDoc<SignupDoc>[]> {
  return client.listDocs<SignupDoc>(SIGNUPS_COLLECTION);
}

export async function listSignupsForEvent(client: FirestoreLikeClient, eventId: string): Promise<SignupDoc[]> {
  const all = await listAllSignups(client);
  return all.filter((d) => d.data.eventId === eventId).map((d) => d.data);
}

export async function getSignup(client: FirestoreLikeClient, eventId: string, email: string): Promise<SignupDoc | null> {
  return client.getDoc<SignupDoc>(SIGNUPS_COLLECTION, signupId(eventId, email));
}

export async function saveSignup(
  client: FirestoreWriteContext,
  eventId: string,
  email: string,
  fields: SignupWritableFields,
  changedBy: string,
): Promise<SignupDoc> {
  const id = signupId(eventId, email);
  const existing = await client.getDoc<SignupDoc>(SIGNUPS_COLLECTION, id);
  const now = new Date().toISOString();
  const statusChanged = !existing || existing.attending !== fields.attending;
  const writable = {
    eventId,
    memberEmail: email.toLowerCase(),
    attending: fields.attending,
    lastChangedBy: changedBy,
    lastChangedAt: now,
    ...(statusChanged ? { statusChangedAt: now } : {}),
  };
  if (!existing) {
    // First signup for this (event, member) pair - skladkaPaid doesn't exist yet, set its default.
    const doc: SignupDoc = { ...writable, skladkaPaid: false };
    await client.setDoc(SIGNUPS_COLLECTION, id, doc);
    return doc;
  }
  // Existing signup: write only the writable subset via merge - skladkaPaid is never in this
  // write, so it survives untouched regardless of what it currently is (same pattern as
  // saveMember/saveProfile post-Plan-A-fix-wave: an update-write can only touch fields it names).
  await client.setDoc(SIGNUPS_COLLECTION, id, writable);
  return { ...existing, ...writable };
}

export async function setSkladkaPaid(
  client: FirestoreWriteContext,
  eventId: string,
  email: string,
  paid: boolean,
  changedBy: string,
): Promise<SignupDoc | null> {
  const id = signupId(eventId, email);
  const existing = await client.getDoc<SignupDoc>(SIGNUPS_COLLECTION, id);
  if (!existing) return null;
  const writable = { skladkaPaid: paid, lastChangedBy: changedBy, lastChangedAt: new Date().toISOString() };
  await client.setDoc(SIGNUPS_COLLECTION, id, writable);
  return { ...existing, ...writable };
}
