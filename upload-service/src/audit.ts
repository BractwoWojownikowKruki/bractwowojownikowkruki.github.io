import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient, FirestoreTransaction, FirestoreQueryCursor, FirestoreQueryFilter } from './firestore.ts';

export type AuditCategory =
  | 'permissions'
  | 'membership'
  | 'events'
  | 'signups'
  | 'dues'
  | 'profile'
  | 'session'
  | 'application'
  | 'gallery'
  | 'site';

export type AuditAudience = 'admin' | 'adminOrAccountant' | 'adminOrModerator' | 'members';
export type AuditFieldVisibility = 'memberVisible' | 'roleRestricted';
export type AuditResourceKind =
  | 'member'
  | 'memberSubmission'
  | 'event'
  | 'signup'
  | 'due'
  | 'eventFee'
  | 'person'
  | 'gallery'
  | 'redirect'
  | 'settings'
  | 'session'
  | 'application';

export interface AuditActionDefinition {
  category: AuditCategory;
  audience: AuditAudience;
  resourceKinds: readonly AuditResourceKind[];
  fields: Readonly<Record<string, AuditFieldVisibility>>;
}

const permissionsFields = { targetEmail: 'roleRestricted', previousRoles: 'roleRestricted', roles: 'roleRestricted' } as const;
const membershipFields = { targetEmail: 'roleRestricted', status: 'roleRestricted', sheetBackup: 'roleRestricted' } as const;
const eventFields = {
  name: 'memberVisible',
  startDate: 'memberVisible',
  endDate: 'memberVisible',
  status: 'memberVisible',
} as const;
const signupFields = {
  memberEmail: 'memberVisible',
  attending: 'memberVisible',
  equipmentCount: 'memberVisible',
  companionCount: 'memberVisible',
} as const;
const duesFields = {
  memberEmail: 'roleRestricted',
  year: 'roleRestricted',
  eventId: 'roleRestricted',
  paid: 'roleRestricted',
  amount: 'roleRestricted',
  feeDigest: 'roleRestricted',
  feeLength: 'roleRestricted',
} as const;
const profileFields = {
  memberEmail: 'roleRestricted',
  name: 'roleRestricted',
  nickname: 'roleRestricted',
  sectionId: 'roleRestricted',
  folderId: 'roleRestricted',
  category: 'roleRestricted',
  order: 'roleRestricted',
  fileId: 'roleRestricted',
  fileCount: 'roleRestricted',
  mainPhoto: 'roleRestricted',
  inMemoriam: 'roleRestricted',
  descriptionHash: 'roleRestricted',
  descriptionLength: 'roleRestricted',
  weaponCount: 'roleRestricted',
  equipmentCount: 'roleRestricted',
  companionCount: 'roleRestricted',
  hidden: 'roleRestricted',
} as const;
const sessionFields = { status: 'roleRestricted' } as const;
const applicationFields = { appId: 'roleRestricted' } as const;
const galleryFields = {
  name: 'memberVisible',
  date: 'memberVisible',
  url: 'memberVisible',
  contributorEmail: 'memberVisible',
  photoCount: 'memberVisible',
  finalized: 'memberVisible',
  // Reported only by the reconciler's `driveFolderProbe` (server.ts) when it positively confirms
  // a still-open operation from folder existence - which, post-allowlist-fix, only `gallery.created`
  // can ever reach (every other gallery action now falls back to `alwaysPendingProbe`). In
  // practice even `gallery.created` never reaches this branch in production: that action's intent
  // always carries a provisional `gallery:pending:{correlationId}` key (see handleStart), which
  // the reconciler can only ever observe as still-pending. This field is therefore not exercised
  // by any current production handler - it exists for defensiveness and for a hypothetical future
  // non-provisional-key `gallery.created` variant, and is covered directly by a test that hands
  // the probe a synthetic non-provisional `gallery.created` intent. Without it, that reconciler
  // path would throw `AuditInputError` (uncovered until the gallery.photo.added reconciliation fix
  // added a passing-case test for this exact path).
  folderId: 'memberVisible',
} as const;
const siteFields = { path: 'roleRestricted', target: 'roleRestricted', liveFetchPostCount: 'roleRestricted', status: 'roleRestricted' } as const;

function action(
  category: AuditCategory,
  audience: AuditAudience,
  resourceKinds: readonly AuditResourceKind[],
  fields: Readonly<Record<string, AuditFieldVisibility>>,
): AuditActionDefinition {
  return { category, audience, resourceKinds, fields };
}

/**
 * Exhaustive audited-action registry. Mutation routes reference only these definitions, which
 * makes visibility, resource type, and persisted diff fields one reviewable server contract.
 */
export const ACTION_REGISTRY = {
  'role.granted': action('permissions', 'admin', ['member'], permissionsFields),
  'role.revoked': action('permissions', 'admin', ['member'], permissionsFields),
  'role.replaced': action('permissions', 'admin', ['member'], permissionsFields),
  'membership.application.submitted': action('membership', 'admin', ['member'], membershipFields),
  'membership.status.approved': action('membership', 'admin', ['member'], membershipFields),
  'membership.status.rejected': action('membership', 'admin', ['member'], membershipFields),
  'membership.status.suspended': action('membership', 'admin', ['member'], membershipFields),
  'membership.status.reactivated': action('membership', 'admin', ['member'], membershipFields),
  'membership.status.removed': action('membership', 'admin', ['member'], membershipFields),
  'membership.sheet_backup.synchronized': action('membership', 'admin', ['member'], membershipFields),
  'event.created': action('events', 'members', ['event'], eventFields),
  'event.updated': action('events', 'members', ['event'], eventFields),
  'event.cancelled': action('events', 'members', ['event'], eventFields),
  'signup.created': action('signups', 'members', ['signup'], signupFields),
  'signup.updated': action('signups', 'members', ['signup'], signupFields),
  'dues.annual.changed': action('dues', 'adminOrAccountant', ['due'], duesFields),
  'dues.entry_fee.changed': action('dues', 'adminOrAccountant', ['due'], duesFields),
  'dues.event_fee.changed': action('dues', 'adminOrAccountant', ['eventFee', 'signup'], duesFields),
  'profile.member.updated': action('profile', 'adminOrModerator', ['member'], profileFields),
  'profile.drive_folder.changed': action('profile', 'adminOrModerator', ['member'], profileFields),
  'profile.person.created': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.description.updated': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.order.updated': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.category.changed': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.deleted': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.photo.added': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.photo.deleted': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.photo.main.changed': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.photo.transferred': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.person.in_memoriam.changed': action('profile', 'adminOrModerator', ['person'], profileFields),
  'profile.photo_submission.created': action('profile', 'adminOrModerator', ['memberSubmission'], profileFields),
  'profile.photo_submission.photo_added': action('profile', 'adminOrModerator', ['memberSubmission'], profileFields),
  'session.login.succeeded': action('session', 'admin', ['session'], sessionFields),
  'application.pwa.installation_reported': action('application', 'admin', ['application'], applicationFields),
  'gallery.created': action('gallery', 'members', ['gallery'], galleryFields),
  'gallery.registered': action('gallery', 'members', ['gallery'], galleryFields),
  'gallery.unregistered': action('gallery', 'admin', ['gallery'], galleryFields),
  'gallery.deleted': action('gallery', 'admin', ['gallery'], galleryFields),
  'gallery.photo.added': action('gallery', 'members', ['gallery'], galleryFields),
  'gallery.finalized': action('gallery', 'members', ['gallery'], galleryFields),
  'gallery.photo.contribution.finalized': action('gallery', 'members', ['gallery'], galleryFields),
  'site.redirect.created': action('site', 'admin', ['redirect'], siteFields),
  'site.redirect.deleted': action('site', 'admin', ['redirect'], siteFields),
  'site.settings.updated': action('site', 'admin', ['settings'], siteFields),
  'site.social_cache.refreshed': action('site', 'admin', ['settings'], siteFields),
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof ACTION_REGISTRY;
export type AuditScalar = string | number | boolean | null;

export interface AuditActor {
  email: string;
  name?: string;
}

export interface AuditResource {
  kind: AuditResourceKind;
  key: string;
  display: string;
}

export interface AuditChangeInput {
  field: string;
  before?: AuditScalar;
  after?: AuditScalar;
}

export interface CanonicalAuditEventInput {
  action: AuditAction;
  actor: AuditActor;
  resource: AuditResource;
  changes: readonly AuditChangeInput[];
  /** Set only by `executeAuditedExternalMutation`/`completeExternalOperation` for the pre-effect
   * provisional-resource-key protocol - not for a caller to set directly. */
  provisionalResourceKey?: string;
  correlationId?: string;
}

export interface CanonicalAuditEvent {
  id: string;
  schemaVersion: 1;
  timestamp: string;
  actor: AuditActor;
  category: AuditCategory;
  action: AuditAction;
  audience: AuditAudience;
  resource: AuditResource;
  changes: Array<AuditChangeInput & { visibility: AuditFieldVisibility }>;
  value: string;
  /**
   * Prefix-searchable tokens (implementation-contract.md "Query and Firestore-index contract"):
   * derived only from `resource.display`, `actor.email`, and the event's own allowlisted string
   * change values - never from a `neverStored` field, since those are never part of this input in
   * the first place. Queried with Firestore `array-contains`, so `wol` finding `Wolin` means the
   * write side must store every prefix length a legal query could ask for (3-24), not just the
   * full word.
   */
  searchTokens: string[];
  /** Present only on a successful event created from an external operation that used the
   * pre-effect provisional-resource-key protocol (implementation-contract.md "Pre-effect resource
   * protocol") - the immutable link between the provisional key used before the effect and this
   * event's final `resource.key`, plus the correlation id shared with its `auditOperations`
   * intent and `auditOperationOutcomes` terminal record. */
  provisionalResourceKey?: string;
  correlationId?: string;
}

export interface AuditEventDependencies {
  createId: () => string;
  now: () => Date;
}

/** How long an awaited request may take before the 15-minute Scheduler reconciler is allowed to
 * claim the operation (implementation-contract.md "Pre-effect resource protocol"). */
export const REQUEST_LEASE_MS = 30 * 60 * 1000;
/** How long one reconciler run holds exclusive claim on an operation, so two overlapping
 * Scheduler invocations can't both probe/complete the same correlation id. */
export const RECONCILIATION_CLAIM_LEASE_MS = 10 * 60 * 1000;
/** An operation still indeterminate this long after it started is parked in `requires_review`
 * rather than reconciled further - implementation-contract.md's 24-hour boundary. */
export const REQUIRES_REVIEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** Immutable pre-effect evidence for a Drive, GitHub, or Sheets write. Never patched after
 * creation - not even to add a final resource id once known, per "Neither the intent nor an
 * already-terminal outcome is patched to substitute a resource ID" (implementation-contract.md). */
export interface AuditOperationIntent {
  id: string;
  schemaVersion: 1;
  state: 'pending';
  startedAt: string;
  actor: AuditActor;
  action: AuditAction;
  resource: AuditResource;
  requestLeaseExpiresAt: string;
  /** Present only for the three routes using the pre-effect protocol (`POST /start`,
   * `POST /admin/people`, `POST /wojownicy-upload/submit`) - `{kind}:pending:{correlationId}`. */
  provisionalResourceKey?: string;
}

/** Immutable terminal evidence. Exactly one of these may ever exist per correlation id - the
 * single-winner transaction in `completeExternalOperation` is what enforces that, so a retry or
 * the reconciler can never append a competing terminal record for the same operation. */
export interface AuditOperationOutcome {
  id: string;
  schemaVersion: 1;
  state: 'succeeded' | 'failed' | 'requires_review';
  completedAt: string;
  /** The first (or only) canonical event this operation produced. Kept singular for every
   * existing single-effect caller and for the "recover the winning event" lost-race path in
   * `executeAuditedExternalMutation`, which only ever needs one representative event. */
  auditEventId?: string;
  /** Present only when the same external effect atomically produced more than one canonical
   * event (implementation-contract.md: "a single backwards-compatible request that changes more
   * than one independent effect may atomically emit one event per effect") - e.g.
   * `profile.person.photo.transferred`, which must appear in both the source and destination
   * person's own Historia. Always includes `auditEventId` as its first entry when present. */
  auditEventIds?: string[];
  provisionalResourceKey?: string;
  finalResourceKey?: string;
  /** Which path recorded the terminal state - diagnostics evidence, not a retry control. */
  determinedBy: 'request' | 'reconciler';
}

/**
 * A separate, mutable "open operations" index - not part of the immutable intent/outcome pair
 * above. Firestore has no way to query "an `auditOperations` doc with no matching
 * `auditOperationOutcomes` doc" (no joins), so the reconciler needs some indexed way to find
 * still-open operations without listing the ever-growing, mostly-resolved `auditOperations`
 * collection. This document is written once alongside the intent and is the only audit-adjacent
 * document this module ever overwrites in place; it carries no evidentiary weight of its own.
 */
export interface AuditOperationOpenMarker {
  correlationId: string;
  startedAt: string;
  requestLeaseExpiresAt: string;
  resolved: boolean;
}

/** A reconciler's exclusive, time-boxed claim on one still-open operation. */
export interface AuditReconciliationClaim {
  correlationId: string;
  claimedAt: string;
  claimLeaseExpiresAt: string;
}

const AUDIT_OPERATIONS_COLLECTION = 'auditOperations';
const AUDIT_OPERATION_OUTCOMES_COLLECTION = 'auditOperationOutcomes';
const AUDIT_OPERATIONS_OPEN_COLLECTION = 'auditOperationsOpen';
const AUDIT_RECONCILIATION_CLAIMS_COLLECTION = 'auditReconciliationClaims';
const AUDIT_EVENTS_COLLECTION = 'auditEvents';

/** Options shared by `startExternalOperation` and `executeAuditedExternalMutation` that don't
 * depend on the effect's result type. */
export interface AuditOperationStartOptions extends Partial<AuditEventDependencies> {
  correlationId?: string;
  /** Set for the three pre-effect-protocol routes: the provisional key used before the effect
   * ran, e.g. `gallery:pending:{correlationId}`. */
  provisionalResourceKey?: string;
}

/** Optional deterministic values and a final resource mapping for an external operation. */
export interface AuditedExternalMutationDependencies<T> extends AuditOperationStartOptions {
  eventInput?: (result: T) => CanonicalAuditEventInput | readonly CanonicalAuditEventInput[];
}

/** Builds audit inputs from the same transactional read snapshot as their business mutation. */
export type CanonicalAuditEventInputFactory = (
  tx: FirestoreTransaction,
) => Promise<CanonicalAuditEventInput | readonly CanonicalAuditEventInput[]>;

const defaultDependencies: AuditEventDependencies = { createId: randomUUID, now: () => new Date() };

/** Input rejection for attempts to create evidence outside the reviewed audit schema. */
export class AuditInputError extends Error {}

/** Deterministic rejection of an audit query the "zero-or-one primary selector" contract
 * forbids - callers map this to HTTP 400, never a partial or best-effort scan. */
export class AuditQueryError extends Error {}

function isAuditScalar(value: unknown): value is AuditScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function displayValue(value: AuditScalar): string {
  if (value === null) return 'null';
  return String(value);
}

/** Produces the compact technical value used in the shared four-column audit table. */
export function formatTechnicalValue(resourceDisplay: string, field: string, value: AuditScalar): string {
  return `${resourceDisplay}.${field}=${displayValue(value)}`;
}

const MIN_SEARCH_TOKEN_LENGTH = 3;
const MAX_SEARCH_TOKEN_LENGTH = 24;

/**
 * Folds Polish diacritics and anything else Unicode NFKD can decompose down to plain a-z0-9,
 * lowercased. `ł`/`Ł` has no canonical decomposition under NFKD (it isn't a combining-mark
 * composition, just a distinct letter), so it needs its own substitution before the generic
 * combining-mark strip runs.
 */
function foldDiacritics(text: string): string {
  return text
    .replace(/[łŁ]/g, 'l')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Splits folded text into words on any non-alphanumeric boundary (plan-addendum-2.md). */
function foldedWords(text: string): string[] {
  return foldDiacritics(text)
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 0);
}

/**
 * One search term, normalized the same way as the write-side tokenizer, per
 * plan-addendum-2.md's "Search contract restated for implementation". Throws `AuditQueryError`
 * (mapped to HTTP 400 by the caller) if the term folds to anything other than exactly one word -
 * the contract requires rejecting multi-term input rather than guessing which word to search.
 */
export function normalizeSearchTerm(term: string): string {
  const words = foldedWords(term);
  if (words.length !== 1) {
    throw new AuditQueryError('Wyszukiwanie przyjmuje dokładnie jedno słowo.');
  }
  return words[0].slice(0, MAX_SEARCH_TOKEN_LENGTH);
}

/**
 * Write-side token set for one word: the complete folded word plus every prefix from length 3 to
 * 24 (implementation-contract.md, plan-addendum-2.md). Storing prefixes - not just the full word -
 * is what lets an `array-contains` query match `wol` against `Wolin` while still rejecting an
 * interior substring like `oli`, which was never stored as a prefix.
 */
function tokensForWord(word: string): string[] {
  const tokens = new Set<string>();
  tokens.add(word);
  const maxPrefix = Math.min(word.length, MAX_SEARCH_TOKEN_LENGTH);
  for (let len = MIN_SEARCH_TOKEN_LENGTH; len <= maxPrefix; len += 1) {
    tokens.add(word.slice(0, len));
  }
  return Array.from(tokens);
}

/**
 * Search tokens for one canonical event: only `resource.display`, `actor.email`, and the event's
 * own string change values feed tokens - exactly the fields the "Per-action stored-field
 * allowlists" section allows to be searchable, since those are the only free text this input ever
 * carries (a `neverStored` field is never part of a `CanonicalAuditEventInput`/`changes` array to
 * begin with, so there is nothing here that could leak one into `searchTokens`).
 */
function computeSearchTokens(resource: AuditResource, actor: AuditActor, changes: readonly AuditChangeInput[]): string[] {
  const sourceText = [resource.display, actor.email, ...changes.flatMap(c => [c.before, c.after])]
    .filter((value): value is string => typeof value === 'string');
  const tokens = new Set<string>();
  for (const text of sourceText) {
    for (const word of foldedWords(text)) {
      for (const token of tokensForWord(word)) tokens.add(token);
    }
  }
  return Array.from(tokens);
}

function normalizeAuditInput(input: CanonicalAuditEventInput): {
  definition: AuditActionDefinition;
  changes: Array<AuditChangeInput & { visibility: AuditFieldVisibility }>;
} {
  const definition = (ACTION_REGISTRY as Record<string, AuditActionDefinition>)[input.action];
  if (!definition) throw new AuditInputError(`Audit action is not registered: ${String(input.action)}`);
  if (!input.actor.email.trim()) throw new AuditInputError('Audit actor email is required.');
  if (!input.resource.key || !input.resource.display || !definition.resourceKinds.includes(input.resource.kind)) {
    throw new AuditInputError('Audit resource does not match the registered action.');
  }
  if (input.changes.length === 0) throw new AuditInputError('Audit event requires a controlled change.');

  return {
    definition,
    changes: input.changes.map(change => {
      const visibility = definition.fields[change.field];
      if (!visibility) throw new AuditInputError(`Audit field is not allowed or is never stored: ${change.field}`);
      if (change.before !== undefined && !isAuditScalar(change.before)) throw new AuditInputError(`Audit field is not scalar: ${change.field}`);
      if (change.after !== undefined && !isAuditScalar(change.after)) throw new AuditInputError(`Audit field is not scalar: ${change.field}`);
      if (change.before === undefined && change.after === undefined) throw new AuditInputError(`Audit change has no value: ${change.field}`);
      return {
        field: change.field,
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
        visibility,
      };
    }),
  };
}

/** Builds a validated, server-owned audit record from a registered action and controlled diff. */
export function createCanonicalAuditEvent(
  input: CanonicalAuditEventInput,
  dependencies: AuditEventDependencies = defaultDependencies,
): CanonicalAuditEvent {
  const { definition, changes } = normalizeAuditInput(input);
  const valueChange = changes[0];
  const value = valueChange.after ?? valueChange.before;
  if (value === undefined) throw new AuditInputError('Audit event has no technical value.');
  const actor: AuditActor = { email: input.actor.email.trim().toLowerCase(), ...(input.actor.name ? { name: input.actor.name } : {}) };
  return {
    id: dependencies.createId(),
    schemaVersion: 1,
    timestamp: dependencies.now().toISOString(),
    actor,
    category: definition.category,
    action: input.action,
    audience: definition.audience,
    resource: input.resource,
    changes,
    value: formatTechnicalValue(input.resource.display, valueChange.field, value),
    searchTokens: computeSearchTokens(input.resource, actor, changes),
    ...(input.provisionalResourceKey ? { provisionalResourceKey: input.provisionalResourceKey } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

/**
 * Writes the immutable pre-effect intent (and its open-operation marker) for a Drive, GitHub, or
 * Sheets write, before the provider call runs. Exported separately from
 * `executeAuditedExternalMutation` so the reconciler's tests, and any future caller that needs to
 * split "start" from "complete" across two requests, can drive each half independently.
 */
export async function startExternalOperation(
  firestore: FirestoreLikeClient,
  intentInput: CanonicalAuditEventInput,
  dependencies: AuditOperationStartOptions = {},
): Promise<{ correlationId: string; intent: AuditOperationIntent }> {
  normalizeAuditInput(intentInput);
  const auditDependencies: AuditEventDependencies = { ...defaultDependencies, ...dependencies };
  const correlationId = dependencies.correlationId ?? auditDependencies.createId();
  const startedAt = auditDependencies.now().toISOString();
  const requestLeaseExpiresAt = new Date(new Date(startedAt).getTime() + REQUEST_LEASE_MS).toISOString();
  const intent: AuditOperationIntent = {
    id: correlationId,
    schemaVersion: 1,
    state: 'pending',
    startedAt,
    actor: { email: intentInput.actor.email.trim().toLowerCase(), ...(intentInput.actor.name ? { name: intentInput.actor.name } : {}) },
    action: intentInput.action,
    resource: intentInput.resource,
    requestLeaseExpiresAt,
    ...(dependencies.provisionalResourceKey ? { provisionalResourceKey: dependencies.provisionalResourceKey } : {}),
  };
  await firestore.createDoc(AUDIT_OPERATIONS_COLLECTION, correlationId, intent);
  const openMarker: AuditOperationOpenMarker = { correlationId, startedAt, requestLeaseExpiresAt, resolved: false };
  await firestore.setDoc(AUDIT_OPERATIONS_OPEN_COLLECTION, correlationId, openMarker);
  return { correlationId, intent };
}

export type CompleteExternalOperationInput =
  // `eventInput` accepts more than one input for the same reason `executeAuditedFirestoreMutation`
  // does (implementation-contract.md: "a single backwards-compatible request that changes more
  // than one independent effect may atomically emit one event per effect") - e.g.
  // `profile.person.photo.transferred`, which must land in both the source and destination
  // person's own Historia from the one Drive move.
  | { state: 'succeeded'; correlationId: string; eventInput: CanonicalAuditEventInput | readonly CanonicalAuditEventInput[]; determinedBy: 'request' | 'reconciler' }
  | { state: 'failed' | 'requires_review'; correlationId: string; determinedBy: 'request' | 'reconciler' };

/**
 * The single-winner completion transaction (implementation-contract.md "External-operation
 * contract"): reads the terminal outcome document inside the transaction and, if one already
 * exists, does nothing further - `won: false`. Firestore's transaction semantics (optimistic
 * read-conflict retry in production, the serialized transaction queue in the in-memory test
 * client) guarantee that of two concurrent callers racing to complete the same correlation id -
 * typically the original awaited request and the reconciler - only one ever observes an absent
 * outcome and gets to create it, so a retry or reconciler pass can never append a second terminal
 * event for the same operation.
 */
export async function completeExternalOperation(
  firestore: FirestoreLikeClient,
  input: CompleteExternalOperationInput,
  dependencies: AuditEventDependencies = defaultDependencies,
): Promise<{ outcome: AuditOperationOutcome; auditEvent?: CanonicalAuditEvent; auditEvents?: CanonicalAuditEvent[]; won: boolean }> {
  return firestore.runTransaction(async tx => {
    const existing = await tx.getDoc<AuditOperationOutcome>(AUDIT_OPERATION_OUTCOMES_COLLECTION, input.correlationId);
    if (existing) return { outcome: existing, won: false };

    const completedAt = dependencies.now().toISOString();
    let outcome: AuditOperationOutcome;
    let auditEvent: CanonicalAuditEvent | undefined;
    let auditEvents: CanonicalAuditEvent[] | undefined;
    if (input.state === 'succeeded') {
      const eventInputs = Array.isArray(input.eventInput) ? input.eventInput : [input.eventInput as CanonicalAuditEventInput];
      if (eventInputs.length === 0) throw new AuditInputError('External operation completion requires at least one event.');
      auditEvents = eventInputs.map(oneInput => createCanonicalAuditEvent({ ...oneInput, correlationId: input.correlationId }, dependencies));
      auditEvent = auditEvents[0];
      outcome = {
        id: input.correlationId,
        schemaVersion: 1,
        state: 'succeeded',
        completedAt,
        auditEventId: auditEvent.id,
        determinedBy: input.determinedBy,
        ...(auditEvent.provisionalResourceKey ? { provisionalResourceKey: auditEvent.provisionalResourceKey } : {}),
        finalResourceKey: auditEvent.resource.key,
        ...(auditEvents.length > 1 ? { auditEventIds: auditEvents.map(e => e.id) } : {}),
      };
      for (const oneEvent of auditEvents) {
        await tx.createDoc(AUDIT_EVENTS_COLLECTION, oneEvent.id, oneEvent);
      }
    } else {
      outcome = { id: input.correlationId, schemaVersion: 1, state: input.state, completedAt, determinedBy: input.determinedBy };
    }
    await tx.createDoc(AUDIT_OPERATION_OUTCOMES_COLLECTION, input.correlationId, outcome);
    // Same transaction, so a caller can never observe the outcome without the open marker
    // already reflecting it - closes the window the reconciler's eligibility check depends on.
    await tx.setDoc(AUDIT_OPERATIONS_OPEN_COLLECTION, input.correlationId, { resolved: true });
    return { outcome, auditEvent, auditEvents, won: true };
  });
}

/**
 * Audits an external write with a durable intent before the provider call and immutable terminal
 * evidence afterwards. A terminal-write failure deliberately leaves the intent pending so the
 * reconciler can determine the real provider outcome instead of recording a false failure -
 * unless the effect itself threw, which the provider is assumed to have already rolled back
 * (implementation-contract.md's provider calls are all single-effect, non-partial operations),
 * so that path records `failed` immediately rather than leaving evidence of an effect that never
 * happened.
 */
export async function executeAuditedExternalMutation<T>(
  firestore: FirestoreLikeClient,
  intentInput: CanonicalAuditEventInput,
  effect: (correlationId: string) => Promise<T>,
  dependencies: AuditedExternalMutationDependencies<T> = {},
): Promise<{ result: T; correlationId: string; auditEvent: CanonicalAuditEvent; auditEvents: readonly CanonicalAuditEvent[] }> {
  const auditDependencies: AuditEventDependencies = { ...defaultDependencies, ...dependencies };
  const { correlationId, intent } = await startExternalOperation(firestore, intentInput, dependencies);

  let result: T;
  try {
    result = await effect(correlationId);
  } catch (error) {
    await completeExternalOperation(firestore, { state: 'failed', correlationId, determinedBy: 'request' }, auditDependencies);
    throw error;
  }

  const rawEventInput = dependencies.eventInput ? dependencies.eventInput(result) : intentInput;
  const eventInputs = Array.isArray(rawEventInput) ? rawEventInput : [rawEventInput as CanonicalAuditEventInput];
  for (const oneInput of eventInputs) {
    if (oneInput.action !== intentInput.action || oneInput.actor.email.trim().toLowerCase() !== intent.actor.email) {
      throw new AuditInputError('External audit outcome must keep the declared action and actor.');
    }
  }
  const finalEventInputs: readonly CanonicalAuditEventInput[] = dependencies.provisionalResourceKey
    ? eventInputs.map(oneInput => ({ ...oneInput, provisionalResourceKey: dependencies.provisionalResourceKey }))
    : eventInputs;
  const { outcome, auditEvent, auditEvents, won } = await completeExternalOperation(
    firestore,
    { state: 'succeeded', correlationId, eventInput: finalEventInputs, determinedBy: 'request' },
    auditDependencies,
  );
  if (won && auditEvent && auditEvents) return { result, correlationId, auditEvent, auditEvents };

  // Lost the single-winner race - only possible if this request outlived its own 30-minute
  // request lease and the reconciler already claimed and resolved the operation first. The
  // provider effect above did succeed (`result` is valid), so recover the winning event rather
  // than fabricate a second one; only a genuine conflict (reconciler recorded failed/
  // requires_review while this request's effect actually succeeded) surfaces as an error, since
  // that combination needs administrator review, not a silent guess. (The reconciler itself only
  // ever produces one event per probe, so there is nothing further to recover for the multi-event
  // case here - a stuck multi-effect operation is a known limitation, see photo.transferred's
  // handler comment.)
  const winningEvent = outcome.auditEventId ? await firestore.getDoc<CanonicalAuditEvent>(AUDIT_EVENTS_COLLECTION, outcome.auditEventId) : null;
  if (winningEvent) return { result, correlationId, auditEvent: winningEvent, auditEvents: [winningEvent] };
  throw new AuditInputError(`External operation ${correlationId} was already reconciled as "${outcome.state}" before this request completed.`);
}

export interface ExternalOperationProbeResult {
  state: 'succeeded' | 'failed' | 'pending';
  /** Required when `state` is `'succeeded'`: the event input describing the final resource,
   * reconstructed from the probe (e.g. a Drive folder id search by name/parent). */
  eventInput?: CanonicalAuditEventInput;
}

/** A resource-specific idempotent final-state probe (implementation-contract.md's Scheduler
 * contract) - never repeats the original irreversible effect, only observes whether it already
 * happened. */
export type ExternalOperationProbe = (intent: AuditOperationIntent) => Promise<ExternalOperationProbeResult>;

export type ReconcileOneOutcome =
  | 'claimed_succeeded'
  | 'claimed_failed'
  | 'claimed_requires_review'
  | 'not_eligible'
  | 'already_claimed'
  | 'already_resolved';

/**
 * One reconciliation attempt for one still-open operation - the unit of work the Cloud Scheduler
 * route in `server.ts` loops over every 15 minutes. Implements, in order: eligibility (the
 * request's own 30-minute lease must have expired), claiming (an exclusive 10-minute
 * reconciliation lease, so two overlapping Scheduler ticks can't both probe the same operation),
 * the probe itself, and the 24-hour `requires_review` boundary. Never calls `effect` again -
 * only `probe`.
 */
export async function reconcileExternalOperation(
  firestore: FirestoreLikeClient,
  correlationId: string,
  probe: ExternalOperationProbe,
  dependencies: AuditEventDependencies = defaultDependencies,
): Promise<{ correlationId: string; outcome: ReconcileOneOutcome }> {
  const marker = await firestore.getDoc<AuditOperationOpenMarker>(AUDIT_OPERATIONS_OPEN_COLLECTION, correlationId);
  if (!marker || marker.resolved) return { correlationId, outcome: 'already_resolved' };

  const now = dependencies.now();
  if (now.getTime() < new Date(marker.requestLeaseExpiresAt).getTime()) {
    return { correlationId, outcome: 'not_eligible' };
  }

  const claimed = await firestore.runTransaction(async tx => {
    const existingClaim = await tx.getDoc<AuditReconciliationClaim>(AUDIT_RECONCILIATION_CLAIMS_COLLECTION, correlationId);
    if (existingClaim && new Date(existingClaim.claimLeaseExpiresAt).getTime() > now.getTime()) return false;
    const claim: AuditReconciliationClaim = {
      correlationId,
      claimedAt: now.toISOString(),
      claimLeaseExpiresAt: new Date(now.getTime() + RECONCILIATION_CLAIM_LEASE_MS).toISOString(),
    };
    await tx.setDoc(AUDIT_RECONCILIATION_CLAIMS_COLLECTION, correlationId, claim);
    return true;
  });
  if (!claimed) return { correlationId, outcome: 'already_claimed' };

  const intent = await firestore.getDoc<AuditOperationIntent>(AUDIT_OPERATIONS_COLLECTION, correlationId);
  if (!intent) return { correlationId, outcome: 'already_resolved' };

  const probeResult = await probe(intent);
  if (probeResult.state === 'succeeded') {
    if (!probeResult.eventInput) throw new AuditInputError('A succeeded probe result must supply eventInput.');
    const finalEventInput: CanonicalAuditEventInput = intent.provisionalResourceKey
      ? { ...probeResult.eventInput, provisionalResourceKey: intent.provisionalResourceKey }
      : probeResult.eventInput;
    await completeExternalOperation(firestore, { state: 'succeeded', correlationId, eventInput: finalEventInput, determinedBy: 'reconciler' }, dependencies);
    return { correlationId, outcome: 'claimed_succeeded' };
  }
  if (probeResult.state === 'failed') {
    await completeExternalOperation(firestore, { state: 'failed', correlationId, determinedBy: 'reconciler' }, dependencies);
    return { correlationId, outcome: 'claimed_failed' };
  }

  // Still indeterminate - decide only whether the 24-hour boundary has passed. Never retries the
  // irreversible effect itself.
  const startedAtMs = new Date(intent.startedAt).getTime();
  if (now.getTime() - startedAtMs >= REQUIRES_REVIEW_AFTER_MS) {
    await completeExternalOperation(firestore, { state: 'requires_review', correlationId, determinedBy: 'reconciler' }, dependencies);
    return { correlationId, outcome: 'claimed_requires_review' };
  }
  return { correlationId, outcome: 'not_eligible' };
}

/** Lists still-open (unresolved) operation correlation ids for one reconciliation sweep. */
export async function listOpenOperationCorrelationIds(firestore: FirestoreLikeClient): Promise<string[]> {
  const docs = await firestore.listDocs<AuditOperationOpenMarker>(AUDIT_OPERATIONS_OPEN_COLLECTION);
  return docs.filter(d => !d.data.resolved).map(d => d.id);
}

/** Commits a Firestore mutation and its immutable canonical audit event in the same transaction. */
export async function executeAuditedFirestoreMutation<T>(
  firestore: FirestoreLikeClient,
  input: CanonicalAuditEventInput | readonly CanonicalAuditEventInput[] | CanonicalAuditEventInputFactory,
  mutation: (tx: FirestoreTransaction) => Promise<T>,
  dependencies: AuditEventDependencies = defaultDependencies,
): Promise<{ result: T; auditEvent: CanonicalAuditEvent; auditEvents: readonly CanonicalAuditEvent[] }> {
  let auditEvents: readonly CanonicalAuditEvent[] | undefined;
  const result = await firestore.runTransaction(async tx => {
    const resolvedInput = typeof input === 'function' ? await input(tx) : input;
    const inputs = Array.isArray(resolvedInput) ? resolvedInput : [resolvedInput];
    if (inputs.length === 0) throw new AuditInputError('Audited mutation requires at least one audit event.');
    auditEvents = inputs.map(auditInput => createCanonicalAuditEvent(auditInput, dependencies));
    const mutationResult = await mutation(tx);
    for (const auditEvent of auditEvents) {
      await tx.createDoc('auditEvents', auditEvent.id, auditEvent);
    }
    return mutationResult;
  });
  if (!auditEvents?.length) throw new AuditInputError('Audited mutation did not produce an audit event.');
  return { result, auditEvent: auditEvents[0], auditEvents };
}

// ---------------------------------------------------------------------------------------------
// Query, role projection, and diagnostics (KRKG-0050 batch 4/6)
// ---------------------------------------------------------------------------------------------

const MAX_LIST_LIMIT = 100;

/**
 * Exactly the "zero-or-one primary selector" the query contract allows
 * (implementation-contract.md "Query and Firestore-index contract"). There is deliberately no
 * variant that combines two of these - the type itself is the enforcement, backed by the runtime
 * checks in `parseAuditQueryRequest`/`queryAuditEvents` for input arriving as untyped request
 * query-string values.
 */
export type AuditPrimarySelector =
  | { kind: 'none' }
  | { kind: 'categoryAction'; category: AuditCategory; action?: AuditAction }
  | { kind: 'actor'; email: string }
  | { kind: 'resourceKey'; key: string }
  | { kind: 'search'; term: string };

export interface AuditQueryOptions {
  selector: AuditPrimarySelector;
  /** Inclusive ISO-8601 timestamp bounds - may accompany any primary selector. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

/** Opaque cursor codec - base64 JSON of the last row's (timestamp, id), matching
 * `FirestoreQueryCursor`. Callers must never construct or parse this themselves. */
export function encodeAuditCursor(cursor: FirestoreQueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAuditCursor(cursor: string): FirestoreQueryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AuditQueryError('Nieprawidłowy kursor.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as FirestoreQueryCursor).timestamp !== 'string' ||
    typeof (parsed as FirestoreQueryCursor).id !== 'string' ||
    !isIsoTimestamp((parsed as FirestoreQueryCursor).timestamp)
  ) {
    throw new AuditQueryError('Nieprawidłowy kursor.');
  }
  return parsed as FirestoreQueryCursor;
}

function buildFirestoreFilter(selector: AuditPrimarySelector): FirestoreQueryFilter | undefined {
  switch (selector.kind) {
    case 'none':
      return undefined;
    case 'categoryAction':
      return selector.action
        ? { field: 'action', op: '==', value: selector.action }
        : { field: 'category', op: '==', value: selector.category };
    case 'actor':
      return { field: 'actor.email', op: '==', value: selector.email.trim().toLowerCase() };
    case 'resourceKey':
      return { field: 'resource.key', op: '==', value: selector.key };
    case 'search':
      return { field: 'searchTokens', op: 'array-contains', value: normalizeSearchTerm(selector.term) };
    default: {
      const exhaustive: never = selector;
      throw new AuditQueryError(`Nieobsługiwany selektor: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Who is asking, for server-side field/category redaction (implementation-contract.md
 * "Per-action stored-field allowlists" and its role-visibility rules). `admin` scope is used for
 * every authenticated administrator/accountant/moderator query (`/admin/audyt` and diagnostics);
 * `member` scope is the protected member-zone contextual page, which is never given elevated
 * flags regardless of the caller's actual roles - it always gets the public projection.
 */
export type AuditViewer =
  | { scope: 'admin'; isAdmin: boolean; isAccountant: boolean; isModerator: boolean }
  | { scope: 'member' };

function viewerCanSeeCategory(viewer: AuditViewer, category: AuditCategory): boolean {
  if (viewer.scope === 'member') return false; // member scope is gated on audience below, not category
  if (viewer.isAdmin) return true;
  if (category === 'dues') return viewer.isAccountant;
  if (category === 'profile') return viewer.isModerator;
  return false;
}

export interface AuditEventRow {
  id: string;
  timestamp: string;
  actor?: AuditActor;
  category: AuditCategory;
  action: AuditAction;
  resource: AuditResource;
  value: string;
  changes: Array<{ field: string; before?: AuditScalar; after?: AuditScalar }>;
}

/**
 * Applies the role/audience/field projection to one stored event, or returns `null` if the
 * viewer may not see it at all. List rows and the detail endpoint share this exact function, so
 * "detail returns exactly one permitted projection" (implementation-contract.md) can never drift
 * from what the list already redacted.
 *
 * Actor identity is withheld from the `member` scope: the per-action stored-field allowlist table
 * calls out "actor email" as `roleRestricted` for every audience-`members` category (events,
 * signups, gallery), so an ordinary signed-in member sees the public value fields but never who
 * performed the action. Every admin-scope viewer permitted to see a category at all sees its
 * actor, since accountant-only/moderator-only are still privileged, authenticated roles, not the
 * general public this restriction targets.
 */
export function projectAuditEvent(event: CanonicalAuditEvent, viewer: AuditViewer): AuditEventRow | null {
  if (viewer.scope === 'member') {
    if (event.audience !== 'members') return null;
    const changes = event.changes.filter(c => c.visibility === 'memberVisible');
    if (changes.length === 0) return null;
    return {
      id: event.id,
      timestamp: event.timestamp,
      category: event.category,
      action: event.action,
      resource: event.resource,
      value: event.value,
      changes: changes.map(({ field, before, after }) => ({ field, before, after })),
    };
  }
  if (!viewerCanSeeCategory(viewer, event.category)) return null;
  return {
    id: event.id,
    timestamp: event.timestamp,
    actor: event.actor,
    category: event.category,
    action: event.action,
    resource: event.resource,
    value: event.value,
    changes: event.changes.map(({ field, before, after }) => ({ field, before, after })),
  };
}

export interface AuditQueryPage {
  rows: AuditEventRow[];
  nextCursor?: string;
}

/**
 * The one read path for both `/admin/audyt` and the protected member-zone contextual page - same
 * query module, different `viewer`. Enforces the zero-or-one primary selector rule, the 100-row
 * cap, and cursor pagination; never issues an unindexed/unfiltered scan (every branch of
 * `buildFirestoreFilter` maps directly onto a `firestore.indexes.json` entry, or to no filter at
 * all for `{kind:'none'}`, which Firestore serves off the automatic single-field timestamp
 * index).
 */
export async function queryAuditEvents(
  firestore: FirestoreLikeClient,
  options: AuditQueryOptions,
  viewer: AuditViewer,
): Promise<AuditQueryPage> {
  if (options.from !== undefined && !isIsoTimestamp(options.from)) throw new AuditQueryError('Nieprawidłowa data początkowa.');
  if (options.to !== undefined && !isIsoTimestamp(options.to)) throw new AuditQueryError('Nieprawidłowa data końcowa.');
  const limit = Math.min(Math.max(options.limit ?? MAX_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const filter = buildFirestoreFilter(options.selector);
  const startAfter = options.cursor ? decodeAuditCursor(options.cursor) : undefined;

  // Requests more than the page size so redaction (a category-invisible-to-this-viewer row, or a
  // member-scope row with no memberVisible changes) can still fill a full page without a second
  // round trip in the common case - never more than one extra Firestore round trip regardless.
  const rows: AuditEventRow[] = [];
  let cursor = startAfter;
  let exhausted = false;
  while (rows.length < limit && !exhausted) {
    const fetchLimit = Math.max(limit - rows.length, 1) * 2;
    const docs = await firestore.queryDocs<CanonicalAuditEvent>('auditEvents', {
      filter,
      timestampField: 'timestamp',
      timestampGte: options.from,
      timestampLte: options.to,
      startAfter: cursor,
      limit: fetchLimit,
    });
    if (docs.length === 0) {
      exhausted = true;
      break;
    }
    // Cursor must advance only to the last doc actually consumed below, not the last doc
    // fetched: an early `break` (page filled before the whole batch was examined) would
    // otherwise skip every unexamined doc in this batch on the next page, silently dropping
    // rows a viewer is entitled to see.
    let consumed = 0;
    for (const doc of docs) {
      consumed += 1;
      const projected = projectAuditEvent(doc.data, viewer);
      if (projected) rows.push(projected);
      if (rows.length >= limit) break;
    }
    const lastConsumed = docs[consumed - 1];
    cursor = { timestamp: lastConsumed.data.timestamp, id: lastConsumed.id };
    // Only a batch that was BOTH shorter than requested AND fully examined (the inner loop never
    // hit its own `break` because the page filled first) proves there is nothing left to fetch.
    // A page that filled mid-batch (`consumed < docs.length`) still has unexamined docs in this
    // same batch, even if the batch as a whole was short - so `exhausted` must stay false and a
    // cursor must still be produced, or those trailing docs become permanently unreachable.
    if (consumed === docs.length && docs.length < fetchLimit) exhausted = true;
  }

  const page = rows.slice(0, limit);
  return {
    rows: page,
    nextCursor: page.length === limit && !exhausted ? encodeAuditCursor(cursor!) : undefined,
  };
}

/** Fetches and projects exactly one event for the detail endpoint - `null` if it doesn't exist
 * or this viewer isn't permitted to see it (both map to HTTP 404 in `server.ts`, never a 403
 * that would confirm the event's existence to an unauthorized caller). */
export async function getAuditEventDetail(firestore: FirestoreLikeClient, id: string, viewer: AuditViewer): Promise<AuditEventRow | null> {
  const event = await firestore.getDoc<CanonicalAuditEvent>('auditEvents', id);
  if (!event) return null;
  return projectAuditEvent(event, viewer);
}

export interface AuditDiagnosticsRow {
  correlationId: string;
  state: 'pending' | 'failed' | 'requires_review';
  action: AuditAction;
  resource: AuditResource;
  actor: AuditActor;
  startedAt: string;
  completedAt?: string;
}

/**
 * Administrator-only listing of every non-succeeded external operation, optionally filtered by
 * correlation id (implementation-contract.md "Diagnostics lists pending, failed, and
 * requires_review by correlation ID"). Deliberately has no retry/resolve mutation - v1's
 * remediation path is "repeat the normal authenticated action", per plan-addendum.md.
 */
export async function listAuditDiagnostics(firestore: FirestoreLikeClient, correlationId?: string): Promise<AuditDiagnosticsRow[]> {
  if (correlationId) {
    const intent = await firestore.getDoc<AuditOperationIntent>(AUDIT_OPERATIONS_COLLECTION, correlationId);
    if (!intent) return [];
    const outcome = await firestore.getDoc<AuditOperationOutcome>(AUDIT_OPERATION_OUTCOMES_COLLECTION, correlationId);
    if (outcome?.state === 'succeeded') return [];
    const state: 'pending' | 'failed' | 'requires_review' = outcome ? (outcome.state as 'failed' | 'requires_review') : 'pending';
    return [
      {
        correlationId,
        state,
        action: intent.action,
        resource: intent.resource,
        actor: intent.actor,
        startedAt: intent.startedAt,
        completedAt: outcome?.completedAt,
      },
    ];
  }
  const intents = await firestore.listDocs<AuditOperationIntent>(AUDIT_OPERATIONS_COLLECTION);
  const rows: AuditDiagnosticsRow[] = [];
  for (const { id, data: intent } of intents) {
    const outcome = await firestore.getDoc<AuditOperationOutcome>(AUDIT_OPERATION_OUTCOMES_COLLECTION, id);
    if (outcome && outcome.state === 'succeeded') continue;
    const state: 'pending' | 'failed' | 'requires_review' = outcome ? (outcome.state as 'failed' | 'requires_review') : 'pending';
    rows.push({
      correlationId: id,
      state,
      action: intent.action,
      resource: intent.resource,
      actor: intent.actor,
      startedAt: intent.startedAt,
      completedAt: outcome?.completedAt,
    });
  }
  rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return rows;
}
