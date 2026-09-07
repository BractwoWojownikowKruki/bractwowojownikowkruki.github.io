import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

export interface DuesDoc {
  email: string;
  year: number;
  paid: boolean;
  // Free-text like events.ts's skladkaFee (e.g. "100 zł") rather than a number - the roster
  // covers members with different rates (see KRKG-0047 design discussion), so a single numeric
  // type would not have captured the reasoning behind a given amount. null means "not set yet".
  amount: string | null;
  updatedBy: string;
  updatedAt: string;
}

// paid/amount are independently settable (KRKG-0047, mirrors EventWritableFields'
// name/startDate/status/skladkaFee split in events.ts) - a caller sends only the field it wants
// to change, and saveDues below leaves the other one exactly as it already was.
export interface DuesWritableFields {
  paid?: boolean;
  amount?: string | null;
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
  client: FirestoreLikeClient,
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
    amount: fields.amount !== undefined ? fields.amount : (existing?.amount ?? null),
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await client.setDoc(COLLECTION, id, doc);
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
