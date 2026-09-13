import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

export interface DuesDoc {
  email: string;
  year: number;
  paid: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface DuesWritableFields {
  paid?: boolean;
}

// The shared per-year rate note (e.g. "100 zł mężczyźni, 50 zł kobiety"), set once by an
// accountant/admin instead of per member - replaces the old per-member DuesDoc.amount field,
// which forced the same free-text rate to be retyped once per row for what is, in practice, one
// club-wide decision per year.
export interface DuesYearFeeDoc {
  year: number;
  note: string | null;
  updatedBy: string;
  updatedAt: string;
}

// A separate, member/event-scoped-but-not-event-owned log for the three money writes that don't
// fit signups.ts's event-scoped signupAuditLog: Wpisowe and Składka roczna aren't tied to any
// event at all, and an event's skladkaFee change isn't "whose signup changed" (signupAuditLog's
// targetMemberEmail would have no honest value to hold). context distinguishes which of the three
// this entry is; the fields that don't apply to a given context are simply null rather than
// omitted, so every entry has the same shape regardless of context.
export interface DuesAuditEntry {
  context: 'wpisowe' | 'roczna' | 'eventFee';
  targetMemberEmail: string | null; // set for wpisowe/roczna, null for eventFee
  eventId: string | null; // set only for eventFee
  eventName: string | null; // denormalized at write time so the audit page never needs an extra join
  year: number | null; // set only for roczna
  changedBy: string;
  changedAt: string;
  changeSummary: string;
}

const COLLECTION = 'duesAnnual';
const AUDIT_COLLECTION = 'duesAuditLog';
const YEAR_FEE_COLLECTION = 'duesYearFee';

function duesId(email: string, year: number): string {
  return `${email.toLowerCase()}_${year}`;
}

export async function getDues(client: FirestoreLikeClient, email: string, year: number): Promise<DuesDoc | null> {
  return client.getDoc<DuesDoc>(COLLECTION, duesId(email, year));
}

export async function listDuesForYear(client: FirestoreLikeClient, year: number): Promise<DuesDoc[]> {
  const all = await client.listDocs<DuesDoc>(COLLECTION);
  return all.map((d) => d.data).filter((d) => d.year === year);
}

export async function saveDues(
  client: FirestoreWriteContext,
  email: string,
  year: number,
  fields: DuesWritableFields,
  updatedBy: string,
): Promise<DuesDoc> {
  const id = duesId(email, year);
  const existing = await client.getDoc<DuesDoc>(COLLECTION, id);
  const doc: DuesDoc = {
    email: email.toLowerCase(),
    year,
    paid: fields.paid ?? existing?.paid ?? false,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await client.setDoc(COLLECTION, id, doc);
  return doc;
}

export async function getDuesYearFee(client: FirestoreLikeClient, year: number): Promise<DuesYearFeeDoc | null> {
  return client.getDoc<DuesYearFeeDoc>(YEAR_FEE_COLLECTION, String(year));
}

export async function saveDuesYearFee(
  client: FirestoreWriteContext,
  year: number,
  note: string | null,
  updatedBy: string,
): Promise<DuesYearFeeDoc> {
  const doc: DuesYearFeeDoc = { year, note, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(YEAR_FEE_COLLECTION, String(year), doc);
  return doc;
}

export async function appendDuesAuditEntry(
  client: FirestoreLikeClient,
  entry: Omit<DuesAuditEntry, 'changedAt'>,
): Promise<void> {
  const id = randomUUID();
  const full: DuesAuditEntry = { ...entry, changedAt: new Date().toISOString() };
  await client.setDoc(AUDIT_COLLECTION, id, full);
}

export async function listDuesAuditLog(client: FirestoreLikeClient): Promise<DuesAuditEntry[]> {
  const all = await client.listDocs<DuesAuditEntry>(AUDIT_COLLECTION);
  return all.map((d) => d.data).sort((a, b) => a.changedAt.localeCompare(b.changedAt));
}
