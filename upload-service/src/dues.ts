import type { FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

// 'not_applicable' (KRKG follow-up) covers a member the club doesn't require this year's składka
// roczna from at all - most commonly the "Emeryt" category (see server.ts's EMERYT_CATEGORY_ID),
// but also settable by hand for e.g. someone who joined partway through the year. It is a real,
// stored choice like the other two - not a computed absence - so an emeryt who actually does pay
// voluntarily can be flipped straight to 'paid' and stays there.
export type DuesStatus = 'unpaid' | 'paid' | 'not_applicable';

export interface DuesDoc {
  email: string;
  year: number;
  status: DuesStatus;
  updatedBy: string;
  updatedAt: string;
}

export interface DuesWritableFields {
  status?: DuesStatus;
}

// A record written before this status field existed has only the old `paid: boolean` - read-time
// normalization rather than a one-off migration script, since Firestore doesn't enforce a schema
// and old records are read here indefinitely (KRKG's usual convention for this kind of shape
// change, e.g. members.ts's status/approvedAt backfill). Never produces 'not_applicable' on its
// own - a pre-existing record was always either paid or unpaid, and the new status only applies to
// how a record gets its *default* now, not to reinterpreting history.
export function normalizeDuesStatus(raw: { status?: unknown; paid?: unknown }): DuesStatus {
  if (raw.status === 'unpaid' || raw.status === 'paid' || raw.status === 'not_applicable') return raw.status;
  return raw.paid === true ? 'paid' : 'unpaid';
}

// categories' fixed id set is seeded by upload-service/scripts/seed-lookup-lists.ts's slugify -
// "Emeryt" -> "emeryt". A member in this category owes no składka roczna by default (see
// effectiveDuesStatus below); skladki.js duplicates this same id as its own page-local constant
// for the identical client-side default, same convention as e.g. SECTION_ABBR.
export const EMERYT_CATEGORY_ID = 'emeryt';

// The status to show/use when no DuesDoc exists yet for this member+year - an explicit record
// always wins once one exists (including one an emeryt was voluntarily flipped to 'paid' on).
export function effectiveDuesStatus(dues: DuesDoc | null, categoryId: string | null): DuesStatus {
  if (dues) return dues.status;
  return categoryId === EMERYT_CATEGORY_ID ? 'not_applicable' : 'unpaid';
}

// The shared per-year rate note (e.g. "100 zł mężczyźni, 50 zł kobiety"), set once by an
// accountant/admin instead of per member - replaces the old per-member DuesDoc.amount field,
// which forced the same free-text rate to be retyped once per row for what is, in practice, one
// club-wide decision per year. dueDate (KRKG-0080) is a separate, optional deadline for the same
// year - null means "no deadline set", same convention as note: null.
export interface DuesYearFeeDoc {
  year: number;
  note: string | null;
  dueDate: string | null; // YYYY-MM-DD, like EventDoc.startDate
  updatedBy: string;
  updatedAt: string;
}

// Independently optional, preserve-on-omit - same convention as DuesWritableFields.status above
// (a caller sends only the field it wants to change; saveDuesYearFee below leaves the other one
// exactly as it already was). Required for the existing note-only PUT /dues/year-fee call path to
// keep producing a note-only audit `changes` entry (server.test.ts:6690) once dueDate exists.
export interface DuesYearFeeWritableFields {
  note?: string | null;
  dueDate?: string | null;
}

// KRKG-0086: legacy shape, kept only so audit-migration.ts can replay pre-KRKG-0050
// `duesAuditLog` documents into canonical auditEvents. The live write path emits canonical
// events directly, and the legacy `duesAuditLog` collection and its read endpoint were removed.
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
const YEAR_FEE_COLLECTION = 'duesYearFee';

function duesId(email: string, year: number): string {
  return `${email.toLowerCase()}_${year}`;
}

// Raw shape as it may actually be stored - either current (status) or legacy (paid) - normalized
// to the current DuesDoc shape by every read below before it reaches a caller.
type RawDuesDoc = Omit<DuesDoc, 'status'> & { status?: unknown; paid?: unknown };

export async function getDues(client: FirestoreLikeClient, email: string, year: number): Promise<DuesDoc | null> {
  const raw = await client.getDoc<RawDuesDoc>(COLLECTION, duesId(email, year));
  return raw ? { ...raw, status: normalizeDuesStatus(raw) } : null;
}

export async function listDuesForYear(client: FirestoreLikeClient, year: number): Promise<DuesDoc[]> {
  const all = await client.listDocs<RawDuesDoc>(COLLECTION);
  return all
    .map((d) => d.data)
    .filter((d) => d.year === year)
    .map((raw) => ({ ...raw, status: normalizeDuesStatus(raw) }));
}

export async function saveDues(
  client: FirestoreWriteContext,
  email: string,
  year: number,
  fields: DuesWritableFields,
  updatedBy: string,
): Promise<DuesDoc> {
  const id = duesId(email, year);
  const existing = await client.getDoc<RawDuesDoc>(COLLECTION, id);
  const doc: DuesDoc = {
    email: email.toLowerCase(),
    year,
    status: fields.status ?? (existing ? normalizeDuesStatus(existing) : 'unpaid'),
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
  fields: DuesYearFeeWritableFields,
  updatedBy: string,
): Promise<DuesYearFeeDoc> {
  const existing = await client.getDoc<DuesYearFeeDoc>(YEAR_FEE_COLLECTION, String(year));
  const doc: DuesYearFeeDoc = {
    year,
    note: fields.note !== undefined ? fields.note : (existing?.note ?? null),
    dueDate: fields.dueDate !== undefined ? fields.dueDate : (existing?.dueDate ?? null),
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await client.setDoc(YEAR_FEE_COLLECTION, String(year), doc);
  return doc;
}
