import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AuthError, checkAllowlist, fetchGoogleJwks, verifyGoogleIdToken, type VerifiedIdentity } from './auth.ts';
import { createAppsScriptAllowlist, createSheetAllowlist } from './allowlist.ts';
import { checkSubmissionOwnership, issueSubmissionToken, verifySubmissionToken } from './submission.ts';
import { checkReauthFreshness, issueSessionToken, maybeRenewSessionToken, verifySessionToken, type SessionClaims, type SessionSigningKey } from './session.ts';
import type { SheetAllowlist } from './allowlist.ts';
import { createDriveClient, resizeThumbnailUrl, type DriveClient } from './drive.ts';
import { createGithubClient, isValidRedirectPath, isValidRedirectTarget, type GithubClient } from './github.ts';
import { mimeTypesEquivalent, sniffImageMimeType, SNIFF_BYTES } from './imageSniff.ts';
import { fetchInstagramPosts, fetchFacebookPosts, fetchYouTubeVideos, clearSocialMediaCache } from './social-media.ts';
import { getFacebookSettings, setFacebookSettings } from './settings.ts';
import { getClientIp, isRateLimited } from './rate-limit.ts';
import {
  bootstrapAboutUsStructure,
  buildPersonFolderName,
  computeOrderForDepartmentMove,
  departmentFolderId,
  fetchCategoryPeople,
  IN_MEMORIAM_FILE_NAME,
  invalidateAboutUsCache,
  isAboutUsCategory,
  isAdminDepartment,
  mapDriveImagesToPhotos,
  parsePersonFolderName,
  type AboutUsCategory,
  type AdminDepartment,
  type PersonPhoto,
} from './about-us.ts';
import { createFirestoreClient, type FirestoreLikeClient, type FirestoreTransaction } from './firestore.ts';
import {
  createCanonicalAuditEvent,
  executeAuditedExternalMutation,
  executeAuditedFirestoreMutation,
  reconcileExternalOperation,
  listOpenOperationCorrelationIds,
  listAuditDiagnostics,
  queryAuditEvents,
  getAuditEventDetail,
  AuditQueryError,
  type AuditAction,
  type AuditCategory,
  type AuditPrimarySelector,
  type AuditQueryOptions,
  type AuditViewer,
  type AuditOperationIntent,
  type ExternalOperationProbe,
  type CanonicalAuditEventInput,
} from './audit.ts';
import { verifyReconcilerOidcToken } from './auth.ts';
import { getMember, listAllMembers, saveMember, setMemberDriveFolderId, setMemberCategoryId, setMemberHidden, recordLastLogin, type MemberDoc, type MemberWritableFields } from './members.ts';
import { applyForMembershipInTransaction, applyAdminTransitionInTransaction, listMembersByStatus, type AdminTransition } from './membership.ts';
import type { MembershipStatus } from './members.ts';
import { createFirestoreMemberAuthorizer, listActiveMemberEmails } from './membership-authorization.ts';
import { createDisabledSheetsClient, createSheetsClient, type SheetsClient } from './sheets.ts';
import { getProfile, listAllProfiles, saveProfile, setWpisowePaid, type ListaWyjazdowaProfileDoc, type ProfileWritableFields } from './lista-wyjazdowa-profile.ts';
import { getAllLookupLists, getLookupList } from './lookup-lists.ts';
import { listEvents, getEvent, createEvent, updateEvent, type EventDoc, type EventWritableFields } from './events.ts';
import {
  listAllSignups,
  listSignupsForEvent,
  getSignup,
  saveSignup,
  setSkladkaPaid,
  listAuditLogForEvent,
  type SignupDoc,
  type SignupWritableFields,
} from './signups.ts';
import { getGrantedRoles, satisfiesRole, requireRole, setGrantedRoles, listAllGrantedRoles, listRoleAuditLog, createRoleAuthorizer } from './roles.ts';
import { listDuesForYear, saveDues, type DuesDoc, type DuesWritableFields, listDuesAuditLog } from './dues.ts';

// Long enough to cover a large gallery uploaded over a flaky connection across several
// sittings, short enough that a lost/abandoned submission token doesn't stay valid forever.
// Deliberately longer than a single Google ID token's lifetime - the frontend re-authenticates
// mid-upload as needed (see dodaj-galerie.js's ensureFreshIdToken) rather than the two lifetimes
// being assumed to match.
const SUBMISSION_TTL_MS = 6 * 60 * 60 * 1000;

export interface ServerDeps {
  drive: DriveClient;
  github: GithubClient;
  // Lista Wyjazdowa's own document store (Task 1) - Firestore rather than a Sheet/Drive file,
  // since these routes read/write structured per-member records (member profile, equipment,
  // lookup lists) keyed by email, not a flat list a human edits directly.
  firestore: FirestoreLikeClient;
  // Cookie-based (verifySessionRequest under the hood, KRKG-0036 Phase 1 cutover): verifies the
  // session cookie, re-checks the live general-kruki allowlist, and renews the cookie on `res`
  // if the sliding window is due. Returns the full SessionClaims (a superset of the old
  // VerifiedIdentity - existing `.email`/`.sub` usages are unaffected) so a *WithStepUp variant
  // can read `.reauthAt` without a second cookie verification.
  authenticate: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // Same, but also requires a fresh (<= reauthFreshnessWindowMs) real Google sign-in and forces
  // a live allowlist re-check bypassing its cache - for the one member-level action that's
  // step-up-gated per design-v2.md Phase 1 point 9: adding photos to a gallery the caller didn't
  // create (KRKG-0028's gap - requireExistingGalleryFolder never checked ownership).
  authenticateWithStepUp: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // Same cookie verification as `authenticate`, checked against a separate, smaller allowlist
  // (Task 1) - kept as its own function rather than a second parameter to `authenticate` so
  // route handlers can't accidentally mix the two up.
  authenticateAdmin: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // authenticateAdmin plus the step-up freshness + forced allowlist refresh described above -
  // required on every *mutating* admin route (14 of the 18 authenticateAdmin call sites; the 4
  // read-only admin/whoami|redirects|people|settings GETs use plain authenticateAdmin, since
  // there's no destructive side effect to gate).
  authenticateAdminWithStepUp: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // Same shape again, checked against the kruki Google Group's live membership (via an Apps
  // Script Web App, see createAppsScriptAllowlist) instead of a Sheet - gates the self-service
  // "Wrzucam swoje zdjęcie" flow in the Wojownicy section. No step-up variant: every route
  // gated by this creates/uploads-to-its-own-just-created folder, never someone else's.
  authenticateWojownicyUpload: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // KRKG-0049: admin-allowlist OR Firestore 'moderator'/'admin' role (see roles.ts's
  // createRoleAuthorizer and this file's anyOf()) - gates the "Zarządzanie ludźmi" page's people-
  // management actions (member list/transition/drive-folder/profile/sync, lookup-lists) to a
  // moderator without giving them the rest of the admin panel. Replaces the old Google-Group-
  // backed authenticateModerator (KRKG-0027, gated gallery deletion, never actually configured in
  // production) - galleries are plain-admin-gated now, see handleDeleteDriveGallery/handleUnregister.
  authenticateAdminOrModerator: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // authenticateAdminOrModerator plus step-up, for the mutating routes in that same set.
  authenticateAdminOrModeratorWithStepUp: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  // Verifies a raw Google ID token (from POST /session/login's body, not an Authorization
  // header - that's the whole exchange this endpoint performs) against the same general kruki
  // allowlist as `authenticate`. Kept as its own dep function, matching the authenticate*
  // pattern above, rather than exposing the raw allowlist/OAuth client id on ServerDeps.
  authenticateSessionLogin: (idToken: string) => Promise<VerifiedIdentity>;
  // KRKG-0046: verifies only that a signed-in session exists - no allowlist check. Used by the
  // two membership endpoints (/membership/whoami, /membership/apply) that must be reachable by
  // any Google identity, member or not, since establishing membership is exactly their purpose.
  authenticateSessionOnly: (req: IncomingMessage, res: ServerResponse) => Promise<SessionClaims>;
  sessionSigningKeys: SessionSigningKey[];
  sessionSlidingWindowMs: number;
  sessionMaxLifetimeMs: number;
  reauthFreshnessWindowMs: number;
  submissionTokenSecret: string;
  driveParentFolderId: string;
  // Maps a doc "key" (the ?key= query param on GET /wojownicy-docs) to its Google Doc file ID -
  // see config.ts's wojownicyDocs for which keys currently exist.
  wojownicyDocs: Record<string, string>;
  allowedOrigin: string;
  maxFileBytes: number;
  maxFilesPerSubmission: number;
  allowedMimeTypes: string[];
  maxJsonBodyBytes: number;
  // How long a /galleries response is served from the in-process cache before the next
  // request triggers a fresh Drive listing. Bounds Drive API call volume to roughly
  // (site traffic / this TTL) regardless of how many visitors load the gallery list, instead
  // of one live Drive call per page view.
  galleriesCacheTtlMs: number;
  // The live email list behind `authenticate`/`authenticateWojownicyUpload` (both share one
  // allowlist - see productionDeps below), for GET /members/directory to enumerate: everyone
  // with site access, not just those who happen to have a members/{email} Firestore doc yet.
  listMemberEmails: () => Promise<string[]>;
  // KRKG-0065: the kruki Google Group's raw, unfiltered current membership (via the same
  // createAppsScriptAllowlist mechanism KRKG-0046 stopped using for authorization), for Zarządzanie
  // ludźmi's on-demand drift check against Firestore's active members - never used to gate access.
  listGroupEmails: () => Promise<string[]>;
  // KRKG-0046: Google Sheets disaster-recovery backup of the members collection. Never a runtime
  // fallback for authorization - see sheets.ts's SheetsClient doc comment.
  sheetsClient: SheetsClient;
  // KRKG-0050: Cloud Scheduler's own OIDC-authenticated service account, and the audience its
  // token must be issued for - see config.ts's matching comment. Both undefined until the
  // Scheduler job is separately provisioned (reconciler-runbook.md); the reconcile route fails
  // closed (503) rather than either booting unauthenticated or refusing to boot.
  auditReconcilerServiceAccountEmail?: string;
  auditReconcileAudience?: string;
}

type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A Firestore route's reviewed set of canonical actions. */
export interface AuditedMutationRouteDescriptor<Actions extends readonly AuditAction[] = readonly AuditAction[]> {
  method: MutationMethod;
  path: string;
  actions: Actions;
}

function auditedRoute<const Actions extends readonly AuditAction[]>(
  method: MutationMethod,
  path: string,
  actions: Actions,
): AuditedMutationRouteDescriptor<Actions> {
  return { method, path, actions };
}

/**
 * Batch 2's Firestore-owned mutation inventory. A handler must use its own descriptor through
 * executeDeclaredAuditedMutation, so a typo or an action borrowed from another route fails
 * before either the business document or immutable evidence can be committed.
 */
export const AUDITED_MEMBER_MUTATION_ROUTES = {
  membershipApply: auditedRoute('POST', '/membership/apply', ['membership.application.submitted']),
  memberTransition: auditedRoute('POST', '/admin/members/transition', [
    'membership.status.approved',
    'membership.status.rejected',
    'membership.status.suspended',
    'membership.status.reactivated',
    'membership.status.removed',
  ]),
  memberDriveFolder: auditedRoute('PUT', '/admin/members/drive-folder', ['profile.drive_folder.changed']),
  memberProfile: auditedRoute('PUT', '/admin/members/profile', ['profile.member.updated']),
  roles: auditedRoute('PUT', '/admin/roles', ['role.granted', 'role.revoked', 'role.replaced']),
  tripMember: auditedRoute('PUT', '/lista-wyjazdowa/member', ['profile.member.updated']),
  tripProfile: auditedRoute('PUT', '/lista-wyjazdowa/profile', ['profile.member.updated']),
  eventCreate: auditedRoute('POST', '/lista-wyjazdowa/events', ['event.created']),
  eventUpdate: auditedRoute('PUT', '/lista-wyjazdowa/events', ['event.updated', 'event.cancelled', 'dues.event_fee.changed']),
  signup: auditedRoute('PUT', '/lista-wyjazdowa/signups', ['signup.created', 'signup.updated']),
  signupFee: auditedRoute('PUT', '/lista-wyjazdowa/signups/skladka', ['dues.event_fee.changed']),
  entryFee: auditedRoute('PUT', '/lista-wyjazdowa/wpisowe', ['dues.entry_fee.changed']),
  annualDues: auditedRoute('PUT', '/lista-wyjazdowa/dues', ['dues.annual.changed']),
} as const;

export const AUDITED_MEMBER_MUTATION_ROUTE_DESCRIPTORS = Object.values(AUDITED_MEMBER_MUTATION_ROUTES);

/** Returns the descriptor only for a Batch-2 Firestore mutation route. */
export function findAuditedMemberMutationRoute(method: string, path: string): AuditedMutationRouteDescriptor | undefined {
  return AUDITED_MEMBER_MUTATION_ROUTE_DESCRIPTORS.find(route => route.method === method && route.path === path);
}

async function executeDeclaredAuditedMutation<T, Actions extends readonly AuditAction[]>(
  deps: ServerDeps,
  descriptor: AuditedMutationRouteDescriptor<Actions>,
  action: Actions[number] | readonly Actions[number][],
  input:
    | Omit<CanonicalAuditEventInput, 'action'>
    | readonly Omit<CanonicalAuditEventInput, 'action'>[]
    | ((tx: FirestoreTransaction) => Promise<Omit<CanonicalAuditEventInput, 'action'> | readonly Omit<CanonicalAuditEventInput, 'action'>[]>),
  mutation: (tx: FirestoreTransaction) => Promise<T>,
): ReturnType<typeof executeAuditedFirestoreMutation<T>> {
  const actions = Array.isArray(action) ? action : [action];
  if (actions.some(candidate => !(descriptor.actions as readonly AuditAction[]).includes(candidate))) {
    throw new Error(`Undeclared audit action for ${descriptor.method} ${descriptor.path}.`);
  }
  const withAction = typeof input === 'function'
    ? async (tx: FirestoreTransaction) => {
        const resolvedInput = await input(tx);
        const inputs = Array.isArray(resolvedInput) ? resolvedInput : [resolvedInput];
        if (inputs.length !== actions.length) throw new Error(`Audit input count does not match actions for ${descriptor.method} ${descriptor.path}.`);
        return inputs.map((auditInput, index) => ({ action: actions[index], ...auditInput }));
      }
    : (() => {
        const inputs = Array.isArray(input) ? input : [input];
        if (inputs.length !== actions.length) throw new Error(`Audit input count does not match actions for ${descriptor.method} ${descriptor.path}.`);
        return inputs.map((auditInput, index) => ({ action: actions[index], ...auditInput }));
      })();
  return executeAuditedFirestoreMutation(deps.firestore, withAction, mutation);
}

// Per-folder exact file-count reservation, in-process. This is what actually enforces
// maxFilesPerSubmission under concurrency - it is only correct because Cloud Run runs a
// single instance (Task 9's --max-instances=1), which makes this module-level state
// authoritative for the whole service, not just one of several replicas. A per-folder async
// lock serializes the check-and-increment (not the slow upload itself) so concurrent requests
// to the SAME folder can't both read a stale count before either has incremented it - the
// earlier version of this check subtracted a fixed margin instead and trusted the frontend's
// own upload concurrency as if that were an enforceable boundary, which it wasn't: nothing
// stops a valid caller from issuing far more concurrent requests directly.
const activeSubmissionCounts = new Map<string, number>();
// Keyed by plain folderId for reserveUploadSlot's own lock, and by a more specific
// `dup:<folderId>:<name>:<size>:<mtime>` key for the per-file dedupe lock further below - an
// unbounded key space (one entry per photo ever uploaded, for the lifetime of a long-lived Cloud
// Run instance) unless each entry is removed once it's no longer needed, which is exactly what
// the cleanup at the end of withFolderLock does.
const folderLocks = new Map<string, Promise<unknown>>();

function withFolderLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = folderLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const queued = next.then(
    () => undefined,
    () => undefined,
  );
  folderLocks.set(key, queued);
  // Only removed if this is still the most recently queued entry for `key` - a call made while
  // this one was in flight would have already replaced it with its own, still-pending entry,
  // which must be left alone.
  queued.then(() => {
    if (folderLocks.get(key) === queued) {
      folderLocks.delete(key);
    }
  });
  return next;
}

export function getFolderLockKeyCountForTests(): number {
  return folderLocks.size;
}

// Reserves one slot for folderId if the folder is under the cap, seeding the counter from a
// real Drive listing the first time this instance sees the folder (so a submission resumed
// after an instance restart doesn't under-count files already uploaded before the restart).
async function reserveUploadSlot(
  drive: DriveClient,
  folderId: string,
  maxFilesPerSubmission: number,
): Promise<boolean> {
  return withFolderLock(folderId, async () => {
    let current = activeSubmissionCounts.get(folderId);
    if (current === undefined) {
      const existing = await drive.listFiles(folderId);
      current = existing.length;
    }
    if (current >= maxFilesPerSubmission) {
      activeSubmissionCounts.set(folderId, current);
      return false;
    }
    activeSubmissionCounts.set(folderId, current + 1);
    return true;
  });
}

// Releases a slot reserved by reserveUploadSlot when the upload it was reserved for ultimately
// fails, so a legitimate retry for the same folder isn't blocked by someone else's failure.
function releaseUploadSlot(folderId: string): void {
  const current = activeSubmissionCounts.get(folderId);
  if (current !== undefined && current > 0) {
    activeSubmissionCounts.set(folderId, current - 1);
  }
}

// Same in-process, single-instance approach as activeSubmissionCounts above, this time tracking
// exact (name, size, original-mtime) triples already in the folder - so an upload of a file
// that's already there can be skipped outright, without ever reading its body. /status already
// does an equivalent check client-side, but only within one submission the browser still
// remembers via localStorage; this closes the same gap server-side for every other case too (a
// second submission with no local upload-state - a different device, cleared storage, or someone
// re-selecting the same files) - Drive itself happily keeps two files with an identical name, so
// without this a repeat submission would just double every photo it repeats.
//
// EXPLICIT SCOPE DECISION: identity here is metadata (name, size, and the source file's own
// last-modified time - see uploadFileStream's originalModifiedMs), never the file's actual
// bytes. Two genuinely different files could in theory share all three and get de-duplicated
// wrongly; reading/hashing every uploaded file's content to rule that out was considered and
// rejected as too costly for what this guards against (accidental re-submission of the same
// batch), not a security boundary. If that trade-off ever stops being acceptable, a content hash
// is the fix - not a fourth metadata field.
const folderKnownFileKeys = new Map<string, Set<string>>();

// modifiedMs is the source file's own last-modified time in epoch ms (undefined when the client
// or a pre-existing Drive file doesn't have one) - rounded to whole seconds since Drive doesn't
// guarantee to echo back the exact millisecond it was given.
function fileKeyFor(name: string, size: number, modifiedMs: number | undefined): string {
  const modifiedPart = modifiedMs !== undefined ? `:${Math.floor(modifiedMs / 1000)}` : '';
  return `${name}:${size}${modifiedPart}`;
}

// Who uploaded which photo, and when - shown as "Dodane przez" in the gallery's detail/lightbox
// view (see GET /gallery-photos/uploaders). Stored as one small JSON file per gallery folder
// (UPLOAD_LOG_FILE_NAME, via the existing generic readTextFile/writeTextFile - no new Drive
// plumbing needed) rather than per-file Drive `properties`, which cap each value at 124 bytes -
// too tight to reliably hold a Google profile picture URL.
export interface UploadAttribution {
  fileId: string;
  email: string;
  name?: string;
  picture?: string;
  uploadedAt: string;
}

const UPLOAD_LOG_FILE_NAME = '.uploads.json';

async function readUploadLog(drive: DriveClient, folderId: string): Promise<UploadAttribution[]> {
  const raw = await drive.readTextFile(folderId, UPLOAD_LOG_FILE_NAME);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Serialized per folder via withFolderLock (the same lock reserveUploadSlot uses) - concurrent
// uploads to the same gallery would otherwise race on this read-modify-write and silently drop
// entries.
function appendUploadAttribution(drive: DriveClient, folderId: string, entry: UploadAttribution): Promise<void> {
  return withFolderLock(folderId, async () => {
    const log = await readUploadLog(drive, folderId);
    log.push(entry);
    await drive.writeTextFile(folderId, UPLOAD_LOG_FILE_NAME, JSON.stringify(log));
  });
}

function setCors(res: ServerResponse, allowedOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Submission-Token');
  // Required for the browser to send/receive the session cookie on a credentials: "include"
  // fetch from www.kruki.org to api.kruki.org (cross-origin, though same-site) - safe alongside
  // an exact single origin above, never a wildcard (the spec forbids combining the two anyway).
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// __Host- is a browser-enforced guarantee that this cookie can only have been set by this exact
// host over HTTPS with Path=/ and no Domain attribute - see design-v2.md Phase 1 point 5 for why
// that's preferable to a broader Domain=kruki.org cookie. SameSite=Lax rather than Strict: same-
// site fetches (www.kruki.org -> api.kruki.org) get the cookie either way since only genuinely
// cross-site requests are restricted, and Lax also covers a top-level navigation landing here.
const SESSION_COOKIE_NAME = '__Host-session';

function setSessionCookie(res: ServerResponse, token: string, maxAgeMs: number): void {
  const maxAgeSeconds = Math.max(0, Math.floor(maxAgeMs / 1000));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// CSRF defense for cookie-authenticated endpoints (design-v2.md "CSRF - one mandatory rule").
// Applied here first, since /session/login and /session/logout are the only endpoints that
// set/clear the session cookie so far - a request authenticated by a bearer header an
// attacker's page can neither read nor attach isn't CSRF-exploitable the way an auto-sent
// cookie is, so the rest of the state-changing routes only need this once they move off
// bearer-token auth onto the cookie (batch 4/5). A cross-origin POST with a CORS-safelisted
// Content-Type (e.g. text/plain) never triggers a preflight, so CORS alone does not block it -
// this is a separate, mandatory check, not redundant with setCors above.
function requireAllowedOrigin(req: IncomingMessage, allowedOrigin: string): void {
  const origin = req.headers.origin;
  // Neither endpoint this guards is ever meant to be reached by a top-level navigation or
  // classic form submit (both are fetch() calls from the frontend's own JS, which always sends
  // Origin on a state-changing request) - fail closed on a missing header rather than treat it
  // as same-origin.
  if (!origin || origin !== allowedOrigin) {
    throw new AuthError('Żądanie z niedozwolonego źródła.', 403);
  }
}

export function readSessionCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

export interface SessionVerifyConfig {
  sessionSigningKeys: SessionSigningKey[];
  sessionSlidingWindowMs: number;
  sessionMaxLifetimeMs: number;
}

// The cookie-based counterpart to auth.ts's verifyUploader: verify identity from the session
// cookie, apply the same live allowlist check every bearer-token route already does today, and
// only then renew the cookie on the response if the sliding window is due (design-v2.md Phase 1
// point 7-8) - in that order deliberately, so a revoked member's 403 never carries an extended
// Set-Cookie alongside it. Not yet wired into ServerDeps or the route dispatch - this is the
// composition a route handler will call once the Phase 1 cutover replaces authenticate*
// (KRKG-0036), built and tested standalone first like every earlier Phase 1 piece.
//
// Generalizes the list-shaped SheetAllowlist for callers that only need an authorization
// decision for one identity, not the full list - specifically so a single-document Firestore
// read (createFirestoreMemberAuthorizer, KRKG-0046) doesn't have to pretend to be a "fetch
// everyone" source just to fit the old shape. verifySessionRequest/withStepUp take this instead
// of SheetAllowlist directly.
export interface Authorizer {
  authorize(identity: { sub: string; email: string }, options?: { forceRefresh?: boolean }): Promise<void>;
}

// Adapts an existing list-shaped SheetAllowlist (the Sheet CSV / Apps Script Group sources) into
// an Authorizer - unchanged behavior for authenticateAdmin, which only has a "fetch the whole
// list" source to work with (a Sheet export).
export function fromAllowlist(allowlist: SheetAllowlist): Authorizer {
  return {
    async authorize(identity, options) {
      const allowedEmails = await allowlist.getEmails(options);
      checkAllowlist(identity, allowedEmails);
    },
  };
}

// KRKG-0049: succeeds if ANY of the given Authorizers succeeds (e.g. admin-allowlist OR Firestore
// 'moderator' role for authenticateAdminOrModerator), trying each in order and rejecting only
// once every one has - the error surfaced is the last one's, an arbitrary but harmless choice
// since none of today's callers inspect the message beyond its 4xx status.
export function anyOf(...authorizers: Authorizer[]): Authorizer {
  return {
    async authorize(identity, options) {
      let lastError: unknown;
      for (const authorizer of authorizers) {
        try {
          await authorizer.authorize(identity, options);
          return;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    },
  };
}

// Returns the full SessionClaims (a superset of VerifiedIdentity) rather than narrowing to
// {sub, email), so a caller that also needs the step-up guard (checkReauthFreshness, from
// session.ts) has reauthAt available without a second cookie read/verify.
export async function verifySessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: SessionVerifyConfig,
  authorizer: Authorizer,
  options: { forceRefresh?: boolean } = {},
): Promise<SessionClaims> {
  const token = readSessionCookie(req);
  if (!token) {
    throw new AuthError('Brak sesji. Zaloguj się ponownie.', 401);
  }
  const now = Date.now();
  const claims = verifySessionToken(token, config.sessionSigningKeys, now, config.sessionMaxLifetimeMs);
  // Authorization before renewal, deliberately: a revoked member must not receive an extended
  // Set-Cookie on the very same 403 that rejects them.
  await authorizer.authorize({ sub: claims.sub, email: claims.email }, options);
  const renewed = maybeRenewSessionToken(claims, config.sessionSigningKeys[0], now, config.sessionSlidingWindowMs, config.sessionMaxLifetimeMs);
  if (renewed) {
    setSessionCookie(res, renewed.token, renewed.exp - now);
  }
  return claims;
}

// Verifies only that a signed, unexpired session cookie exists - no allowlist check at all.
// Deliberately NOT built by delegating into verifySessionRequest with an always-true allowlist:
// verifySessionRequest's ordering (authorize-then-renew) exists specifically so a revoked
// member's 403 never carries an extended Set-Cookie - that invariant doesn't apply here since
// there's nothing to authorize, so this renews unconditionally. Used only by the two KRKG-0046
// membership endpoints reachable by a not-yet-approved applicant.
export async function verifySessionOnly(
  req: IncomingMessage,
  res: ServerResponse,
  config: SessionVerifyConfig,
): Promise<SessionClaims> {
  const token = readSessionCookie(req);
  if (!token) {
    throw new AuthError('Brak sesji. Zaloguj się ponownie.', 401);
  }
  const now = Date.now();
  const claims = verifySessionToken(token, config.sessionSigningKeys, now, config.sessionMaxLifetimeMs);
  const renewed = maybeRenewSessionToken(claims, config.sessionSigningKeys[0], now, config.sessionSlidingWindowMs, config.sessionMaxLifetimeMs);
  if (renewed) {
    setSessionCookie(res, renewed.token, renewed.exp - now);
  }
  return claims;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Every /*whoami endpoint's response shape - name/picture included whenever the identity has
// them so the frontend's nav avatar (previously read straight off the locally-decoded Google
// JWT) has something to render from a page-load session check too, now that there's no
// client-readable token to decode any of this from directly.
function identityResponseBody(identity: { email: string; name?: string; picture?: string }): Record<string, string> {
  return {
    email: identity.email,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.picture ? { picture: identity.picture } : {}),
  };
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new AuthError(`Treść żądania przekracza maksymalny dozwolony rozmiar (${maxBytes} B).`, 413);
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function requireSubmissionToken(req: IncomingMessage): string {
  const header = req.headers['x-submission-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) throw new AuthError('Brak nagłówka X-Submission-Token.', 401);
  return token;
}

function requireAllowedMimeType(mimeType: string, allowedMimeTypes: string[]): void {
  if (!allowedMimeTypes.includes(mimeType)) {
    throw new AuthError(`Niedozwolony typ pliku: ${mimeType}.`, 400);
  }
}

// Discards a request body nothing is going to read (the duplicate-upload skip path below never
// calls validatedUploadStream) - without this, the still-incoming bytes sit unread on the
// connection, which can retain buffered data and stall reuse of a keep-alive socket under
// repeated duplicate uploads.
function drainRequestBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => {});
    req.on('end', resolve);
    req.on('error', reject);
    req.resume();
  });
}

// Reads the request stream, sniffs the first bytes against the declared MIME type before
// forwarding anything, and aborts as soon as more than maxBytes have been read - so an
// oversized or mislabeled file is rejected mid-stream, never fully buffered or written to Drive.
async function* validatedUploadStream(
  req: IncomingMessage,
  maxBytes: number,
  declaredMimeType: string,
): AsyncGenerator<Buffer> {
  const iterator = req[Symbol.asyncIterator]();
  let peek = Buffer.alloc(0);
  let total = 0;
  let done = false;

  while (peek.length < SNIFF_BYTES && !done) {
    const next = await iterator.next();
    done = Boolean(next.done);
    if (next.value) {
      const chunk = next.value as Buffer;
      total += chunk.length;
      if (total > maxBytes) {
        throw new AuthError(`Plik przekracza maksymalny dozwolony rozmiar (${Math.floor(maxBytes / 1024 / 1024)} MB).`, 413);
      }
      peek = Buffer.concat([peek, chunk]);
    }
  }

  const sniffed = sniffImageMimeType(peek);
  if (!sniffed || !mimeTypesEquivalent(sniffed, declaredMimeType)) {
    throw new AuthError('Zawartość pliku nie pasuje do zadeklarowanego typu obrazu.', 400);
  }

  yield peek;

  while (!done) {
    const next = await iterator.next();
    done = Boolean(next.done);
    if (next.value) {
      const chunk = next.value as Buffer;
      total += chunk.length;
      if (total > maxBytes) {
        throw new AuthError(`Plik przekracza maksymalny dozwolony rozmiar (${Math.floor(maxBytes / 1024 / 1024)} MB).`, 413);
      }
      yield chunk;
    }
  }
}

async function handleWhoami(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  sendJson(res, 200, identityResponseBody(identity));
}

// KRKG-0046: the only two routes reachable by a signed-in visitor who is not (yet) an active
// member - authenticateSessionOnly checks nothing but the session cookie itself.
async function handleMembershipWhoami(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateSessionOnly(req, res);
  const member = await getMember(deps.firestore, identity.email);
  sendJson(res, 200, { email: identity.email, status: member?.status ?? null });
}

// Deliberately narrower than GET /lista-wyjazdowa/lookup-lists (which requires active
// membership) - the "Zgłoś się" form needs the Sekcja dropdown *before* the visitor is a member,
// so this exposes only the one list that form needs, not weapons/categories too.
async function handleMembershipSections(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateSessionOnly(req, res);
  const sections = await getLookupList(deps.firestore, 'sections');
  sendJson(res, 200, { sections });
}

async function handleMembershipApply(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateSessionOnly(req, res);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  const fullNameInput = optionalTrimmedString(
    body.fullName,
    LW_MAX_NAME_LENGTH,
    `Imię i nazwisko może mieć najwyżej ${LW_MAX_NAME_LENGTH} znaków.`,
  );
  const nicknameInput = optionalTrimmedString(
    body.nickname,
    LW_MAX_NAME_LENGTH,
    `Ksywa może mieć najwyżej ${LW_MAX_NAME_LENGTH} znaków.`,
  );
  const fullName = fullNameInput ?? nicknameInput;
  if (fullName === null) {
    throw new AuthError('Podaj Imię i nazwisko lub Ksywę.', 400);
  }
  const sectionId = requireTrimmedString(body.sectionId, LW_MAX_NAME_LENGTH, 'Sekcja jest wymagana.');
  const lookupLists = await getAllLookupLists(deps.firestore);
  requireKnownLookupId(lookupLists.sections, sectionId, 'Wybrana sekcja nie istnieje.');
  const { result: member } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.membershipApply,
    'membership.application.submitted',
    async tx => {
      const existing = await tx.getDoc<MemberDoc>('members', identity.email.toLowerCase());
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${identity.email.toLowerCase()}`, display: 'member' },
        changes: [{ field: 'status', ...(existing ? { before: existing.status } : {}), after: 'pending' }],
      };
    },
    tx => applyForMembershipInTransaction(tx, identity.email, { fullName, nickname: nicknameInput, sectionId }),
  );
  sendJson(res, 200, { member });
}

// Exchanges a raw Google ID token (verified once, here) for a first-party session cookie -
// see design-v2.md Phase 1 points 1-6. Not yet used by any route's authentication (that's the
// Phase 1 cutover batch): existing routes still check the Authorization header exactly as
// before this endpoint existed.
async function handleSessionLogin(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const { idToken } = await readJsonBody<{ idToken?: string }>(req, deps.maxJsonBodyBytes);
  if (!idToken) throw new AuthError('Brak tokenu Google ID.', 400);
  const identity = await deps.authenticateSessionLogin(idToken);
  await executeAuditedFirestoreMutation(
    deps.firestore,
    {
      action: 'session.login.succeeded',
      actor: { email: identity.email },
      resource: { kind: 'session', key: `session:${identity.email.toLowerCase()}`, display: identity.email.toLowerCase() },
      changes: [{ field: 'status', after: 'succeeded' }],
    },
    async tx => recordLastLogin(tx, identity.email),
  );
  const now = Date.now();
  const token = issueSessionToken(identity, deps.sessionSigningKeys[0], now, deps.sessionSlidingWindowMs);
  setSessionCookie(res, token, deps.sessionSlidingWindowMs);
  sendJson(res, 200, identityResponseBody(identity));
}

/** Records the browser-confirmed PWA installation once per signed-in member and fixed app id. */
async function handlePwaInstallation(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const email = identity.email.toLowerCase();
  const markerId = `pwa:${email}`;
  const recorded = await deps.firestore.runTransaction(async tx => {
    const existing = await tx.getDoc('applicationInstallations', markerId);
    if (existing) return false;
    const auditEvent = createCanonicalAuditEvent({
      action: 'application.pwa.installation_reported',
      actor: { email },
      resource: { kind: 'application', key: `application:${email}:/`, display: email },
      changes: [{ field: 'appId', after: '/' }],
    });
    await tx.createDoc('applicationInstallations', markerId, { actorEmail: email, appId: '/' });
    await tx.createDoc('auditEvents', auditEvent.id, auditEvent);
    return true;
  });
  sendJson(res, 200, { recorded });
}

// Stateless design (see design-v2.md Phase 1 point 10) - this clears the cookie on this device
// only, it does not revoke the token server-side. Idempotent and unauthenticated on purpose:
// calling it with no session, or an already-invalid one, is still a successful logout.
async function handleSessionLogout(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

export interface GalleryListItem {
  id: string;
  name: string;
  date: string;
  contributors: string[];
  coverThumbnailLink: string | null;
}

// Single in-process cache shared by every request, same reasoning as activeSubmissionCounts
// above: Cloud Run runs a single instance for this service, so this is authoritative rather
// than an approximation that would go stale across replicas.
let galleriesCache: { expiresAt: number; data: GalleryListItem[] } | null = null;

async function buildGalleryList(deps: ServerDeps): Promise<GalleryListItem[]> {
  const folders = await deps.drive.listGalleryFolders(deps.driveParentFolderId);
  return Promise.all(
    folders.map(async folder => {
      const [manifest, coverThumbnailLink] = await Promise.all([
        deps.drive.readManifest(folder.id),
        deps.drive.getCoverThumbnail(folder.id),
      ]);
      return {
        id: folder.id,
        name: manifest?.name ?? folder.name,
        date: manifest?.date ?? folder.modifiedTime,
        contributors: manifest?.contributors ?? [],
        coverThumbnailLink,
      };
    }),
  );
}

// Requires the same kruki-group sign-in as upload/register (KRKG-0031) - previously
// unauthenticated, like the static albums.generated.json it's replacing for Drive galleries,
// but each gallery's `contributors` is a list of real email addresses, so a fully public,
// unauthenticated endpoint was handing that out to anyone on the internet. Gating it narrows
// that to signed-in kruki-group members, who already know each other. The cache above is what
// keeps this from becoming a live-Drive-call-per-request once a caller is past that gate.
async function handleGalleries(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticate(req, res);
  const now = Date.now();
  if (!galleriesCache || galleriesCache.expiresAt <= now) {
    const data = await buildGalleryList(deps);
    galleriesCache = { expiresAt: now + deps.galleriesCacheTtlMs, data };
  }
  sendJson(res, 200, { galleries: galleriesCache.data });
}

function parseAboutUsCategory(value: string | null): AboutUsCategory {
  if (!value || !isAboutUsCategory(value)) {
    throw new AuthError('Nieprawidłowa kategoria.', 400);
  }
  return value;
}

// Admin-only counterpart to parseAboutUsCategory - also accepts "upload" (see AdminDepartment),
// so the admin panel can list/manage the self-service submission queue the same way it does
// any real category. Never used by the public /about-us endpoint.
function parseAdminDepartment(value: string | null): AdminDepartment {
  if (!value || !isAdminDepartment(value)) {
    throw new AuthError('Nieprawidłowy dział.', 400);
  }
  return value;
}

async function handleAboutUs(res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const category = parseAboutUsCategory(url.searchParams.get('category'));
  const folders = await bootstrapAboutUsStructure(deps.drive);
  const people = await fetchCategoryPeople(deps.drive, folders.categories[category]);
  sendJson(res, 200, { people });
}

async function handleAdminWhoami(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdmin(req, res);
  sendJson(res, 200, identityResponseBody(identity));
}

// KRKG-0049: the Zarządzanie ludźmi page's own whoami, separate from /admin/whoami - a moderator
// (Firestore role, not necessarily on the admin allowlist) must see this one admin-panel page
// without the other three revealing themselves too. Drives both this page's own sign-in gate and
// nav.js's narrower visibility toggle for that one nav entry. Also reports isAdmin so the page can
// hide the Rola column/audit log for a plain moderator - role assignment stays admin-only
// (see ASSIGNABLE_ROLES/handleAdminSetRoles), and GET /admin/roles(+/audit-log) would just 403 for
// them, which would otherwise break Promise.all-loading the whole member list.
async function handleAdminMembersWhoami(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminOrModerator(req, res);
  let isAdmin = true;
  try {
    await deps.authenticateAdmin(req, res);
  } catch {
    isAdmin = false;
  }
  sendJson(res, 200, { ...identityResponseBody(identity), isAdmin });
}

// Not scoped to About Us specifically - clears the Instagram/Facebook posts cache so the
// homepage's Aktualności feed picks up new posts immediately, instead of waiting out the 6h TTL.
async function handleAdminRefreshSocialCache(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'site.social_cache.refreshed',
      actor: { email: identity.email },
      resource: { kind: 'settings', key: 'settings:social-media-cache', display: 'social-media-cache' },
      changes: [{ field: 'status', after: 'refreshed' }],
    },
    async () => { clearSocialMediaCache(); },
  );
  sendJson(res, 200, { ok: true });
}

async function handleAdminGetSettings(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req, res);
  const settings = await getFacebookSettings(deps.drive);
  sendJson(res, 200, settings);
}

async function handleAdminUpdateSettings(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { liveFetchPostCount } = await readJsonBody<{ liveFetchPostCount?: number }>(req, deps.maxJsonBodyBytes);
  const count = Number(liveFetchPostCount);
  await executeAuditedExternalMutation(deps.firestore, { action: 'site.settings.updated', actor: { email: identity.email }, resource: { kind: 'settings', key: 'settings:facebook', display: 'facebook' }, changes: [{ field: 'liveFetchPostCount', after: count }] }, async () => setFacebookSettings(deps.drive, { liveFetchPostCount: count }));
  sendJson(res, 200, { ok: true });
}

const MEMBERSHIP_STATUSES = ['pending', 'active', 'suspended', 'removed', 'rejected'] as const;

async function handleAdminListMembers(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdminOrModerator(req, res);
  const status = url.searchParams.get('status');
  if (!status || !(MEMBERSHIP_STATUSES as readonly string[]).includes(status)) {
    throw new AuthError('Nieprawidłowy status.', 400);
  }
  const members = await listMembersByStatus(deps.firestore, status as MembershipStatus);
  sendJson(res, 200, { members });
}

const ADMIN_TRANSITIONS = ['approve', 'reject', 'suspend', 'reactivate', 'remove'] as const;

// KRKG-0046: every transition re-syncs the *complete* current member list to the backup sheet,
// never just the one changed member - a partial sync would blank out everyone else's row (see
// design.md's Sheets failure/consistency contract and the plan review that caught this).
async function handleAdminMemberTransition(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminOrModeratorWithStepUp(req, res);
  const body = await readJsonBody<{ email?: string; transition?: string }>(req, deps.maxJsonBodyBytes);
  if (!body.email) throw new AuthError('Brak email.', 400);
  if (!body.transition || !(ADMIN_TRANSITIONS as readonly string[]).includes(body.transition)) {
    throw new AuthError('Nieprawidłowe przejście statusu.', 400);
  }
  const transition = body.transition as AdminTransition;
  const actionByTransition = {
    approve: 'membership.status.approved',
    reject: 'membership.status.rejected',
    suspend: 'membership.status.suspended',
    reactivate: 'membership.status.reactivated',
    remove: 'membership.status.removed',
  } as const;
  const { result: member } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.memberTransition,
    actionByTransition[transition],
    async tx => {
      const existing = await tx.getDoc<MemberDoc>('members', body.email!.toLowerCase());
      const statusByTransition = { approve: 'active', reject: 'rejected', suspend: 'suspended', reactivate: 'active', remove: 'removed' } as const;
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${body.email!.toLowerCase()}`, display: 'member' },
        changes: [{ field: 'status', before: existing?.status ?? null, after: statusByTransition[transition] }],
      };
    },
    tx => applyAdminTransitionInTransaction(tx, body.email!, transition, identity.email),
  );
  // Independent audited sub-operation, correlated to the transition above only by both sharing
  // this request - not by any shared transaction. The Firestore transition already committed
  // via executeDeclaredAuditedMutation, so a Sheets failure here must not roll back or discard
  // it. Unlike handleAdminMembersSynchronize's own identical Sheets call - which is genuinely
  // global/whole-list in scope and keeps the shared `member:sheet-backup` key - this sub-operation
  // is triggered by, and scoped to, one specific member's transition, so it is member-attributed
  // with that same member's own `member:{email}` resource key (plan-addendum.md), matching the
  // primary transition event's resource key above so it also surfaces in that member's own
  // Historia filter.
  const allMembers = await listAllMembers(deps.firestore);
  const { result: sheetSyncStatus } = await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'membership.sheet_backup.synchronized',
      actor: { email: identity.email },
      resource: { kind: 'member', key: `member:${body.email.toLowerCase()}`, display: body.email.toLowerCase() },
      changes: [{ field: 'sheetBackup', after: 'requested' }],
    },
    async () => deps.sheetsClient.syncAllMembers(allMembers),
    {
      eventInput: status => ({
        action: 'membership.sheet_backup.synchronized',
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${body.email!.toLowerCase()}`, display: body.email!.toLowerCase() },
        changes: [{ field: 'sheetBackup', after: status }],
      }),
    },
  );
  sendJson(res, 200, { member, sheetSyncStatus });
}

// Admin panel counterpart to KRKG-0037's deferred driveFolderId gap (design.md §2/§6): lets an
// admin link a member's account to a Drive folder that already exists under one of the public
// About-Us categories (Blachowi/Niewiasty/Emeryci/Kandydaci), instead of a manual Firestore
// console edit. folderId: null clears the link. Unlike the member-writable fields in
// MemberWritableFields, driveFolderId is deliberately not member-settable - this is the one
// admin-only write path for it (see setMemberDriveFolderId's comment).
async function handleAdminSetMemberDriveFolder(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminOrModeratorWithStepUp(req, res);
  const { email, folderId } = await readJsonBody<{ email?: string; folderId?: string | null }>(req, deps.maxJsonBodyBytes);
  if (!email) throw new AuthError('Brak email.', 400);
  const member = await getMember(deps.firestore, email);
  if (!member) throw new AuthError('Nie znaleziono takiego członka.', 404);
  await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.memberDriveFolder,
    'profile.drive_folder.changed',
    async tx => {
      const current = await tx.getDoc<MemberDoc>('members', email.toLowerCase());
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${email.toLowerCase()}`, display: 'member' },
        changes: [{ field: 'folderId', before: current?.driveFolderId ?? null, after: folderId ?? null }],
      };
    },
    tx => setMemberDriveFolderId(tx, email, folderId ?? null),
  );
  sendJson(res, 200, { ok: true });
}

async function handleAdminMembersSynchronize(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminOrModeratorWithStepUp(req, res);
  const allMembers = await listAllMembers(deps.firestore);
  const { result: sheetSyncStatus } = await executeAuditedExternalMutation(deps.firestore, { action: 'membership.sheet_backup.synchronized', actor: { email: identity.email }, resource: { kind: 'member', key: 'member:sheet-backup', display: 'sheet-backup' }, changes: [{ field: 'sheetBackup', after: 'requested' }] }, async () => deps.sheetsClient.syncAllMembers(allMembers), { eventInput: status => ({ action: 'membership.sheet_backup.synchronized', actor: { email: identity.email }, resource: { kind: 'member', key: 'member:sheet-backup', display: 'sheet-backup' }, changes: [{ field: 'sheetBackup', after: status }] }) });
  sendJson(res, 200, { sheetSyncStatus });
}

// KRKG-0065: read-only, on-demand comparison of the kruki Google Group's raw membership against
// Firestore's active members - the Group is now updated by hand as a secondary record (KRKG-0046
// moved actual authorization to Firestore), so this is purely a drift check for the admin to spot
// where the two have diverged, not an authorization path. No step-up: it reads two lists and
// returns a diff, nothing is mutated.
async function handleAdminMembersGroupSync(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdminOrModerator(req, res);
  const [groupEmails, firestoreEmails] = await Promise.all([deps.listGroupEmails(), deps.listMemberEmails()]);
  const groupSet = new Set(groupEmails);
  const firestoreSet = new Set(firestoreEmails);
  const onlyInFirestore = [...firestoreSet].filter(e => !groupSet.has(e)).sort();
  const onlyInGroup = [...groupSet].filter(e => !firestoreSet.has(e)).sort();
  sendJson(res, 200, { onlyInFirestore, onlyInGroup });
}

// KRKG-0049: lets the admin panel (Zarządzanie ludźmi page's Sekcja dropdown) read lookupLists
// without requiring kruki-group membership - GET /lista-wyjazdowa/lookup-lists needs
// authenticateWojownicyUpload, which an admin-allowlist/moderator account is not guaranteed to
// satisfy (the gates are deliberately independent, same reasoning as handleAdminUpdateMemberProfile
// existing instead of reusing the accountant-role-gated PUT /lista-wyjazdowa/member).
async function handleAdminGetLookupLists(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdminOrModerator(req, res);
  const lists = await getAllLookupLists(deps.firestore);
  sendJson(res, 200, lists);
}

// KRKG-0049: admin-only role assignment UI (Zarządzanie ludźmi page) - the first way to grant
// userRoles other than a direct Firestore-console edit. GET is a plain read (handleAdminListMembers
// pattern); PUT uses the step-up gate like the other admin mutations here, since granting 'admin'
// is the most privilege-sensitive write in this file.
async function handleAdminListRoles(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req, res);
  const roles = await listAllGrantedRoles(deps.firestore);
  sendJson(res, 200, { roles });
}

const ASSIGNABLE_ROLES = ['accountant', 'moderator', 'admin'] as const;

// A member can hold more than one of these at once (KRKG-0049) - mirrors
// zarzadzanie-ludzmi.js's ROLE_LABELS, for the audit entry's human-readable summary.
const ROLE_LABELS: Record<string, string> = { accountant: 'Księgowy', moderator: 'Moderator', admin: 'Admin' };

function rolesLabel(roles: string[]): string {
  if (!roles.length) return 'Brak';
  return roles.map((r) => ROLE_LABELS[r] ?? r).join(', ');
}

async function handleAdminSetRoles(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { email, roles } = await readJsonBody<{ email?: unknown; roles?: unknown }>(req, deps.maxJsonBodyBytes);
  if (typeof email !== 'string' || !email.trim()) throw new AuthError('Brak email.', 400);
  if (!Array.isArray(roles) || roles.some((r) => !(ASSIGNABLE_ROLES as readonly string[]).includes(r))) {
    throw new AuthError('Nieprawidłowa rola.', 400);
  }
  const newRoles = roles as string[];
  const previousRoles = await getGrantedRoles(deps.firestore, email);
  const action = previousRoles.length === 0 && newRoles.length > 0
    ? 'role.granted'
    : previousRoles.length > 0 && newRoles.length === 0
      ? 'role.revoked'
      : 'role.replaced';
  await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.roles,
    action,
    async tx => {
      const current = await tx.getDoc<{ roles: string[] }>('userRoles', email.toLowerCase());
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${email.toLowerCase()}`, display: 'target' },
        changes: [{ field: 'roles', before: rolesLabel(current?.roles ?? []), after: rolesLabel(newRoles) }],
      };
    },
    tx => setGrantedRoles(tx, email, newRoles),
  );
  sendJson(res, 200, { ok: true });
}

// Admin-only (KRKG-0049) - who has admin/accountant is itself sensitive, same reasoning as the
// dues audit log being accountant/admin-only rather than open to every signed-in member.
async function handleAdminListRolesAuditLog(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req, res);
  const entries = await listRoleAuditLog(deps.firestore);
  sendJson(res, 200, { entries });
}

async function handleAdminListRedirects(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req, res);
  const redirects = await deps.github.listRedirects();
  sendJson(res, 200, { redirects });
}

async function handleAdminCreateRedirect(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { path, target } = await readJsonBody<{ path?: string; target?: string }>(req, deps.maxJsonBodyBytes);
  const trimmedPath = (path ?? '').trim().toLowerCase();
  const trimmedTarget = (target ?? '').trim();
  if (!isValidRedirectPath(trimmedPath)) {
    throw new AuthError(
      'Alias musi się składać z małych liter, cyfr i myślników (np. "discord") i nie może być nazwą zarezerwowaną przez istniejącą stronę.',
      400,
    );
  }
  if (!isValidRedirectTarget(trimmedTarget)) {
    throw new AuthError('Docelowy adres musi być pełnym adresem URL zaczynającym się od http:// lub https://.', 400);
  }
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'site.redirect.created',
      actor: { email: identity.email },
      resource: { kind: 'redirect', key: `redirect:${trimmedPath}`, display: trimmedPath },
      changes: [{ field: 'path', after: trimmedPath }, { field: 'target', after: trimmedTarget }],
    },
    async () => deps.github.appendRedirectToMain({ path: trimmedPath, target: trimmedTarget }),
  );
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeleteRedirect(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const path = url.searchParams.get('path');
  if (!path) throw new AuthError('Brak aliasu.', 400);
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'site.redirect.deleted',
      actor: { email: identity.email },
      resource: { kind: 'redirect', key: `redirect:${path}`, display: path },
      changes: [{ field: 'path', after: path }],
    },
    async () => deps.github.removeRedirectFromMain(path),
  );
  sendJson(res, 200, { ok: true });
}

// Shared guard for the public, unauthenticated social-media GET endpoints - see rate-limit.ts
// for why they need one. Returns true (and has already written the 429 response) when the
// caller should stop, so route handlers below can `if (rejectIfRateLimited(...)) return;`... but
// since these live in a single if/else dispatch chain rather than their own functions, callers
// instead write `if (!rejectIfRateLimited(req, res)) await handleX(...)`.
function rejectIfRateLimited(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isRateLimited(getClientIp(req))) return false;
  sendJson(res, 429, { error: 'Zbyt wiele żądań, spróbuj ponownie za chwilę.' });
  return true;
}

async function handleAdminCreatePerson(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { category, name, order, description } = await readJsonBody<{
    category?: string;
    name?: string;
    order?: number | null;
    description?: string;
  }>(req, deps.maxJsonBodyBytes);
  const validCategory = parseAboutUsCategory(category ?? null);
  if (!name || !name.trim()) throw new AuthError('Brak imienia.', 400);

  const folderName = buildPersonFolderName(name, order ?? null);
  // Pre-effect resource protocol (implementation-contract.md): no final Drive folder id exists
  // before the effect runs, so the correlation id is generated first and used as the intent's
  // immutable provisional resource key - not the browser-supplied identity.sub, which isn't a
  // correlation id and isn't unique per attempt.
  const correlationId = randomUUID();
  const provisionalResourceKey = `person:pending:${correlationId}`;
  const { result: folderId } = await executeAuditedExternalMutation(deps.firestore, {
    action: 'profile.person.created', actor: { email: identity.email },
    resource: { kind: 'person', key: provisionalResourceKey, display: name.trim() },
    changes: [{ field: 'name', after: name.trim() }, { field: 'category', after: validCategory }],
  }, async () => {
    const folders = await bootstrapAboutUsStructure(deps.drive);
    const id = await deps.drive.createAlbumFolder(folders.categories[validCategory], folderName);
    if (description) await deps.drive.writeTextFile(id, 'Opis.txt', description);
    return id;
  }, {
    correlationId,
    provisionalResourceKey,
    eventInput: id => ({ action: 'profile.person.created', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${id}`, display: name.trim() }, changes: [{ field: 'name', after: name.trim() }, { field: 'category', after: validCategory }] }),
  });
  invalidateAboutUsCache();
  sendJson(res, 200, { folderId });
}

async function handleAdminUpdateDescription(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const { description } = await readJsonBody<{ description?: string }>(req, deps.maxJsonBodyBytes);
  const value = description ?? '';
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.description.updated', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'descriptionHash', after: createHash('sha256').update(value).digest('hex') }, { field: 'descriptionLength', after: value.length }] }, async () => deps.drive.writeTextFile(folderId, 'Opis.txt', value));
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeletePerson(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.deleted', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'folderId', after: folderId }] }, async () => deps.drive.deleteFolder(folderId));
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminListPeople(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req, res);
  const department = parseAdminDepartment(url.searchParams.get('category'));
  const folders = await bootstrapAboutUsStructure(deps.drive);
  const people = await fetchCategoryPeople(deps.drive, departmentFolderId(folders, department));
  sendJson(res, 200, { people });
}

// Renames the folder to reflect a new display order and/or name - the two always travel
// together (see buildPersonFolderName) so the admin panel sends both, even when only one
// actually changed, rather than this handler needing to fetch the current folder name first.
async function handleAdminUpdatePersonOrder(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { folderId, name, order } = await readJsonBody<{ folderId?: string; name?: string; order?: number | null }>(
    req,
    deps.maxJsonBodyBytes,
  );
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  if (!name || !name.trim()) throw new AuthError('Brak imienia.', 400);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.order.updated', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: name.trim() }, changes: [{ field: 'name', after: name.trim() }, { field: 'order', after: order ?? null }] }, async () => deps.drive.renameFolder(folderId, buildPersonFolderName(name, order ?? null)));
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Moves a person's folder into a different department (any of the 4 categories, "upload", or
// "deleted" - the admin panel's "remove from site" action, see AboutUsFolders.deletedRoot) -
// e.g. reviewing a self-service submission and moving it out of the staging folder into
// Niewiasty/Kandydaci/etc. Drive's own move semantics (addParents/removeParents) are handled in
// moveFolder; this just resolves the target department name to its folder id.
//
// Moving into one of the 4 *public* categories also reassigns the person's display order (see
// computeOrderForDepartmentMove): every department appends them at the end, except Emeryci,
// which prepends instead - by design, not something the admin panel asks for explicitly.
// "upload"/"deleted" skip this entirely since order is meaningless there.
async function handleAdminMovePerson(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { folderId, category } = await readJsonBody<{ folderId?: string; category?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const department = parseAdminDepartment(category ?? null);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.category.changed', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'category', after: department }] }, async () => {
    const folders = await bootstrapAboutUsStructure(deps.drive); const targetFolderId = departmentFolderId(folders, department); const { name: currentFolderName } = await deps.drive.moveFolder(folderId, targetFolderId);
    if (isAboutUsCategory(department)) { const siblings = await deps.drive.listGalleryFolders(targetFolderId); const newOrder = computeOrderForDepartmentMove(department, siblings.filter(f => f.id !== folderId).map(f => f.name)); const { name: personName } = parsePersonFolderName(currentFolderName); await deps.drive.renameFolder(folderId, buildPersonFolderName(personName, newOrder)); }
  });

  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminUploadPhoto(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const folderId = url.searchParams.get('folderId');
  const fileName = url.searchParams.get('fileName');
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  if (!folderId || !fileName) throw new AuthError('Brak folderId lub fileName.', 400);
  requireAllowedMimeType(mimeType, deps.allowedMimeTypes);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.photo.added', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'fileId', after: 'pending' }] }, async () => deps.drive.uploadFileStream(folderId, decodeURIComponent(fileName), mimeType, validatedUploadStream(req, deps.maxFileBytes, mimeType)), { eventInput: file => ({ action: 'profile.person.photo.added', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'fileId', after: file.id }] }) });
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeletePhoto(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const fileId = url.searchParams.get('fileId');
  // I4: this resource key must be `person:{folderId}`, matching photo.added/photo.main.changed/
  // in_memoriam.changed (the rest of this same person-photo action family) and the contract's
  // canonical `person:{personId}` notation - not the ad hoc `person:photo:{fileId}` it used
  // before, which isn't a notation the contract defines at all. folderId comes from the same
  // request-body/query source those sibling handlers use, supplied by the client the same way
  // (publiczne-wizytowki.js's delete-photo button now carries data-folder-id alongside
  // data-file-id).
  const folderId = url.searchParams.get('folderId');
  if (!fileId || !folderId) throw new AuthError('Brak fileId lub folderId.', 400);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.photo.deleted', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'fileId', after: fileId }] }, async () => deps.drive.deleteFolder(fileId));
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Designates one photo in a folder as the "main" one, by giving it (and only it) the leading
// "!" that fetchCategoryPeople's alphabetical sort relies on (see the comment on isMain in
// handleWojownicyUploadPhoto below for why "!" specifically) - strips the prefix from whatever
// other file currently has it first, so exactly one photo is ever marked main at a time.
async function handleAdminSetMainPhoto(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { folderId, fileId } = await readJsonBody<{ folderId?: string; fileId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId || !fileId) throw new AuthError('Brak folderId lub fileId.', 400);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.photo.main.changed', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'mainPhoto', after: fileId }] }, async () => { const images = await deps.drive.listImageFiles(folderId); for (const image of images) { const isTarget = image.id === fileId; const hasMainPrefix = image.name.startsWith('!'); if (isTarget && !hasMainPrefix) await deps.drive.renameFolder(image.id, `!${image.name}`); else if (!isTarget && hasMainPrefix) await deps.drive.renameFolder(image.id, image.name.slice(1)); } });
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Moves a single photo into a different person's folder - see moveFile in drive.ts for why
// (reviewing an upload-staging submission for someone who already has an existing profile).
//
// I4 (final review): a transfer must show up in BOTH people's own Historia, not only the
// destination's - the source person's photo genuinely left their folder, which is exactly the
// kind of change their own history should record. The source folder id isn't known until the
// Drive move itself reads the file's current parent (moveFile now returns it - see its comment
// in drive.ts), so the intent declared before the effect still only names the destination (the
// one resource identifier this handler already had up front); the second, source-keyed event is
// added only in the final `eventInput`, atomically alongside the destination event, via
// executeAuditedExternalMutation's array support (implementation-contract.md: "a single
// backwards-compatible request that changes more than one independent effect may atomically emit
// one event per effect"). If Drive reports no previous parent at all (shouldn't happen for a real
// photo, but not assumed), only the destination event is emitted - never a fabricated source key.
async function handleAdminTransferPhoto(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { fileId, targetFolderId } = await readJsonBody<{ fileId?: string; targetFolderId?: string }>(
    req,
    deps.maxJsonBodyBytes,
  );
  if (!fileId || !targetFolderId) throw new AuthError('Brak fileId lub targetFolderId.', 400);
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'profile.person.photo.transferred',
      actor: { email: identity.email },
      resource: { kind: 'person', key: `person:${targetFolderId}`, display: targetFolderId },
      changes: [{ field: 'fileId', after: fileId }, { field: 'folderId', after: targetFolderId }],
    },
    async () => deps.drive.moveFile(fileId, targetFolderId),
    {
      eventInput: ({ previousFolderId }) => {
        const destinationEvent: CanonicalAuditEventInput = {
          action: 'profile.person.photo.transferred',
          actor: { email: identity.email },
          resource: { kind: 'person', key: `person:${targetFolderId}`, display: targetFolderId },
          changes: [{ field: 'fileId', after: fileId }, { field: 'folderId', after: targetFolderId }],
        };
        if (!previousFolderId || previousFolderId === targetFolderId) return destinationEvent;
        const sourceEvent: CanonicalAuditEventInput = {
          action: 'profile.person.photo.transferred',
          actor: { email: identity.email },
          resource: { kind: 'person', key: `person:${previousFolderId}`, display: previousFolderId },
          changes: [{ field: 'fileId', before: fileId }, { field: 'folderId', after: targetFolderId }],
        };
        return [destinationEvent, sourceEvent];
      },
    },
  );
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Toggles the "Oznacz jako in memoriam" marker (see IN_MEMORIAM_FILE_NAME in about-us.ts) - the
// public site renders this person's photos grayscale with a black diagonal ribbon once set.
async function handleAdminSetInMemoriam(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { folderId, inMemoriam } = await readJsonBody<{ folderId?: string; inMemoriam?: boolean }>(req, deps.maxJsonBodyBytes);
  if (!folderId || typeof inMemoriam !== 'boolean') throw new AuthError('Brak folderId lub inMemoriam.', 400);
  await executeAuditedExternalMutation(deps.firestore, { action: 'profile.person.in_memoriam.changed', actor: { email: identity.email }, resource: { kind: 'person', key: `person:${folderId}`, display: folderId }, changes: [{ field: 'inMemoriam', after: inMemoriam }] }, async () => deps.drive.writeTextFile(folderId, IN_MEMORIAM_FILE_NAME, inMemoriam ? 'true' : 'false'));
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

const WOJOWNICY_UPLOAD_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function extensionForMimeType(mimeType: string): string {
  return WOJOWNICY_UPLOAD_MIME_EXTENSIONS[mimeType] ?? 'jpg';
}

async function handleWojownicyUploadWhoami(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  sendJson(res, 200, identityResponseBody(identity));
}

// Serves the live HTML export of one of the two Wojownicy-only Google Docs (Zasady Bractwa,
// Poradnik Walki) - same membership gate as the rest of /wojownicy-upload/*. Fetched fresh from
// Drive on every request (no on-disk/repo caching, deliberately - see config.ts's wojownicyDocs
// comment on why that matters here), so editing the Doc in Google is all it takes to update
// the page.
async function handleWojownicyDoc(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const key = url.searchParams.get('key');
  const fileId = key ? deps.wojownicyDocs[key] : undefined;
  if (!fileId) throw new AuthError('Nieznany dokument.', 404);
  const html = await deps.drive.exportDocHtml(fileId);
  sendJson(res, 200, { html });
}

// A member's driveFolderId (members.ts) is reusable for a new submission only while it is still
// sitting unreviewed in "upload" - once an admin approves it (moves it into a public category) or
// soft-deletes it, a further /profil/ photo edit must go through review again as a brand-new
// staging folder, not silently land in the already-public (or removed) one. Returns null if there
// is nothing reusable, in which case the caller creates a fresh folder exactly as before.
async function findReusableSubmissionFolder(
  deps: ServerDeps,
  member: MemberDoc | null,
  uploadRootId: string,
): Promise<string | null> {
  if (!member?.driveFolderId) return null;
  const [exists, parentId] = await Promise.all([
    deps.drive.folderExists(member.driveFolderId),
    deps.drive.getFolderParentId(member.driveFolderId),
  ]);
  if (!exists || parentId !== uploadRootId) return null;
  return member.driveFolderId;
}

// Creates the per-submission staging folder (Strona/O Nas/upload/{Imię} - {email} - {data}) and
// issues a submission token exactly like handleStart does for gallery uploads - the two photo
// endpoints below require it, so one group member can't upload into another's (or an admin
// category's) folder just by guessing/reusing a folderId.
//
// Idempotent per member (KRKG photo-duplication fix): a member who submits more than once while
// their previous submission is still pending reuses that same "upload" folder (see
// findReusableSubmissionFolder) instead of minting a new one every time - previously this always
// created a brand-new Drive folder/"person" on every call, so a member re-saving their profile
// (or retrying after a failed photo upload) accumulated multiple near-duplicate, mostly-empty
// entries in the admin's Upload (zgłoszenia) queue, exactly as reported.
async function handleWojownicyUploadSubmit(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const { name } = await readJsonBody<{ name?: string }>(req, deps.maxJsonBodyBytes);
  if (!name || !name.trim()) throw new AuthError('Brak imienia.', 400);

  const folders = await bootstrapAboutUsStructure(deps.drive);
  const member = await getMember(deps.firestore, identity.email);
  const reusableFolderId = await findReusableSubmissionFolder(deps, member, folders.uploadRoot);

  let folderId: string;
  if (reusableFolderId) {
    folderId = reusableFolderId;
  } else {
    const date = new Date().toISOString().slice(0, 10);
    const folderName = `${name.trim()} - ${identity.email} - ${date}`;
    // Pre-effect resource protocol - see the matching comment in handleAdminCreatePerson. Final
    // resource key format (member:{actorEmail}:submission:{folderId}) is
    // implementation-contract.md's "Pre-effect resource protocol" list, not the generic
    // person:{personId}/gallery:{folderId} notation.
    const correlationId = randomUUID();
    const provisionalResourceKey = `memberSubmission:pending:${correlationId}`;
    const { result: createdFolderId } = await executeAuditedExternalMutation(
      deps.firestore,
      {
        action: 'profile.photo_submission.created',
        actor: { email: identity.email },
        resource: { kind: 'memberSubmission', key: provisionalResourceKey, display: name.trim() },
        changes: [{ field: 'name', after: name.trim() }],
      },
      () => deps.drive.createAlbumFolder(folders.uploadRoot, folderName),
      {
        correlationId,
        provisionalResourceKey,
        eventInput: newFolderId => ({
          action: 'profile.photo_submission.created',
          actor: { email: identity.email },
          resource: { kind: 'memberSubmission', key: `member:${identity.email.toLowerCase()}:submission:${newFolderId}`, display: name.trim() },
          changes: [{ field: 'name', after: name.trim() }],
        }),
      },
    );
    folderId = createdFolderId;
    // Self-service linkage (KRKG-0037's deferred driveFolderId gap, design.md §6): the member's
    // own submission sets the link automatically, same field the admin panel's "link existing
    // folder" action (handleAdminSetMemberDriveFolder) also writes by hand. Only possible when a
    // members/{email} doc already exists - profil.js always PUTs /lista-wyjazdowa/member before
    // reaching this endpoint, but the older, unlinked /wojownicy/wrzuc/ page does not, so this is
    // skipped rather than thrown for that caller.
    if (member) {
      await setMemberDriveFolderId(deps.firestore, identity.email, folderId);
      await deps.drive.writeTextFile(folderId, '.owner-email', identity.email);
    }
    // The admin panel's Upload (zgłoszenia) list (fetchCategoryPeople) caches per category for up
    // to 6h - without this, a brand-new submission folder could stay invisible to an admin who
    // already had that page open/cached earlier in the day.
    invalidateAboutUsCache();
  }

  const submissionToken = issueSubmissionToken(
    { folderId, sub: identity.sub, exp: Date.now() + SUBMISSION_TTL_MS },
    deps.submissionTokenSecret,
  );
  sendJson(res, 200, { folderId, submissionToken });
}

// isMain=true renames whatever the browser called the file to "!main.<ext>" - every other photo
// keeps its own original name. The leading "!" is load-bearing, not decorative: about-us.ts's
// fetchCategoryPeople picks the *alphabetically first* file (Drive's orderBy=name) as the
// person's main photo, and a plain "main.<ext>" is not guaranteed to sort before an extra
// photo's original camera/phone filename (e.g. "IMG_1234.jpg" sorts before "main.jpg" - 'I' <
// 'm'), which was silently showing the wrong photo as the cover once moved into a public
// category. "!" sorts before every digit and letter, so this file always wins regardless of
// what the other photos happen to be named.
async function handleWojownicyUploadPhoto(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const folderId = url.searchParams.get('folderId');
  const fileName = url.searchParams.get('fileName');
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  const isMain = url.searchParams.get('isMain') === 'true';
  if (!folderId || !fileName) throw new AuthError('Brak folderId lub fileName.', 400);
  requireAllowedMimeType(mimeType, deps.allowedMimeTypes);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  const targetName = isMain ? `!main.${extensionForMimeType(mimeType)}` : decodeURIComponent(fileName);
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'profile.photo_submission.photo_added',
      actor: { email: identity.email },
      // I4: matches profile.photo_submission.created's own final resource key
      // (`member:{actorEmail}:submission:{folderId}`, implementation-contract.md's canonical
      // notation) - not the ad hoc `memberSubmission:{folderId}` this used before, which meant
      // the two halves of the same submission were unreachable via the same Historia/resourceKey
      // filter.
      resource: { kind: 'memberSubmission', key: `member:${identity.email.toLowerCase()}:submission:${folderId}`, display: folderId },
      changes: [{ field: 'fileId', after: 'pending' }],
    },
    async () => {
      const reserved = await reserveUploadSlot(deps.drive, folderId, deps.maxFilesPerSubmission);
      if (!reserved) {
        throw new AuthError(`Zgłoszenie osiągnęło maksymalną liczbę zdjęć (${deps.maxFilesPerSubmission}).`, 400);
      }
      try {
        return await deps.drive.uploadFileStream(
          folderId,
          targetName,
          mimeType,
          validatedUploadStream(req, deps.maxFileBytes, mimeType),
        );
      } catch (err) {
        releaseUploadSlot(folderId);
        throw err;
      }
    },
    {
      eventInput: uploaded => ({
        action: 'profile.photo_submission.photo_added',
        actor: { email: identity.email },
        // I4: matches profile.photo_submission.created's own final resource key
        // (`member:{actorEmail}:submission:{folderId}`, implementation-contract.md's canonical
        // notation) - not the ad hoc `memberSubmission:{folderId}` this used before, which meant
        // the two halves of the same submission were unreachable via the same Historia/resourceKey
        // filter.
        resource: { kind: 'memberSubmission', key: `member:${identity.email.toLowerCase()}:submission:${folderId}`, display: folderId },
        changes: [{ field: 'fileId', after: uploaded.id }],
      }),
    },
  );
  // Same reasoning as handleWojownicyUploadSubmit's cache invalidation: without it, a photo just
  // uploaded into an already-cached category (most commonly "upload" itself) can stay invisible
  // to an admin browsing that page for up to 6h.
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Lista Wyjazdowa (KRKG's trip-roster feature, Plan A) - same authenticateWojownicyUpload gate
// as the rest of this cluster (live kruki Google Group membership), since every route here
// reads or writes only the caller's own member/profile record, keyed by their session email.

// Free-text length caps. maxJsonBodyBytes already bounds a request as a whole; these keep a
// single field from being the thing that fills it, and keep the roster/summary views (Plan B)
// renderable.
const LW_MAX_NAME_LENGTH = 120;
const LW_MAX_DESCRIPTION_LENGTH = 500;

// The PUT bodies are untrusted JSON, not the typed shapes TypeScript's `Partial<...>` annotation
// pretends they are: without these guards a `{"equipment": "x"}` reaches saveProfile's `.map()`
// and surfaces as an uncaught 500 rather than a clean, Polish-language 400.
function requireTrimmedString(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== 'string') throw new AuthError(message, 400);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new AuthError(message, 400);
  return trimmed;
}

function optionalTrimmedString(value: unknown, maxLength: number, message: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireTrimmedString(value, maxLength, message);
}

// Absent means "nothing of this kind", which is a legitimate profile (no weapons yet, no camp
// equipment); anything present but non-array is a malformed request.
function requireArray(value: unknown, message: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AuthError(message, 400);
  return value;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AuthError(message, 400);
  return value as Record<string, unknown>;
}

// Referential integrity against lookupLists, which Firestore itself cannot enforce (no foreign
// keys - design.md §5). Without this a member can persist a sectionId that resolves to nothing,
// which would silently break Plan B's roster grouping by Sekcja. Retired items are accepted on
// purpose: "retired" withdraws a value from *new* selection in the UI, it does not invalidate
// the profiles already referencing it, so someone whose section was retired can still re-save.
function requireKnownLookupId(items: { id: string }[], id: string, message: string): void {
  if (!items.some((item) => item.id === id)) throw new AuthError(message, 400);
}

async function handleListaWyjazdowaGetMember(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const member = await getMember(deps.firestore, identity.email);
  sendJson(res, 200, { member });
}

// Shared by handleListaWyjazdowaPutMember (self-service + accountant/admin from Lista Członków)
// and handleAdminUpdateMemberProfile (admin panel's Spis Ludności page, KRKG-0049) - same field
// validation either way, only the auth gate and target-resolution differ.
async function parseMemberWritableFields(deps: ServerDeps, body: Record<string, unknown>): Promise<MemberWritableFields> {
  const fullNameInput = optionalTrimmedString(
    body.fullName,
    LW_MAX_NAME_LENGTH,
    `Imię i nazwisko może mieć najwyżej ${LW_MAX_NAME_LENGTH} znaków.`,
  );
  const nicknameInput = optionalTrimmedString(
    body.nickname,
    LW_MAX_NAME_LENGTH,
    `Ksywa może mieć najwyżej ${LW_MAX_NAME_LENGTH} znaków.`,
  );
  // Ksywa is never backfilled from Imię i nazwisko - it stays genuinely optional. Imię i
  // nazwisko falls back to Ksywa so a member who only gives one identifier still has a
  // non-empty fullName (used for the Drive folder name and any display that reads it
  // directly); if neither is given there is nothing to identify the member by at all.
  const fullName = fullNameInput ?? nicknameInput;
  if (fullName === null) {
    throw new AuthError('Podaj Imię i nazwisko lub Ksywę.', 400);
  }
  const fields: MemberWritableFields = {
    fullName,
    nickname: nicknameInput,
    sectionId: requireTrimmedString(body.sectionId, LW_MAX_NAME_LENGTH, 'Sekcja jest wymagana.'),
  };
  const lookupLists = await getAllLookupLists(deps.firestore);
  requireKnownLookupId(lookupLists.sections, fields.sectionId, 'Wybrana sekcja nie istnieje.');
  return fields;
}

// Self-service by default (targets the caller); an accountant/admin editing someone else's
// record from the Lista Członków page (KRKG-0047) passes ?memberEmail=, gated by requireRole -
// the same ?memberEmail= convention as the wpisowe/dues endpoints below, rather than a separate
// admin-only route, since the validation (name/nickname length, known sectionId) is identical
// either way.
async function handleListaWyjazdowaPutMember(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const targetEmailParam = url.searchParams.get('memberEmail');
  if (targetEmailParam) {
    await requireRole(deps.firestore, identity.email, 'accountant');
  }
  const targetEmail = targetEmailParam ?? identity.email;
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  const fields = await parseMemberWritableFields(deps, body);
  const { result: member } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.tripMember,
    'profile.member.updated',
    async tx => {
      const existing = await tx.getDoc<MemberDoc>('members', targetEmail.toLowerCase());
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${targetEmail.toLowerCase()}`, display: 'member' },
        changes: [
          { field: 'name', ...(existing ? { before: existing.fullName } : {}), after: fields.fullName },
          { field: 'nickname', ...(existing ? { before: existing.nickname } : {}), after: fields.nickname },
          { field: 'sectionId', ...(existing ? { before: existing.sectionId } : {}), after: fields.sectionId },
        ],
      };
    },
    tx => saveMember(tx, targetEmail, fields, identity.email),
  );
  sendJson(res, 200, { member });
}

// Admin-panel counterpart (KRKG-0049's Zarządzanie ludźmi page) to the accountant/admin-role-gated
// endpoint above - gated by the admin-or-moderator authorizer instead of requireRole('accountant'),
// matching every other member-editing action on that page (transition, drive-folder link).
// Requires the member to already exist, unlike handleListaWyjazdowaPutMember's self-service path,
// which may be creating a brand-new doc - an admin/moderator editing from a list of already-known
// members should never accidentally create one from a mistyped email.
//
// categoryId ("typ członka", KRKG-0050) is handled separately from parseMemberWritableFields on
// purpose: that helper is shared with the self-service PUT above, and categoryId is admin-owned
// only (design.md §7, same as driveFolderId) - self-service must never be able to set it. Omitting
// it from the body leaves it untouched (so older callers/tests that only ever sent
// fullName/nickname/sectionId keep working); the Zarządzanie ludźmi page always sends the row's
// current value alongside those on every save (see zarzadzanie-ludzmi.js's saveMemberProfileField),
// with null meaning "no type assigned" - same as sending an explicit null, not "leave unchanged".
async function handleAdminUpdateMemberProfile(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminOrModeratorWithStepUp(req, res);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  const email = body.email;
  if (typeof email !== 'string' || !email.trim()) throw new AuthError('Brak email.', 400);
  const existing = await getMember(deps.firestore, email);
  if (!existing) throw new AuthError('Nie znaleziono takiego członka.', 404);
  // fullName/nickname/sectionId are only validated-and-saved as a bundle when at least one of
  // them is actually present - same "send it or leave it untouched" shape as categoryId/hidden
  // below, so e.g. zarzadzanie-ludzmi.js's hidden checkbox can PUT { email, hidden } alone without
  // also having to resend (and re-pass validation for) the name/section fields already showing.
  const hasMemberFields = body.fullName !== undefined || body.nickname !== undefined || body.sectionId !== undefined;
  const fields = hasMemberFields ? await parseMemberWritableFields(deps, body) : undefined;
  let categoryId: string | null | undefined;
  if (body.categoryId !== undefined) {
    const categoryIdRaw = body.categoryId;
    if (categoryIdRaw !== null && typeof categoryIdRaw !== 'string') {
      throw new AuthError('Nieprawidłowy typ członka.', 400);
    }
    categoryId = categoryIdRaw === null || categoryIdRaw === '' ? null : categoryIdRaw;
    if (categoryId !== null) {
      const lookupLists = await getAllLookupLists(deps.firestore);
      requireKnownLookupId(lookupLists.categories, categoryId, 'Wybrany typ członka nie istnieje.');
    }
  }
  let hidden: boolean | undefined;
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') throw new AuthError('Nieprawidłowa wartość hidden.', 400);
    hidden = body.hidden;
  }
  if (!fields && categoryId === undefined && hidden === undefined) {
    sendJson(res, 200, { member: existing });
    return;
  }
  const { result: member } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.memberProfile,
    'profile.member.updated',
    async tx => {
      const current = await tx.getDoc<MemberDoc>('members', email.toLowerCase());
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${email.toLowerCase()}`, display: 'member' },
        changes: [
          ...(fields ? [
            { field: 'name', before: current?.fullName ?? null, after: fields.fullName },
            { field: 'nickname', before: current?.nickname ?? null, after: fields.nickname },
            { field: 'sectionId', before: current?.sectionId ?? null, after: fields.sectionId },
          ] : []),
          ...(categoryId !== undefined ? [{ field: 'category', before: current?.categoryId ?? null, after: categoryId }] : []),
          ...(hidden !== undefined ? [{ field: 'hidden', before: current?.hidden ?? false, after: hidden }] : []),
        ],
      };
    },
    async tx => {
      // Firestore transactions require every read to happen before any write - fetch the
      // current doc once up front and hand it to each helper below (via their `preloaded`
      // param) instead of letting saveMember/setMemberCategoryId/setMemberHidden each do their
      // own getDoc, which would interleave a read after an earlier helper's write and fail.
      const currentDoc = await tx.getDoc<MemberDoc>('members', email.toLowerCase());
      const saved = fields ? await saveMember(tx, email, fields, identity.email, currentDoc) : { ...existing };
      if (categoryId !== undefined) {
        await setMemberCategoryId(tx, email, categoryId, currentDoc);
        saved.categoryId = categoryId;
      }
      if (hidden !== undefined) {
        await setMemberHidden(tx, email, hidden, currentDoc);
        saved.hidden = hidden;
      }
      return saved;
    },
  );
  sendJson(res, 200, { member });
}

async function handleListaWyjazdowaGetProfile(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const profile = await getProfile(deps.firestore, identity.email);
  sendJson(res, 200, { profile });
}

// Closes KRKG-0037's deferred driveFolderId/photo-display gap (design.md §2/§6): lets the /profil/
// page show a member their own uploaded photo(s) even though nothing about them is publicly
// listed yet (fetchCategoryPeople only ever reads the 4 public categories, never "upload" - see
// about-us.ts). `pendingApproval: true` means the folder is still sitting in "upload", unreviewed;
// `false` means an admin has since moved it into a public category (or elsewhere) - see
// findReusableSubmissionFolder for the same upload-root check used on the write side.
async function handleListaWyjazdowaGetProfilePhoto(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const member = await getMember(deps.firestore, identity.email);
  if (!member?.driveFolderId) {
    sendJson(res, 200, { submission: null });
    return;
  }
  const exists = await deps.drive.folderExists(member.driveFolderId);
  if (!exists) {
    sendJson(res, 200, { submission: null });
    return;
  }
  const [folders, images] = await Promise.all([
    bootstrapAboutUsStructure(deps.drive),
    deps.drive.listImageFiles(member.driveFolderId),
  ]);
  const parentId = await deps.drive.getFolderParentId(member.driveFolderId);
  const { mainPhoto, photos } = mapDriveImagesToPhotos(images);
  sendJson(res, 200, { submission: { mainPhoto, photos, pendingApproval: parentId === folders.uploadRoot } });
}

// KRKG-0067: backs the clickable-username profile drawer shown on Lista Wyjazdowa, Spis Ludności,
// and Zarządzanie ludźmi. Two-tier auth, tried in this order (same "try the broader gate, fall
// back to the narrower one" idiom as resolveAdminAuditAuth above): an admin/moderator - the same
// gate that already lets Zarządzanie ludźmi manage members in every status
// (handleAdminListMembers) - may view ANY existing MemberDoc regardless of status or `hidden`,
// and does NOT need to be an active club member themselves. Everyone else must be an active
// member (authenticateWojownicyUpload) and the target must be active and not hidden.
async function handleMemberProfile(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  let isAdminOrModerator = true;
  try {
    await deps.authenticateAdminOrModerator(req, res);
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    isAdminOrModerator = false;
  }
  if (!isAdminOrModerator) {
    await deps.authenticateWojownicyUpload(req, res);
  }

  const rawEmail = url.searchParams.get('email');
  if (!rawEmail) {
    sendJson(res, 400, { error: 'Brak parametru email.' });
    return;
  }
  const email = rawEmail.trim().toLowerCase();

  if (!isAdminOrModerator) {
    const activeEmails = await deps.listMemberEmails();
    if (!activeEmails.some(e => e.toLowerCase() === email)) {
      sendJson(res, 404, { error: 'Nie znaleziono członka.' });
      return;
    }
  }

  const [member, profile, lookupLists] = await Promise.all([
    getMember(deps.firestore, email),
    getProfile(deps.firestore, email),
    getAllLookupLists(deps.firestore),
  ]);

  // A hidden member is treated as entirely absent for a plain active caller, matching
  // handleListaWyjazdowaGetRoster/handleMembersDirectory's KRKG-0060 behavior. An admin/moderator
  // (isAdminOrModerator, resolved above) is exempt - already established.
  if (!isAdminOrModerator && member?.hidden === true) {
    sendJson(res, 404, { error: 'Nie znaleziono członka.' });
    return;
  }

  const sectionLabelById = new Map(lookupLists.sections.map(s => [s.id, s.label]));
  const categoryLabelById = new Map(lookupLists.categories.map(c => [c.id, c.label]));
  const weaponLabelById = new Map(lookupLists.weapons.map(w => [w.id, w.label]));

  let mainPhoto: PersonPhoto | null = null;
  let photos: PersonPhoto[] = [];
  let description: string | null = null;
  let published = false;

  if (member?.driveFolderId) {
    const exists = await deps.drive.folderExists(member.driveFolderId);
    if (exists) {
      const [folders, parentId] = await Promise.all([
        bootstrapAboutUsStructure(deps.drive),
        deps.drive.getFolderParentId(member.driveFolderId),
      ]);
      published = Object.values(folders.categories).includes(parentId ?? '');
      const isPendingUpload = !published && parentId === folders.uploadRoot;
      if (published || isPendingUpload) {
        const images = await deps.drive.listImageFiles(member.driveFolderId);
        ({ mainPhoto, photos } = mapDriveImagesToPhotos(images));
        if (published) {
          description = await deps.drive.readTextFile(member.driveFolderId, 'Opis.txt');
        }
      }
    }
  }

  sendJson(res, 200, {
    // A member on the allowlist with no `members/{email}` document yet (never opened "Mój
    // profil") still gets a usable name, same fallback as wyjazd.js's displayName().
    fullName: member?.fullName ?? email.split('@')[0],
    nickname: member?.nickname ?? null,
    sectionLabel: member?.sectionId ? (sectionLabelById.get(member.sectionId) ?? member.sectionId) : null,
    categoryLabel: member?.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null,
    weapons: (profile?.weaponIds ?? []).map(id => weaponLabelById.get(id) ?? id),
    mainPhoto,
    photos,
    description,
    published,
  });
}

async function handleListaWyjazdowaPutProfile(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  // wpisowePaid is accountant/admin-only (design.md §7a) and is simply never read out of the
  // body here - saveProfile carries the stored value forward, so sending it has no effect.
  const fields: ProfileWritableFields = {
    weaponIds: requireArray(body.weaponIds, 'Lista broni ma nieprawidłowy format.').map((id) =>
      requireTrimmedString(id, LW_MAX_NAME_LENGTH, 'Lista broni ma nieprawidłowy format.'),
    ),
    equipment: requireArray(body.equipment, 'Lista sprzętu obozowego ma nieprawidłowy format.').map((raw) => {
      const item = requireObject(raw, 'Lista sprzętu obozowego ma nieprawidłowy format.');
      return {
        id: optionalTrimmedString(item.id, LW_MAX_NAME_LENGTH, 'Lista sprzętu obozowego ma nieprawidłowy format.') ?? '',
        name: requireTrimmedString(
          item.name,
          LW_MAX_NAME_LENGTH,
          `Nazwa sprzętu jest wymagana (maks. ${LW_MAX_NAME_LENGTH} znaków).`,
        ),
        description:
          optionalTrimmedString(
            item.description,
            LW_MAX_DESCRIPTION_LENGTH,
            `Opis sprzętu może mieć najwyżej ${LW_MAX_DESCRIPTION_LENGTH} znaków.`,
          ) ?? '',
      };
    }),
    companions: requireArray(body.companions, 'Lista osób towarzyszących ma nieprawidłowy format.').map((raw) => {
      const companion = requireObject(raw, 'Lista osób towarzyszących ma nieprawidłowy format.');
      return {
        id:
          optionalTrimmedString(
            companion.id,
            LW_MAX_NAME_LENGTH,
            'Lista osób towarzyszących ma nieprawidłowy format.',
          ) ?? '',
        name: requireTrimmedString(
          companion.name,
          LW_MAX_NAME_LENGTH,
          `Imię osoby towarzyszącej jest wymagane (maks. ${LW_MAX_NAME_LENGTH} znaków).`,
        ),
      };
    }),
  };
  const lookupLists = await getAllLookupLists(deps.firestore);
  for (const weaponId of fields.weaponIds) {
    requireKnownLookupId(lookupLists.weapons, weaponId, 'Wybrana broń nie istnieje.');
  }
  const { result: profile } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.tripProfile,
    'profile.member.updated',
    async tx => {
      const existing = await tx.getDoc<ListaWyjazdowaProfileDoc>('listaWyjazdowaProfile', identity.email.toLowerCase());
      return {
        actor: { email: identity.email },
        resource: { kind: 'member', key: `member:${identity.email.toLowerCase()}`, display: 'member' },
        changes: [
          { field: 'weaponCount', ...(existing ? { before: existing.weaponIds.length } : {}), after: fields.weaponIds.length },
          { field: 'equipmentCount', ...(existing ? { before: existing.equipment.length } : {}), after: fields.equipment.length },
          { field: 'companionCount', ...(existing ? { before: existing.companions.length } : {}), after: fields.companions.length },
        ],
      };
    },
    tx => saveProfile(tx, identity.email, fields),
  );
  sendJson(res, 200, { profile });
}

async function handleListaWyjazdowaLookupLists(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const lists = await getAllLookupLists(deps.firestore);
  sendJson(res, 200, lists);
}

// Lista Wyjazdowa Plan B: events & sign-up. Same authenticateWojownicyUpload gate as Plan A above
// - every route here is still limited to the live kruki-group membership, not open to the public.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireDateString(value: unknown, message: string): string {
  const trimmed = requireTrimmedString(value, 10, message);
  if (!DATE_PATTERN.test(trimmed)) throw new AuthError(message, 400);
  return trimmed;
}

async function handleListaWyjazdowaGetEvents(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const events = await listEvents(deps.firestore);
  const allSignups = await listAllSignups(deps.firestore);
  const attendingCountByEvent = new Map<string, number>();
  const viewerAttendingByEvent = new Set<string>();
  const viewerEmail = identity.email.toLowerCase();
  for (const { data } of allSignups) {
    if (!data.attending) continue;
    attendingCountByEvent.set(data.eventId, (attendingCountByEvent.get(data.eventId) ?? 0) + 1);
    if (data.memberEmail === viewerEmail) viewerAttendingByEvent.add(data.eventId);
  }
  const withSummary = events.map((e) => ({
    ...e,
    attendingCount: attendingCountByEvent.get(e.id) ?? 0,
    viewerAttending: viewerAttendingByEvent.has(e.id),
  }));
  sendJson(res, 200, { events: withSummary });
}

async function handleListaWyjazdowaPostEvent(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  const name = requireTrimmedString(body.name, LW_MAX_NAME_LENGTH, 'Nazwa wyjazdu jest wymagana.');
  const startDate = requireDateString(body.startDate, 'Data rozpoczęcia jest wymagana (RRRR-MM-DD).');
  const eventId = randomUUID();
  const { result: event } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.eventCreate,
    'event.created',
    {
      actor: { email: identity.email },
      resource: { kind: 'event', key: `event:${eventId}`, display: name },
      changes: [{ field: 'name', after: name }, { field: 'startDate', after: startDate }, { field: 'status', after: 'active' }],
    },
    tx => createEvent(tx, { name, startDate }, identity.email, eventId),
  );
  sendJson(res, 200, { event });
}

async function handleListaWyjazdowaPutEvent(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) throw new AuthError('Brak identyfikatora wyjazdu.', 400);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  const fields: EventWritableFields = {};
  if (body.name !== undefined) fields.name = requireTrimmedString(body.name, LW_MAX_NAME_LENGTH, 'Nazwa wyjazdu nie może być pusta.');
  if (body.startDate !== undefined) fields.startDate = requireDateString(body.startDate, 'Data rozpoczęcia jest nieprawidłowa (RRRR-MM-DD).');
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'cancelled') throw new AuthError('Nieprawidłowy status wyjazdu.', 400);
    fields.status = body.status;
  }
  if (body.skladkaFee !== undefined) {
    await requireRole(deps.firestore, identity.email, 'accountant');
    fields.skladkaFee = body.skladkaFee === null ? null : requireTrimmedString(body.skladkaFee, LW_MAX_NAME_LENGTH, 'Opis składki jest nieprawidłowy.');
  }
  const eventFieldCount = Number(fields.name !== undefined) + Number(fields.startDate !== undefined) + Number(fields.status !== undefined);
  if (eventFieldCount === 0 && fields.skladkaFee === undefined) {
    throw new AuthError('Podaj co najmniej jedno pole wyjazdu do zmiany.', 400);
  }
  const metadataAction = fields.status === 'cancelled' ? 'event.cancelled' : 'event.updated';
  const actions = fields.skladkaFee !== undefined
    ? eventFieldCount > 0
      ? [metadataAction, 'dues.event_fee.changed'] as const
      : ['dues.event_fee.changed'] as const
    : [metadataAction] as const;
  const { result: event } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.eventUpdate,
    actions,
    async tx => {
      const existing = await tx.getDoc<EventDoc>('events', eventId);
      if (!existing) throw new AuthError('Nie znaleziono wyjazdu.', 404);
      const metadataInput = {
        actor: { email: identity.email },
        resource: { kind: 'event' as const, key: `event:${eventId}`, display: fields.name ?? existing.name },
        changes: [
          ...(fields.name !== undefined ? [{ field: 'name', before: existing.name, after: fields.name }] : []),
          ...(fields.startDate !== undefined ? [{ field: 'startDate', before: existing.startDate, after: fields.startDate }] : []),
          ...(fields.status !== undefined ? [{ field: 'status', before: existing.status, after: fields.status }] : []),
        ],
      };
      if (fields.skladkaFee === undefined) return metadataInput;
      const feeDigest = (fee: string | null): string | null => fee === null ? null : createHash('sha256').update(fee).digest('hex');
      const feeInput = {
        actor: { email: identity.email },
        resource: { kind: 'eventFee' as const, key: `eventFee:${eventId}`, display: fields.name ?? existing.name },
        changes: [
          { field: 'feeDigest', before: feeDigest(existing.skladkaFee), after: feeDigest(fields.skladkaFee) },
          { field: 'feeLength', before: existing.skladkaFee?.length ?? null, after: fields.skladkaFee?.length ?? 0 },
        ],
      };
      return eventFieldCount > 0 ? [metadataInput, feeInput] : [feeInput];
    },
    tx => updateEvent(tx, eventId, fields).then(event => {
      if (!event) throw new AuthError('Nie znaleziono wyjazdu.', 404);
      return event;
    }),
  );
  sendJson(res, 200, { event });
}

async function handleListaWyjazdowaGetSignups(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) throw new AuthError('Brak identyfikatora wyjazdu.', 400);
  const signups = await listSignupsForEvent(deps.firestore, eventId);
  sendJson(res, 200, { signups });
}

async function handleListaWyjazdowaGetMySignup(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) throw new AuthError('Brak identyfikatora wyjazdu.', 400);
  const signup = await getSignup(deps.firestore, eventId, identity.email);
  sendJson(res, 200, { signup });
}

async function handleListaWyjazdowaPutSignup(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const eventId = url.searchParams.get('eventId');
  const memberEmail = url.searchParams.get('memberEmail');
  if (!eventId) throw new AuthError('Brak identyfikatora wyjazdu.', 400);
  if (!memberEmail) throw new AuthError('Brak adresu e-mail członka.', 400);

  const event = await getEvent(deps.firestore, eventId);
  if (!event) throw new AuthError('Nie znaleziono wyjazdu.', 404);

  // memberEmail is open-edit (any member may sign anyone up), but it still has to name a real
  // club member - checked against the live Google Group allowlist (the same one GET
  // /lista-wyjazdowa/roster now enumerates), not the members/{email} collection. A member who has
  // never opened "Mój profil" has no members/{email} document yet but is still a real member and
  // must be signable up; a typo'd or invented address isn't on the allowlist either way, so this
  // still rejects it before it can create an orphan signup doc that inflates attendingCount (the
  // events list's "N os.") while never showing up on the roster or the event page's breakdown.
  const allowedEmails = await deps.listMemberEmails();
  if (!allowedEmails.includes(memberEmail.toLowerCase())) throw new AuthError('Nie znaleziono takiego członka.', 404);

  // The target member need not have a Lista Wyjazdowa profile yet - "I'm coming, no gear/
  // companions listed yet" is a legitimate signup. A missing profile just means its
  // equipment/companion sets are empty for the referential check below, so any *non-empty*
  // equipmentIds/companionIds on a profile-less member are rejected the same way an id that's
  // simply not theirs would be - not via a separate "no profile" 400.
  const targetProfile = await getProfile(deps.firestore, memberEmail);

  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  if (typeof body.attending !== 'boolean') throw new AuthError('Pole attending jest wymagane (true/false).', 400);
  const equipmentIds = requireArray(body.equipmentIds, 'Lista sprzętu ma nieprawidłowy format.').map((id) =>
    requireTrimmedString(id, LW_MAX_NAME_LENGTH, 'Lista sprzętu ma nieprawidłowy format.'),
  );
  const companionIds = requireArray(body.companionIds, 'Lista osób towarzyszących ma nieprawidłowy format.').map((id) =>
    requireTrimmedString(id, LW_MAX_NAME_LENGTH, 'Lista osób towarzyszących ma nieprawidłowy format.'),
  );

  const validEquipmentIds = new Set(targetProfile?.equipment.map((e) => e.id) ?? []);
  for (const id of equipmentIds) {
    if (!validEquipmentIds.has(id)) throw new AuthError('Wybrany sprzęt nie należy do tego członka.', 400);
  }
  const validCompanionIds = new Set(targetProfile?.companions.map((c) => c.id) ?? []);
  for (const id of companionIds) {
    if (!validCompanionIds.has(id)) throw new AuthError('Wybrana osoba towarzysząca nie należy do tego członka.', 400);
  }

  const fields: SignupWritableFields = { attending: body.attending, equipmentIds, companionIds };
  const normalizedMemberEmail = memberEmail.toLowerCase();
  const existingSignup = await getSignup(deps.firestore, eventId, normalizedMemberEmail);
  const action = existingSignup ? 'signup.updated' : 'signup.created';
  const { result: signup } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.signup,
    action,
    async tx => {
      const existing = await tx.getDoc<SignupDoc>('signups', `${eventId}_${normalizedMemberEmail}`);
      return {
        actor: { email: identity.email },
        resource: { kind: 'signup', key: `signup:${eventId}:${normalizedMemberEmail}`, display: normalizedMemberEmail },
        changes: [
          { field: 'attending', ...(existing ? { before: existing.attending } : {}), after: fields.attending },
          { field: 'equipmentCount', ...(existing ? { before: existing.equipmentIds.length } : {}), after: equipmentIds.length },
          { field: 'companionCount', ...(existing ? { before: existing.companionIds.length } : {}), after: companionIds.length },
        ],
      };
    },
    tx => saveSignup(tx, eventId, normalizedMemberEmail, fields, identity.email),
  );
  sendJson(res, 200, { signup });
}

async function handleListaWyjazdowaGetAuditLog(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const eventId = url.searchParams.get('eventId');
  if (!eventId) throw new AuthError('Brak identyfikatora wyjazdu.', 400);
  const entries = await listAuditLogForEvent(deps.firestore, eventId);
  sendJson(res, 200, { entries });
}

// Enumerates the live kruki Google Group allowlist (same as GET /members/directory, KRKG-0045),
// not just members/{email} docs: a club member who never opened "Mój profil" still has to be
// settable as attending/not-attending a trip, which is only possible if their row exists at all.
// fullName/nickname/sectionId/categoryId are null for such a member; the event page's "Wszyscy"
// filter is what surfaces them (see wyjazd.js's renderRoster), hidden by default behind "tylko
// zgłoszeni" so a long allowlist doesn't bury the people who already signed up.
async function handleListaWyjazdowaGetRoster(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const [emails, members, profiles] = await Promise.all([
    deps.listMemberEmails(),
    listAllMembers(deps.firestore),
    listAllProfiles(deps.firestore),
  ]);
  const memberByEmail = new Map(members.map((m) => [m.email, m]));
  const profileByEmail = new Map(profiles.map((p) => [p.email, p]));
  // KRKG-0060: a member marked hidden (only settable from Zarządzanie ludźmi) is excluded from
  // this roster entirely, not just their name - they read as absent, not as an anonymous row.
  const roster = emails.filter((email) => memberByEmail.get(email)?.hidden !== true).map((email) => {
    const member = memberByEmail.get(email);
    const profile = profileByEmail.get(email);
    return {
      email,
      fullName: member?.fullName ?? null,
      nickname: member?.nickname ?? null,
      sectionId: member?.sectionId ?? null,
      categoryId: member?.categoryId ?? null,
      weaponIds: profile?.weaponIds ?? [],
      equipment: profile?.equipment ?? [],
      companions: profile?.companions ?? [],
      // hasProfile separates "has a listaWyjazdowaProfile document and hasn't paid" from "has no
      // such document at all", which the wpisowePaid: false fallback alone cannot express. The
      // Składki page needs the distinction: PUT /lista-wyjazdowa/wpisowe is a 404 for a member
      // with no profile document (setWpisowePaid deliberately refuses to create one, since a
      // wpisowePaid-only document would be missing weaponIds/equipment/companions and would break
      // PUT /lista-wyjazdowa/signups' targetProfile.equipment access), so a toggle button must
      // not be offered for those members in the first place.
      hasProfile: profile !== undefined,
      wpisowePaid: profile?.wpisowePaid ?? false,
    };
  });
  sendJson(res, 200, { roster });
}

// GET /members/directory (KRKG-0045): the club-wide "Lista Członków" page. Same allowlist
// enumeration as the Lista Wyjazdowa roster above (the same live kruki Google Group membership
// that already gates authenticateWojownicyUpload/authenticate), so someone who has site access but
// never saved a profile still shows up, just with blank fullName/nickname/sectionId rather than
// being missing entirely.
async function handleMembersDirectory(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const [emails, members, lookupLists] = await Promise.all([
    deps.listMemberEmails(),
    listAllMembers(deps.firestore),
    getAllLookupLists(deps.firestore),
  ]);
  const memberByEmail = new Map(members.map((m) => [m.email, m]));
  const sectionLabelById = new Map(lookupLists.sections.map((s) => [s.id, s.label]));
  const categoryLabelById = new Map(lookupLists.categories.map((c) => [c.id, c.label]));
  // KRKG-0060: a member marked hidden (only settable from Zarządzanie ludźmi) is excluded from
  // this directory entirely, not just their name - they read as absent, not as an anonymous row.
  const directory = emails.filter((email) => memberByEmail.get(email)?.hidden !== true).map((email) => {
    const member = memberByEmail.get(email);
    return {
      email,
      fullName: member?.fullName ?? null,
      nickname: member?.nickname ?? null,
      sectionId: member?.sectionId ?? null,
      sectionLabel: member?.sectionId ? (sectionLabelById.get(member.sectionId) ?? member.sectionId) : null,
      categoryId: member?.categoryId ?? null,
      categoryLabel: member?.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null,
    };
  });
  directory.sort((a, b) => a.email.localeCompare(b.email));
  sendJson(res, 200, { members: directory });
}

// Plan C (składki/dues): every route below that touches skladkaFee/skladkaPaid/wpisowePaid/
// duesAnnual gates on the accountant role via requireRole before any read/write of that data -
// see roles.ts. GET /lista-wyjazdowa/my-role lets the client know upfront whether to show the
// accountant-only UI at all.
async function handleListaWyjazdowaGetMyRole(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  const granted = await getGrantedRoles(deps.firestore, identity.email);
  sendJson(res, 200, { canManageSkladki: satisfiesRole(granted, 'accountant') });
}

async function handleListaWyjazdowaPutSkladkaPaid(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  await requireRole(deps.firestore, identity.email, 'accountant');
  const eventId = url.searchParams.get('eventId');
  const memberEmail = url.searchParams.get('memberEmail');
  if (!eventId) throw new AuthError('Brak identyfikatora wyjazdu.', 400);
  if (!memberEmail) throw new AuthError('Brak adresu e-mail członka.', 400);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  if (typeof body.paid !== 'boolean') throw new AuthError('Pole paid jest wymagane (true/false).', 400);
  const paid = body.paid;
  const normalizedMemberEmail = memberEmail.toLowerCase();
  const { result: signup } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.signupFee,
    'dues.event_fee.changed',
    async tx => {
      const existing = await tx.getDoc<SignupDoc>('signups', `${eventId}_${normalizedMemberEmail}`);
      if (!existing) throw new AuthError('Ten członek nie jest zapisany na ten wyjazd.', 404);
      return {
        actor: { email: identity.email },
        resource: { kind: 'signup', key: `signup:${eventId}:${normalizedMemberEmail}`, display: normalizedMemberEmail },
        changes: [
          { field: 'memberEmail', after: normalizedMemberEmail },
          { field: 'paid', before: existing.skladkaPaid, after: paid },
        ],
      };
    },
    async tx => {
      const updated = await setSkladkaPaid(tx, eventId, normalizedMemberEmail, paid, identity.email);
      if (!updated) throw new AuthError('Ten członek nie jest zapisany na ten wyjazd.', 404);
      return updated;
    },
  );
  sendJson(res, 200, { signup });
}

async function handleListaWyjazdowaPutWpisowe(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  await requireRole(deps.firestore, identity.email, 'accountant');
  const memberEmail = url.searchParams.get('memberEmail');
  if (!memberEmail) throw new AuthError('Brak adresu e-mail członka.', 400);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  if (typeof body.paid !== 'boolean') throw new AuthError('Pole paid jest wymagane (true/false).', 400);
  const paid = body.paid;
  const normalizedMemberEmail = memberEmail.toLowerCase();
  const { result: profile } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.entryFee,
    'dues.entry_fee.changed',
    async tx => {
      const existing = await tx.getDoc<ListaWyjazdowaProfileDoc>('listaWyjazdowaProfile', normalizedMemberEmail);
      if (!existing) throw new AuthError('Ten członek nie ma jeszcze profilu Listy Wyjazdowej.', 404);
      return {
        actor: { email: identity.email },
        resource: { kind: 'due', key: `due:${normalizedMemberEmail}:entry_fee`, display: normalizedMemberEmail },
        changes: [{ field: 'paid', before: existing.wpisowePaid, after: paid }],
      };
    },
    async tx => {
      const updated = await setWpisowePaid(tx, normalizedMemberEmail, paid, identity.email);
      if (!updated) throw new AuthError('Ten członek nie ma jeszcze profilu Listy Wyjazdowej.', 404);
      return updated;
    },
  );
  sendJson(res, 200, { profile });
}

function requireYear(value: string | null, message: string): number {
  const year = Number(value);
  if (!value || !Number.isInteger(year) || year < 2000 || year > 2100) throw new AuthError(message, 400);
  return year;
}

async function handleListaWyjazdowaGetDues(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateWojownicyUpload(req, res);
  const year = requireYear(url.searchParams.get('year'), 'Nieprawidłowy rok.');
  const dues = await listDuesForYear(deps.firestore, year);
  sendJson(res, 200, { dues });
}

async function handleListaWyjazdowaPutDues(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  await requireRole(deps.firestore, identity.email, 'accountant');
  const memberEmail = url.searchParams.get('memberEmail');
  const year = requireYear(url.searchParams.get('year'), 'Nieprawidłowy rok.');
  if (!memberEmail) throw new AuthError('Brak adresu e-mail członka.', 400);
  const member = await getMember(deps.firestore, memberEmail);
  if (!member) throw new AuthError('Nie znaleziono takiego członka.', 404);
  const body = await readJsonBody<Record<string, unknown>>(req, deps.maxJsonBodyBytes);
  // paid and amount (KRKG-0047) are independently settable - same optional-field shape as
  // handleListaWyjazdowaPutEvent's skladkaFee, each producing its own audit entry below only
  // when that field was actually present in the body.
  const fields: DuesWritableFields = {};
  if (body.paid !== undefined) {
    if (typeof body.paid !== 'boolean') throw new AuthError('Pole paid jest wymagane (true/false).', 400);
    fields.paid = body.paid;
  }
  if (body.amount !== undefined) {
    fields.amount =
      body.amount === null ? null : requireTrimmedString(body.amount, LW_MAX_NAME_LENGTH, 'Kwota składki jest nieprawidłowa.');
  }
  if (fields.paid === undefined && fields.amount === undefined) {
    throw new AuthError('Podaj paid lub amount do zmiany.', 400);
  }
  const normalizedMemberEmail = memberEmail.toLowerCase();
  const { result: dues } = await executeDeclaredAuditedMutation(
    deps,
    AUDITED_MEMBER_MUTATION_ROUTES.annualDues,
    'dues.annual.changed',
    async tx => {
      const existing = await tx.getDoc<DuesDoc>('duesAnnual', `${normalizedMemberEmail}_${year}`);
      return {
        actor: { email: identity.email },
        resource: { kind: 'due', key: `due:${normalizedMemberEmail}:${year}`, display: normalizedMemberEmail },
        changes: [
          ...(fields.paid !== undefined ? [{ field: 'paid', ...(existing ? { before: existing.paid } : {}), after: fields.paid }] : []),
          ...(fields.amount !== undefined ? [{ field: 'amount', ...(existing ? { before: existing.amount } : {}), after: fields.amount }] : []),
        ],
      };
    },
    tx => saveDues(tx, normalizedMemberEmail, year, fields, identity.email),
  );
  sendJson(res, 200, { dues });
}

// Accountant/admin-only (KRKG-0047) - the dues audit log names who paid what and when, which is
// more sensitive than the roster/dues themselves, so it is no longer open to every signed-in
// member the way it was before this story.
async function handleListaWyjazdowaGetDuesAuditLog(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req, res);
  await requireRole(deps.firestore, identity.email, 'accountant');
  const entries = await listDuesAuditLog(deps.firestore);
  sendJson(res, 200, { entries });
}

// Structured console log for every destructive gallery action (KRKG-0027's audit requirement) -
// actor, target, outcome, and a correlation id tying a single request's attempt/result together
// in Cloud Run's log output. No dedicated logging store exists in this project; console.log is
// the same mechanism every other error path here already relies on for operator visibility.
function logDestructiveAction(action: string, actorEmail: string, target: string, outcome: 'ok' | 'error', detail?: unknown): void {
  const correlationId = randomUUID();
  console.log(
    JSON.stringify({ audit: true, action, actorEmail, target, outcome, correlationId, at: new Date().toISOString() }),
  );
  if (detail !== undefined) {
    console.error(`[${correlationId}]`, detail);
  }
}

// Only for galleries this service itself created (drive.file scope can't touch anything else -
// see KRKG-0025's design.md) - a folder registered by URL instead goes through /unregister.
// Admin-gated (KRKG-0049) - previously moderator-gated (KRKG-0027), but that Google-Group
// mechanism was never actually configured in production (always denied everyone), and galleries
// don't need their own moderator concept per this repo's current direction.
async function handleDeleteDriveGallery(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { folderId } = await readJsonBody<{ folderId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  try {
    await executeAuditedExternalMutation(
      deps.firestore,
      {
        action: 'gallery.deleted', actor: { email: identity.email },
        resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId },
        changes: [{ field: 'name', after: folderId }],
      },
      async () => deps.drive.deleteFolder(folderId),
    );
  } catch (err) {
    logDestructiveAction('delete-drive-gallery', identity.email, folderId, 'error', err);
    throw err;
  }
  logDestructiveAction('delete-drive-gallery', identity.email, folderId, 'ok');
  // Invalidated immediately rather than left to expire on its own TTL, so the deletion is
  // reflected on the next /galleries call instead of up to galleriesCacheTtlMs later.
  galleriesCache = null;
  sendJson(res, 200, { ok: true });
}

async function handleStart(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const { name, date } = await readJsonBody<{ name?: string; date: string }>(req, deps.maxJsonBodyBytes);
  if (!date) throw new AuthError('Brak daty albumu.', 400);
  const folderName = name ? `${date} ${name}` : date;
  // Pre-effect resource protocol - see the matching comment in handleAdminCreatePerson.
  const correlationId = randomUUID();
  const provisionalResourceKey = `gallery:pending:${correlationId}`;
  const { result: folderId } = await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'gallery.created',
      actor: { email: identity.email },
      resource: { kind: 'gallery', key: provisionalResourceKey, display: name ?? date },
      changes: [{ field: 'name', after: name ?? date }, { field: 'date', after: date }],
    },
    async () => {
      const createdFolderId = await deps.drive.createAlbumFolder(deps.driveParentFolderId, folderName);
      // Made public right away, not deferred to /finalize: the gallery detail view fetches photos
      // client-side straight from Drive's public API (see app.js's DRIVE_API_KEY_PUBLIC), so any
      // file already uploaded needs to be visible even if the submission never reaches /finalize.
      await deps.drive.setFolderPublic(createdFolderId);
      return createdFolderId;
    },
    {
      correlationId,
      provisionalResourceKey,
      eventInput: createdFolderId => ({
        action: 'gallery.created',
        actor: { email: identity.email },
        resource: { kind: 'gallery', key: `gallery:${createdFolderId}`, display: name ?? date },
        changes: [{ field: 'name', after: name ?? date }, { field: 'date', after: date }],
      }),
    },
  );
  const submissionToken = issueSubmissionToken(
    { folderId, sub: identity.sub, exp: Date.now() + SUBMISSION_TTL_MS },
    deps.submissionTokenSecret,
  );
  sendJson(res, 200, { folderId, submissionToken });
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const folderId = url.searchParams.get('folderId');
  const fileName = url.searchParams.get('fileName');
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  if (!folderId || !fileName) throw new AuthError('Brak folderId lub fileName.', 400);
  requireAllowedMimeType(mimeType, deps.allowedMimeTypes);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  const decodedFileName = decodeURIComponent(fileName);
  // Only possible when the client sent Content-Length (a real File body always does) and/or
  // lastModifiedMs (the browser's File.lastModified - both dodaj-galerie.js and
  // dodaj-zdjecia.js send it); skip duplicate detection entirely rather than guess if missing.
  const contentLength = Number(req.headers['content-length']);
  const sizeKnown = Number.isFinite(contentLength);
  const lastModifiedParam = url.searchParams.get('lastModifiedMs');
  const lastModifiedMs =
    lastModifiedParam !== null && Number.isFinite(Number(lastModifiedParam)) ? Number(lastModifiedParam) : undefined;

  // Reserved exactly, in-process, before every write - not an approximation. See the comment
  // above reserveUploadSlot for why this is correct (single Cloud Run instance + a per-folder
  // lock) where the earlier margin-based check wasn't. /finalize's own count check remains as
  // an unconditional backstop regardless.
  async function uploadNow(): Promise<{ id: string }> {
    const reserved = await reserveUploadSlot(deps.drive, folderId as string, deps.maxFilesPerSubmission);
    if (!reserved) {
      throw new AuthError(`Zgłoszenie osiągnęło maksymalną liczbę zdjęć (${deps.maxFilesPerSubmission}).`, 400);
    }
    try {
      return await deps.drive.uploadFileStream(
        folderId as string,
        decodedFileName,
        mimeType,
        validatedUploadStream(req, deps.maxFileBytes, mimeType),
        lastModifiedMs,
      );
    } catch (err) {
      releaseUploadSlot(folderId as string);
      throw err;
    }
  }

  // Only a genuinely new file reaches Drive, so the audit event (gallery.photo.added) is only
  // ever emitted here, wrapping just the real upload effect - never the duplicate-skip fast
  // path above, which changes no state and must stay silent per the story's "successful
  // state-changing action" scope. The intent/correlation is created immediately before the
  // effect, matching every other Drive-writing route in this file (external-operation protocol).
  async function uploadAudited(): Promise<{ id: string }> {
    const { result } = await executeAuditedExternalMutation(
      deps.firestore,
      {
        action: 'gallery.photo.added',
        actor: { email: identity.email },
        resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId as string },
        changes: [{ field: 'photoCount', after: 1 }],
      },
      uploadNow,
      {
        // gallery's field allowlist has no fileId (implementation-contract.md's per-action
        // stored-field allowlist table lists only the controlled photoCount/name/date/etc. for
        // this category), so - unlike handleWojownicyUploadPhoto's profile-scoped fileId - the
        // final event stays on the same photoCount=1 change declared in the intent above; there
        // is no final-resource substitution to make here (no provisional key is used either,
        // since /upload always has a real folderId up front).
        eventInput: () => ({
          action: 'gallery.photo.added',
          actor: { email: identity.email },
          resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId as string },
          changes: [{ field: 'photoCount', after: 1 }],
        }),
      },
    );
    return result;
  }

  let uploaded: { id: string };
  if (sizeKnown) {
    // A file with this exact (name, size, mtime) already sits in the folder - skip outright
    // rather than writing a second copy (not even counted against maxFilesPerSubmission, since
    // nothing new is being added). The whole check-and-upload for this one key is serialized by
    // dedupeKey - a lock distinct from reserveUploadSlot's own folderId-keyed one, so this never
    // blocks (or gets blocked by) uploads of any *other* file in the same folder - so a
    // concurrent request for the exact same file has to wait for this one's real Drive outcome
    // instead of being told "duplicate" while that outcome is still unknown and could still
    // fail. If it does fail, the waiting request finds the key still unclaimed and uploads for
    // real itself, same as a solo retry would. See fileKeyFor's comment for what "duplicate"
    // does and doesn't mean here.
    const dedupeKey = `dup:${folderId}:${fileKeyFor(decodedFileName, contentLength, lastModifiedMs)}`;
    const result = await withFolderLock(dedupeKey, async () => {
      let known = folderKnownFileKeys.get(folderId as string);
      if (!known) {
        const existing = await deps.drive.listFiles(folderId as string);
        known = new Set(existing.map(f => fileKeyFor(f.name, f.size, f.modifiedTime ? Date.parse(f.modifiedTime) : undefined)));
        folderKnownFileKeys.set(folderId as string, known);
      }
      const key = fileKeyFor(decodedFileName, contentLength, lastModifiedMs);
      if (known.has(key)) return null;
      const uploadResult = await uploadAudited();
      known.add(key);
      return uploadResult;
    });
    if (result === null) {
      await drainRequestBody(req);
      sendJson(res, 200, { ok: true, skipped: true });
      return;
    }
    uploaded = result;
  } else {
    uploaded = await uploadAudited();
  }
  // Best-effort: a failure here shouldn't fail an otherwise-successful upload (the photo is
  // already safely in Drive), just leave it unattributed in the detail view's "Dodane przez".
  try {
    await appendUploadAttribution(deps.drive, folderId, {
      fileId: uploaded.id,
      email: identity.email,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.picture ? { picture: identity.picture } : {}),
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Nie udało się zapisać informacji o autorze zdjęcia:', err);
  }
  sendJson(res, 200, { ok: true });
}

async function handleStatus(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);
  const uploadedFiles = await deps.drive.listFiles(folderId);
  sendJson(res, 200, { uploadedFiles });
}

async function handleFinalize(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const { folderId, name, date } = await readJsonBody<{ folderId: string; name?: string; date: string }>(
    req,
    deps.maxJsonBodyBytes,
  );
  if (!folderId || !date) throw new AuthError('Brak folderId lub daty.', 400);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  const uploadedFiles = await deps.drive.listFiles(folderId);
  if (uploadedFiles.length === 0) {
    throw new AuthError('Nie przesłano żadnych zdjęć do tego folderu.', 400);
  }
  if (uploadedFiles.length > deps.maxFilesPerSubmission) {
    throw new AuthError(
      `Zgłoszenie przekracza maksymalną liczbę zdjęć (${deps.maxFilesPerSubmission}). Skontaktuj się z administratorem.`,
      400,
    );
  }

  // The folder was already made public by /start (see its comment) - nothing to do here for
  // that. A failure writing the manifest below simply fails /finalize with no compensating
  // action needed.
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'gallery.finalized',
      actor: { email: identity.email },
      resource: { kind: 'gallery', key: `gallery:${folderId}`, display: name ?? folderId },
      changes: [
        ...(name ? [{ field: 'name' as const, after: name }] : []),
        { field: 'date' as const, after: date },
        { field: 'finalized' as const, after: 'true' },
      ],
    },
    async () => deps.drive.writeManifest(folderId, {
      ...(name ? { name } : {}),
      date,
      contributors: [identity.email],
    }),
  );

  // No albums.json/GitHub commit needed here - the app owns this folder (it created it), so
  // GET /galleries already discovers it live via the manifest just written above. Registering
  // a folder the app did NOT create (an existing external gallery) goes through /register
  // instead, which commits to albums.json for the pipeline-based sync to pick up.
  // Invalidated so the new gallery shows up on the next /galleries call instead of waiting out
  // galleriesCacheTtlMs - same reasoning as handleGalleryPhotosFinalize's cache clear below.
  galleriesCache = null;
  sendJson(res, 200, { ok: true });
}

// Confirms folderId is a real, already-discoverable gallery (one of driveParentFolderId's own
// children) before handing out a token for it - the frontend only ever offers this for a
// gallery it already rendered from GET /galleries, but this endpoint shouldn't just trust an
// arbitrary caller-supplied id.
async function requireExistingGalleryFolder(drive: DriveClient, driveParentFolderId: string, folderId: string): Promise<void> {
  const folders = await drive.listGalleryFolders(driveParentFolderId);
  if (!folders.some(f => f.id === folderId)) {
    throw new AuthError('Nie znaleziono galerii.', 404);
  }
}

// Starting point for "add photos to an existing gallery" (as opposed to /start, which always
// creates a brand-new folder) - issues a submission token for an already-published gallery so
// the rest of the flow (/upload, then /gallery-photos/finalize below) can reuse the exact same
// per-file upload endpoint and token-ownership machinery as creating a new one.
async function handleGalleryPhotosStart(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWithStepUp(req, res);
  const { folderId } = await readJsonBody<{ folderId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  await requireExistingGalleryFolder(deps.drive, deps.driveParentFolderId, folderId);
  const submissionToken = issueSubmissionToken(
    { folderId, sub: identity.sub, exp: Date.now() + SUBMISSION_TTL_MS },
    deps.submissionTokenSecret,
  );
  sendJson(res, 200, { folderId, submissionToken });
}

// Counterpart to /finalize for the same flow - the gallery already has a manifest with its own
// name/date, so this only ever adds the uploader to `contributors` (never overwrites name/date)
// rather than writing a fresh manifest from scratch.
//
// setFolderPublic is called here too (idempotent - see its own comment in drive.ts), even though
// /start already makes every new gallery's folder public up front. This is a self-healing
// backstop for galleries created before that existed: their folder was only ever made public in
// /finalize, so a first upload attempt with any failed files left it private forever - a cover
// thumbnail still shows (read server-side with the app's own Drive credentials), but every photo
// is invisible in the gallery detail view, which fetches the file list from the public Drive API
// with an anonymous key that can't see a private folder. Each successful "add photos" round
// re-asserts public sharing, closing that gap for good the first time someone adds more photos.
async function handleGalleryPhotosFinalize(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const { folderId } = await readJsonBody<{ folderId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  const existing = await deps.drive.readManifest(folderId);
  const contributors = new Set(existing?.contributors ?? []);
  contributors.add(identity.email);
  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'gallery.photo.contribution.finalized',
      actor: { email: identity.email },
      resource: { kind: 'gallery', key: `gallery:${folderId}`, display: existing?.name ?? folderId },
      changes: [{ field: 'contributorEmail', after: identity.email.toLowerCase() }],
    },
    async () => {
      await deps.drive.setFolderPublic(folderId);
      await deps.drive.writeManifest(folderId, {
        ...(existing?.name ? { name: existing.name } : {}),
        date: existing?.date ?? new Date().toISOString().slice(0, 10),
        contributors: [...contributors],
      });
    },
  );
  galleriesCache = null;
  sendJson(res, 200, { ok: true });
}

// Same gate as /galleries (KRKG-0031) - lets the gallery detail view show "Dodane przez"
// (avatar/name/timestamp) for each photo to signed-in kruki-group members, without handing
// uploader emails/names/photos to anonymous visitors.
async function handleGalleryPhotoUploaders(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticate(req, res);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const uploaders = await readUploadLog(deps.drive, folderId);
  sendJson(res, 200, { uploaders });
}

// Mirrors public/galerie/dodaj-galerie.js's isValidAlbumUrl, but this copy is the one that
// actually matters: the browser check is only UX, and POST /register can be called directly by
// anyone holding a valid bearer token, bypassing it entirely. Without a server-side allowlist,
// an allowlisted account could commit a javascript:/data: URL (or any http(s) host) into
// albums.json, which public/galerie/app.js later renders straight into an <a href> - escapeAttr
// there only HTML-escapes the attribute, it does not neutralize a dangerous URL scheme, so that
// would be a stored XSS served to every visitor who opens the gallery link (KRKG-0026). Each
// pattern is anchored immediately after "https://" through to end-of-string, so there is no room
// for a credential prefix (https://evil@photos.app.goo.gl/...) or a lookalike host
// (https://photos.app.goo.gl.evil.example/...) to slip through.
const CANONICAL_GALLERY_URL_PATTERNS = [
  /^https:\/\/photos\.app\.goo\.gl\/[A-Za-z0-9_-]+$/,
  /^https:\/\/photos\.google\.com\/share\/[A-Za-z0-9_-]+$/,
  /^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+$/,
];

function canonicalizeGalleryUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!CANONICAL_GALLERY_URL_PATTERNS.some(pattern => pattern.test(trimmed))) {
    throw new AuthError(
      'Link nie wygląda na udostępniony album Google Photos ani folder Google Drive. Oczekiwany format: https://photos.app.goo.gl/XYZ, https://photos.google.com/share/... lub https://drive.google.com/drive/folders/XYZ.',
      400,
    );
  }
  return trimmed;
}

// Lets an already-authenticated, allowlisted user register a gallery that already exists
// (a Google Photos album, or a Drive folder the app itself did NOT create) instead of
// uploading files - replaces the old GitHub Issue/PR submission path with something tied to a
// real authenticated identity rather than self-reported issue-form data. Both URL shapes are
// handled identically, exactly like the pipeline-based sync (sync-albums.ts) already branches
// on URL shape itself - upload-service's Drive OAuth credentials only ever have drive.file
// scope (see KRKG-0025's design.md), which can never write into a folder it didn't create, so
// there is no faster path for Drive URLs than the same albums.json + CI pipeline Photos uses.
async function handleRegister(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req, res);
  const { url, name, date } = await readJsonBody<{ url?: string; name?: string; date: string }>(req, deps.maxJsonBodyBytes);
  if (!url || !date) throw new AuthError('Brak adresu URL galerii lub daty.', 400);
  const canonicalUrl = canonicalizeGalleryUrl(url);

  await executeAuditedExternalMutation(
    deps.firestore,
    {
      action: 'gallery.registered', actor: { email: identity.email },
      resource: { kind: 'gallery', key: `gallery:${canonicalUrl}`, display: name ?? canonicalUrl },
      changes: [{ field: 'url', after: canonicalUrl }, { field: 'date', after: date }],
    },
    async () => deps.github.appendAlbumToMain({
      url: canonicalUrl,
      ...(name ? { nameOverride: name } : {}),
      dateOverride: date,
    }),
  );
  sendJson(res, 200, { ok: true });
}

// Deletes a gallery registered by URL (Photos or Drive-by-URL - both live only as an
// albums.json entry, see handleRegister above) by removing that entry, same auth gate as
// everything else. An app-owned Drive folder is deleted via /delete-drive-gallery instead.
async function handleUnregister(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateAdminWithStepUp(req, res);
  const { url } = await readJsonBody<{ url?: string }>(req, deps.maxJsonBodyBytes);
  if (!url) throw new AuthError('Brak adresu URL galerii.', 400);
  try {
    await executeAuditedExternalMutation(
      deps.firestore,
      {
        action: 'gallery.unregistered', actor: { email: identity.email },
        resource: { kind: 'gallery', key: `gallery:${url}`, display: url },
        changes: [{ field: 'url', after: url }],
      },
      async () => deps.github.removeAlbumFromMain(url),
    );
  } catch (err) {
    logDestructiveAction('unregister', identity.email, url, 'error', err);
    throw err;
  }
  logDestructiveAction('unregister', identity.email, url, 'ok');
  sendJson(res, 200, { ok: true });
}

async function handleInstagramPosts(res: ServerResponse): Promise<void> {
  try {
    const posts = await fetchInstagramPosts();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Short browser cache, not 6h like the server-side cache in social-media.ts: that server
    // cache already absorbs repeated Graph API calls, so there's no need for the browser to
    // also sit on a stale copy for hours - a long value here made the admin's "refresh cache"
    // button (POST /admin/social-media/refresh, which only clears the server-side cache)
    // invisible to visitors for up to 6h after clicking it.
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.writeHead(200);
    res.end(JSON.stringify(posts));
  } catch (error) {
    // The public response never includes the upstream error text (KRKG-0034) - it can carry
    // implementation details or, in a misconfigured deployment, part of a token/key. The full
    // error is still logged server-side, tagged with the same correlationId returned to the
    // caller, so an operator can correlate a support report back to the real cause.
    const correlationId = randomUUID();
    console.error(`[${correlationId}] Instagram posts fetch error:`, error);
    sendJson(res, 500, {
      error: 'Nie udało się pobrać postów z Instagrama.',
      correlationId,
      posts: [],
      source: 'instagram',
      lastUpdated: new Date().toISOString()
    });
  }
}

async function handleFacebookPosts(res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    // liveFetchPostCount tells the frontend how many of these posts to compare against its
    // statically-synced archive (KRKG-0035) - included here, rather than a second public
    // endpoint, since this handler already needs to read the setting for nothing extra.
    const [posts, settings] = await Promise.all([fetchFacebookPosts(), getFacebookSettings(deps.drive)]);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Short browser cache, not 6h like the server-side cache in social-media.ts: that server
    // cache already absorbs repeated Graph API calls, so there's no need for the browser to
    // also sit on a stale copy for hours - a long value here made the admin's "refresh cache"
    // button (POST /admin/social-media/refresh, which only clears the server-side cache)
    // invisible to visitors for up to 6h after clicking it.
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.writeHead(200);
    res.end(JSON.stringify({ ...posts, liveFetchPostCount: settings.liveFetchPostCount }));
  } catch (error) {
    // See handleInstagramPosts's catch block above for why details are not returned publicly.
    const correlationId = randomUUID();
    console.error(`[${correlationId}] Facebook posts fetch error:`, error);
    sendJson(res, 500, {
      error: 'Nie udało się pobrać postów z Facebooka.',
      correlationId,
      posts: [],
      source: 'facebook',
      lastUpdated: new Date().toISOString()
    });
  }
}

async function handleYouTubeVideos(res: ServerResponse): Promise<void> {
  try {
    const data = await fetchYouTubeVideos();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes - see handleFacebookPosts
    res.writeHead(200);
    res.end(JSON.stringify(data));
  } catch (error) {
    // See handleInstagramPosts's catch block above for why details are not returned publicly.
    const correlationId = randomUUID();
    console.error(`[${correlationId}] YouTube videos fetch error:`, error);
    sendJson(res, 500, {
      error: 'Nie udało się pobrać filmów z YouTube.',
      correlationId,
      channelTitle: '',
      channelThumbnail: '',
      channelUrl: '',
      videos: [],
      lastUpdated: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// KRKG-0050 batch 4/6: audit query, diagnostics, and reconciliation routes.
// ---------------------------------------------------------------------------------------------

/**
 * Query-string parser shared by the admin and member-zone audit list/detail routes - the
 * "zero-or-one primary selector" contract is enforced here as much as inside `queryAuditEvents`
 * itself, since more than one selector query param is a request-shape error the route should
 * reject before ever touching Firestore.
 */
function parseAuditQueryOptions(url: URL): AuditQueryOptions {
  const params = url.searchParams;
  const category = params.get('category');
  const action = params.get('action');
  const actorEmail = params.get('actorEmail');
  const resourceKey = params.get('resourceKey');
  const q = params.get('q');
  if (action && !category) throw new AuditQueryError('Selektor action wymaga podania category.');

  const selectors: AuditPrimarySelector[] = [];
  if (category) selectors.push({ kind: 'categoryAction', category: category as AuditCategory, ...(action ? { action: action as AuditAction } : {}) });
  if (actorEmail) selectors.push({ kind: 'actor', email: actorEmail });
  if (resourceKey) selectors.push({ kind: 'resourceKey', key: resourceKey });
  if (q) selectors.push({ kind: 'search', term: q });
  if (selectors.length > 1) throw new AuditQueryError('Można podać tylko jeden selektor podstawowy (category/action, actorEmail, resourceKey albo q).');

  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  const cursor = params.get('cursor') ?? undefined;
  const limitParam = params.get('limit');
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isFinite(limit) || limit <= 0) throw new AuditQueryError('Nieprawidłowy limit.');
  }
  return { selector: selectors[0] ?? { kind: 'none' }, from, to, cursor, limit };
}

interface AdminAuditAuth {
  identity: SessionClaims;
  isAdmin: boolean;
  isModerator: boolean;
  isAccountant: boolean;
}

/**
 * Resolves who's asking for `/admin/audyt/*` (and its dedicated whoami). Full administrators (the
 * same admin-allowlist-or-admin-role gate as every other `authenticateAdmin` route) get every
 * category; a Firestore-granted moderator gets that same complete administrator-scope history.
 * A Firestore-granted accountant with neither of those roles may still authenticate through this
 * same shell (the fallback branch below) - `viewerCanSeeCategory` only lets an accountant-only
 * viewer see the 'dues' category once here, never anything else this scope covers; diagnostics
 * stays administrator-only regardless, gated separately by `handleAdminAuditDiagnostics`'s own
 * `authenticateAdmin` call.
 */
async function resolveAdminAuditAuth(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<AdminAuditAuth> {
  try {
    const identity = await deps.authenticateAdminOrModerator(req, res);
    const granted = await getGrantedRoles(deps.firestore, identity.email);
    let isAdmin = granted.includes('admin');
    if (!isAdmin) {
      try {
        await deps.authenticateAdmin(req, res);
        isAdmin = true;
      } catch {
        // Not an allowlisted administrator - only a Firestore-granted moderator may still proceed.
      }
    }
    const isModerator = isAdmin || granted.includes('moderator');
    if (!isAdmin && !isModerator) {
      throw new AuthError('Brak uprawnień do przeglądania audytu.', 403);
    }
    return { identity, isAdmin, isModerator, isAccountant: isAdmin || granted.includes('accountant') };
  } catch (err) {
    // Neither an allowlisted administrator nor a Firestore-granted moderator - a pure accountant
    // may still reach this same shell for dues-category history, the one category their role
    // covers. Re-throws anything other than the expected auth rejection (e.g. a genuine 401 for
    // no session at all still surfaces from the deps.authenticate call below).
    if (!(err instanceof AuthError)) throw err;
    const identity = await deps.authenticate(req, res);
    const granted = await getGrantedRoles(deps.firestore, identity.email);
    if (!granted.includes('accountant')) throw new AuthError('Brak uprawnień do przeglądania audytu.', 403);
    return { identity, isAdmin: false, isModerator: false, isAccountant: true };
  }
}

async function resolveAdminAuditViewer(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<AuditViewer> {
  const auth = await resolveAdminAuditAuth(req, res, deps);
  return { scope: 'admin', isAdmin: auth.isAdmin, isAccountant: auth.isAccountant, isModerator: auth.isModerator };
}

// Dedicated whoami for the /admin/audyt/ shell (rather than reusing /admin/members/whoami, which
// is admin-or-moderator only and gates Zarządzanie ludźmi's very different, broader people-
// management page) - an accountant-only viewer must pass this gate to see the page at all, even
// though they'd fail /admin/members/whoami's stricter check.
async function handleAdminAuditWhoami(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const auth = await resolveAdminAuditAuth(req, res, deps);
  sendJson(res, 200, { ...identityResponseBody(auth.identity), isAdmin: auth.isAdmin });
}

async function handleAdminAuditEventsList(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const viewer = await resolveAdminAuditViewer(req, res, deps);
  const page = await queryAuditEvents(deps.firestore, parseAuditQueryOptions(url), viewer);
  sendJson(res, 200, page);
}

async function handleAdminAuditEventDetail(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const viewer = await resolveAdminAuditViewer(req, res, deps);
  const id = url.searchParams.get('id');
  if (!id) throw new AuthError('Brak id.', 400);
  const row = await getAuditEventDetail(deps.firestore, id, viewer);
  if (!row) throw new AuthError('Nie znaleziono.', 404);
  sendJson(res, 200, row);
}

/** Administrator-only, per implementation-contract.md ("Diagnostics are administrator-only and
 * never contextual member history") - deliberately not open to accountant/moderator-only staff,
 * unlike the list/detail routes above. */
async function handleAdminAuditDiagnostics(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req, res);
  const correlationId = url.searchParams.get('correlationId') ?? undefined;
  const rows = await listAuditDiagnostics(deps.firestore, correlationId);
  sendJson(res, 200, { rows });
}

async function handleAuditEventsListPublic(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticate(req, res);
  const page = await queryAuditEvents(deps.firestore, parseAuditQueryOptions(url), { scope: 'member' });
  sendJson(res, 200, page);
}

async function handleAuditEventDetailPublic(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticate(req, res);
  const id = url.searchParams.get('id');
  if (!id) throw new AuthError('Brak id.', 400);
  const row = await getAuditEventDetail(deps.firestore, id, { scope: 'member' });
  if (!row) throw new AuthError('Nie znaleziono.', 404);
  sendJson(res, 200, row);
}

/**
 * Resource-specific idempotent final-state probes (implementation-contract.md's Scheduler
 * contract), keyed by the audited resource kind. Every resource kind that can appear through
 * `executeAuditedExternalMutation` must have an entry here - not to guarantee a positive
 * existence check for all of them (some genuinely can't, see below), but so that
 * `handleInternalAuditReconcile` always calls `reconcileExternalOperation` and lets its 24-hour
 * `requires_review` boundary apply, instead of short-circuiting to a permanent `not_eligible`
 * that would leave a stuck operation `pending` forever. None of these probes ever repeats the
 * original effect - they only observe whether it already happened, or admit they can't tell.
 */
function buildReconciliationProbes(deps: ServerDeps): Partial<Record<AuditOperationIntent['resource']['kind'], ExternalOperationProbe>> {
  // Always-pending fallback shared by any external-operation resource kind/action where no
  // positive existence probe can be trusted (per implementation-contract.md: never fabricate
  // `succeeded`, never fabricate `failed` merely because the final state can't be observed) -
  // relies entirely on `reconcileExternalOperation`'s 24h `requires_review` boundary. Reused by
  // every non-allowlisted `gallery`- and `person`-kind action below (see driveFolderProbe's
  // comment) as well as by `settingsProbe`/`memberProbe` further down - deliberately worded here
  // without naming specific actions so this comment doesn't go stale as more actions are added.
  const alwaysPendingProbe: ExternalOperationProbe = async () => ({ state: 'pending' });

  const driveFolderProbe = (kind: 'gallery' | 'person'): ExternalOperationProbe => async intent => {
    // Allowlist, not blocklist: for each kind, exactly one creation action is where "the folder
    // now exists" is actual proof of success, because before that operation ran, the folder did
    // not exist yet - `gallery.created` for `gallery`, `profile.person.created` for `person`.
    // Every other action sharing either resource kind reuses a folder (or, for
    // `gallery.registered`/`gallery.unregistered`, a GitHub-hosted URL string - not even a Drive
    // folder id) that already existed for an unrelated reason, so folder existence proves nothing
    // about whether THAT action's own effect happened:
    //  - `gallery.photo.added`/`gallery.finalized`/`gallery.photo.contribution.finalized` and the
    //    non-creation `person`-kind actions (`profile.person.description.updated`,
    //    `.order.updated`, `.category.changed`, `.photo.added`, `.photo.deleted`,
    //    `.photo.main.changed`, `.photo.transferred`, `.in_memoriam.changed`): the folder already
    //    existed before the update ran, so `folderExists` is trivially always true and would
    //    fabricate `succeeded` regardless of whether the update itself ever completed.
    //  - `gallery.deleted`/`profile.person.deleted`: inverted - the folder still existing means
    //    the deletion did NOT happen, so a positive `folderExists` here is exactly the wrong
    //    signal to report success.
    //  - `gallery.registered`/`gallery.unregistered`: their resource key is a GitHub-hosted
    //    gallery URL, not a Drive folder id at all, so calling `deps.drive.folderExists` on it
    //    would be semantically wrong regardless of the false-positive issue above.
    // None of these can be positively confirmed here - same always-pending fallback as
    // `settings`/`member` below, resolved only via the 24h `requires_review` boundary. This is a
    // genuine allowlist for both kinds (not a blocklist), so a future new action added to either
    // kind in ACTION_REGISTRY is safely always-pending by default without anyone having to touch
    // this probe again.
    if (kind === 'gallery' && intent.action !== 'gallery.created') return alwaysPendingProbe(intent);
    if (kind === 'person' && intent.action !== 'profile.person.created') return alwaysPendingProbe(intent);
    // The provisional key is `{kind}:pending:{correlationId}` - there is no folder id to probe
    // for until the effect has actually created one, so a still-provisional intent can only ever
    // be "pending" here (never "failed": Drive folder creation is a single all-or-nothing call,
    // so if it had thrown, `executeAuditedExternalMutation`'s own catch path would already have
    // recorded `failed` synchronously, and this reconciler branch would never see that intent as
    // still open in the first place).
    const provisionalPrefix = `${kind}:pending:`;
    if (intent.resource.key.startsWith(provisionalPrefix)) return { state: 'pending' };
    const folderId = intent.resource.key.slice(`${kind}:`.length);
    const exists = await deps.drive.folderExists(folderId);
    if (!exists) return { state: 'pending' };
    return {
      state: 'succeeded',
      eventInput: {
        action: intent.action,
        actor: intent.actor,
        resource: intent.resource,
        changes: [{ field: 'folderId', after: folderId }],
      },
    };
  };

  // memberSubmission's provisional key (`memberSubmission:pending:{correlationId}`, from
  // handleWojownicyUploadSubmit) upgrades on success to the canonical
  // `member:{actorEmail}:submission:{folderId}` shape (implementation-contract.md's "Pre-effect
  // resource protocol"), not the generic `{kind}:{folderId}` shape driveFolderProbe assumes -
  // handleWojownicyUploadPhoto's own intent (I4 fix) now uses that exact same final shape from
  // the start, so both this kind's mutation routes share one parsing rule here.
  //
  // Same allowlist-vs-blocklist bug as driveFolderProbe above, third instance (see a83ab0a and
  // 13b4709): `profile.photo_submission.created` is the only memberSubmission action where "the
  // submission folder now exists" is proof of success (before it ran, the folder did not exist).
  // `profile.photo_submission.photo_added` (handleWojownicyUploadPhoto) reuses the submission
  // folder that `.created` already made - by I4's own fix it uses that same real, non-provisional
  // key from the outset - so `folderExists` on it is trivially always true and would fabricate
  // `succeeded` for a photo upload that never completed. Allowlist, not blocklist, so a future
  // third memberSubmission-kind action defaults safely to always-pending without anyone having to
  // touch this probe again.
  const memberSubmissionProbe: ExternalOperationProbe = async intent => {
    if (intent.resource.key.startsWith('memberSubmission:pending:')) return { state: 'pending' };
    if (intent.action !== 'profile.photo_submission.created') return alwaysPendingProbe(intent);
    const match = /:submission:([^:]+)$/.exec(intent.resource.key);
    if (!match) return { state: 'pending' };
    const folderId = match[1];
    const exists = await deps.drive.folderExists(folderId);
    if (!exists) return { state: 'pending' };
    return {
      state: 'succeeded',
      eventInput: {
        action: intent.action,
        actor: intent.actor,
        resource: intent.resource,
        changes: [{ field: 'folderId', after: folderId }],
      },
    };
  };

  // GitHub-backed redirects: `redirects.json`'s presence/absence of the path *is* the final
  // state, and `listRedirects` is a plain read - a genuine idempotent existence probe, unlike the
  // two fallback probes below.
  const redirectProbe: ExternalOperationProbe = async intent => {
    const path = intent.resource.key.slice('redirect:'.length);
    const redirects = await deps.github.listRedirects();
    const exists = redirects.some(r => r.path === path);
    const wantsExistence = intent.action === 'site.redirect.created';
    if (exists !== wantsExistence) return { state: 'pending' };
    return {
      state: 'succeeded',
      eventInput: { action: intent.action, actor: intent.actor, resource: intent.resource, changes: [{ field: 'path', after: path }] },
    };
  };

  // `settings:facebook` is Drive-backed (settings.ts), but `AuditOperationIntent` doesn't carry
  // the write's expected value, and the settings file always exists (bootstrapped, default
  // fallback) whether or not this specific update landed - so reading it back can't distinguish
  // "this write happened" from "some earlier write happened". `settings:social-media-cache`
  // clears an in-process cache with no persisted state at all to read back. Neither can produce a
  // real existence check within this batch's scope, so both stay `pending` forever and rely on
  // `reconcileExternalOperation`'s 24h `requires_review` boundary rather than a fabricated probe.
  const settingsProbe: ExternalOperationProbe = alwaysPendingProbe;

  // Sheets-backed member sync (`membership.sheet_backup.synchronized`): `SheetsClient` has no
  // read-back method (see sheets.ts) to confirm a write landed, and building one is out of this
  // batch's scope (flagged as a follow-up in the batch-4 report). Same fallback as settings above
  // - `pending` forever, so the 24h boundary still applies instead of a permanent `not_eligible`.
  const memberProbe: ExternalOperationProbe = alwaysPendingProbe;

  return {
    gallery: driveFolderProbe('gallery'),
    person: driveFolderProbe('person'),
    memberSubmission: memberSubmissionProbe,
    redirect: redirectProbe,
    settings: settingsProbe,
    member: memberProbe,
  };
}

/**
 * Internal, OIDC-authenticated route Cloud Scheduler calls every 15 minutes
 * (plan-addendum.md "Scheduler operational delivery"). Not reachable by any browser session -
 * fails closed (503) if the reconciler service account/audience aren't configured yet, and 401s
 * any caller whose OIDC token isn't a valid, current token issued to that exact service account.
 */
async function handleInternalAuditReconcile(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  if (!deps.auditReconcilerServiceAccountEmail || !deps.auditReconcileAudience) {
    throw new AuthError('Reconciler Schedulera nie jest skonfigurowany.', 503);
  }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Brak tokenu OIDC.', 401);
  }
  await verifyReconcilerOidcToken(authHeader.slice('Bearer '.length), deps.auditReconcileAudience, deps.auditReconcilerServiceAccountEmail);

  const probes = buildReconciliationProbes(deps);
  // Every kind `buildReconciliationProbes` currently returns is reachable through
  // `executeAuditedExternalMutation`, so this fallback should never actually fire - it exists so
  // a resource kind added later without a matching probe entry still reaches
  // `reconcileExternalOperation`'s 24h `requires_review` boundary instead of silently regressing
  // to a permanent `not_eligible`, the exact bug this fixes for redirect/settings/member today.
  const fallbackPendingProbe: ExternalOperationProbe = async () => ({ state: 'pending' });
  const correlationIds = await listOpenOperationCorrelationIds(deps.firestore);
  const results = [];
  for (const correlationId of correlationIds) {
    const intent = await deps.firestore.getDoc<AuditOperationIntent>('auditOperations', correlationId);
    if (!intent) {
      results.push({ correlationId, outcome: 'not_eligible' as const });
      continue;
    }
    const probe = probes[intent.resource.kind] ?? fallbackPendingProbe;
    results.push(await reconcileExternalOperation(deps.firestore, correlationId, probe));
  }
  sendJson(res, 200, { results });
}

export function createRequestListener(deps: ServerDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setCors(res, deps.allowedOrigin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    try {
      // Enforced once, centrally, for every state-changing request rather than per-handler -
      // see design-v2.md "CSRF - one mandatory rule": a route added later inherits this
      // automatically instead of silently shipping without it. GET/OPTIONS are exempt (no side
      // effects to protect, and OPTIONS never reaches this point anyway). Safe to enforce today,
      // ahead of the Phase 1 cutover: every legitimate call already crosses the www.kruki.org ->
      // api.kruki.org origin boundary since Phase 0, and cross-origin fetches always send Origin.
      if (req.method !== 'GET') {
        requireAllowedOrigin(req, deps.allowedOrigin);
      }
      if (req.method === 'GET' && url.pathname === '/whoami') {
        await handleWhoami(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/session/login') {
        await handleSessionLogin(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/session/logout') {
        await handleSessionLogout(req, res);
      } else if (req.method === 'POST' && url.pathname === '/application/pwa-installation') {
        await handlePwaInstallation(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/membership/whoami') {
        await handleMembershipWhoami(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/membership/sections') {
        await handleMembershipSections(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/membership/apply') {
        await handleMembershipApply(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/galleries') {
        await handleGalleries(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/about-us') {
        await handleAboutUs(res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/whoami') {
        await handleAdminWhoami(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/members/whoami') {
        await handleAdminMembersWhoami(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/social-media/refresh') {
        await handleAdminRefreshSocialCache(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/members') {
        await handleAdminListMembers(req, res, url, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/members/transition') {
        await handleAdminMemberTransition(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/members/drive-folder') {
        await handleAdminSetMemberDriveFolder(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/members/profile') {
        await handleAdminUpdateMemberProfile(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/lookup-lists') {
        await handleAdminGetLookupLists(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/members/synchronize') {
        await handleAdminMembersSynchronize(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/members/group-sync') {
        await handleAdminMembersGroupSync(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/roles') {
        await handleAdminListRoles(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/roles') {
        await handleAdminSetRoles(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/roles/audit-log') {
        await handleAdminListRolesAuditLog(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/audyt/whoami') {
        await handleAdminAuditWhoami(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/audyt/events') {
        await handleAdminAuditEventsList(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/audyt/event') {
        await handleAdminAuditEventDetail(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/audyt/diagnostics') {
        await handleAdminAuditDiagnostics(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/audyt/events') {
        await handleAuditEventsListPublic(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/audyt/event') {
        await handleAuditEventDetailPublic(req, res, url, deps);
      } else if (req.method === 'POST' && url.pathname === '/internal/audit/reconcile') {
        await handleInternalAuditReconcile(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/redirects') {
        await handleAdminListRedirects(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/redirects') {
        await handleAdminCreateRedirect(req, res, deps);
      } else if (req.method === 'DELETE' && url.pathname === '/admin/redirects') {
        await handleAdminDeleteRedirect(req, res, url, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/people') {
        await handleAdminCreatePerson(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/people/description') {
        await handleAdminUpdateDescription(req, res, url, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/people/order') {
        await handleAdminUpdatePersonOrder(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/people/category') {
        await handleAdminMovePerson(req, res, deps);
      } else if (req.method === 'DELETE' && url.pathname === '/admin/people') {
        await handleAdminDeletePerson(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/people') {
        await handleAdminListPeople(req, res, url, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/people/photo') {
        await handleAdminUploadPhoto(req, res, url, deps);
      } else if (req.method === 'DELETE' && url.pathname === '/admin/people/photo') {
        await handleAdminDeletePhoto(req, res, url, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/people/photo/main') {
        await handleAdminSetMainPhoto(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/people/photo/transfer') {
        await handleAdminTransferPhoto(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/admin/people/in-memoriam') {
        await handleAdminSetInMemoriam(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/wojownicy-upload/whoami') {
        await handleWojownicyUploadWhoami(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/wojownicy-upload/submit') {
        await handleWojownicyUploadSubmit(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/wojownicy-upload/photo') {
        await handleWojownicyUploadPhoto(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/wojownicy-docs') {
        await handleWojownicyDoc(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/member') {
        await handleListaWyjazdowaGetMember(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/member') {
        await handleListaWyjazdowaPutMember(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/profile') {
        await handleListaWyjazdowaGetProfile(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/profile') {
        await handleListaWyjazdowaPutProfile(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/profile/photo') {
        await handleListaWyjazdowaGetProfilePhoto(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/lookup-lists') {
        await handleListaWyjazdowaLookupLists(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/member-profile') {
        await handleMemberProfile(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/events') {
        await handleListaWyjazdowaGetEvents(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/lista-wyjazdowa/events') {
        await handleListaWyjazdowaPostEvent(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/events') {
        await handleListaWyjazdowaPutEvent(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/signups') {
        await handleListaWyjazdowaGetSignups(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/signups/mine') {
        await handleListaWyjazdowaGetMySignup(req, res, url, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/signups') {
        await handleListaWyjazdowaPutSignup(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/signups/audit-log') {
        await handleListaWyjazdowaGetAuditLog(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/roster') {
        await handleListaWyjazdowaGetRoster(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/members/directory') {
        await handleMembersDirectory(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/my-role') {
        await handleListaWyjazdowaGetMyRole(req, res, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/signups/skladka') {
        await handleListaWyjazdowaPutSkladkaPaid(req, res, url, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/wpisowe') {
        await handleListaWyjazdowaPutWpisowe(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/dues') {
        await handleListaWyjazdowaGetDues(req, res, url, deps);
      } else if (req.method === 'PUT' && url.pathname === '/lista-wyjazdowa/dues') {
        await handleListaWyjazdowaPutDues(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/lista-wyjazdowa/dues/audit-log') {
        await handleListaWyjazdowaGetDuesAuditLog(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/instagram-posts') {
        if (!rejectIfRateLimited(req, res)) await handleInstagramPosts(res);
      } else if (req.method === 'GET' && url.pathname === '/facebook-posts') {
        if (!rejectIfRateLimited(req, res)) await handleFacebookPosts(res, deps);
      } else if (req.method === 'GET' && url.pathname === '/youtube-videos') {
        if (!rejectIfRateLimited(req, res)) await handleYouTubeVideos(res);
      } else if (req.method === 'GET' && url.pathname === '/admin/settings') {
        await handleAdminGetSettings(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/settings') {
        await handleAdminUpdateSettings(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/delete-drive-gallery') {
        await handleDeleteDriveGallery(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/start') {
        await handleStart(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/register') {
        await handleRegister(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/unregister') {
        await handleUnregister(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/upload') {
        await handleUpload(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/status') {
        await handleStatus(req, res, url, deps);
      } else if (req.method === 'POST' && url.pathname === '/finalize') {
        await handleFinalize(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/gallery-photos/start') {
        await handleGalleryPhotosStart(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/gallery-photos/finalize') {
        await handleGalleryPhotosFinalize(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/gallery-photos/uploaders') {
        await handleGalleryPhotoUploaders(req, res, url, deps);
      } else {
        sendJson(res, 404, { error: 'Nie znaleziono.' });
      }
    } catch (err) {
      if (err instanceof AuthError) {
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof AuditQueryError) {
        // Deterministic rejection of an unsupported audit query shape (e.g. two primary
        // selectors, or a malformed cursor/date) - implementation-contract.md requires this be a
        // clean 400, never a 500 or a best-effort partial scan.
        sendJson(res, 400, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Błąd serwera.' });
      }
    }
  };
}

// config.ts validates required env vars at import time, so it's only imported here, inside the
// entry-point guard below - importing server.ts as a module (as server.test.ts does) must not
// require every production env var to be set, nor start a real listening server as a side effect.
async function startProductionServer(): Promise<void> {
  const { config } = await import('./config.ts');
  const driveDeps = {
    clientId: config.driveClientId,
    clientSecret: config.driveClientSecret,
    refreshToken: config.driveRefreshToken,
  };
  // See config.ts's docsClientId comment - falls back to driveDeps until that separate Web
  // OAuth client's credential exists, so /wojownicy-docs keeps failing closed (403/404 from
  // Drive) rather than the whole service failing to boot over a not-yet-done one-time setup.
  const docsDriveDeps = config.docsClientId && config.docsClientSecret && config.docsRefreshToken
    ? { clientId: config.docsClientId, clientSecret: config.docsClientSecret, refreshToken: config.docsRefreshToken }
    : driveDeps;
  const firestoreClient = createFirestoreClient(config.firestoreProjectId);
  const adminAllowlist = createSheetAllowlist({ url: config.adminAllowlistSheetUrl });
  const adminAuthorizer = fromAllowlist(adminAllowlist);
  // KRKG-0065: read-only, never used for authorization - see ServerDeps.listGroupEmails.
  const krukiGroupAllowlist = createAppsScriptAllowlist({ url: config.krukiGroupSyncUrl });
  // KRKG-0046: replaces the Apps-Script/Google-Group-backed allowlist that hit Google's daily
  // Groups-read quota in production. A single Firestore members/{email} read is now the sole
  // authorization check for ordinary member site access - admin stays on its own Sheet allowlist
  // (design.md's scope inventory); moderator moved onto Firestore roles too as of KRKG-0049.
  const memberAuthorizer = createFirestoreMemberAuthorizer(firestoreClient);
  // KRKG-0049: the "Zarządzanie ludźmi" page's gate - either the admin allowlist, or a Firestore
  // 'moderator'/'admin' userRoles grant (see roles.ts's createRoleAuthorizer). anyOf tries each in
  // order and only rejects if every one does.
  const adminOrModeratorAuthorizer = anyOf(adminAuthorizer, createRoleAuthorizer(firestoreClient, 'moderator'));
  const sessionVerifyConfig: SessionVerifyConfig = {
    sessionSigningKeys: config.sessionSigningKeys,
    sessionSlidingWindowMs: config.sessionSlidingWindowMs,
    sessionMaxLifetimeMs: config.sessionMaxLifetimeMs,
  };
  // Every *WithStepUp variant does the same two things on top of the plain cookie check: force
  // a live (non-cached) authorization re-check, then require reauthAt within the last
  // reauthFreshnessWindowMs - see design-v2.md Phase 1 point 9 for why that has to be a
  // separate, non-renewable field rather than derived from the (sliding-renewed) session itself.
  // For the Firestore-backed memberAuthorizer, "live re-check" is simply its normal behavior
  // (no cache to force-bypass) - forceRefresh is a no-op there but harmless to pass through.
  function withStepUp(authorizer: Authorizer) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<SessionClaims> => {
      const claims = await verifySessionRequest(req, res, sessionVerifyConfig, authorizer, { forceRefresh: true });
      checkReauthFreshness(claims, Date.now(), config.reauthFreshnessWindowMs);
      return claims;
    };
  }
  // KRKG-0046: disabled (fails safe, "not_configured") until the one-time Sheets OAuth setup
  // (scripts/get-sheets-refresh-token.ts) is done - never a boot-time failure.
  const sheetsClient: SheetsClient =
    config.sheetsClientId && config.sheetsClientSecret && config.sheetsRefreshToken && config.membersBackupSheetId
      ? createSheetsClient({
          clientId: config.sheetsClientId,
          clientSecret: config.sheetsClientSecret,
          refreshToken: config.sheetsRefreshToken,
          sheetId: config.membersBackupSheetId,
        })
      : createDisabledSheetsClient();
  const productionDeps: ServerDeps = {
    drive: createDriveClient(driveDeps, docsDriveDeps),
    github: createGithubClient({ token: config.githubToken, repo: config.githubRepo }),
    firestore: firestoreClient,
    authenticate: (req, res) => verifySessionRequest(req, res, sessionVerifyConfig, memberAuthorizer),
    authenticateWithStepUp: withStepUp(memberAuthorizer),
    authenticateAdmin: (req, res) => verifySessionRequest(req, res, sessionVerifyConfig, adminAuthorizer),
    authenticateAdminWithStepUp: withStepUp(adminAuthorizer),
    authenticateWojownicyUpload: (req, res) => verifySessionRequest(req, res, sessionVerifyConfig, memberAuthorizer),
    authenticateAdminOrModerator: (req, res) => verifySessionRequest(req, res, sessionVerifyConfig, adminOrModeratorAuthorizer),
    authenticateAdminOrModeratorWithStepUp: withStepUp(adminOrModeratorAuthorizer),
    // KRKG-0046: no longer checks any allowlist - it must succeed for any verified Google
    // identity, member or not, so a not-yet-approved applicant can reach /membership/apply.
    // Authorization for every actual privileged route is still enforced independently and
    // unchanged (verifySessionRequest above) - this only changes when a non-member first
    // receives a session, not what that session can do.
    authenticateSessionLogin: async idToken => verifyGoogleIdToken(idToken, config.googleOAuthClientId),
    authenticateSessionOnly: (req, res) => verifySessionOnly(req, res, sessionVerifyConfig),
    sessionSigningKeys: config.sessionSigningKeys,
    sessionSlidingWindowMs: config.sessionSlidingWindowMs,
    sessionMaxLifetimeMs: config.sessionMaxLifetimeMs,
    reauthFreshnessWindowMs: config.reauthFreshnessWindowMs,
    submissionTokenSecret: config.submissionTokenSecret,
    driveParentFolderId: config.driveParentFolderId,
    wojownicyDocs: config.wojownicyDocs,
    allowedOrigin: config.allowedOrigin,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerSubmission: config.maxFilesPerSubmission,
    allowedMimeTypes: config.allowedMimeTypes,
    maxJsonBodyBytes: config.maxJsonBodyBytes,
    galleriesCacheTtlMs: config.galleriesCacheTtlMs,
    listMemberEmails: () => listActiveMemberEmails(firestoreClient),
    listGroupEmails: () => krukiGroupAllowlist.getEmails(),
    sheetsClient,
    auditReconcilerServiceAccountEmail: config.auditReconcilerServiceAccountEmail,
    auditReconcileAudience: config.auditReconcileAudience,
  };
  const server = createServer(createRequestListener(productionDeps));
  server.listen(config.port, () => {
    console.log(`upload-service listening on :${config.port}`);
  });

  // Pre-warms the auth caches (Google's JWKS, the admin allowlist) as soon as the container
  // boots, in the background - not awaited before listen() above, so this never delays Cloud
  // Run's readiness check. A cold instance already pays real startup latency; without this,
  // whichever visitor's request happens to arrive first also pays for a JWKS fetch plus an
  // allowlist fetch (the Sheet CSV) stacked on top of that, lazily, inline with their own
  // request. Warming here means that cost is paid once at boot instead. KRKG-0046/KRKG-0049: the
  // member and moderator-role authorizers have no cache to warm (a plain Firestore document read
  // per request, no daily quota to protect), so neither is included here.
  Promise.all([fetchGoogleJwks(), adminAllowlist.getEmails()]).catch(err => {
    console.error('Nie udało się wstępnie rozgrzać pamięci podręcznej uwierzytelniania:', err);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startProductionServer();
}
