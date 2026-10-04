import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';

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
  if (isDuesStatus(raw.status)) return raw.status;
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

export function isDuesStatus(value: unknown): value is DuesStatus {
  return value === 'unpaid' || value === 'paid' || value === 'not_applicable';
}

// Wpisowe and a trip's per-person składka use the same three states as składka roczna. Both were
// plain booleans before (wpisowePaid on listaWyjazdowaProfile, skladkaPaid on signups), so their
// records are read-time normalized like normalizeDuesStatus above: the new *Status field wins,
// otherwise the legacy boolean `true` means paid. The legacy `false` was also written as a mere
// default on document creation, so it is not an explicit choice and the default below applies.
// "Bobo" (children) owe no wpisowe by default - same "explicit record wins" rule as emeryt above.
export const BOBO_CATEGORY_ID = 'bobo';

export function effectiveWpisoweStatus(
  profile: { wpisoweStatus?: unknown; wpisowePaid?: unknown } | null | undefined,
  categoryId: string | null,
): DuesStatus {
  if (profile && isDuesStatus(profile.wpisoweStatus)) return profile.wpisoweStatus;
  if (profile?.wpisowePaid === true) return 'paid';
  return categoryId === BOBO_CATEGORY_ID ? 'not_applicable' : 'unpaid';
}

// A trip's składka has no category default - everyone starts unpaid.
export function normalizeSkladkaStatus(signup: { skladkaStatus?: unknown; skladkaPaid?: unknown }): DuesStatus {
  if (isDuesStatus(signup.skladkaStatus)) return signup.skladkaStatus;
  return signup.skladkaPaid === true ? 'paid' : 'unpaid';
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

// ---------------------------------------------------------------------------------------------
// Charges (składki as a list): the Składki page shows one button per charge. Three kinds exist:
//  - Wpisowe: built in, not stored here (see effectiveWpisoweStatus above).
//  - 'annual' (składka roczna): one per year. Its rate note and deadline stay in duesYearFee and
//    its per-person statuses in duesAnnual, exactly as before; the `duesCharges` document only
//    records that the year was created on purpose. A year that already has year-fee or status
//    data counts as existing without one (listAnnualYears), so nothing recorded earlier vanishes.
//  - 'extra' (składka dodatkowa): created by any member, who then manages its statuses.
//    Per-person statuses live in `duesExtraStatus`; a person without a record is 'not_applicable'.
// ---------------------------------------------------------------------------------------------

export type DuesChargeKind = 'annual' | 'extra';

export interface DuesChargeDoc {
  id: string;
  kind: DuesChargeKind;
  year: number | null; // annual only
  name: string; // annual: String(year)
  amount: string | null; // extra only - free text, like the annual rate note
  description: string | null; // extra only
  dueDate: string | null; // extra only, YYYY-MM-DD
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ExtraChargeWritableFields {
  name?: string;
  amount?: string | null;
  description?: string | null;
  dueDate?: string | null;
}

export interface ExtraStatusDoc {
  chargeId: string;
  personId: string;
  status: DuesStatus;
  updatedBy: string;
  updatedAt: string;
}

const CHARGES_COLLECTION = 'duesCharges';
const EXTRA_STATUS_COLLECTION = 'duesExtraStatus';
const PAYMENT_INFO_COLLECTION = 'duesPaymentInfo';
const PAYMENT_INFO_ID = 'current';

export function annualChargeId(year: number): string {
  return `annual-${year}`;
}

export function extraStatusId(chargeId: string, personId: string): string {
  return `${chargeId}_${personId.toLowerCase()}`;
}

export function newAnnualChargeDoc(year: number, createdBy: string): DuesChargeDoc {
  const now = new Date().toISOString();
  return {
    id: annualChargeId(year),
    kind: 'annual',
    year,
    name: String(year),
    amount: null,
    description: null,
    dueDate: null,
    createdBy,
    createdAt: now,
    updatedBy: createdBy,
    updatedAt: now,
  };
}

export function newExtraChargeDoc(id: string, fields: Required<ExtraChargeWritableFields>, createdBy: string): DuesChargeDoc {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'extra',
    year: null,
    name: fields.name,
    amount: fields.amount,
    description: fields.description,
    dueDate: fields.dueDate,
    createdBy,
    createdAt: now,
    updatedBy: createdBy,
    updatedAt: now,
  };
}

export function applyExtraChargeFields(existing: DuesChargeDoc, fields: ExtraChargeWritableFields, updatedBy: string): DuesChargeDoc {
  return {
    ...existing,
    name: fields.name !== undefined ? fields.name : existing.name,
    amount: fields.amount !== undefined ? fields.amount : existing.amount,
    description: fields.description !== undefined ? fields.description : existing.description,
    dueDate: fields.dueDate !== undefined ? fields.dueDate : existing.dueDate,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
}

export async function getCharge(client: Pick<FirestoreLikeClient, 'getDoc'> | FirestoreWriteContext, id: string): Promise<DuesChargeDoc | null> {
  return client.getDoc<DuesChargeDoc>(CHARGES_COLLECTION, id);
}

export async function saveCharge(client: FirestoreWriteContext, doc: DuesChargeDoc): Promise<DuesChargeDoc> {
  await client.setDoc(CHARGES_COLLECTION, doc.id, doc);
  return doc;
}

export async function listExtraCharges(client: FirestoreLikeClient): Promise<DuesChargeDoc[]> {
  const all = await client.listDocs<DuesChargeDoc>(CHARGES_COLLECTION);
  return all.map((d) => d.data).filter((d) => d.kind === 'extra');
}

// Every year that exists as a składka roczna: created explicitly, or already carrying a year-fee
// note or any person's status from before years had to be created by hand.
export async function listAnnualYears(client: FirestoreLikeClient): Promise<number[]> {
  const [charges, yearFees, statuses] = await Promise.all([
    client.listDocs<DuesChargeDoc>(CHARGES_COLLECTION),
    client.listDocs<{ year?: unknown }>(YEAR_FEE_COLLECTION),
    client.listDocs<{ year?: unknown }>(COLLECTION),
  ]);
  const years = new Set<number>();
  for (const { data } of charges) if (data.kind === 'annual' && typeof data.year === 'number') years.add(data.year);
  for (const { data } of yearFees) if (typeof data.year === 'number') years.add(data.year);
  for (const { data } of statuses) if (typeof data.year === 'number') years.add(data.year);
  return [...years].sort((a, b) => a - b);
}

export async function listExtraStatuses(client: FirestoreLikeClient, chargeId: string): Promise<ExtraStatusDoc[]> {
  const all = await client.listDocs<ExtraStatusDoc>(EXTRA_STATUS_COLLECTION);
  return all.map((d) => d.data).filter((d) => d.chargeId === chargeId && isDuesStatus(d.status));
}

export async function getExtraStatus(
  client: FirestoreWriteContext,
  chargeId: string,
  personId: string,
): Promise<DuesStatus> {
  const doc = await client.getDoc<ExtraStatusDoc>(EXTRA_STATUS_COLLECTION, extraStatusId(chargeId, personId));
  return doc && isDuesStatus(doc.status) ? doc.status : 'not_applicable';
}

export async function saveExtraStatus(
  client: FirestoreWriteContext,
  chargeId: string,
  personId: string,
  status: DuesStatus,
  updatedBy: string,
): Promise<ExtraStatusDoc> {
  const doc: ExtraStatusDoc = { chargeId, personId: personId.toLowerCase(), status, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(EXTRA_STATUS_COLLECTION, extraStatusId(chargeId, personId), doc);
  return doc;
}

// Takes the statuses read just before the transaction (a transaction cannot list a collection).
export async function deleteExtraCharge(
  tx: Pick<FirestoreTransaction, 'deleteDoc'>,
  chargeId: string,
  statuses: readonly ExtraStatusDoc[],
): Promise<void> {
  for (const status of statuses) await tx.deleteDoc(EXTRA_STATUS_COLLECTION, extraStatusId(chargeId, status.personId));
  await tx.deleteDoc(CHARGES_COLLECTION, chargeId);
}

// "Jak płacić": one club-wide free-text block (account number, BLIK, ...) shown at the top of the
// Składki page. Whitespace and line breaks are stored exactly as typed.
export interface DuesPaymentInfoDoc {
  text: string;
  updatedBy: string;
  updatedAt: string;
}

export async function getPaymentInfo(client: Pick<FirestoreLikeClient, 'getDoc'> | FirestoreWriteContext): Promise<DuesPaymentInfoDoc | null> {
  return client.getDoc<DuesPaymentInfoDoc>(PAYMENT_INFO_COLLECTION, PAYMENT_INFO_ID);
}

export async function savePaymentInfo(client: FirestoreWriteContext, text: string, updatedBy: string): Promise<DuesPaymentInfoDoc> {
  const doc: DuesPaymentInfoDoc = { text, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(PAYMENT_INFO_COLLECTION, PAYMENT_INFO_ID, doc);
  return doc;
}
