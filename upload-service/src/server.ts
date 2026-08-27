import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AuthError, fetchGoogleJwks, verifyUploader, type VerifiedIdentity } from './auth.ts';
import { createAppsScriptAllowlist, createSheetAllowlist } from './allowlist.ts';
import { checkSubmissionOwnership, issueSubmissionToken, verifySubmissionToken } from './submission.ts';
import { createDriveClient, type DriveClient } from './drive.ts';
import { createGithubClient, type GithubClient } from './github.ts';
import { mimeTypesEquivalent, sniffImageMimeType, SNIFF_BYTES } from './imageSniff.ts';
import { fetchInstagramPosts, fetchFacebookPosts, fetchYouTubeVideos, clearSocialMediaCache } from './social-media.ts';
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
  parsePersonFolderName,
  type AboutUsCategory,
  type AdminDepartment,
} from './about-us.ts';

// Long enough to cover a large gallery uploaded over a flaky connection across several
// sittings, short enough that a lost/abandoned submission token doesn't stay valid forever.
// Deliberately longer than a single Google ID token's lifetime - the frontend re-authenticates
// mid-upload as needed (see dodaj-galerie.js's ensureFreshIdToken) rather than the two lifetimes
// being assumed to match.
const SUBMISSION_TTL_MS = 6 * 60 * 60 * 1000;

export interface ServerDeps {
  drive: DriveClient;
  github: GithubClient;
  authenticate: (req: IncomingMessage) => Promise<VerifiedIdentity>;
  // Same Google-ID-token verification as `authenticate`, checked against a separate,
  // smaller allowlist (Task 1) - kept as its own function rather than a second parameter
  // to `authenticate` so route handlers can't accidentally mix the two up.
  authenticateAdmin: (req: IncomingMessage) => Promise<VerifiedIdentity>;
  // Same shape again, checked against the kruki Google Group's live membership (via an Apps
  // Script Web App, see createAppsScriptAllowlist) instead of a Sheet - gates the self-service
  // "Wrzucam swoje zdjęcie" flow in the Wojownicy section.
  authenticateWojownicyUpload: (req: IncomingMessage) => Promise<VerifiedIdentity>;
  submissionTokenSecret: string;
  driveParentFolderId: string;
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
const folderLocks = new Map<string, Promise<unknown>>();

function withFolderLock<T>(folderId: string, fn: () => Promise<T>): Promise<T> {
  const previous = folderLocks.get(folderId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  folderLocks.set(
    folderId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
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
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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
  const identity = await deps.authenticate(req);
  sendJson(res, 200, { email: identity.email });
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

// Public and unauthenticated, like the static albums.generated.json it's replacing for Drive
// galleries - the cache above is what keeps this from becoming a live-Drive-call-per-page-view.
async function handleGalleries(res: ServerResponse, deps: ServerDeps): Promise<void> {
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
  const identity = await deps.authenticateAdmin(req);
  sendJson(res, 200, { email: identity.email });
}

// Not scoped to About Us specifically - clears the Instagram/Facebook posts cache so the
// homepage's Aktualności feed picks up new posts immediately, instead of waiting out the 6h TTL.
async function handleAdminRefreshSocialCache(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  clearSocialMediaCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminCreatePerson(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const { category, name, order, description } = await readJsonBody<{
    category?: string;
    name?: string;
    order?: number | null;
    description?: string;
  }>(req, deps.maxJsonBodyBytes);
  const validCategory = parseAboutUsCategory(category ?? null);
  if (!name || !name.trim()) throw new AuthError('Brak imienia.', 400);

  const folders = await bootstrapAboutUsStructure(deps.drive);
  const folderName = buildPersonFolderName(name, order ?? null);
  const folderId = await deps.drive.createAlbumFolder(folders.categories[validCategory], folderName);
  if (description) {
    await deps.drive.writeTextFile(folderId, 'Opis.txt', description);
  }
  invalidateAboutUsCache();
  sendJson(res, 200, { folderId });
}

async function handleAdminUpdateDescription(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const { description } = await readJsonBody<{ description?: string }>(req, deps.maxJsonBodyBytes);
  await deps.drive.writeTextFile(folderId, 'Opis.txt', description ?? '');
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeletePerson(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  await deps.drive.deleteFolder(folderId);
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminListPeople(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const department = parseAdminDepartment(url.searchParams.get('category'));
  const folders = await bootstrapAboutUsStructure(deps.drive);
  const people = await fetchCategoryPeople(deps.drive, departmentFolderId(folders, department));
  sendJson(res, 200, { people });
}

// Renames the folder to reflect a new display order and/or name - the two always travel
// together (see buildPersonFolderName) so the admin panel sends both, even when only one
// actually changed, rather than this handler needing to fetch the current folder name first.
async function handleAdminUpdatePersonOrder(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const { folderId, name, order } = await readJsonBody<{ folderId?: string; name?: string; order?: number | null }>(
    req,
    deps.maxJsonBodyBytes,
  );
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  if (!name || !name.trim()) throw new AuthError('Brak imienia.', 400);
  await deps.drive.renameFolder(folderId, buildPersonFolderName(name, order ?? null));
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
  await deps.authenticateAdmin(req);
  const { folderId, category } = await readJsonBody<{ folderId?: string; category?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const department = parseAdminDepartment(category ?? null);
  const folders = await bootstrapAboutUsStructure(deps.drive);
  const targetFolderId = departmentFolderId(folders, department);
  const { name: currentFolderName } = await deps.drive.moveFolder(folderId, targetFolderId);

  if (isAboutUsCategory(department)) {
    const siblings = await deps.drive.listGalleryFolders(targetFolderId);
    const newOrder = computeOrderForDepartmentMove(
      department,
      siblings.filter(f => f.id !== folderId).map(f => f.name),
    );
    const { name: personName } = parsePersonFolderName(currentFolderName);
    await deps.drive.renameFolder(folderId, buildPersonFolderName(personName, newOrder));
  }

  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminUploadPhoto(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const folderId = url.searchParams.get('folderId');
  const fileName = url.searchParams.get('fileName');
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  if (!folderId || !fileName) throw new AuthError('Brak folderId lub fileName.', 400);
  requireAllowedMimeType(mimeType, deps.allowedMimeTypes);
  await deps.drive.uploadFileStream(
    folderId,
    decodeURIComponent(fileName),
    mimeType,
    validatedUploadStream(req, deps.maxFileBytes, mimeType),
  );
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeletePhoto(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const fileId = url.searchParams.get('fileId');
  if (!fileId) throw new AuthError('Brak fileId.', 400);
  await deps.drive.deleteFolder(fileId);
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Designates one photo in a folder as the "main" one, by giving it (and only it) the leading
// "!" that fetchCategoryPeople's alphabetical sort relies on (see the comment on isMain in
// handleWojownicyUploadPhoto below for why "!" specifically) - strips the prefix from whatever
// other file currently has it first, so exactly one photo is ever marked main at a time.
async function handleAdminSetMainPhoto(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const { folderId, fileId } = await readJsonBody<{ folderId?: string; fileId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId || !fileId) throw new AuthError('Brak folderId lub fileId.', 400);
  const images = await deps.drive.listImageFiles(folderId);
  for (const image of images) {
    const isTarget = image.id === fileId;
    const hasMainPrefix = image.name.startsWith('!');
    if (isTarget && !hasMainPrefix) {
      await deps.drive.renameFolder(image.id, `!${image.name}`);
    } else if (!isTarget && hasMainPrefix) {
      await deps.drive.renameFolder(image.id, image.name.slice(1));
    }
  }
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Moves a single photo into a different person's folder - see moveFile in drive.ts for why
// (reviewing an upload-staging submission for someone who already has an existing profile).
async function handleAdminTransferPhoto(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const { fileId, targetFolderId } = await readJsonBody<{ fileId?: string; targetFolderId?: string }>(
    req,
    deps.maxJsonBodyBytes,
  );
  if (!fileId || !targetFolderId) throw new AuthError('Brak fileId lub targetFolderId.', 400);
  await deps.drive.moveFile(fileId, targetFolderId);
  invalidateAboutUsCache();
  sendJson(res, 200, { ok: true });
}

// Toggles the "Oznacz jako in memoriam" marker (see IN_MEMORIAM_FILE_NAME in about-us.ts) - the
// public site renders this person's photos grayscale with a black diagonal ribbon once set.
async function handleAdminSetInMemoriam(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticateAdmin(req);
  const { folderId, inMemoriam } = await readJsonBody<{ folderId?: string; inMemoriam?: boolean }>(req, deps.maxJsonBodyBytes);
  if (!folderId || typeof inMemoriam !== 'boolean') throw new AuthError('Brak folderId lub inMemoriam.', 400);
  await deps.drive.writeTextFile(folderId, IN_MEMORIAM_FILE_NAME, inMemoriam ? 'true' : 'false');
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
  const identity = await deps.authenticateWojownicyUpload(req);
  sendJson(res, 200, { email: identity.email });
}

// Creates the per-submission staging folder (Strona/O Nas/upload/{Imię} - {email} - {data}) and
// issues a submission token exactly like handleStart does for gallery uploads - the two photo
// endpoints below require it, so one group member can't upload into another's (or an admin
// category's) folder just by guessing/reusing a folderId.
async function handleWojownicyUploadSubmit(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticateWojownicyUpload(req);
  const { name } = await readJsonBody<{ name?: string }>(req, deps.maxJsonBodyBytes);
  if (!name || !name.trim()) throw new AuthError('Brak imienia.', 400);

  const folders = await bootstrapAboutUsStructure(deps.drive);
  const date = new Date().toISOString().slice(0, 10);
  const folderName = `${name.trim()} - ${identity.email} - ${date}`;
  const folderId = await deps.drive.createAlbumFolder(folders.uploadRoot, folderName);
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
  const identity = await deps.authenticateWojownicyUpload(req);
  const folderId = url.searchParams.get('folderId');
  const fileName = url.searchParams.get('fileName');
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  const isMain = url.searchParams.get('isMain') === 'true';
  if (!folderId || !fileName) throw new AuthError('Brak folderId lub fileName.', 400);
  requireAllowedMimeType(mimeType, deps.allowedMimeTypes);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  const reserved = await reserveUploadSlot(deps.drive, folderId, deps.maxFilesPerSubmission);
  if (!reserved) {
    throw new AuthError(`Zgłoszenie osiągnęło maksymalną liczbę zdjęć (${deps.maxFilesPerSubmission}).`, 400);
  }

  const targetName = isMain ? `!main.${extensionForMimeType(mimeType)}` : decodeURIComponent(fileName);
  try {
    await deps.drive.uploadFileStream(
      folderId,
      targetName,
      mimeType,
      validatedUploadStream(req, deps.maxFileBytes, mimeType),
    );
  } catch (err) {
    releaseUploadSlot(folderId);
    throw err;
  }
  sendJson(res, 200, { ok: true });
}

// Only for galleries this service itself created (drive.file scope can't touch anything else -
// see KRKG-0025's design.md) - a folder registered by URL instead goes through /unregister.
async function handleDeleteDriveGallery(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticate(req);
  const { folderId } = await readJsonBody<{ folderId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  await deps.drive.deleteFolder(folderId);
  // Invalidated immediately rather than left to expire on its own TTL, so the deletion is
  // reflected on the next /galleries call instead of up to galleriesCacheTtlMs later.
  galleriesCache = null;
  sendJson(res, 200, { ok: true });
}

async function handleStart(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req);
  const { name, date } = await readJsonBody<{ name?: string; date: string }>(req, deps.maxJsonBodyBytes);
  if (!date) throw new AuthError('Brak daty albumu.', 400);
  const folderName = name ? `${date} ${name}` : date;
  const folderId = await deps.drive.createAlbumFolder(deps.driveParentFolderId, folderName);
  const submissionToken = issueSubmissionToken(
    { folderId, sub: identity.sub, exp: Date.now() + SUBMISSION_TTL_MS },
    deps.submissionTokenSecret,
  );
  sendJson(res, 200, { folderId, submissionToken });
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req);
  const folderId = url.searchParams.get('folderId');
  const fileName = url.searchParams.get('fileName');
  const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';
  if (!folderId || !fileName) throw new AuthError('Brak folderId lub fileName.', 400);
  requireAllowedMimeType(mimeType, deps.allowedMimeTypes);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  // Reserved exactly, in-process, before every write - not an approximation. See the comment
  // above reserveUploadSlot for why this is correct (single Cloud Run instance + a per-folder
  // lock) where the earlier margin-based check wasn't. /finalize's own count check remains as
  // an unconditional backstop regardless.
  const reserved = await reserveUploadSlot(deps.drive, folderId, deps.maxFilesPerSubmission);
  if (!reserved) {
    throw new AuthError(`Zgłoszenie osiągnęło maksymalną liczbę zdjęć (${deps.maxFilesPerSubmission}).`, 400);
  }

  let uploaded: { id: string };
  try {
    uploaded = await deps.drive.uploadFileStream(
      folderId,
      decodeURIComponent(fileName),
      mimeType,
      validatedUploadStream(req, deps.maxFileBytes, mimeType),
    );
  } catch (err) {
    releaseUploadSlot(folderId);
    throw err;
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
  const identity = await deps.authenticate(req);
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);
  const uploadedFiles = await deps.drive.listFiles(folderId);
  sendJson(res, 200, { uploadedFiles });
}

async function handleFinalize(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req);
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

  // Written while the folder is still private, before anything public-facing happens - a
  // failure here simply fails /finalize with no compensating action needed.
  await deps.drive.writeManifest(folderId, {
    ...(name ? { name } : {}),
    date,
    contributors: [identity.email],
  });

  // No albums.json/GitHub commit needed here - the app owns this folder (it created it), so
  // GET /galleries already discovers it live via the manifest just written above. Registering
  // a folder the app did NOT create (an existing external gallery) goes through /register
  // instead, which commits to albums.json for the pipeline-based sync to pick up.
  await deps.drive.setFolderPublic(folderId);
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
  const identity = await deps.authenticate(req);
  const { folderId } = await readJsonBody<{ folderId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  await requireExistingGalleryFolder(deps.drive, deps.driveParentFolderId, folderId);
  const submissionToken = issueSubmissionToken(
    { folderId, sub: identity.sub, exp: Date.now() + SUBMISSION_TTL_MS },
    deps.submissionTokenSecret,
  );
  sendJson(res, 200, { folderId, submissionToken });
}

// Counterpart to /finalize for the same flow - the gallery is already public and already has a
// manifest with its own name/date, so this only ever adds the uploader to `contributors` (never
// overwrites name/date, and never re-publishes) rather than writing a fresh manifest from
// scratch.
async function handleGalleryPhotosFinalize(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req);
  const { folderId } = await readJsonBody<{ folderId?: string }>(req, deps.maxJsonBodyBytes);
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const claims = verifySubmissionToken(requireSubmissionToken(req), deps.submissionTokenSecret);
  checkSubmissionOwnership(claims, folderId, identity.sub);

  const existing = await deps.drive.readManifest(folderId);
  const contributors = new Set(existing?.contributors ?? []);
  contributors.add(identity.email);
  await deps.drive.writeManifest(folderId, {
    ...(existing?.name ? { name: existing.name } : {}),
    date: existing?.date ?? new Date().toISOString().slice(0, 10),
    contributors: [...contributors],
  });
  galleriesCache = null;
  sendJson(res, 200, { ok: true });
}

// Public and unauthenticated, like /galleries - lets the gallery detail view show "Dodane
// przez" (avatar/name/timestamp) for each photo without requiring a visitor to sign in just to
// look. Not more sensitive than what /galleries already exposes (contributor email addresses).
async function handleGalleryPhotoUploaders(res: ServerResponse, url: URL, deps: ServerDeps): Promise<void> {
  const folderId = url.searchParams.get('folderId');
  if (!folderId) throw new AuthError('Brak folderId.', 400);
  const uploaders = await readUploadLog(deps.drive, folderId);
  sendJson(res, 200, { uploaders });
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
  await deps.authenticate(req);
  const { url, name, date } = await readJsonBody<{ url?: string; name?: string; date: string }>(req, deps.maxJsonBodyBytes);
  if (!url || !date) throw new AuthError('Brak adresu URL galerii lub daty.', 400);
  try {
    new URL(url);
  } catch {
    throw new AuthError('Nieprawidłowy adres URL galerii.', 400);
  }

  await deps.github.appendAlbumToMain({
    url,
    ...(name ? { nameOverride: name } : {}),
    dateOverride: date,
  });
  sendJson(res, 200, { ok: true });
}

// Deletes a gallery registered by URL (Photos or Drive-by-URL - both live only as an
// albums.json entry, see handleRegister above) by removing that entry, same auth gate as
// everything else. An app-owned Drive folder is deleted via /delete-drive-gallery instead.
async function handleUnregister(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  await deps.authenticate(req);
  const { url } = await readJsonBody<{ url?: string }>(req, deps.maxJsonBodyBytes);
  if (!url) throw new AuthError('Brak adresu URL galerii.', 400);
  await deps.github.removeAlbumFromMain(url);
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
    console.error('Instagram posts fetch error:', error);
    sendJson(res, 500, {
      error: 'Nie udało się pobrać postów z Instagrama.',
      details: error instanceof Error ? error.message : String(error),
      posts: [],
      source: 'instagram',
      lastUpdated: new Date().toISOString()
    });
  }
}

async function handleFacebookPosts(res: ServerResponse): Promise<void> {
  try {
    const posts = await fetchFacebookPosts();
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
    console.error('Facebook posts fetch error:', error);
    sendJson(res, 500, {
      error: 'Nie udało się pobrać postów z Facebooka.',
      details: error instanceof Error ? error.message : String(error),
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
    console.error('YouTube videos fetch error:', error);
    sendJson(res, 500, {
      error: 'Nie udało się pobrać filmów z YouTube.',
      details: error instanceof Error ? error.message : String(error),
      channelTitle: '',
      channelThumbnail: '',
      channelUrl: '',
      videos: [],
      lastUpdated: new Date().toISOString(),
    });
  }
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
      if (req.method === 'GET' && url.pathname === '/whoami') {
        await handleWhoami(req, res, deps);
      } else if (req.method === 'GET' && url.pathname === '/galleries') {
        await handleGalleries(res, deps);
      } else if (req.method === 'GET' && url.pathname === '/about-us') {
        await handleAboutUs(res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/admin/whoami') {
        await handleAdminWhoami(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/admin/social-media/refresh') {
        await handleAdminRefreshSocialCache(req, res, deps);
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
      } else if (req.method === 'GET' && url.pathname === '/instagram-posts') {
        await handleInstagramPosts(res);
      } else if (req.method === 'GET' && url.pathname === '/facebook-posts') {
        await handleFacebookPosts(res);
      } else if (req.method === 'GET' && url.pathname === '/youtube-videos') {
        await handleYouTubeVideos(res);
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
        await handleGalleryPhotoUploaders(res, url, deps);
      } else {
        sendJson(res, 404, { error: 'Nie znaleziono.' });
      }
    } catch (err) {
      if (err instanceof AuthError) {
        sendJson(res, err.status, { error: err.message });
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
  const adminAllowlist = createSheetAllowlist({ url: config.adminAllowlistSheetUrl });
  // One shared allowlist (live kruki Google Group membership, see createAppsScriptAllowlist)
  // now gates both the Krucze Galerie access/upload flow and the Wojownicy self-service
  // upload flow - previously galerie had its own separate, manually-maintained Sheet. Sharing
  // one instance (not two separate ones pointed at the same URL) also means one cache, so a
  // visitor hitting both flows doesn't double the Apps Script call volume.
  const groupAllowlist = createAppsScriptAllowlist({ url: config.wojownicyUploadGroupUrl });
  const productionDeps: ServerDeps = {
    drive: createDriveClient(driveDeps),
    github: createGithubClient({ token: config.githubToken, repo: config.githubRepo }),
    authenticate: req => verifyUploader(req, config.googleOAuthClientId, groupAllowlist),
    authenticateAdmin: req => verifyUploader(req, config.googleOAuthClientId, adminAllowlist),
    authenticateWojownicyUpload: req => verifyUploader(req, config.googleOAuthClientId, groupAllowlist),
    submissionTokenSecret: config.submissionTokenSecret,
    driveParentFolderId: config.driveParentFolderId,
    allowedOrigin: config.allowedOrigin,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerSubmission: config.maxFilesPerSubmission,
    allowedMimeTypes: config.allowedMimeTypes,
    maxJsonBodyBytes: config.maxJsonBodyBytes,
    galleriesCacheTtlMs: config.galleriesCacheTtlMs,
  };
  const server = createServer(createRequestListener(productionDeps));
  server.listen(config.port, () => {
    console.log(`upload-service listening on :${config.port}`);
  });

  // Pre-warms the auth caches (Google's JWKS, both allowlists) as soon as the container boots,
  // in the background - not awaited before listen() above, so this never delays Cloud Run's
  // readiness check. A cold instance already pays real startup latency; without this, whichever
  // visitor's request happens to arrive first also pays for a JWKS fetch plus an allowlist fetch
  // (a Sheet CSV, or worse, the Apps Script group check) stacked on top of that, lazily, inline
  // with their own request. Warming here means that cost is paid once at boot instead.
  Promise.all([fetchGoogleJwks(), adminAllowlist.getEmails(), groupAllowlist.getEmails()]).catch(err => {
    console.error('Nie udało się wstępnie rozgrzać pamięci podręcznej uwierzytelniania:', err);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startProductionServer();
}
