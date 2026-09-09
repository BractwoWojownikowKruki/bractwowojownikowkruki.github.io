import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';

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
}

export interface AuditEventDependencies {
  createId: () => string;
  now: () => Date;
}

/** Immutable pre-effect evidence for a Drive, GitHub, or other non-transactional write. */
export interface AuditOperationIntent {
  id: string;
  schemaVersion: 1;
  state: 'pending';
  startedAt: string;
  actor: AuditActor;
  action: AuditAction;
  resource: AuditResource;
}

/** Immutable terminal evidence paired with exactly one successful canonical audit event. */
export interface AuditOperationOutcome {
  id: string;
  schemaVersion: 1;
  state: 'succeeded' | 'failed';
  completedAt: string;
  auditEventId?: string;
}

/** Optional deterministic values and a final resource mapping for an external operation. */
export interface AuditedExternalMutationDependencies<T> extends Partial<AuditEventDependencies> {
  correlationId?: string;
  eventInput?: (result: T) => CanonicalAuditEventInput;
}

/** Builds audit inputs from the same transactional read snapshot as their business mutation. */
export type CanonicalAuditEventInputFactory = (
  tx: FirestoreTransaction,
) => Promise<CanonicalAuditEventInput | readonly CanonicalAuditEventInput[]>;

const defaultDependencies: AuditEventDependencies = { createId: randomUUID, now: () => new Date() };

/** Input rejection for attempts to create evidence outside the reviewed audit schema. */
export class AuditInputError extends Error {}

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
  return {
    id: dependencies.createId(),
    schemaVersion: 1,
    timestamp: dependencies.now().toISOString(),
    actor: { email: input.actor.email.trim().toLowerCase(), ...(input.actor.name ? { name: input.actor.name } : {}) },
    category: definition.category,
    action: input.action,
    audience: definition.audience,
    resource: input.resource,
    changes,
    value: formatTechnicalValue(input.resource.display, valueChange.field, value),
  };
}

/**
 * Audits an external write with a durable intent before the provider call and immutable terminal
 * evidence afterwards. A terminal-write failure deliberately leaves the intent pending so Batch
 * 4's reconciler can determine the real provider outcome instead of recording a false failure.
 */
export async function executeAuditedExternalMutation<T>(
  firestore: FirestoreLikeClient,
  intentInput: CanonicalAuditEventInput,
  effect: (correlationId: string) => Promise<T>,
  dependencies: AuditedExternalMutationDependencies<T> = {},
): Promise<{ result: T; correlationId: string; auditEvent: CanonicalAuditEvent }> {
  normalizeAuditInput(intentInput);
  const auditDependencies: AuditEventDependencies = { ...defaultDependencies, ...dependencies };
  const correlationId = dependencies.correlationId ?? auditDependencies.createId();
  const startedAt = auditDependencies.now().toISOString();
  const intent: AuditOperationIntent = {
    id: correlationId,
    schemaVersion: 1,
    state: 'pending',
    startedAt,
    actor: { email: intentInput.actor.email.trim().toLowerCase(), ...(intentInput.actor.name ? { name: intentInput.actor.name } : {}) },
    action: intentInput.action,
    resource: intentInput.resource,
  };
  await firestore.createDoc('auditOperations', correlationId, intent);

  let result: T;
  try {
    result = await effect(correlationId);
  } catch (error) {
    const outcome: AuditOperationOutcome = {
      id: correlationId,
      schemaVersion: 1,
      state: 'failed',
      completedAt: auditDependencies.now().toISOString(),
    };
    await firestore.createDoc('auditOperationOutcomes', correlationId, outcome);
    throw error;
  }

  const eventInput = dependencies.eventInput ? dependencies.eventInput(result) : intentInput;
  if (eventInput.action !== intentInput.action || eventInput.actor.email.trim().toLowerCase() !== intent.actor.email) {
    throw new AuditInputError('External audit outcome must keep the declared action and actor.');
  }
  const auditEvent = createCanonicalAuditEvent(eventInput, auditDependencies);
  const outcome: AuditOperationOutcome = {
    id: correlationId,
    schemaVersion: 1,
    state: 'succeeded',
    completedAt: auditDependencies.now().toISOString(),
    auditEventId: auditEvent.id,
  };
  await firestore.runTransaction(async tx => {
    await tx.createDoc('auditOperationOutcomes', correlationId, outcome);
    await tx.createDoc('auditEvents', auditEvent.id, auditEvent);
  });
  return { result, correlationId, auditEvent };
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
