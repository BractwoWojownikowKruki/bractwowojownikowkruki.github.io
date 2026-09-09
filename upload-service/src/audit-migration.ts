import { createHash } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';
import { createCanonicalAuditEvent, type CanonicalAuditEvent, type CanonicalAuditEventInput } from './audit.ts';
import type { RoleAuditEntry } from './roles.ts';
import type { DuesAuditEntry } from './dues.ts';
import type { AuditLogEntry as SignupAuditLogEntry } from './signups.ts';

/**
 * KRKG-0050 batch 4/6: migration from the three legacy per-feature audit-log collections
 * (`rolesAuditLog`, `signupAuditLog`, `duesAuditLog`) into the canonical `auditEvents` collection.
 * Batch 6 runs this against production; this batch only builds and unit-tests it (dry-run mode
 * only - see plan-addendum-2.md's "Batch and legacy sequencing").
 *
 * Every legacy write in this codebase already stores one log entry per Firestore document (see
 * roles.ts/dues.ts/signups.ts's `append*AuditEntry` - always `client.setDoc(collection,
 * randomUUID(), entry)`), so "one legacy document to one expected event" holds structurally
 * today. The preflight below still checks it explicitly rather than assuming it, because the
 * contract (implementation-contract.md "PWA, migration, and capacity") requires aborting on a
 * multi-entry or unparseable document even if none exists yet - a defensive check against a
 * shape this migration was never designed for, not a check the current data is expected to fail.
 */

export type LegacyCollection = 'rolesAuditLog' | 'signupAuditLog' | 'duesAuditLog';

export const LEGACY_COLLECTIONS: readonly LegacyCollection[] = ['rolesAuditLog', 'signupAuditLog', 'duesAuditLog'];

export interface LegacySourceDoc {
  collection: LegacyCollection;
  documentId: string;
  data: unknown;
}

/**
 * The outcome of parsing one legacy document. `ok` carries exactly the one
 * `CanonicalAuditEventInput` (plus the historical timestamp/id the live write path doesn't
 * otherwise have a way to express) this document maps to; `unparseable`/`multi_event` are abort
 * conditions the preflight surfaces to an operator rather than silently dropping or guessing.
 */
export type LegacyParseResult =
  | { status: 'ok'; input: CanonicalAuditEventInput; timestamp: string }
  | { status: 'unparseable'; reason: string }
  | { status: 'multi_event'; reason: string };

/** Deterministic `(collection, documentId)` source identity → the target `auditEvents` id.
 * Same source always maps to the same target id, which is what makes the migration idempotent
 * (create-if-absent) and repeat-safe. */
export function migratedEventId(collection: LegacyCollection, documentId: string): string {
  return `migrated:${collection}:${documentId}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rolesLabel(roles: unknown): string {
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string').join(',') : '';
}

/** `rolesAuditLog` → `role.granted` / `role.revoked` / `role.replaced`. The legacy entry only
 * stored full before/after role arrays, not which single role changed, so the specific action is
 * inferred from the set-size delta - documented as a migration-time judgment call, not a live
 * write-path rule. A same-size change (e.g. one role swapped for another) is `role.replaced`. */
function parseRoleAuditEntry(doc: LegacySourceDoc): LegacyParseResult {
  const data = doc.data;
  if (!isRecord(data) || typeof data.targetEmail !== 'string' || !Array.isArray(data.previousRoles) || !Array.isArray(data.newRoles) || typeof data.changedBy !== 'string' || typeof data.changedAt !== 'string') {
    return { status: 'unparseable', reason: 'rolesAuditLog document is missing a required field.' };
  }
  const previousRoles = data.previousRoles as string[];
  const newRoles = data.newRoles as string[];
  const action = newRoles.length > previousRoles.length ? 'role.granted' : newRoles.length < previousRoles.length ? 'role.revoked' : 'role.replaced';
  return {
    status: 'ok',
    timestamp: data.changedAt,
    input: {
      action,
      actor: { email: data.changedBy },
      resource: { kind: 'member', key: `member:${data.targetEmail}`, display: data.targetEmail },
      changes: [
        { field: 'roles', before: rolesLabel(previousRoles), after: rolesLabel(newRoles) },
        { field: 'targetEmail', after: data.targetEmail },
      ],
    },
  };
}

// Historical strings the pre-batch-2 write path used for participation changes (removed by
// commit 1cb84fb - "KRKG-0050 batch 2/6" - which stopped all new legacy-log writes; recovered
// from that commit's own diff of the removed `handleListaWyjazdowaPutSignup` call:
// `git show 1cb84fb -- upload-service/src/server.ts`). "Zgłoszono udział" always carried the
// exact equipment/companion counts at the moment of signing up; "Wycofano zgłoszenie udziału" is
// a fixed string with no counts (a withdrawal never restated them).
const PARTICIPATION_SIGNED_UP_RE = /^Zgłoszono udział \(sprzęt: (\d+), osoby towarzyszące: (\d+)\)$/;
const PARTICIPATION_WITHDRAWN = 'Wycofano zgłoszenie udziału';

/** `signupAuditLog` historically recorded two independent kinds of member-signup change under
 * the identical `AuditLogEntry` shape: the `skladkaPaid` toggle (`dues.event_fee.changed`, per
 * implementation-contract.md's "Compatibility clarification"), and the participation change
 * itself (attending/equipment/companions) - which maps to the registered `signup.updated` action
 * on the same `signup:{eventId}:{email}` resource. A single legacy entry never records whether it
 * was the member's very first signup for that event (no cross-document state is consulted here,
 * to keep "one legacy document to one expected event" a pure per-document mapping), so every
 * participation change - including a first-time sign-up - migrates as `signup.updated`, which is
 * always an accurate description of "this signup's state changed to X", never a claim of some
 * different resource state that can't be confirmed from the document alone. */
function parseSignupAuditEntry(doc: LegacySourceDoc): LegacyParseResult {
  const data = doc.data;
  if (!isRecord(data) || typeof data.eventId !== 'string' || typeof data.targetMemberEmail !== 'string' || typeof data.changedBy !== 'string' || typeof data.changedAt !== 'string' || typeof data.changeSummary !== 'string') {
    return { status: 'unparseable', reason: 'signupAuditLog document is missing a required field.' };
  }
  const summary = data.changeSummary;
  const resource = { kind: 'signup' as const, key: `signup:${data.eventId}:${data.targetMemberEmail}`, display: data.targetMemberEmail };
  const actor = { email: data.changedBy };

  const signedUpMatch = PARTICIPATION_SIGNED_UP_RE.exec(summary);
  if (signedUpMatch) {
    return {
      status: 'ok',
      timestamp: data.changedAt,
      input: {
        action: 'signup.updated',
        actor,
        resource,
        changes: [
          { field: 'attending', after: true },
          { field: 'equipmentCount', after: Number(signedUpMatch[1]) },
          { field: 'companionCount', after: Number(signedUpMatch[2]) },
          { field: 'memberEmail', after: data.targetMemberEmail },
        ],
      },
    };
  }
  if (summary === PARTICIPATION_WITHDRAWN) {
    return {
      status: 'ok',
      timestamp: data.changedAt,
      input: {
        action: 'signup.updated',
        actor,
        resource,
        changes: [
          { field: 'attending', after: false },
          { field: 'memberEmail', after: data.targetMemberEmail },
        ],
      },
    };
  }

  let paid: boolean;
  if (/nieopłacon/.test(summary)) paid = false;
  else if (/opłacon/.test(summary)) paid = true;
  else return { status: 'unparseable', reason: `signupAuditLog changeSummary does not match a recognized shape (paid/unpaid or participation): "${summary}"` };
  return {
    status: 'ok',
    timestamp: data.changedAt,
    input: {
      action: 'dues.event_fee.changed',
      actor,
      resource,
      changes: [
        { field: 'paid', after: paid },
        { field: 'memberEmail', after: data.targetMemberEmail },
      ],
    },
  };
}

const WPISOWE_PAID_RE = /wpisowe jako opłacone/;
const WPISOWE_UNPAID_RE = /wpisowe jako nieopłacone/;
const ROCZNA_PAID_RE = /roczn[aą] \d+ jako opłacon/;
const ROCZNA_UNPAID_RE = /roczn[aą] \d+ jako nieopłacon/;
const ROCZNA_AMOUNT_SET_RE = /na:\s*(.+)$/;
const ROCZNA_AMOUNT_CLEARED_RE = /^Usunięto kwotę/;
const EVENT_FEE_SET_RE = /na:\s*(.+)$/;
const EVENT_FEE_CLEARED_RE = /^Usunięto składkę/;

/** `duesAuditLog` → one of the three `dues.*` actions, keyed by the legacy entry's own
 * `context` field. The `roczna`/`eventFee` amount and fee-description text is only ever
 * recoverable from `changeSummary`'s free-text sentence (the legacy schema never stored a
 * structured before/after) - parsed defensively, and for `eventFee` immediately reduced to a
 * digest/length per the "no raw fee description is stored" rule, exactly like the live write
 * path. A `changeSummary` this doesn't recognize is `unparseable`, never guessed. */
function parseDuesAuditEntry(doc: LegacySourceDoc): LegacyParseResult {
  const data = doc.data;
  if (!isRecord(data) || typeof data.context !== 'string' || typeof data.changedBy !== 'string' || typeof data.changedAt !== 'string' || typeof data.changeSummary !== 'string') {
    return { status: 'unparseable', reason: 'duesAuditLog document is missing a required field.' };
  }
  const summary = data.changeSummary;
  const actor = { email: data.changedBy };

  if (data.context === 'wpisowe') {
    if (typeof data.targetMemberEmail !== 'string') return { status: 'unparseable', reason: 'wpisowe entry has no targetMemberEmail.' };
    let paid: boolean;
    if (WPISOWE_PAID_RE.test(summary)) paid = true;
    else if (WPISOWE_UNPAID_RE.test(summary)) paid = false;
    else return { status: 'unparseable', reason: `Unrecognized wpisowe changeSummary: "${summary}"` };
    return {
      status: 'ok',
      timestamp: data.changedAt,
      input: {
        action: 'dues.entry_fee.changed',
        actor,
        // Matches the live write path's own key (handleListaWyjazdowaPutWpisowe in server.ts)
        // and the Historia link in public/lista-wyjazdowa/skladki/skladki.js - both already use
        // `entry_fee`, not `entry` (finding I3 of the final review).
        resource: { kind: 'due', key: `due:${data.targetMemberEmail}:entry_fee`, display: data.targetMemberEmail },
        changes: [{ field: 'paid', after: paid }, { field: 'memberEmail', after: data.targetMemberEmail }],
      },
    };
  }

  if (data.context === 'roczna') {
    if (typeof data.targetMemberEmail !== 'string' || typeof data.year !== 'number') {
      return { status: 'unparseable', reason: 'roczna entry has no targetMemberEmail/year.' };
    }
    if (ROCZNA_PAID_RE.test(summary) || ROCZNA_UNPAID_RE.test(summary)) {
      const paid = ROCZNA_PAID_RE.test(summary);
      return {
        status: 'ok',
        timestamp: data.changedAt,
        input: {
          action: 'dues.annual.changed',
          actor,
          resource: { kind: 'due', key: `due:${data.targetMemberEmail}:${data.year}`, display: data.targetMemberEmail },
          changes: [{ field: 'paid', after: paid }, { field: 'year', after: data.year }, { field: 'memberEmail', after: data.targetMemberEmail }],
        },
      };
    }
    if (ROCZNA_AMOUNT_CLEARED_RE.test(summary)) {
      return {
        status: 'ok',
        timestamp: data.changedAt,
        input: {
          action: 'dues.annual.changed',
          actor,
          resource: { kind: 'due', key: `due:${data.targetMemberEmail}:${data.year}`, display: data.targetMemberEmail },
          changes: [{ field: 'amount', after: null }, { field: 'year', after: data.year }, { field: 'memberEmail', after: data.targetMemberEmail }],
        },
      };
    }
    const amountMatch = ROCZNA_AMOUNT_SET_RE.exec(summary);
    if (amountMatch) {
      return {
        status: 'ok',
        timestamp: data.changedAt,
        input: {
          action: 'dues.annual.changed',
          actor,
          resource: { kind: 'due', key: `due:${data.targetMemberEmail}:${data.year}`, display: data.targetMemberEmail },
          changes: [{ field: 'amount', after: amountMatch[1] }, { field: 'year', after: data.year }, { field: 'memberEmail', after: data.targetMemberEmail }],
        },
      };
    }
    return { status: 'unparseable', reason: `Unrecognized roczna changeSummary: "${summary}"` };
  }

  if (data.context === 'eventFee') {
    if (typeof data.eventId !== 'string') return { status: 'unparseable', reason: 'eventFee entry has no eventId.' };
    if (EVENT_FEE_CLEARED_RE.test(summary)) {
      return {
        status: 'ok',
        timestamp: data.changedAt,
        input: {
          action: 'dues.event_fee.changed',
          actor,
          resource: { kind: 'eventFee', key: `eventFee:${data.eventId}`, display: typeof data.eventName === 'string' ? data.eventName : data.eventId },
          changes: [{ field: 'feeDigest', after: null }, { field: 'feeLength', after: 0 }],
        },
      };
    }
    const feeMatch = EVENT_FEE_SET_RE.exec(summary);
    if (feeMatch) {
      const feeText = feeMatch[1];
      return {
        status: 'ok',
        timestamp: data.changedAt,
        input: {
          action: 'dues.event_fee.changed',
          actor,
          resource: { kind: 'eventFee', key: `eventFee:${data.eventId}`, display: typeof data.eventName === 'string' ? data.eventName : data.eventId },
          // Never the raw fee text itself - implementation-contract.md's "no raw fee description
          // is accepted by the audit event constructor", same as the live write path.
          changes: [{ field: 'feeDigest', after: sha256(feeText) }, { field: 'feeLength', after: feeText.length }],
        },
      };
    }
    return { status: 'unparseable', reason: `Unrecognized eventFee changeSummary: "${summary}"` };
  }

  return { status: 'unparseable', reason: `Unknown duesAuditLog context: "${String(data.context)}"` };
}

function parseLegacyDoc(doc: LegacySourceDoc): LegacyParseResult {
  // Defensive, not currently reachable by real data: every append*AuditEntry helper in
  // roles.ts/dues.ts/signups.ts writes exactly one entry per document (see this file's top
  // comment). If a document ever held an array of entries instead, it is a case this migration
  // was never designed for, so it is an abort condition rather than "migrate the first entry".
  if (Array.isArray(doc.data)) {
    return { status: 'multi_event', reason: `Document data is an array of ${doc.data.length} entries, not a single audit-log entry.` };
  }
  if (doc.collection === 'rolesAuditLog') return parseRoleAuditEntry(doc);
  if (doc.collection === 'signupAuditLog') return parseSignupAuditEntry(doc);
  return parseDuesAuditEntry(doc);
}

export interface MigrationPreflightRow {
  collection: LegacyCollection;
  documentId: string;
  entryCount: 0 | 1;
  parseStatus: 'ok' | 'unparseable' | 'multi_event';
  reason?: string;
  targetEventId?: string;
}

export interface MigrationPreflightReport {
  rows: MigrationPreflightRow[];
  totalDocuments: number;
  okCount: number;
  abortCount: number;
  /** True only when every document parsed to exactly one event - the migration itself must
   * refuse to run otherwise. */
  canProceed: boolean;
}

/**
 * Reads every document across the three legacy collections and reports, per document,
 * collection/documentId/entry-count/parse status - never writes anything.
 * implementation-contract.md: "aborts on multi-event or unparseable documents".
 */
export async function preflightAuditMigration(firestore: FirestoreLikeClient): Promise<MigrationPreflightReport> {
  const rows: MigrationPreflightRow[] = [];
  for (const collection of LEGACY_COLLECTIONS) {
    const docs = await firestore.listDocs<unknown>(collection);
    for (const { id, data } of docs) {
      const result = parseLegacyDoc({ collection, documentId: id, data });
      if (result.status === 'ok') {
        rows.push({ collection, documentId: id, entryCount: 1, parseStatus: 'ok', targetEventId: migratedEventId(collection, id) });
      } else {
        rows.push({ collection, documentId: id, entryCount: 0, parseStatus: result.status, reason: result.reason });
      }
    }
  }
  const okCount = rows.filter(r => r.parseStatus === 'ok').length;
  const abortCount = rows.length - okCount;
  return { rows, totalDocuments: rows.length, okCount, abortCount, canProceed: abortCount === 0 };
}

export interface MigrationRunRow {
  collection: LegacyCollection;
  documentId: string;
  targetEventId: string;
  action: 'would_create' | 'created' | 'already_migrated';
}

export interface MigrationRunReport {
  dryRun: boolean;
  rows: MigrationRunRow[];
  createdCount: number;
  alreadyMigratedCount: number;
}

/**
 * Runs the actual migration - always preflights first and refuses to write anything if the
 * preflight would abort. Create-if-absent (`createDoc`, which fails on an existing id) makes a
 * repeat run of the same source data a no-op rather than a duplicate, since
 * `migratedEventId(collection, documentId)` is deterministic. `dryRun: true` (the default, and
 * the only mode this batch actually exercises - see plan-addendum-2.md) never calls `createDoc`
 * at all.
 */
export async function migrateAuditLogs(firestore: FirestoreLikeClient, options: { dryRun: boolean } = { dryRun: true }): Promise<MigrationRunReport> {
  const preflight = await preflightAuditMigration(firestore);
  if (!preflight.canProceed) {
    throw new Error(
      `Migration preflight found ${preflight.abortCount} document(s) that are multi-event or unparseable - aborting before any write. See the preflight report for details.`,
    );
  }
  const rows: MigrationRunRow[] = [];
  let createdCount = 0;
  let alreadyMigratedCount = 0;
  for (const collection of LEGACY_COLLECTIONS) {
    const docs = await firestore.listDocs<unknown>(collection);
    for (const { id, data } of docs) {
      const parsed = parseLegacyDoc({ collection, documentId: id, data });
      if (parsed.status !== 'ok') continue; // unreachable given canProceed, kept for type-safety
      const targetEventId = migratedEventId(collection, id);
      const existing = await firestore.getDoc<CanonicalAuditEvent>('auditEvents', targetEventId);
      if (existing) {
        alreadyMigratedCount += 1;
        rows.push({ collection, documentId: id, targetEventId, action: 'already_migrated' });
        continue;
      }
      if (options.dryRun) {
        rows.push({ collection, documentId: id, targetEventId, action: 'would_create' });
        continue;
      }
      const event = createCanonicalAuditEvent(parsed.input, { createId: () => targetEventId, now: () => new Date(parsed.timestamp) });
      await firestore.createDoc('auditEvents', targetEventId, event);
      createdCount += 1;
      rows.push({ collection, documentId: id, targetEventId, action: 'created' });
    }
  }
  return { dryRun: options.dryRun, rows, createdCount, alreadyMigratedCount };
}
