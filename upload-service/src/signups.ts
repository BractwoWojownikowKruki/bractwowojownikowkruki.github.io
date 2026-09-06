import { randomUUID } from 'node:crypto';
import type { FirestoreDoc, FirestoreLikeClient } from './firestore.ts';

export interface SignupDoc {
  eventId: string;
  memberEmail: string;
  attending: boolean;
  equipmentIds: string[];
  companionIds: string[];
  skladkaPaid: boolean;
  lastChangedBy: string;
  lastChangedAt: string;
}

export interface SignupWritableFields {
  attending: boolean;
  equipmentIds: string[];
  companionIds: string[];
}

export interface AuditLogEntry {
  eventId: string;
  targetMemberEmail: string;
  changedBy: string;
  changedAt: string;
  changeSummary: string;
}

const SIGNUPS_COLLECTION = 'signups';
const AUDIT_COLLECTION = 'signupAuditLog';

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
  client: FirestoreLikeClient,
  eventId: string,
  email: string,
  fields: SignupWritableFields,
  changedBy: string,
): Promise<SignupDoc> {
  const id = signupId(eventId, email);
  const existing = await client.getDoc<SignupDoc>(SIGNUPS_COLLECTION, id);
  const writable = {
    eventId,
    memberEmail: email.toLowerCase(),
    attending: fields.attending,
    equipmentIds: fields.equipmentIds,
    companionIds: fields.companionIds,
    lastChangedBy: changedBy,
    lastChangedAt: new Date().toISOString(),
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
  client: FirestoreLikeClient,
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

export async function appendAuditLogEntry(client: FirestoreLikeClient, entry: Omit<AuditLogEntry, 'changedAt'>): Promise<void> {
  const id = randomUUID();
  const full: AuditLogEntry = { ...entry, changedAt: new Date().toISOString() };
  await client.setDoc(AUDIT_COLLECTION, id, full);
}

export async function listAuditLogForEvent(client: FirestoreLikeClient, eventId: string): Promise<AuditLogEntry[]> {
  const all = await client.listDocs<AuditLogEntry>(AUDIT_COLLECTION);
  return all
    .map((d) => d.data)
    .filter((entry) => entry.eventId === eventId)
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
}
