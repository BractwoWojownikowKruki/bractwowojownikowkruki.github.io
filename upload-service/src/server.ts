import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AuthError, verifyUploader, type VerifiedIdentity } from './auth.ts';
import { createSheetAllowlist } from './allowlist.ts';
import { checkSubmissionOwnership, issueSubmissionToken, verifySubmissionToken } from './submission.ts';
import { createDriveClient, type DriveClient } from './drive.ts';
import { createGithubClient, type GithubClient } from './github.ts';
import { mimeTypesEquivalent, sniffImageMimeType, SNIFF_BYTES } from './imageSniff.ts';
import { extractDriveFolderId } from './urls.ts';

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
  // Delay before each revoke retry in /finalize's failure-compensation path. Empty in tests
  // for speed; production uses real backoff (see productionDeps below).
  revokeRetryDelaysMs: number[];
  // Called when /finalize fails to publish AND every revoke retry also fails, so the folder
  // may still be publicly readable with no automatic fix. Production logs a structured line
  // a Cloud Logging alert policy is wired to match (Task 0 Step 12); tests substitute a spy.
  alertStuckFolder: (folderId: string, driveUrl: string, reason: string) => void;
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

function setCors(res: ServerResponse, allowedOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries revokeFolderPublic with the configured backoff before giving up - a transient Drive
// error on the compensating revoke shouldn't immediately strand a folder in the public state.
async function revokeWithRetry(drive: DriveClient, folderId: string, delaysMs: number[]): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await drive.revokeFolderPublic(folderId);
      return true;
    } catch {
      if (attempt >= delaysMs.length) return false;
      await sleep(delaysMs[attempt]);
    }
  }
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

  try {
    await deps.drive.uploadFileStream(
      folderId,
      decodeURIComponent(fileName),
      mimeType,
      validatedUploadStream(req, deps.maxFileBytes, mimeType),
    );
  } catch (err) {
    releaseUploadSlot(folderId);
    throw err;
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

  // Folder stays private until this point. If the GitHub commit fails after this, the just-
  // granted public permission is revoked below (with retry) - a half-finalized submission
  // is never left publicly link-accessible with no compensating action or recovery path.
  await deps.drive.setFolderPublic(folderId);
  try {
    await deps.github.appendAlbumToMain({
      url: `https://drive.google.com/drive/folders/${folderId}`,
      ...(name ? { nameOverride: name } : {}),
      dateOverride: date,
    });
  } catch (err) {
    const revoked = await revokeWithRetry(deps.drive, folderId, deps.revokeRetryDelaysMs);
    if (!revoked) {
      deps.alertStuckFolder(
        folderId,
        `https://drive.google.com/drive/folders/${folderId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
  sendJson(res, 200, { ok: true });
}

// Lets an already-authenticated, allowlisted user register a gallery that already exists,
// instead of uploading files - replaces the old GitHub Issue/PR submission path with something
// tied to a real authenticated identity rather than self-reported issue-form data.
async function handleRegister(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const identity = await deps.authenticate(req);
  const { url, name, date } = await readJsonBody<{ url?: string; name?: string; date: string }>(req, deps.maxJsonBodyBytes);
  if (!url || !date) throw new AuthError('Brak adresu URL galerii lub daty.', 400);
  try {
    new URL(url);
  } catch {
    throw new AuthError('Nieprawidłowy adres URL galerii.', 400);
  }

  const driveFolderId = extractDriveFolderId(url);
  if (driveFolderId) {
    // Requires the folder to already be shared with edit access to this service's Drive
    // credentials - if it isn't, writeManifest's Drive error propagates as a 500 like any
    // other Drive failure elsewhere in this service.
    await deps.drive.writeManifest(driveFolderId, {
      ...(name ? { name } : {}),
      date,
      contributors: [identity.email],
    });
    sendJson(res, 200, { ok: true, type: 'drive', folderId: driveFolderId });
    return;
  }

  await deps.github.appendAlbumToMain({
    url,
    ...(name ? { nameOverride: name } : {}),
    dateOverride: date,
  });
  sendJson(res, 200, { ok: true, type: 'photos' });
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
      } else if (req.method === 'POST' && url.pathname === '/start') {
        await handleStart(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/register') {
        await handleRegister(req, res, deps);
      } else if (req.method === 'POST' && url.pathname === '/upload') {
        await handleUpload(req, res, url, deps);
      } else if (req.method === 'GET' && url.pathname === '/status') {
        await handleStatus(req, res, url, deps);
      } else if (req.method === 'POST' && url.pathname === '/finalize') {
        await handleFinalize(req, res, deps);
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

// Structured so a Cloud Logging alert policy (Task 0 Step 12) can match on
// jsonPayload.alert === "stuck-public-drive-folder" and notify an administrator.
function alertStuckFolder(folderId: string, driveUrl: string, reason: string): void {
  console.error(
    JSON.stringify({
      alert: 'stuck-public-drive-folder',
      folderId,
      driveUrl,
      reason,
      message:
        'Publishing failed and revoking public Drive access also failed after retries - this folder may still be publicly readable and needs manual review.',
    }),
  );
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
  const allowlist = createSheetAllowlist({ url: config.allowlistSheetUrl });
  const productionDeps: ServerDeps = {
    drive: createDriveClient(driveDeps),
    github: createGithubClient({ token: config.githubToken, repo: config.githubRepo }),
    authenticate: req => verifyUploader(req, config.googleOAuthClientId, allowlist),
    submissionTokenSecret: config.submissionTokenSecret,
    driveParentFolderId: config.driveParentFolderId,
    allowedOrigin: config.allowedOrigin,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerSubmission: config.maxFilesPerSubmission,
    allowedMimeTypes: config.allowedMimeTypes,
    maxJsonBodyBytes: config.maxJsonBodyBytes,
    galleriesCacheTtlMs: config.galleriesCacheTtlMs,
    revokeRetryDelaysMs: [500, 1500, 3000],
    alertStuckFolder,
  };
  const server = createServer(createRequestListener(productionDeps));
  server.listen(config.port, () => {
    console.log(`upload-service listening on :${config.port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startProductionServer();
}
