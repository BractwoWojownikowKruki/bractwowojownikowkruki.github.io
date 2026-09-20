import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { AuthError } from './auth.ts';
import {
  createRequestListener,
  fromAllowlist,
  anyOf,
  getFolderLockKeyCountForTests,
  readSessionCookie,
  verifySessionRequest,
  type ServerDeps,
  type SessionVerifyConfig,
} from './server.ts';
import { issueSessionToken, verifySessionToken, type SessionClaims, type SessionSigningKey } from './session.ts';
import type { SheetAllowlist } from './allowlist.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DriveClient, DriveFileInfo } from './drive.ts';
import type { GithubClient } from './github.ts';
import { resetAboutUsBootstrapForTests } from './about-us.ts';
import { resetSettingsBootstrapForTests } from './settings.ts';
import { resetRateLimitForTests } from './rate-limit.ts';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { createDisabledSheetsClient } from './sheets.ts';
import { createRoleAuthorizer } from './roles.ts';
import { executeAuditedFirestoreMutation, startExternalOperation, completeExternalOperation } from './audit.ts';
import { getFile } from './files.ts';

const nodeFetch = globalThis.fetch;
const ALLOWED_ORIGIN_FOR_TESTS = 'https://example.test'; // matches makeDeps()'s allowedOrigin

// Response statuses that the Fetch spec forbids from carrying a body - constructing a Response
// with a non-null body at one of these statuses throws, even if the body is zero-length.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Most tests here only assert on res.status/headers and never call .json()/.text(), leaving
// undici's response body stream unconsumed. Fully draining every response ourselves -
// regardless of what the calling test actually reads - is defensive hygiene against connections
// being left in a half-read state across this suite's rapid server create/close cycles (see
// withServer). Buffering it into a plain Response also means callers can still call
// .json()/.text() exactly as before, just against the buffered bytes instead of the live socket.
async function drainResponse(res: Response): Promise<Response> {
  const buffer = await res.arrayBuffer();
  const body = NULL_BODY_STATUSES.has(res.status) ? null : buffer;
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// The escape hatch for the handful of tests that specifically exercise the requireAllowedOrigin
// guard itself (missing Origin) - still drains the body like `fetch` below, just without
// defaulting the Origin header.
async function rawFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return drainResponse(await nodeFetch(url, options));
}

// Every real caller has sent Origin on every state-changing request since Phase 0 made
// www.kruki.org -> api.kruki.org cross-origin (cross-origin fetches always include it) - the
// central requireAllowedOrigin guard in server.ts relies on that. Defaulting it here means the
// ~150 test call sites written before that guard existed don't each need updating individually;
// `rawFetch` above is the escape hatch for the handful of tests that specifically exercise the
// guard itself (missing Origin) - a test that sets its own Origin header (e.g. a wrong one)
// doesn't need it, since an explicit header is never overridden below.
async function fetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has('Origin')) {
    headers.set('Origin', ALLOWED_ORIGIN_FOR_TESTS);
  }
  return drainResponse(await nodeFetch(url, { ...options, headers }));
}

const VALID_JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]),
  Buffer.alloc(100, 0x42),
]);

// server.ts's per-folder upload-count reservation lives in module-level state, correct in
// production since Cloud Run runs a single instance for the whole service's lifetime. In tests,
// that means every test that reaches the reservation logic needs its own folder id - reusing a
// literal folder id across tests would otherwise leak reservation counts between them.
let nextFolderId = 0;
function uniqueFolderId(): string {
  nextFolderId += 1;
  return `folder-${nextFolderId}`;
}

function makeFakeDrive(overrides: Partial<DriveClient> = {}): DriveClient {
  return {
    createAlbumFolder: async () => 'folder-created-by-start',
    uploadFileStream: async (_folderId, _fileName, _mimeType, bodyStream) => {
      // Drain the stream so the caller's byte-counting/sniffing logic actually runs.
      for await (const _chunk of bodyStream) {
        // no-op
      }
      return { id: 'fake-uploaded-file-id' };
    },
    listFiles: async () => [],
    setFolderPublic: async () => {},
    deleteFolder: async () => {},
    folderExists: async () => true,
    getFolderParentId: async () => null,
    getFolderName: async () => null,
    renameFolder: async () => {},
    moveFolder: async () => ({ name: 'Test Person' }),
    moveFile: async () => ({}),
    writeManifest: async () => {},
    readManifest: async () => null,
    listGalleryFolders: async () => [],
    getCoverThumbnail: async () => null,
    findFolderByName: async () => null,
    ensureFolder: async () => 'ensured-folder-id',
    readTextFile: async () => null,
    writeTextFile: async () => {},
    listImageFiles: async () => [],
    exportDocHtml: async () => '<p>fake doc content</p>',
    ...overrides,
  };
}

function makeFakeGithub(overrides: Partial<GithubClient> = {}): GithubClient {
  return {
    appendAlbumToMain: async () => {},
    removeAlbumFromMain: async () => {},
    listRedirects: async () => [],
    appendRedirectToMain: async () => {},
    removeRedirectFromMain: async () => {},
    ...overrides,
  };
}

function makeFakeFirestore() {
  return createInMemoryFirestoreClient();
}

function fakeSessionClaims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    v: 'v1',
    sub: 'sub-1',
    email: 'alice@gmail.com',
    iat: Date.now(),
    reauthAt: Date.now(),
    exp: Date.now() + 14 * 24 * 60 * 60 * 1000,
    jti: 'test-jti',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    drive: makeFakeDrive(),
    github: makeFakeGithub(),
    firestore: overrides.firestore ?? makeFakeFirestore(),
    authenticate: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    authenticateWithStepUp: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    authenticateAdmin: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@gmail.com' }),
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@gmail.com' }),
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'wojownik-1', email: 'wojownik@gmail.com' }),
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@gmail.com' }),
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@gmail.com' }),
    authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    sessionSigningKeys: [{ v: 'v1', secret: 'test-session-secret' }],
    sessionSlidingWindowMs: 14 * 24 * 60 * 60 * 1000,
    sessionMaxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
    reauthFreshnessWindowMs: 30 * 60 * 1000,
    submissionTokenSecret: 'test-secret',
    driveParentFolderId: 'parent-1',
    wojownicyDocs: { 'zasady-bractwa': 'doc-zasady-1', 'poradnik-walki': 'doc-poradnik-1' },
    allowedOrigin: 'https://example.test',
    maxFileBytes: 10 * 1024 * 1024,
    maxFilesPerSubmission: 800,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
    maxJsonBodyBytes: 8192,
    // 0 by default so /galleries' module-level cache never leaks a stale result between tests;
    // the dedicated caching test below overrides this to a real TTL to exercise the cache itself.
    galleriesCacheTtlMs: 0,
    listMemberEmails: async () => [],
    listGroupEmails: async () => [],
    sheetsClient: createDisabledSheetsClient(),
    ...overrides,
  };
}

async function withServer<T>(deps: ServerDeps, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(createRequestListener(deps));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function issueTestSubmissionToken(deps: ServerDeps, folderId: string): Promise<string> {
  const { issueSubmissionToken } = await import('./submission.ts');
  return issueSubmissionToken({ folderId, sub: 'sub-1', exp: Date.now() + 60_000 }, deps.submissionTokenSecret);
}

test('OPTIONS returns 204 with CORS headers', async () => {
  await withServer(makeDeps(), async baseUrl => {
    const res = await fetch(`${baseUrl}/start`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.test');
  });
});

// Required for the browser to actually send/receive the session cookie on a credentials:
// "include" fetch (KRKG-0036 Phase 1) - without this header a credentialed cross-origin request
// is rejected by the browser regardless of Access-Control-Allow-Origin being correct.
test('every response advertises Access-Control-Allow-Credentials: true', async () => {
  await withServer(makeDeps(), async baseUrl => {
    const preflight = await fetch(`${baseUrl}/start`, { method: 'OPTIONS' });
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

    const actual = await fetch(`${baseUrl}/whoami`);
    assert.equal(actual.headers.get('access-control-allow-credentials'), 'true');
  });
});

// Regression test: PUT and DELETE were added for admin routes (edit description, delete
// person/photo) without updating this header, so the browser's CORS preflight silently
// rejected every one of those requests before they ever reached the server.
test('OPTIONS advertises PUT and DELETE alongside GET/POST for admin routes', async () => {
  await withServer(makeDeps(), async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/description`, { method: 'OPTIONS' });
    const allowed = res.headers.get('access-control-allow-methods') ?? '';
    assert.ok(allowed.includes('PUT'), `expected PUT in "${allowed}"`);
    assert.ok(allowed.includes('DELETE'), `expected DELETE in "${allowed}"`);
  });
});

test('/galleries rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticate: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    drive: makeFakeDrive({ listGalleryFolders: async () => { driveCalled = true; return []; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/galleries`);
    assert.equal(res.status, 401);
    assert.equal(driveCalled, false);
  });
});

test('/galleries merges each discovered folder with its manifest, for a signed-in kruki-group member', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      listGalleryFolders: async rootFolderId => {
        assert.equal(rootFolderId, 'parent-1');
        return [{ id: 'g1', name: 'Raw Folder Name', modifiedTime: '2026-01-01T00:00:00.000Z' }];
      },
      readManifest: async folderId => {
        assert.equal(folderId, 'g1');
        return { name: 'Zlot Wolin', date: '2026-08-09', contributors: ['alice@gmail.com'] };
      },
      getCoverThumbnail: async () => 'https://drive.example/thumb.jpg',
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/galleries`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { galleries: unknown[] };
    assert.deepEqual(body.galleries, [
      {
        id: 'g1',
        name: 'Zlot Wolin',
        date: '2026-08-09',
        contributors: ['alice@gmail.com'],
        coverThumbnailLink: 'https://drive.example/thumb.jpg',
      },
    ]);
  });
});

test('/galleries falls back to the folder name and modified time when no manifest exists', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      listGalleryFolders: async () => [{ id: 'g1', name: 'Legacy Folder', modifiedTime: '2026-01-01T00:00:00.000Z' }],
      readManifest: async () => null,
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/galleries`);
    const body = (await res.json()) as { galleries: { name: string; date: string; contributors: string[] }[] };
    assert.deepEqual(body.galleries[0], {
      id: 'g1',
      name: 'Legacy Folder',
      date: '2026-01-01T00:00:00.000Z',
      contributors: [],
      coverThumbnailLink: null,
    });
  });
});

test('/galleries serves the cached listing without calling Drive again within the TTL', async () => {
  let listCalls = 0;
  const deps = makeDeps({
    galleriesCacheTtlMs: 60_000,
    drive: makeFakeDrive({
      listGalleryFolders: async () => {
        listCalls++;
        return [{ id: 'g1', name: 'Folder', modifiedTime: '2026-01-01T00:00:00.000Z' }];
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    await fetch(`${baseUrl}/galleries`);
    await fetch(`${baseUrl}/galleries`);
  });
  assert.equal(listCalls, 1);
});

test('GET /about-us returns people for a valid category, sorted by folder-name order', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      listGalleryFolders: async parentId => {
        if (parentId !== 'folder-Blachowi') return [];
        return [
          { id: 'p2', name: '2. Piotr', modifiedTime: '2024-01-01T00:00:00Z' },
          { id: 'p1', name: '1. Ragnar', modifiedTime: '2024-01-01T00:00:00Z' },
        ];
      },
      readTextFile: async () => 'Krótki opis.',
      listImageFiles: async folderId => [{ id: `${folderId}-img1`, name: 'a.jpg', thumbnailLink: `https://example.test/${folderId}=s220` }],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/about-us?category=Blachowi`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people.length, 2);
    assert.equal(body.people[0].name, 'Ragnar');
    assert.equal(body.people[1].name, 'Piotr');
    assert.equal(body.people[0].mainPhoto.url, 'https://example.test/p1=s800');
  });
});

test('GET /about-us rejects an unknown category', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/about-us?category=NieIstnieje`);
    assert.equal(res.status, 400);
  });
});

function fakeRequestWithCookieHeader(cookie: string | undefined): IncomingMessage {
  return { headers: { cookie } } as unknown as IncomingMessage;
}

test('readSessionCookie extracts __Host-session from among several cookies', () => {
  const req = fakeRequestWithCookieHeader('other=1; __Host-session=abc.def; another=2');
  assert.equal(readSessionCookie(req), 'abc.def');
});

test('readSessionCookie returns null when the cookie header is missing', () => {
  assert.equal(readSessionCookie(fakeRequestWithCookieHeader(undefined)), null);
});

test('readSessionCookie returns null when __Host-session is not among the cookies present', () => {
  assert.equal(readSessionCookie(fakeRequestWithCookieHeader('other=1; another=2')), null);
});

const SESSION_KEY: SessionSigningKey = { v: 'v1', secret: 'test-session-secret' };
const SESSION_CONFIG: SessionVerifyConfig = {
  sessionSigningKeys: [SESSION_KEY],
  sessionSlidingWindowMs: 14 * 24 * 60 * 60 * 1000,
  sessionMaxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
};

function fakeRequestWithSessionCookie(token: string | null): IncomingMessage {
  return fakeRequestWithCookieHeader(token === null ? undefined : `__Host-session=${token}`);
}

function fakeResponseRecordingHeaders(): { res: ServerResponse; setCookie: () => string | undefined } {
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value) } as unknown as ServerResponse;
  return { res, setCookie: () => headers.get('set-cookie') };
}

function fakeAllowlist(emails: string[]): SheetAllowlist & { forceRefreshCalls: number } {
  const allowlist = {
    forceRefreshCalls: 0,
    async getEmails(options: { forceRefresh?: boolean } = {}) {
      if (options.forceRefresh) allowlist.forceRefreshCalls += 1;
      return emails;
    },
  };
  return allowlist;
}

test('verifySessionRequest rejects a request with no session cookie', async () => {
  const { res } = fakeResponseRecordingHeaders();
  await assert.rejects(
    () => verifySessionRequest(fakeRequestWithSessionCookie(null), res, SESSION_CONFIG, fromAllowlist(fakeAllowlist(['alice@gmail.com']))),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionRequest returns the session claims for a valid, allowlisted cookie', async () => {
  const now = Date.now();
  const token = issueSessionToken({ sub: 'sub-1', email: 'alice@gmail.com' }, SESSION_KEY, now, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res, setCookie } = fakeResponseRecordingHeaders();
  const claims = await verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fromAllowlist(fakeAllowlist(['alice@gmail.com'])));
  assert.equal(claims.sub, 'sub-1');
  assert.equal(claims.email, 'alice@gmail.com');
  assert.equal(setCookie(), undefined); // not yet due for renewal - no Set-Cookie written
});

test('verifySessionRequest rejects a caller who is no longer on the allowlist', async () => {
  const now = Date.now();
  const token = issueSessionToken({ sub: 'sub-1', email: 'removed@gmail.com' }, SESSION_KEY, now, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res } = fakeResponseRecordingHeaders();
  await assert.rejects(
    () => verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fromAllowlist(fakeAllowlist(['alice@gmail.com']))),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

// A revoked member's cookie may well be due for renewal (still cryptographically valid, past
// the sliding window's halfway point) - authorization must still be checked first, so this 403
// carries no extended Set-Cookie alongside it.
test('verifySessionRequest does not renew the cookie for a caller rejected by the allowlist check', async () => {
  const issuedAt = Date.now() - (SESSION_CONFIG.sessionSlidingWindowMs / 2 + 1000); // due for renewal
  const token = issueSessionToken({ sub: 'sub-1', email: 'removed@gmail.com' }, SESSION_KEY, issuedAt, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res, setCookie } = fakeResponseRecordingHeaders();
  await assert.rejects(
    () => verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fromAllowlist(fakeAllowlist(['alice@gmail.com']))),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
  assert.equal(setCookie(), undefined);
});

test('verifySessionRequest rejects a malformed/expired cookie the same way verifySessionToken would', async () => {
  const { res } = fakeResponseRecordingHeaders();
  await assert.rejects(
    () => verifySessionRequest(fakeRequestWithSessionCookie('not-a-valid-token'), res, SESSION_CONFIG, fromAllowlist(fakeAllowlist(['alice@gmail.com']))),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionRequest renews the cookie past the halfway point of the sliding window, preserving identity', async () => {
  const issuedAt = Date.now() - (SESSION_CONFIG.sessionSlidingWindowMs / 2 + 1000);
  const token = issueSessionToken({ sub: 'sub-1', email: 'alice@gmail.com' }, SESSION_KEY, issuedAt, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res, setCookie } = fakeResponseRecordingHeaders();
  const claims = await verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fromAllowlist(fakeAllowlist(['alice@gmail.com'])));
  assert.equal(claims.sub, 'sub-1');

  const renewedCookie = setCookie();
  assert.ok(renewedCookie);
  assert.match(renewedCookie!, /^__Host-session=/);
  const renewedToken = renewedCookie!.match(/^__Host-session=([^;]+)/)![1];
  const renewedClaims = verifySessionToken(renewedToken, [SESSION_KEY], Date.now(), SESSION_CONFIG.sessionMaxLifetimeMs);
  assert.equal(renewedClaims.sub, 'sub-1');
  assert.equal(renewedClaims.iat, claims.iat);
  assert.equal(renewedClaims.jti, claims.jti);
  assert.ok(renewedClaims.exp > claims.exp);
});

test('verifySessionRequest passes forceRefresh through to the allowlist', async () => {
  const now = Date.now();
  const token = issueSessionToken({ sub: 'sub-1', email: 'alice@gmail.com' }, SESSION_KEY, now, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res } = fakeResponseRecordingHeaders();
  const allowlist = fakeAllowlist(['alice@gmail.com']);
  await verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fromAllowlist(allowlist), { forceRefresh: true });
  assert.equal(allowlist.forceRefreshCalls, 1);
});

test('POST /session/login issues a session cookie for a caller authenticateSessionLogin accepts', async () => {
  const deps = makeDeps({ authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'alice@gmail.com' });

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie!, /^__Host-session=/);
    assert.match(setCookie!, /HttpOnly/);
    assert.match(setCookie!, /Secure/);
    assert.match(setCookie!, /SameSite=Lax/);
    assert.match(setCookie!, /Path=\//);
    assert.doesNotMatch(setCookie!, /Domain=/);

    const token = setCookie!.match(/^__Host-session=([^;]+)/)![1];
    const claims = verifySessionToken(token, deps.sessionSigningKeys, Date.now(), deps.sessionMaxLifetimeMs);
    assert.equal(claims.sub, 'sub-1');
    assert.equal(claims.email, 'alice@gmail.com');
    assert.equal(claims.iat, claims.reauthAt);
  });
});

// KRKG-0046: authenticateSessionLogin deliberately no longer checks any allowlist - a not-yet-
// approved applicant must still get a session cookie so they can reach /membership/apply. This
// is a regression guard for that specific decision, distinct from the generic "issues a cookie"
// test above.
test('POST /session/login issues a cookie even for an email with no membership record at all', async () => {
  const deps = makeDeps({ authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'notamember@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('set-cookie'));
  });
});

test('POST /session/login records lastLoginAt for an existing member', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'alice@gmail.com', {
    email: 'alice@gmail.com', fullName: 'Alice', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x',
    approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', lastLoginAt: null,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ lastLoginAt: string | null }>('members', 'alice@gmail.com');
  assert.equal(typeof stored?.lastLoginAt, 'string');
});

test('POST /session/login records a canonical session event with the signed-in member as actor', async () => {
  const client = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore: client,
    authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 200);
  });

  const [audit] = await client.listDocs<{ action: string; actor: { email: string }; resource: { key: string }; changes: Array<{ field: string; after: string }> }>('auditEvents');
  assert.deepEqual(audit, {
    id: audit.id,
    data: {
      ...audit.data,
      action: 'session.login.succeeded',
      actor: { email: 'alice@gmail.com' },
      resource: { kind: 'session', key: 'session:alice@gmail.com', display: 'alice@gmail.com' },
      changes: [{ field: 'status', after: 'succeeded', visibility: 'roleRestricted' }],
    },
  });
});

test('POST /application/pwa-installation records one canonical installation event per signed-in member', async () => {
  const client = createInMemoryFirestoreClient();
  const deps = makeDeps({ firestore: client, authenticate: async () => fakeSessionClaims({ email: 'alice@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const first = await fetch(`${baseUrl}/application/pwa-installation`, { method: 'POST' });
    const repeated = await fetch(`${baseUrl}/application/pwa-installation`, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await first.json(), { recorded: true });
    assert.deepEqual(await repeated.json(), { recorded: false });
  });

  const events = await client.listDocs<{ action: string; actor: { email: string }; resource: { key: string; display: string }; changes: Array<{ field: string; after: string }>; value: string }>('auditEvents');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.action, 'application.pwa.installation_reported');
  assert.equal(events[0].data.actor.email, 'alice@gmail.com');
  assert.equal(events[0].data.resource.key, 'application:alice@gmail.com:/');
  assert.equal(events[0].data.resource.display, 'alice@gmail.com');
  assert.deepEqual(events[0].data.changes, [{ field: 'appId', after: '/', visibility: 'roleRestricted' }]);
  assert.equal(events[0].data.value, 'alice@gmail.com.appId=/');
  assert.deepEqual(await client.getDoc('applicationInstallations', 'pwa:alice@gmail.com'), {
    actorEmail: 'alice@gmail.com', appId: '/',
  });
});

test('POST /session/login rejects a body with no idToken', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

// KRKG-0046: authenticateSessionLogin no longer checks any allowlist (it verifies the Google ID
// token only), so this now exercises a token-verification failure rather than a membership one -
// still a generic pass-through check either way.
test('POST /session/login passes through an AuthError from authenticateSessionLogin (e.g. an invalid Google ID token)', async () => {
  const deps = makeDeps({
    authenticateSessionLogin: async () => {
      throw new AuthError('Nieprawidłowy token Google ID.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

// KRKG-0046: /membership/whoami and /membership/apply are the only two routes reachable by a
// signed-in session with no membership at all - gated by authenticateSessionOnly, not
// authenticate. Firestore doc shape mirrors membership.test.ts's fixtures.
test("GET /membership/whoami returns the caller's own status without requiring membership", async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'pending@example.com', {
    email: 'pending@example.com', fullName: 'P', nickname: null, sectionId: 'sekcja-1',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'x',
    approvedAt: null, approvedBy: null, updatedAt: 'x', updatedBy: 'pending@example.com',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'pending@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/whoami`, { credentials: 'include' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'pending@example.com', status: 'pending' });
  });
});

test('GET /membership/whoami returns status null when no application exists yet', async () => {
  const deps = makeDeps({ authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'new@example.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/whoami`, { credentials: 'include' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'new@example.com', status: null });
  });
});

test('GET /membership/sections returns the sections list for any signed-in identity, without requiring membership', async () => {
  const client = makeListaWyjazdowaFirestore();
  const deps = makeDeps({
    firestore: client,
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'new@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/sections`, { credentials: 'include' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sections.some((s: { id: string }) => s.id === 'krakow'));
  });
});

test('GET /membership/sections rejects a request with no session', async () => {
  const deps = makeDeps({
    authenticateSessionOnly: async () => {
      throw new AuthError('Brak sesji. Zaloguj się ponownie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/sections`, { credentials: 'include' });
    assert.equal(res.status, 401);
  });
});

test('POST /membership/apply creates a pending application for any signed-in identity', async () => {
  const client = makeListaWyjazdowaFirestore();
  const deps = makeDeps({
    firestore: client,
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'new@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ fullName: 'New Person', nickname: 'Newbie', sectionId: 'krakow' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.status, 'pending');
    assert.equal(body.member.email, 'new@example.com');
  });
});

test('POST /membership/apply rejects a sectionId that is not in lookupLists', async () => {
  const client = makeListaWyjazdowaFirestore();
  const deps = makeDeps({
    firestore: client,
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'new@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ fullName: 'New', nickname: null, sectionId: 'nieznana-sekcja' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /membership/apply returns 409 for an already-active member', async () => {
  const client = makeListaWyjazdowaFirestore();
  client.seed('members', 'active@example.com', {
    email: 'active@example.com', fullName: 'A', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x',
    approvedAt: 'x', approvedBy: 'admin@example.com', updatedAt: 'x', updatedBy: 'active@example.com',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'active@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ fullName: 'Active', nickname: null, sectionId: 'krakow' }),
    });
    assert.equal(res.status, 409);
  });
});

// Admin-owned fields (status, categoryId, approvedAt, approvedBy) must never be settable from
// this endpoint's request body - applyForMembership (membership.ts) only ever reads
// fullName/nickname/sectionId off the parsed body in handleMembershipApply, so a client sending
// extra fields has no effect regardless of their values.
test('POST /membership/apply ignores admin-owned fields present in the request body', async () => {
  const client = makeListaWyjazdowaFirestore();
  const deps = makeDeps({
    firestore: client,
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'sub-1', email: 'new@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/membership/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ fullName: 'New', nickname: null, sectionId: 'krakow', status: 'active', categoryId: 'hacked' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.status, 'pending');
    assert.equal(body.member.categoryId, null);
  });
});

// Login-CSRF: a cross-origin POST with a CORS-safelisted Content-Type (e.g. text/plain) never
// triggers a preflight, so CORS alone would not stop an attacker's page from POSTing their own
// valid idToken and having it silently accepted, setting the *attacker's* session in the
// victim's browser - this is what requireAllowedOrigin exists to block. Uses rawFetch since this
// specific test needs to send no Origin at all, unlike every other test in this file.
test('POST /session/login rejects a request with no Origin header', async () => {
  const deps = makeDeps({ authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await rawFetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

test('POST /session/login rejects a request from a different Origin', async () => {
  const deps = makeDeps({ authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ idToken: 'fake-google-id-token' }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  });
});

test('POST /session/logout clears the session cookie', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie!, /^__Host-session=;/);
    assert.match(setCookie!, /Max-Age=0/);
  });
});

test('POST /session/logout succeeds even with no prior session (idempotent)', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
  });
});

test('POST /session/logout rejects a request with no Origin header', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await rawFetch(`${baseUrl}/session/logout`, { method: 'POST' });
    assert.equal(res.status, 403);
  });
});

test('POST /session/logout rejects a request from a different Origin', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/session/logout`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });
});

// The origin guard is enforced once, centrally, for every non-GET request (see
// createRequestListener) rather than per-handler - these two spot-check that it actually covers
// routes far from /session/*, not just the ones it was added alongside.
test('POST /admin/social-media/refresh rejects a request with no Origin header, before authenticateAdmin ever runs', async () => {
  let authenticateAdminCalled = false;
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      authenticateAdminCalled = true;
      return fakeSessionClaims({ sub: 'a1', email: 'admin@gmail.com' });
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await rawFetch(`${baseUrl}/admin/social-media/refresh`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(authenticateAdminCalled, false);
  });
});

test('DELETE /admin/redirects rejects a request from a different Origin', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects?path=%2Fold`, {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });
});

test('GET /admin/whoami returns the admin email when authenticateAdmin succeeds', async () => {
  const deps = makeDeps({ authenticateAdmin: async () => fakeSessionClaims({ sub: 'a1', email: 'admin@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'admin@gmail.com' });
  });
});

// The frontend's nav avatar used to read name/picture off the locally-decoded Google JWT - now
// that a page-load session check only ever gets whatever a whoami-style endpoint returns, every
// one of them needs to include these (identityResponseBody) for that to keep working at all.
test('GET /whoami includes name/picture when the session claims carry them', async () => {
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 's1', email: 'alice@gmail.com', name: 'Alice', picture: 'https://example.com/a.jpg' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/whoami`);
    assert.deepEqual(await res.json(), { email: 'alice@gmail.com', name: 'Alice', picture: 'https://example.com/a.jpg' });
  });
});

test('anyOf succeeds if the first authorizer succeeds, without trying the second', async () => {
  let secondCalled = false;
  const first = { authorize: async () => {} };
  const second = { authorize: async () => { secondCalled = true; } };
  await anyOf(first, second).authorize({ sub: 's1', email: 'a@example.test' });
  assert.equal(secondCalled, false);
});

test('anyOf succeeds if only the second authorizer succeeds', async () => {
  const first = { authorize: async () => { throw new AuthError('no', 403); } };
  const second = { authorize: async () => {} };
  await anyOf(first, second).authorize({ sub: 's1', email: 'a@example.test' });
});

test('anyOf rejects if every authorizer rejects, surfacing the last error', async () => {
  const first = { authorize: async () => { throw new AuthError('first', 403); } };
  const second = { authorize: async () => { throw new AuthError('second', 403); } };
  await assert.rejects(
    () => anyOf(first, second).authorize({ sub: 's1', email: 'a@example.test' }),
    (err: unknown) => err instanceof AuthError && err.message === 'second',
  );
});

// End-to-end proof that a moderator (Firestore userRoles role only, not on the admin allowlist)
// is actually let through by the real anyOf(adminAuthorizer, createRoleAuthorizer(...)) wiring -
// every other test in this file mocks authenticateAdminOrModerator directly, which only proves
// the route calls the right dep, not that the dep's own logic is correct.
test('anyOf(fromAllowlist(admin), createRoleAuthorizer(moderator)) lets a Firestore-only moderator through', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'mod@example.test', { roles: ['moderator'] });
  const adminAllowlist: SheetAllowlist = { getEmails: async () => ['admin@example.test'] };
  const authorizer = anyOf(fromAllowlist(adminAllowlist), createRoleAuthorizer(client, 'moderator'));
  await authorizer.authorize({ sub: 's1', email: 'mod@example.test' });
  await assert.rejects(() => authorizer.authorize({ sub: 's2', email: 'nobody@example.test' }));
});

test('GET /admin/members/whoami reports isAdmin: true for an admin-allowlist caller', async () => {
  const deps = makeDeps({
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'a1', email: 'admin@gmail.com' }),
    authenticateAdmin: async () => fakeSessionClaims({ sub: 'a1', email: 'admin@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'admin@gmail.com', isAdmin: true });
  });
});

test('GET /admin/members/whoami reports isAdmin: false for a Firestore-role-only moderator', async () => {
  const deps = makeDeps({
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@gmail.com' }),
    authenticateAdmin: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'moderator@gmail.com', isAdmin: false });
  });
});

test('GET /admin/members/whoami rejects a caller who is neither admin nor moderator', async () => {
  const deps = makeDeps({
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/whoami`);
    assert.equal(res.status, 403);
  });
});

test('POST /admin/social-media/refresh requires admin auth and returns ok', async () => {
  let authenticatedAsAdmin = false;
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      authenticatedAsAdmin = true;
      return fakeSessionClaims({ sub: 'a1', email: 'admin@gmail.com' });
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/social-media/refresh`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
  assert.equal(authenticatedAsAdmin, true);
});

test('POST /admin/social-media/refresh rejects when authenticateAdmin fails', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Brak uprawnień.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/social-media/refresh`, { method: 'POST' });
    assert.equal(res.status, 403);
  });
});

test('GET /admin/settings returns the default when nothing has been saved yet', async () => {
  resetSettingsBootstrapForTests();
  const deps = makeDeps({ drive: makeFakeDrive({ readTextFile: async () => null }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/settings`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { liveFetchPostCount: 5 });
  });
});

test('GET /admin/settings rejects when authenticateAdmin fails', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => {
      throw new AuthError('Brak uprawnień.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/settings`);
    assert.equal(res.status, 403);
  });
});

test('POST /admin/settings writes the setting, then GET reflects it', async () => {
  resetSettingsBootstrapForTests();
  let saved: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      readTextFile: async () => saved ?? null,
      writeTextFile: async (_folderId, _fileName, content) => {
        saved = content;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const postRes = await fetch(`${baseUrl}/admin/settings`, {
      method: 'POST',
      body: JSON.stringify({ liveFetchPostCount: 1 }),
    });
    assert.equal(postRes.status, 200);
    const getRes = await fetch(`${baseUrl}/admin/settings`);
    assert.deepEqual(await getRes.json(), { liveFetchPostCount: 1 });
  });
});

test('POST /admin/settings rejects an out-of-range value without writing', async () => {
  resetSettingsBootstrapForTests();
  let wrote = false;
  const deps = makeDeps({
    drive: makeFakeDrive({ writeTextFile: async () => { wrote = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/settings`, {
      method: 'POST',
      body: JSON.stringify({ liveFetchPostCount: 0 }),
    });
    assert.equal(res.status, 400);
  });
  assert.equal(wrote, false);
});

test('GET /facebook-posts returns 429 once a single caller exceeds the per-IP rate limit', async () => {
  resetRateLimitForTests();
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`${baseUrl}/facebook-posts`);
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});

test('PUT /admin/people/description updates a person\'s Opis.txt', async () => {
  let writtenDescription: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      writeTextFile: async (_folderId, _fileName, content) => {
        writtenDescription = content;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/description?folderId=person-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Nowy opis.' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(writtenDescription, 'Nowy opis.');
});

test('DELETE /admin/people trashes the person folder', async () => {
  let deletedFolderId: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({ deleteFolder: async folderId => { deletedFolderId = folderId; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?folderId=person-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(deletedFolderId, 'person-1');
});

test('GET /admin/people lists people for a category (same shape as public endpoint)', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      listGalleryFolders: async parentId =>
        parentId === 'folder-Emeryci' ? [{ id: 'p1', name: 'Jan', modifiedTime: '2024-01-01T00:00:00Z' }] : [],
      readTextFile: async () => null,
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=Emeryci`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people[0].name, 'Jan');
    assert.equal(body.people[0].folderId, 'p1');
  });
});

// KRKG bugfix: Zarządzanie ludźmi's loadDriveFolderOptions() calls this GET inside the same
// Promise.all as the member list itself - before this fix it stayed authenticateAdmin-only while
// every sibling route on that page (list/transition/drive-folder/profile/lookup-lists) moved to
// authenticateAdminOrModerator under KRKG-0049, so a Firestore-role-only moderator's whole table
// load 403'd even though the page itself let them in.
test('GET /admin/people is accessible to a Firestore-role-only moderator, not just the admin allowlist', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@gmail.com' }),
    authenticateAdmin: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      listGalleryFolders: async parentId =>
        parentId === 'folder-Emeryci' ? [{ id: 'p1', name: 'Jan', modifiedTime: '2024-01-01T00:00:00Z' }] : [],
      readTextFile: async () => null,
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=Emeryci`);
    assert.equal(res.status, 200);
  });
});

test('GET /admin/people?category=upload lists people from the upload staging folder', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root' : `folder-${name}`),
      listGalleryFolders: async parentId =>
        parentId === 'upload-root' ? [{ id: 'p1', name: 'Anna - anna@gmail.com - 2026-08-19', modifiedTime: '2026-08-19T00:00:00Z' }] : [],
      readTextFile: async () => null,
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=upload`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people[0].folderId, 'p1');
    assert.equal(body.people[0].name, 'Anna - anna@gmail.com - 2026-08-19');
    assert.equal(body.people[0].order, null);
  });
});

test('GET /admin/people?category=upload enriches an entry with publicFolderId/publicName/publicDescription when the member already has a published public folder (KRKG-0070 addendum)', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'anna@gmail.com', seedMemberDoc({ email: 'anna@gmail.com', driveFolderId: 'public-1', stagingFolderId: 's1' }));
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root-pubstatus-1' : `folder-${name}`),
      listGalleryFolders: async parentId =>
        parentId === 'upload-root-pubstatus-1' ? [{ id: 's1', name: 'Anna - anna@gmail.com - 2026-08-19', modifiedTime: '2026-08-19T00:00:00Z' }] : [],
      readTextFile: async (folderId, fileName) => {
        if (folderId === 's1' && fileName === '.owner-email') return 'anna@gmail.com';
        if (folderId === 'public-1' && fileName === 'Opis.txt') return 'Opis publiczny.';
        return null;
      },
      getFolderName: async folderId => (folderId === 'public-1' ? '3. Anna Wojowniczka' : null),
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=upload`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people[0].publicFolderId, 'public-1');
    assert.equal(body.people[0].publicName, 'Anna Wojowniczka');
    assert.equal(body.people[0].publicDescription, 'Opis publiczny.');
  });
});

test('GET /admin/people?category=upload returns null public fields when the member has no driveFolderId yet (KRKG-0070 addendum)', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'anna@gmail.com', seedMemberDoc({ email: 'anna@gmail.com', driveFolderId: null, stagingFolderId: 's1' }));
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root-pubstatus-2' : `folder-${name}`),
      listGalleryFolders: async parentId =>
        parentId === 'upload-root-pubstatus-2' ? [{ id: 's1', name: 'Anna - anna@gmail.com - 2026-08-19', modifiedTime: '2026-08-19T00:00:00Z' }] : [],
      readTextFile: async (folderId, fileName) => (folderId === 's1' && fileName === '.owner-email' ? 'anna@gmail.com' : null),
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=upload`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people[0].publicFolderId, null);
    assert.equal(body.people[0].publicName, null);
    assert.equal(body.people[0].publicDescription, null);
  });
});

test('GET /admin/people?category=upload returns null public fields when there is no owner-email marker or no matching MemberDoc (KRKG-0070 addendum)', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root-pubstatus-3' : `folder-${name}`),
      listGalleryFolders: async parentId =>
        parentId === 'upload-root-pubstatus-3' ? [{ id: 's1', name: 'Ktos - orphan', modifiedTime: '2026-08-19T00:00:00Z' }] : [],
      readTextFile: async () => null,
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=upload`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people[0].publicFolderId, null);
    assert.equal(body.people[0].publicName, null);
    assert.equal(body.people[0].publicDescription, null);
  });
});

test('GET /admin/people rejects a nonexistent department', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=NieIstnieje`);
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/order renames the folder to reflect the new name and order', async () => {
  let renamedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      renameFolder: async (_folderId, newName) => {
        renamedTo = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', name: 'Ragnar', order: 3 }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(renamedTo, '3. Ragnar');
});

test('PUT /admin/people/order accepts a null order (unnumbered, sorted alphabetically)', async () => {
  let renamedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      renameFolder: async (_folderId, newName) => {
        renamedTo = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', name: 'Ragnar', order: null }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(renamedTo, 'Ragnar');
});

test('PUT /admin/people/order rejects a missing name', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', order: 1 }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/category moves the folder into the target department', async () => {
  resetAboutUsBootstrapForTests();
  let movedFolderId: string | undefined;
  let movedToParent: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      moveFolder: async (folderId, newParentId) => {
        movedFolderId = folderId;
        movedToParent = newParentId;
        return { name: '5. Ragnar' };
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'Niewiasty' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(movedFolderId, 'person-1');
  assert.equal(movedToParent, 'folder-Niewiasty');
});

test('PUT /admin/people/category can move a folder into the upload staging department', async () => {
  resetAboutUsBootstrapForTests();
  let movedToParent: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root' : `folder-${name}`),
      moveFolder: async (_folderId, newParentId) => {
        movedToParent = newParentId;
        return { name: '5. Ragnar' };
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'upload' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(movedToParent, 'upload-root');
});

test('PUT /admin/people/category rejects a nonexistent department', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'NieIstnieje' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/category can move a folder into the deleted archive department', async () => {
  resetAboutUsBootstrapForTests();
  let movedToParent: string | undefined;
  let renameCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'deleted' ? 'deleted-root' : `folder-${name}`),
      moveFolder: async (_folderId, newParentId) => {
        movedToParent = newParentId;
        return { name: '5. Ragnar' };
      },
      renameFolder: async () => {
        renameCalled = true;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'deleted' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(movedToParent, 'deleted-root');
  // Order is meaningless in the deleted/upload staging folders - moving there must not rename.
  assert.equal(renameCalled, false);
});

test('PUT /admin/people/category moving into upload does not reassign order', async () => {
  resetAboutUsBootstrapForTests();
  let renameCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root' : `folder-${name}`),
      moveFolder: async () => ({ name: '5. Ragnar' }),
      renameFolder: async () => {
        renameCalled = true;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'upload' }),
    });
  });
  assert.equal(renameCalled, false);
});

test('PUT /admin/people/category moving into a normal department appends the person at the end', async () => {
  resetAboutUsBootstrapForTests();
  let renamedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      moveFolder: async () => ({ name: 'Ragnar' }),
      // The moved folder itself already shows up under the target once Drive's move completes
      // - listGalleryFolders' fake reflects that (folder id "person-1"), and the handler must
      // exclude it from the sibling list before computing the new max order.
      listGalleryFolders: async () => [
        { id: 'person-1', name: 'Ragnar', modifiedTime: '' },
        { id: 'sib-1', name: '3. Anna', modifiedTime: '' },
        { id: 'sib-2', name: '1. Piotr', modifiedTime: '' },
      ],
      renameFolder: async (_folderId, newName) => {
        renamedTo = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'Niewiasty' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(renamedTo, '4. Ragnar');
});

test('PUT /admin/people/category moving into Emeryci prepends the person at the top', async () => {
  resetAboutUsBootstrapForTests();
  let renamedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      moveFolder: async () => ({ name: 'Ragnar' }),
      listGalleryFolders: async () => [
        { id: 'sib-1', name: '2. Jan', modifiedTime: '' },
        { id: 'sib-2', name: '5. Piotr', modifiedTime: '' },
      ],
      renameFolder: async (_folderId, newName) => {
        renamedTo = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'Emeryci' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(renamedTo, '1. Ragnar');
});

test('PUT /admin/people/category moving into an empty department defaults order to 1', async () => {
  resetAboutUsBootstrapForTests();
  let renamedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      moveFolder: async () => ({ name: 'Ragnar' }),
      listGalleryFolders: async () => [],
      renameFolder: async (_folderId, newName) => {
        renamedTo = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    await fetch(`${baseUrl}/admin/people/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', category: 'Blachowi' }),
    });
  });
  assert.equal(renamedTo, '1. Ragnar');
});

test('POST /admin/people/photo streams an uploaded file into the person folder', async () => {
  let uploadedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      uploadFileStream: async (folderId, _fileName, _mimeType, bodyStream) => {
        uploadedTo = folderId;
        for await (const _chunk of bodyStream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(
      `${baseUrl}/admin/people/photo?folderId=person-1&fileName=zdjecie.jpg&mimeType=image%2Fjpeg`,
      { method: 'POST', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) },
    );
    assert.equal(res.status, 200);
  });
  assert.equal(uploadedTo, 'person-1');
});

test('POST /admin/people/photo returns the uploaded photo DTO with a durable thumbnail URL', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      uploadFileStream: async (_folderId, _fileName, _mimeType, bodyStream) => {
        for await (const _chunk of bodyStream) {
          // Drain the validated stream, exactly as the default fake does.
        }
        return { id: 'photo-1' };
      },
      listImageFiles: async () => [{ id: 'photo-1', name: 'zdjecie.jpg', thumbnailLink: 'https://lh3.googleusercontent.com/photo=s220' }],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(
      `${baseUrl}/admin/people/photo?folderId=person-1&fileName=zdjecie.jpg&mimeType=image%2Fjpeg`,
      { method: 'POST', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      photo: { id: 'photo-1', name: 'zdjecie.jpg', url: 'https://lh3.googleusercontent.com/photo=s300' },
    });
  });
});

test('POST /admin/people/photo returns a null URL when Drive has not generated a thumbnail yet', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      listImageFiles: async () => [{ id: 'fake-uploaded-file-id', name: 'zdjecie.jpg', thumbnailLink: null }],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(
      `${baseUrl}/admin/people/photo?folderId=person-1&fileName=zdjecie.jpg&mimeType=image%2Fjpeg`,
      { method: 'POST', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      photo: { id: 'fake-uploaded-file-id', name: 'zdjecie.jpg', url: null },
    });
  });
});

test('POST /admin/people/photo returns a null URL when Drive metadata lookup fails after upload', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      listImageFiles: async () => { throw new Error('Drive metadata temporarily unavailable'); },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(
      `${baseUrl}/admin/people/photo?folderId=person-1&fileName=zdjecie.jpg&mimeType=image%2Fjpeg`,
      { method: 'POST', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      photo: { id: 'fake-uploaded-file-id', name: 'zdjecie.jpg', url: null },
    });
  });
});

test('DELETE /admin/people/photo trashes the photo file', async () => {
  let deletedId: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({ deleteFolder: async fileId => { deletedId = fileId; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo?fileId=photo-1&folderId=person-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(deletedId, 'photo-1');
});

test('DELETE /admin/people/photo rejects a missing folderId (I4: resource key needs person:{folderId}, not fileId alone)', async () => {
  const deps = makeDeps({ drive: makeFakeDrive({}) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo?fileId=photo-1`, { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});

test('DELETE /admin/people/photo audits profile.person.photo.deleted on the person:{folderId} resource, matching its sibling person-photo actions', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    drive: makeFakeDrive({ deleteFolder: async () => {} }),
    firestore,
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo?fileId=photo-1&folderId=person-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  const events = await firestore.listDocs<{ action: string; resource: { key: string } }>('auditEvents');
  const event = events.find(e => e.data.action === 'profile.person.photo.deleted')!.data;
  assert.equal(event.resource.key, 'person:person-1');
});

test('PUT /admin/people/photo/main prefixes the target photo and strips any previous main prefix', async () => {
  // Stateful, not a fixed return value: auditedSetMainPhoto now re-lists after renaming to verify
  // exactly one "!"-prefixed file resulted (KRKG-0083 design review, non-atomicity finding) - a
  // mock that always returns the pre-rename list would make that postcondition check see two
  // (or zero) "!" files and fail the request even though the rename itself succeeded.
  const images = [
    { id: 'photo-1', name: '!IMG_0001.jpg', thumbnailLink: null },
    { id: 'photo-2', name: 'IMG_0002.jpg', thumbnailLink: null },
  ];
  const deps = makeDeps({
    drive: makeFakeDrive({
      listImageFiles: async () => images.map(image => ({ ...image })),
      renameFolder: async (fileId, newName) => {
        const image = images.find(img => img.id === fileId);
        if (image) image.name = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/main`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', fileId: 'photo-2' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(images.find(image => image.id === 'photo-1')!.name, 'IMG_0001.jpg');
  assert.equal(images.find(image => image.id === 'photo-2')!.name, '!IMG_0002.jpg');
});

test('PUT /admin/people/photo/main is a no-op when the target is already main and nothing else has the prefix', async () => {
  let renameCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listImageFiles: async () => [
        { id: 'photo-1', name: '!IMG_0001.jpg', thumbnailLink: null },
        { id: 'photo-2', name: 'IMG_0002.jpg', thumbnailLink: null },
      ],
      renameFolder: async () => {
        renameCalled = true;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/main`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', fileId: 'photo-1' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(renameCalled, false);
});

test('PUT /admin/people/photo/main rejects a missing fileId', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/main`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/photo/transfer moves the photo into the target folder', async () => {
  let movedFileId: string | undefined;
  let movedToParent: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      moveFile: async (fileId, newParentFolderId) => {
        movedFileId = fileId;
        movedToParent = newParentFolderId;
        return {};
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/transfer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'photo-1', targetFolderId: 'person-2' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(movedFileId, 'photo-1');
  assert.equal(movedToParent, 'person-2');
});

test('PUT /admin/people/photo/transfer audits profile.person.photo.transferred on BOTH the source and destination person (I4)', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      moveFile: async () => ({ previousFolderId: 'person-1' }),
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/transfer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'photo-1', targetFolderId: 'person-2' }),
    });
    assert.equal(res.status, 200);
  });
  const events = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; before?: string; after?: string }> }>('auditEvents');
  const transferEvents = events.filter(e => e.data.action === 'profile.person.photo.transferred');
  assert.equal(transferEvents.length, 2, 'one event per affected person - source and destination');
  const byResourceKey = Object.fromEntries(transferEvents.map(e => [e.data.resource.key, e.data]));
  assert.ok(byResourceKey['person:person-2'], 'destination person must see the transfer in their own Historia');
  assert.ok(byResourceKey['person:person-1'], 'source person must also see the transfer in their own Historia (not just the destination)');
  assert.equal(byResourceKey['person:person-1'].changes.find(c => c.field === 'fileId')?.before, 'photo-1');
});

test('PUT /admin/people/photo/transfer emits only the destination event when Drive reports no previous parent', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      moveFile: async () => ({}),
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/transfer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'photo-1', targetFolderId: 'person-2' }),
    });
    assert.equal(res.status, 200);
  });
  const events = await firestore.listDocs<{ action: string; resource: { key: string } }>('auditEvents');
  const transferEvents = events.filter(e => e.data.action === 'profile.person.photo.transferred');
  assert.equal(transferEvents.length, 1, 'no fabricated source event when Drive reports no previous parent');
  assert.equal(transferEvents[0].data.resource.key, 'person:person-2');
});

test('PUT /admin/people/photo/transfer rejects a missing targetFolderId', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/transfer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'photo-1' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/photo/approve rejects a caller without step-up', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne potwierdzenie tożsamości.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 's1', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(res.status, 401);
  });
});

test('PUT /admin/people/photo/approve rejects an unknown targetCategory with 400, before touching Drive', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      readTextFile: async () => {
        throw new Error('should not read anything before category validation');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 's1', targetCategory: 'upload', name: 'Test' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/photo/approve returns 404 when the staging folder has no .owner-email marker', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      readTextFile: async () => null,
      moveFile: async () => {
        throw new Error('should not move a file for an unowned folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 's1', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/people/photo/approve returns 404 when .owner-email resolves to no MemberDoc', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 's1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      moveFile: async () => {
        throw new Error('should not move a file for an unresolved owner');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 's1', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/people/photo/approve returns 404 when the supplied stagingFolderId is not the member\'s current canonical one (stale/legacy folder)', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 'current-staging-folder' }));
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 'stale-folder' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      moveFile: async () => {
        throw new Error('should not move a file for a non-canonical staging folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 'stale-folder', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/people/photo/approve returns 404 when fileId does not belong to the staging folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1' }));
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 's1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      listImageFiles: async () => [{ id: 'other-file', name: 'other.jpg', thumbnailLink: 'https://example.test/other=s220' }],
      moveFile: async () => {
        throw new Error('should not move a file not listed in the staging folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 's1', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/people/photo/approve, first approval, rejects a missing name with 400 before creating any folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1', driveFolderId: null }));
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 's1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      listImageFiles: async () => [{ id: 'f1', name: 'f1.jpg', thumbnailLink: 'https://example.test/f1=s220' }],
      createAlbumFolder: async () => {
        throw new Error('should not create a folder without a name');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 's1', targetCategory: 'Blachowi' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/people/photo/approve, first approval: creates the public folder named only from the supplied name, links driveFolderId, moves the file, keeps its ! prefix', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'anna@gmail.com', seedMemberDoc({
    email: 'anna@gmail.com',
    fullName: 'Anna Kowalska',
    nickname: 'Storm',
    stagingFolderId: 'staging-anna',
    driveFolderId: null,
  }));
  let createdFolderName = '';
  let movedTo = '';
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      readTextFile: async (id, fileName) => (id === 'staging-anna' && fileName === '.owner-email' ? 'anna@gmail.com' : null),
      listImageFiles: async id => (id === 'staging-anna' ? [{ id: 'f1', name: '!f1.jpg', thumbnailLink: 'https://example.test/f1=s220' }] : []),
      createAlbumFolder: async (_parent, name) => {
        createdFolderName = name;
        return 'new-public-folder';
      },
      moveFile: async (fileId, targetFolderId) => {
        movedTo = targetFolderId;
        return { previousFolderId: 'staging-anna' };
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 'staging-anna', targetCategory: 'Blachowi', name: 'Storm Wojowniczka' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'new-public-folder');
  });
  assert.equal(createdFolderName, 'Storm Wojowniczka');
  assert.ok(!createdFolderName.includes('anna@gmail.com'), 'public folder name must never contain the email');
  assert.equal(movedTo, 'new-public-folder');
  const updated = await firestore.getDoc<{ driveFolderId: string | null }>('members', 'anna@gmail.com');
  assert.equal(updated?.driveFolderId, 'new-public-folder');
  // Review-round-2 blocker #1: the admin-owned driveFolderId link must be its own audited
  // Firestore mutation (profile.drive_folder.changed, the same action/route
  // handleAdminSetMemberDriveFolder already uses for this exact field), not a bare setDoc.
  const events = (await firestore.listDocs<{ action?: string }>('auditEvents')).map(doc => doc.data as { action: string; changes: Array<{ field: string; before?: unknown; after?: unknown }> });
  const driveFolderEvent = events.find(e => e.action === 'profile.drive_folder.changed');
  assert.ok(driveFolderEvent, 'expected a profile.drive_folder.changed audit event');
  const folderIdChange = driveFolderEvent!.changes.find(c => c.field === 'folderId');
  assert.equal(folderIdChange?.before, null);
  assert.equal(folderIdChange?.after, 'new-public-folder');
});

test('PUT /admin/people/photo/approve, first approval with description: writes Opis.txt in the new folder (KRKG-0070 addendum)', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'anna@gmail.com', seedMemberDoc({
    email: 'anna@gmail.com',
    stagingFolderId: 'staging-anna',
    driveFolderId: null,
  }));
  let writtenDescription: string | undefined;
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      readTextFile: async (id, fileName) => (id === 'staging-anna' && fileName === '.owner-email' ? 'anna@gmail.com' : null),
      listImageFiles: async id => (id === 'staging-anna' ? [{ id: 'f1', name: 'f1.jpg', thumbnailLink: 'https://example.test/f1=s220' }] : []),
      createAlbumFolder: async () => 'new-public-folder',
      writeTextFile: async (folderId, fileName, content) => {
        if (folderId === 'new-public-folder' && fileName === 'Opis.txt') writtenDescription = content;
      },
      moveFile: async () => ({ previousFolderId: 'staging-anna' }),
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1'], stagingFolderId: 'staging-anna', targetCategory: 'Blachowi', name: 'Storm Wojowniczka', description: 'Krótki opis.' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(writtenDescription, 'Krótki opis.');
});

test('PUT /admin/people/photo/approve rejects an empty or missing fileIds with 400, before touching Drive', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      readTextFile: async () => {
        throw new Error('should not read anything before fileIds validation');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const missing = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stagingFolderId: 's1', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(missing.status, 400);
    const empty = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: [], stagingFolderId: 's1', targetCategory: 'Blachowi', name: 'Test' }),
    });
    assert.equal(empty.status, 400);
  });
});

test('PUT /admin/people/photo/approve rejects the whole batch with 404 when one of several fileIds does not belong to the staging folder, moving none of them (KRKG-0070 addendum)', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1', driveFolderId: 'existing-public-folder' }));
  const movedFileIds: string[] = [];
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 's1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      listImageFiles: async id =>
        id === 's1'
          ? [
              { id: 'f1', name: 'f1.jpg', thumbnailLink: 'https://example.test/f1=s220' },
              { id: 'f2', name: 'f2.jpg', thumbnailLink: 'https://example.test/f2=s220' },
            ]
          : [],
      moveFile: async fileId => {
        movedFileIds.push(fileId);
        return { previousFolderId: 's1' };
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1', 'not-in-staging', 'f2'], stagingFolderId: 's1' }),
    });
    assert.equal(res.status, 404);
  });
  assert.deepEqual(movedFileIds, [], 'no file may be moved when any fileId in the batch is invalid');
});

test('PUT /admin/people/photo/approve moves every fileId in a batch to the existing public folder, normalizing !main when more than one carried it (KRKG-0070 addendum)', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1', driveFolderId: 'existing-public-folder' }));
  const movedFileIds: string[] = [];
  const renamedTo: Record<string, string> = {};
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 's1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      listImageFiles: async id => {
        if (id === 's1') return [
          { id: 'f1', name: '!f1.jpg', thumbnailLink: 'https://example.test/f1=s220' },
          { id: 'f2', name: '!f2.jpg', thumbnailLink: 'https://example.test/f2=s220' },
        ];
        if (id === 'existing-public-folder') {
          // Reflects the target folder's state as it stands *after* whichever of f1/f2 has
          // already been moved so far in this test run - starts empty, f1 lands first (see
          // fileIds order below) and keeps its "!" since the target had none yet.
          const landed: Array<{ id: string; name: string; thumbnailLink: string }> = [];
          if (movedFileIds.includes('f1')) landed.push({ id: 'f1', name: `${renamedTo.f1 ?? '!f1.jpg'}`, thumbnailLink: 'https://example.test/f1=s220' });
          if (movedFileIds.includes('f2')) landed.push({ id: 'f2', name: `${renamedTo.f2 ?? '!f2.jpg'}`, thumbnailLink: 'https://example.test/f2=s220' });
          return landed;
        }
        return [];
      },
      moveFile: async fileId => {
        movedFileIds.push(fileId);
        return { previousFolderId: 's1' };
      },
      renameFolder: async (id, newName) => {
        renamedTo[id] = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f1', 'f2'], stagingFolderId: 's1' }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(movedFileIds, ['f1', 'f2']);
  assert.equal(renamedTo.f2, 'f2.jpg', 'f2 must lose its ! prefix since f1 already claimed main by the time f2 landed');
  assert.equal(renamedTo.f1, undefined, 'f1 must keep its ! prefix - it was the first to land in an empty target folder');
});

test('PUT /admin/people/photo/approve, subsequent approval: moves the file into the existing public folder and strips its ! prefix when the folder already has a main photo (no targetCategory/name/description needed - KRKG-0070 addendum)', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 'staging-1', driveFolderId: 'existing-public-folder' }));
  // Stateful (see the same note on the "prefixes the target photo" test above): the target
  // folder's listing must reflect the rename auditedSetMainPhoto just performed, since it now
  // re-lists afterward to verify exactly one "!"-prefixed file resulted.
  const targetImages = [
    { id: 'existing-main', name: '!existing-main.jpg', thumbnailLink: 'https://example.test/main=s220' },
    { id: 'f2', name: '!f2.jpg', thumbnailLink: 'https://example.test/f2=s220' },
  ];
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 'staging-1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      listImageFiles: async id => {
        if (id === 'staging-1') return [{ id: 'f2', name: '!f2.jpg', thumbnailLink: 'https://example.test/f2=s220' }];
        if (id === 'existing-public-folder') return targetImages.map(image => ({ ...image }));
        return [];
      },
      moveFile: async () => ({ previousFolderId: 'staging-1' }),
      renameFolder: async (id, newName) => {
        const image = targetImages.find(img => img.id === id);
        if (image) image.name = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f2'], stagingFolderId: 'staging-1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'existing-public-folder');
  });
  assert.equal(targetImages.find(image => image.id === 'f2')!.name, 'f2.jpg', 'the incoming ! prefix must be stripped since the target already had a main photo');
});

test('PUT /admin/people/photo/approve: a failure during the post-transfer !main normalization is itself audited as failed, without losing the already-succeeded transfer', async () => {
  // Review-round-2 blocker #2: the normalization step must be its own auditable, failure-visible
  // operation - not a bare, unaudited rename that could silently leave an inconsistent two-!
  // state with no trace. This test forces the rename to throw and asserts both outcomes are
  // correctly recorded: transferred = succeeded, main.changed = failed. Once the photo has moved,
  // "Zatwierdź" can no longer be retried for it (it's not in staging anymore) - recovery is the
  // existing "Ustaw główne" button on the now-public folder, a manual step.
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 'staging-1', driveFolderId: 'existing-public-folder' }));
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      readTextFile: async (id, fileName) => (id === 'staging-1' && fileName === '.owner-email' ? 'ktos@gmail.com' : null),
      listImageFiles: async id => {
        if (id === 'staging-1') return [{ id: 'f2', name: '!f2.jpg', thumbnailLink: 'https://example.test/f2=s220' }];
        if (id === 'existing-public-folder') return [
          { id: 'existing-main', name: '!existing-main.jpg', thumbnailLink: 'https://example.test/main=s220' },
          { id: 'f2', name: '!f2.jpg', thumbnailLink: 'https://example.test/f2=s220' },
        ];
        return [];
      },
      moveFile: async () => ({ previousFolderId: 'staging-1' }),
      renameFolder: async () => {
        throw new Error('Drive rename failed');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/photo/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds: ['f2'], stagingFolderId: 'staging-1' }),
    });
    assert.equal(res.status, 500);
  });
  const events = (await firestore.listDocs<{ action?: string }>('auditEvents')).map(doc => doc.data as { action: string });
  assert.ok(events.some(e => e.action === 'profile.person.photo.transferred'), 'the transfer itself must still be recorded as succeeded - it completed before the rename ran');
  const outcomes = (await firestore.listDocs('auditOperationOutcomes')).map(doc => doc.data as { state: string });
  assert.ok(outcomes.some(o => o.state === 'failed'), 'the normalization attempt must be recorded as failed, never silently dropped or fabricated as succeeded');
});

test('PUT /admin/people/in-memoriam writes the marker file and invalidates the cache', async () => {
  let writtenTo: string | undefined;
  let writtenName: string | undefined;
  let writtenContent: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      writeTextFile: async (folderId, fileName, content) => {
        writtenTo = folderId;
        writtenName = fileName;
        writtenContent = content;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/in-memoriam`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', inMemoriam: true }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(writtenTo, 'person-1');
  assert.equal(writtenName, '.in-memoriam');
  assert.equal(writtenContent, 'true');
});

test('PUT /admin/people/in-memoriam can unset the marker', async () => {
  let writtenContent: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      writeTextFile: async (_folderId, _fileName, content) => {
        writtenContent = content;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/in-memoriam`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1', inMemoriam: false }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(writtenContent, 'false');
});

test('PUT /admin/people/in-memoriam rejects a missing inMemoriam field', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people/in-memoriam`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'person-1' }),
    });
    assert.equal(res.status, 400);
  });
});

test('GET /admin/people includes inMemoriam for each person', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      listGalleryFolders: async parentId =>
        parentId === 'folder-Blachowi' ? [{ id: 'p1', name: '1. Ragnar', modifiedTime: '2024-01-01T00:00:00Z' }] : [],
      readTextFile: async (_folderId, fileName) => (fileName === '.in-memoriam' ? 'true' : null),
      listImageFiles: async () => [],
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people?category=Blachowi`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.people[0].inMemoriam, true);
  });
});

test('/register rejects an unauthenticated caller before touching Drive or GitHub', async () => {
  let driveCalled = false;
  let githubCalled = false;
  const deps = makeDeps({
    authenticate: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    drive: makeFakeDrive({ writeManifest: async () => { driveCalled = true; } }),
    github: makeFakeGithub({ appendAlbumToMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://drive.google.com/drive/folders/abc', date: '2026-08-09' }),
    });
    assert.equal(res.status, 401);
    assert.equal(driveCalled, false);
    assert.equal(githubCalled, false);
  });
});

test('/register rejects a body missing the URL or the date', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-09' }),
    });
    assert.equal(res.status, 400);
  });
});

test('/register rejects a malformed URL', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url', date: '2026-08-09' }),
    });
    assert.equal(res.status, 400);
  });
});

test('/register rejects unsafe or unsupported URL schemes/hosts without invoking GitHub', async () => {
  const unsafeUrls = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://drive.google.com/drive/folders/abc123',
    'https://evil.example@photos.app.goo.gl/AbCdEf',
    'https://photos.app.goo.gl.evil.example/AbCdEf',
    'https://drive.google.com.evil.example/drive/folders/abc123',
  ];
  for (const url of unsafeUrls) {
    let githubCalled = false;
    const deps = makeDeps({ github: makeFakeGithub({ appendAlbumToMain: async () => { githubCalled = true; } }) });
    await withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, date: '2026-08-09' }),
      });
      assert.equal(res.status, 400, `expected 400 for "${url}", got ${res.status}`);
      assert.equal(githubCalled, false, `GitHub should not be called for "${url}"`);
    });
  }
});

test('/register commits a Drive folder URL to albums.json and does not touch Drive itself', async () => {
  let appendedEntry: unknown = null;
  let driveCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({ writeManifest: async () => { driveCalled = true; } }),
    github: makeFakeGithub({ appendAlbumToMain: async entry => { appendedEntry = entry; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://drive.google.com/drive/folders/abc123', name: 'Zlot Wolin', date: '2026-08-09' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(appendedEntry, {
      url: 'https://drive.google.com/drive/folders/abc123',
      nameOverride: 'Zlot Wolin',
      dateOverride: '2026-08-09',
    });
    // upload-service's Drive OAuth credentials only have drive.file scope, so it can never
    // write into a folder it didn't create itself - registering a Drive URL must go through
    // the same albums.json + CI pipeline as a Photos URL, not a direct Drive write.
    assert.equal(driveCalled, false);
  });
});

test('/register commits a Google Photos URL to albums.json identically', async () => {
  let appendedEntry: unknown = null;
  const deps = makeDeps({
    github: makeFakeGithub({ appendAlbumToMain: async entry => { appendedEntry = entry; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://photos.app.goo.gl/AbCdEf', name: 'Zlot Wolin', date: '2026-08-09' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(appendedEntry, {
      url: 'https://photos.app.goo.gl/AbCdEf',
      nameOverride: 'Zlot Wolin',
      dateOverride: '2026-08-09',
    });
  });
});

test('/unregister rejects an unauthenticated caller before touching GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    github: makeFakeGithub({ removeAlbumFromMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://photos.app.goo.gl/AbCdEf' }),
    });
    assert.equal(res.status, 401);
    assert.equal(githubCalled, false);
  });
});

// See the equivalent /delete-drive-gallery test above for why this matters.
test('/unregister rejects a caller who passes the general allowlist but not the admin one', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'member-1', email: 'member@gmail.com' }),
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    github: makeFakeGithub({ removeAlbumFromMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://photos.app.goo.gl/AbCdEf' }),
    });
    assert.equal(res.status, 403);
    assert.equal(githubCalled, false);
  });
});

test('/unregister rejects a body missing url', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test('/unregister removes the matching albums.json entry, for a Drive-by-URL or a Photos URL alike', async () => {
  let removedUrl: string | null = null;
  const deps = makeDeps({
    github: makeFakeGithub({ removeAlbumFromMain: async url => { removedUrl = url; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://drive.google.com/drive/folders/abc123' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.equal(removedUrl, 'https://drive.google.com/drive/folders/abc123');
  });
});

test('GET /admin/members?status=pending lists pending applications', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'pending@example.com', {
    email: 'pending@example.com', fullName: 'P', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'x',
    approvedAt: null, approvedBy: null, updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({ firestore: client });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members?status=pending`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].email, 'pending@example.com');
  });
});

test('GET /admin/members includes a member marked hidden - the one listing allowed to show them', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'skryty@example.com', {
    email: 'skryty@example.com', fullName: 'Skryty', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x',
    approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: true,
  });
  const deps = makeDeps({ firestore: client });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members?status=active`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].hidden, true);
  });
});

// KRKG bugfix: the Broń column on Zarządzanie ludźmi reads weaponIds straight off this response
// (joined from listaWyjazdowaProfile, not MemberDoc) rather than a separate fetch, since the
// roster route it could otherwise reuse (GET /lista-wyjazdowa/roster) requires live kruki Google
// Group membership that a moderator/admin-allowlist account isn't guaranteed to have.
test('GET /admin/members includes weaponIds joined from listaWyjazdowaProfile', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'zbrojny@example.com', {
    email: 'zbrojny@example.com', fullName: 'Zbrojny', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x',
    approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: false,
  });
  client.seed('listaWyjazdowaProfile', 'zbrojny@example.com', {
    weaponIds: ['miecz', 'topor'], companions: [], wpisowePaid: false,
    updatedAt: 'x', updatedBy: 'x',
  });
  client.seed('members', 'goly@example.com', {
    email: 'goly@example.com', fullName: 'Goly', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x',
    approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: false,
  });
  const deps = makeDeps({ firestore: client });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members?status=active`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const byEmail = Object.fromEntries(body.members.map((m: { email: string }) => [m.email, m]));
    assert.deepEqual(byEmail['zbrojny@example.com'].weaponIds, ['miecz', 'topor']);
    assert.deepEqual(byEmail['goly@example.com'].weaponIds, []);
  });
});

test('GET /admin/members rejects an unknown status value', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members?status=bogus`);
    assert.equal(res.status, 400);
  });
});

test('GET /admin/members rejects an unauthenticated caller', async () => {
  const deps = makeDeps({
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members?status=pending`);
    assert.equal(res.status, 401);
  });
});

test('POST /admin/members/transition approves a pending member via authenticateAdminOrModeratorWithStepUp', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'pending@example.com', {
    email: 'pending@example.com', fullName: 'P', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'x',
    approvedAt: null, approvedBy: null, updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'pending@example.com', transition: 'approve' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.status, 'active');
    assert.equal(body.member.approvedBy, 'admin@example.com');
  });
});

test('POST /admin/members/transition rejects an unknown transition value', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'someone@example.com', transition: 'bogus' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /admin/members/transition requires step-up freshness (rejects a stale reauthAt)', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'someone@example.com', transition: 'approve' }),
    });
    assert.equal(res.status, 401);
  });
});

test('POST /admin/members/transition reports sheetSyncStatus and includes the full member list, not just the one changed', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'pending@example.com', {
    email: 'pending@example.com', fullName: 'P', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'x', approvedAt: null, approvedBy: null, updatedAt: 'x', updatedBy: 'x',
  });
  client.seed('members', 'other@example.com', {
    email: 'other@example.com', fullName: 'O', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  let syncedEmails: string[] = [];
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
    sheetsClient: {
      syncAllMembers: async members => {
        syncedEmails = members.map((m: { email: string }) => m.email);
        return 'ok';
      },
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'pending@example.com', transition: 'approve' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheetSyncStatus, 'ok');
  });
  assert.deepEqual(syncedEmails.sort(), ['other@example.com', 'pending@example.com']);
});

test('C2: POST /admin/members/transition audits the Sheets mirror as a correlated membership.sheet_backup.synchronized event, alongside the primary transition event', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'pending@example.com', {
    email: 'pending@example.com', fullName: 'P', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'x', approvedAt: null, approvedBy: null, updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
    sheetsClient: { syncAllMembers: async () => 'ok' },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'pending@example.com', transition: 'approve' }),
    });
    assert.equal(res.status, 200);
  });
  const events = await client.listDocs<{ action: string; resource: { kind: string; key: string }; changes: Array<{ field: string; after?: string }> }>('auditEvents');
  const transitionEvent = events.find(e => e.data.action === 'membership.status.approved');
  const sheetEvent = events.find(e => e.data.action === 'membership.sheet_backup.synchronized');
  assert.ok(transitionEvent, 'the primary transition must still be audited, unchanged');
  assert.ok(sheetEvent, 'the Sheets mirror write must be its own audited event, not silently unaudited');
  assert.equal(sheetEvent!.data.changes.find(c => c.field === 'sheetBackup')?.after, 'ok');
  // GPT-5 follow-up finding: this sub-operation must be member-attributed with the transitioned
  // member's own canonical `member:{email}` key, not the old shared `member:sheet-backup` key -
  // otherwise it's invisible from that member's own Historia resource-key filter.
  assert.equal(sheetEvent!.data.resource.key, 'member:pending@example.com', 'must use the transitioned member\'s own resource key, not a shared sheet-backup key');
  assert.equal(sheetEvent!.data.resource.key, transitionEvent!.data.resource.key, 'must match the primary transition event\'s own resource key');
});

test('POST /admin/members/transition still returns 200 (Firestore succeeded) even when the Sheets sync fails', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'pending@example.com', {
    email: 'pending@example.com', fullName: 'P', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'pending', appliedAt: 'x', approvedAt: null, approvedBy: null, updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
    sheetsClient: { syncAllMembers: async () => 'failed' },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'pending@example.com', transition: 'approve' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.status, 'active');
    assert.equal(body.sheetSyncStatus, 'failed');
  });
});

test('PUT /admin/members/drive-folder links an existing member to a Drive folder', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/drive-folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', folderId: 'folder-xyz' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
  const stored = await client.getDoc<{ driveFolderId: string | null }>('members', 'ala@example.com');
  assert.equal(stored?.driveFolderId, 'folder-xyz');
});

test('PUT /admin/members/drive-folder can clear a member\'s folder link by passing folderId: null', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: 'old-folder', status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/drive-folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', folderId: null }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ driveFolderId: string | null }>('members', 'ala@example.com');
  assert.equal(stored?.driveFolderId, null);
});

test('PUT /admin/members/drive-folder 404s for an unknown member', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/drive-folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'nobody@example.com', folderId: 'folder-xyz' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/members/drive-folder rejects a missing email', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/drive-folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ folderId: 'folder-xyz' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/members/drive-folder requires step-up freshness (rejects a stale reauthAt)', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/drive-folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', folderId: 'folder-xyz' }),
    });
    assert.equal(res.status, 401);
  });
});

test('PUT /admin/members/profile updates fullName/nickname/sectionId for an existing member', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala Nowak', nickname: 'Alka', sectionId: 'krakow' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.fullName, 'Ala Nowak');
    assert.equal(body.member.nickname, 'Alka');
    assert.equal(body.member.updatedBy, 'admin@example.com');
  });
});

test('PUT /admin/members/profile sets categoryId when present in the body', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('lookupLists', 'categories', { items: [{ id: 'thing', label: 'Thing', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow', categoryId: 'thing' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.categoryId, 'thing');
  });
  const stored = await client.getDoc<{ categoryId: string | null }>('members', 'ala@example.com');
  assert.equal(stored?.categoryId, 'thing');
});

test('PUT /admin/members/profile can clear categoryId back to null', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: 'thing', driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow', categoryId: null }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ categoryId: string | null }>('members', 'ala@example.com');
  assert.equal(stored?.categoryId, null);
});

test('PUT /admin/members/profile leaves categoryId untouched when omitted from the body', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: 'thing', driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala Nowak', nickname: null, sectionId: 'krakow' }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ categoryId: string | null }>('members', 'ala@example.com');
  assert.equal(stored?.categoryId, 'thing');
});

test('PUT /admin/members/profile rejects an unknown categoryId', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('lookupLists', 'categories', { items: [{ id: 'thing', label: 'Thing', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow', categoryId: 'bogus' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/members/profile sets hidden when present in the body', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: false,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', hidden: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.hidden, true);
  });
  const stored = await client.getDoc<{ hidden: boolean }>('members', 'ala@example.com');
  assert.equal(stored?.hidden, true);
});

test('PUT /admin/members/profile setting hidden alone does not require fullName/nickname/sectionId', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: false,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', hidden: true }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ fullName: string; hidden: boolean }>('members', 'ala@example.com');
  assert.equal(stored?.hidden, true);
  assert.equal(stored?.fullName, 'Ala', 'unrelated fields must survive untouched');
});

test('PUT /admin/members/profile can clear hidden back to false', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: true,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', hidden: false }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ hidden: boolean }>('members', 'ala@example.com');
  assert.equal(stored?.hidden, false);
});

test('PUT /admin/members/profile leaves hidden untouched when omitted from the body', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: true,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala Nowak', nickname: null, sectionId: 'krakow' }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ hidden: boolean }>('members', 'ala@example.com');
  assert.equal(stored?.hidden, true);
});

test('PUT /admin/members/profile rejects a non-boolean hidden value', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: false,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', hidden: 'yes' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/members/profile with no mutable field remains a no-op and emits no audit event', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x', hidden: false,
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com' }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(await client.listDocs('auditEvents'), []);
});

test('PUT /admin/members/profile 404s for an unknown member', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'nobody@example.com', fullName: 'X', nickname: null, sectionId: 'krakow' }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/members/profile rejects an unknown sectionId', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'nieznana' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/members/profile rejects a missing email', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ fullName: 'Ala', nickname: null, sectionId: 'krakow' }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/members/profile requires step-up freshness (rejects a stale reauthAt)', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow' }),
    });
    assert.equal(res.status, 401);
  });
});

// KRKG bugfix: Zarządzanie ludźmi's own Broń column, editable by admin AND moderator - writes the
// same listaWyjazdowaProfile the member's own "Mój profil" (PUT /lista-wyjazdowa/profile) does,
// but keyed to an arbitrary member (?email=/body.email) rather than the caller, same split as
// PUT /lista-wyjazdowa/wpisowe.
test('PUT /admin/members/weapons sets weaponIds on an existing member, creating the profile doc', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'weapons', { items: [{ id: 'miecz', label: 'Miecz', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'mod-1', email: 'moderator@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/weapons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', weaponIds: ['miecz'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.profile.weaponIds, ['miecz']);
  });
  const stored = await client.getDoc<{ weaponIds: string[] }>('listaWyjazdowaProfile', 'ala@example.com');
  assert.deepEqual(stored?.weaponIds, ['miecz']);
});

test('PUT /admin/members/weapons can clear weaponIds back to empty', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'weapons', { items: [{ id: 'miecz', label: 'Miecz', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  client.seed('listaWyjazdowaProfile', 'ala@example.com', {
    weaponIds: ['miecz'], companions: [], wpisowePaid: false, updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/weapons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', weaponIds: [] }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ weaponIds: string[] }>('listaWyjazdowaProfile', 'ala@example.com');
  assert.deepEqual(stored?.weaponIds, []);
});

test('PUT /admin/members/weapons rejects a weaponId that is not in lookupLists', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'weapons', { items: [{ id: 'miecz', label: 'Miecz', retired: false }] });
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala', nickname: null, sectionId: 'krakow',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/weapons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', weaponIds: ['nieistniejaca'] }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/members/weapons 404s for an unknown member', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'weapons', { items: [{ id: 'miecz', label: 'Miecz', retired: false }] });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/weapons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'brak@example.com', weaponIds: [] }),
    });
    assert.equal(res.status, 404);
  });
});

test('PUT /admin/members/weapons requires step-up freshness (rejects a stale reauthAt)', async () => {
  const deps = makeDeps({
    authenticateAdminOrModeratorWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/weapons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', weaponIds: [] }),
    });
    assert.equal(res.status, 401);
  });
});

test('GET /admin/lookup-lists returns sections/categories/weapons', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  const deps = makeDeps({ firestore: client });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/lookup-lists`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.sections, [{ id: 'krakow', label: 'Kraków', retired: false }]);
  });
});

test('GET /admin/lookup-lists rejects an unauthenticated caller', async () => {
  const deps = makeDeps({
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/lookup-lists`);
    assert.equal(res.status, 401);
  });
});

test('GET /admin/roles lists granted roles', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'ala@example.com', { roles: ['accountant'] });
  const deps = makeDeps({ firestore: client });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.roles, [{ email: 'ala@example.com', roles: ['accountant'] }]);
  });
});

test('GET /admin/roles rejects an unauthenticated caller', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`);
    assert.equal(res.status, 401);
  });
});

test('PUT /admin/roles grants a role to a member and records only canonical evidence', async () => {
  const client = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore: client,
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', roles: ['admin'] }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ roles: string[] }>('userRoles', 'ala@example.com');
  assert.deepEqual(stored?.roles, ['admin']);
  const [audit] = await client.listDocs<{ action: string; actor: { email: string }; changes: Array<{ field: string; before: string; after: string }> }>('auditEvents');
  assert.equal(audit.data.action, 'role.granted');
  assert.equal(audit.data.actor.email, 'admin@example.com');
  assert.deepEqual(audit.data.changes, [{ field: 'roles', before: 'Brak', after: 'Admin', visibility: 'roleRestricted' }]);
});

test('PUT /admin/roles can revoke every role by passing an empty array without appending legacy evidence', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'ala@example.com', { roles: ['accountant'] });
  const deps = makeDeps({
    firestore: client,
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', roles: [] }),
    });
    assert.equal(res.status, 200);
  });
  const stored = await client.getDoc<{ roles: string[] }>('userRoles', 'ala@example.com');
  assert.deepEqual(stored?.roles, []);
  const [audit] = await client.listDocs<{ action: string; changes: Array<{ field: string; before: string; after: string }> }>('auditEvents');
  assert.equal(audit.data.action, 'role.revoked');
  assert.deepEqual(audit.data.changes, [{ field: 'roles', before: 'Księgowy', after: 'Brak', visibility: 'roleRestricted' }]);
});

test('PUT /admin/roles rejects an unknown role name', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', roles: ['superadmin'] }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/roles rejects a missing email', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ roles: ['admin'] }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/roles rejects a non-string email (400, not a 500 crash)', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    for (const email of [123, { nested: 'object' }, ['array'], null]) {
      const res = await fetch(`${baseUrl}/admin/roles`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
        body: JSON.stringify({ email, roles: ['admin'] }),
      });
      assert.equal(res.status, 400, `expected 400 for email=${JSON.stringify(email)}`);
    }
  });
});

test('PUT /admin/roles rejects a whitespace-only email', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: '   ', roles: ['admin'] }),
    });
    assert.equal(res.status, 400);
  });
});

test('PUT /admin/roles requires step-up freshness (rejects a stale reauthAt)', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN_FOR_TESTS },
      body: JSON.stringify({ email: 'ala@example.com', roles: ['admin'] }),
    });
    assert.equal(res.status, 401);
  });
});

test('POST /admin/members/synchronize syncs the full member list and requires step-up', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'a@example.com', {
    email: 'a@example.com', fullName: 'A', nickname: null, sectionId: 's',
    categoryId: null, driveFolderId: null, status: 'active', appliedAt: 'x', approvedAt: 'x', approvedBy: 'admin', updatedAt: 'x', updatedBy: 'x',
  });
  let syncedCount = -1;
  const deps = makeDeps({
    firestore: client,
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
    sheetsClient: {
      syncAllMembers: async members => {
        syncedCount = members.length;
        return 'ok';
      },
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/synchronize`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN_FOR_TESTS },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sheetSyncStatus, 'ok');
  });
  assert.equal(syncedCount, 1);
});

test('POST /admin/members/synchronize rejects a stale admin session', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/synchronize`, { method: 'POST', headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 401);
  });
});

// Admin-only (not authenticateAdminOrModerator, unlike the rest of Zarządzanie ludźmi) - a
// moderator can manage member records but must not trigger the Sheets backup sync.
test('POST /admin/members/synchronize rejects a Firestore-role-only moderator', async () => {
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/synchronize`, { method: 'POST', headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 403);
  });
});

// KRKG-0065: GET /admin/members/group-sync diffs the raw Google Group membership (deps.listGroupEmails
// - never used for authorization, see ServerDeps.listGroupEmails) against Firestore's active members
// (deps.listMemberEmails, already exactly that set) in both directions.
test('GET /admin/members/group-sync reports emails present on only one side, in both directions', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
    listMemberEmails: async () => ['a@example.com', 'b@example.com'],
    listGroupEmails: async () => ['b@example.com', 'c@example.com'],
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/group-sync`, { headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.onlyInFirestore, ['a@example.com']);
    assert.deepEqual(body.onlyInGroup, ['c@example.com']);
  });
});

test('GET /admin/members/group-sync reports no drift when both sides match', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
    listMemberEmails: async () => ['a@example.com'],
    listGroupEmails: async () => ['a@example.com'],
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/group-sync`, { headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.onlyInFirestore, []);
    assert.deepEqual(body.onlyInGroup, []);
  });
});

test('GET /admin/members/group-sync rejects a caller who is not an admin', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => {
      throw new AuthError('Brak uprawnień.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/group-sync`, { headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 403);
  });
});

// Admin-only (not authenticateAdminOrModerator, unlike the rest of Zarządzanie ludźmi) - a
// moderator can manage member records but must not run the Google Group drift check.
test('GET /admin/members/group-sync rejects a Firestore-role-only moderator', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/group-sync`, { headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 403);
  });
});

test('GET /admin/redirects rejects an unauthenticated caller before touching GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    authenticateAdmin: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    github: makeFakeGithub({ listRedirects: async () => { githubCalled = true; return []; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects`);
    assert.equal(res.status, 401);
    assert.equal(githubCalled, false);
  });
});

test('GET /admin/redirects returns the current list of redirects', async () => {
  const deps = makeDeps({
    github: makeFakeGithub({ listRedirects: async () => [{ path: 'discord', target: 'https://discord.gg/abc123' }] }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { redirects: unknown };
    assert.deepEqual(body, { redirects: [{ path: 'discord', target: 'https://discord.gg/abc123' }] });
  });
});

test('POST /admin/redirects rejects an unauthenticated caller before touching GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    github: makeFakeGithub({ appendRedirectToMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'discord', target: 'https://discord.gg/abc123' }),
    });
    assert.equal(res.status, 401);
    assert.equal(githubCalled, false);
  });
});

test('POST /admin/redirects rejects an invalid alias without touching GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    github: makeFakeGithub({ appendRedirectToMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Discord Invite', target: 'https://discord.gg/abc123' }),
    });
    assert.equal(res.status, 400);
    assert.equal(githubCalled, false);
  });
});

test('POST /admin/redirects rejects a non-http(s) target without touching GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    github: makeFakeGithub({ appendRedirectToMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'discord', target: 'javascript:alert(1)' }),
    });
    assert.equal(res.status, 400);
    assert.equal(githubCalled, false);
  });
});

test('POST /admin/redirects commits the new alias to redirects.json', async () => {
  let appendedEntry: unknown = null;
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    github: makeFakeGithub({ appendRedirectToMain: async entry => { appendedEntry = entry; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'discord', target: 'https://discord.gg/abc123' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(appendedEntry, { path: 'discord', target: 'https://discord.gg/abc123' });
  });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; after: string }> }>('auditEvents');
  assert.equal(event.data.action, 'site.redirect.created');
  assert.equal(event.data.resource.key, 'redirect:discord');
  assert.deepEqual(event.data.changes.map(change => [change.field, change.after]), [
    ['path', 'discord'], ['target', 'https://discord.gg/abc123'],
  ]);
  assert.equal((await firestore.listDocs('auditOperations')).length, 1);
  assert.equal((await firestore.listDocs('auditOperationOutcomes')).length, 1);
});

test('DELETE /admin/redirects rejects an unauthenticated caller before touching GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    github: makeFakeGithub({ removeRedirectFromMain: async () => { githubCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects?path=discord`, { method: 'DELETE' });
    assert.equal(res.status, 401);
    assert.equal(githubCalled, false);
  });
});

test('DELETE /admin/redirects removes the matching redirects.json entry', async () => {
  let removedPath: string | null = null;
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    github: makeFakeGithub({ removeRedirectFromMain: async path => { removedPath = path; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects?path=discord`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.equal(removedPath, 'discord');
  });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string } }>('auditEvents');
  assert.equal(event.data.action, 'site.redirect.deleted');
  assert.equal(event.data.resource.key, 'redirect:discord');
});

test('GET /files rejects an unauthenticated caller', async () => {
  const deps = makeDeps({
    authenticate: async () => { throw new AuthError('Brak sesji.', 401); },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/files`);
    assert.equal(res.status, 401);
  });
});

test('POST then GET /files round-trips a file and marks it deletable by its owner', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const postRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/arkusz', description: 'Nasz arkusz' }),
    });
    assert.equal(postRes.status, 200);
    const { file } = (await postRes.json()) as { file: { id: string; name: string; docType: string; addedByEmail: string } };
    assert.equal(file.name, 'Nasz arkusz');
    assert.equal(file.docType, 'generic');
    assert.equal(file.addedByEmail, 'ala@example.test');

    const getRes = await fetch(`${baseUrl}/files`);
    const { files } = (await getRes.json()) as { files: Array<{ id: string; canDelete: boolean }> };
    assert.equal(files.length, 1);
    assert.equal(files[0].id, file.id);
    assert.equal(files[0].canDelete, true);
  });
});

test('GET /files marks another member\'s file as not deletable for a plain member', async () => {
  const firestore = createInMemoryFirestoreClient();
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', description: 'Plik Ali' }),
    });
  });
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'bob@example.test' }) }), async baseUrl => {
    const res = await fetch(`${baseUrl}/files`);
    const { files } = (await res.json()) as { files: Array<{ canDelete: boolean }> };
    assert.equal(files[0].canDelete, false);
  });
});

test('GET /files marks every file deletable for a moderator', async () => {
  const firestore = createInMemoryFirestoreClient();
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', description: 'Plik Ali' }),
    });
  });
  firestore.seed('userRoles', 'mod@example.test', { roles: ['moderator'] });
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'mod@example.test' }) }), async baseUrl => {
    const res = await fetch(`${baseUrl}/files`);
    const { files } = (await res.json()) as { files: Array<{ canDelete: boolean }> };
    assert.equal(files[0].canDelete, true);
  });
});

test('POST /files rejects a body with no url', async () => {
  const deps = makeDeps({ authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'brak URL' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /files rejects a syntactically invalid url', async () => {
  const deps = makeDeps({ authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'nie-jest-URL' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /files rejects a javascript: URL', async () => {
  const deps = makeDeps({ authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /files rejects a plain http: URL', async () => {
  const deps = makeDeps({ authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://example.com/x' }),
    });
    assert.equal(res.status, 400);
  });
});

test('DELETE /files lets the owner delete their own file, with a full before-state in the audit event', async () => {
  const firestore = createInMemoryFirestoreClient();
  let fileId = '';
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    const postRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', description: 'Plik' }),
    });
    fileId = ((await postRes.json()) as { file: { id: string } }).file.id;
    const delRes = await fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
  });
  assert.equal(await getFile(firestore, fileId), null);

  const events = await firestore.listDocs<{ action: string; changes: Array<{ field: string; before?: unknown }> }>('auditEvents');
  const deleteEvent = events.map(e => e.data).find(e => e.action === 'file.deleted');
  const beforeFields = new Set(deleteEvent!.changes.map(c => c.field));
  assert.deepEqual([...beforeFields].sort(), ['description', 'docType', 'name', 'url']);
});

test('DELETE /files rejects a different plain member deleting someone else\'s file', async () => {
  const firestore = createInMemoryFirestoreClient();
  let fileId = '';
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    const postRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', description: 'Plik' }),
    });
    fileId = ((await postRes.json()) as { file: { id: string } }).file.id;
  });
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'bob@example.test' }) }), async baseUrl => {
    const res = await fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' });
    assert.equal(res.status, 403);
  });
  assert.ok(await getFile(firestore, fileId));
});

test('DELETE /files lets a moderator delete someone else\'s file', async () => {
  const firestore = createInMemoryFirestoreClient();
  let fileId = '';
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    const postRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', description: 'Plik' }),
    });
    fileId = ((await postRes.json()) as { file: { id: string } }).file.id;
  });
  firestore.seed('userRoles', 'mod@example.test', { roles: ['moderator'] });
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'mod@example.test' }) }), async baseUrl => {
    const res = await fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(await getFile(firestore, fileId), null);
});

test('DELETE /files returns 404 for an unknown id', async () => {
  const deps = makeDeps({ authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/files?id=does-not-exist`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

// KRKG-0076 P2 (external delegated review, Codex gpt-5.6-terra): an earlier version of this test
// asserted the old handler's actual behavior - two truly concurrent DELETEs of the same file both
// returning 200 - because the file read and owner/moderator decision ran BEFORE the transaction,
// so the race loser's tx.deleteDoc was an indistinguishable no-op that still got a full,
// unconditional file.deleted audit event committed alongside it: a false audit record for a
// deletion that never actually happened on that request. That review flagged this as a real
// audit-integrity bug, not an acceptable idempotency trade-off - see design.md's "Odwrócone po
// recenzji Batchy 1-2" section for the full reasoning. The fix moved the read inside the same
// transaction that writes the audit event (via tx.getDoc), so this test now asserts the corrected,
// race-safe contract instead: exactly one request's transaction commits (200), the other's
// transactional read finds the document already gone and the whole transaction aborts before any
// write (404) - and exactly one file.deleted audit event exists, never two.
//
// A round-2 delegated review (reviews/KRKG-0076-plan-review-round2-opencode.md, finding #1) noted
// that a bare Promise.all of two fetch() calls against this same in-process node:http server does
// not reliably force concurrent handler execution, so this still fires the two DELETEs with a
// small stagger to make sure both are genuinely in flight rather than accidentally sequential. No
// explicit read-gating wrapper is needed any more (unlike the old pre-transaction-read version):
// the in-memory Firestore test double fully serializes `runTransaction` calls through one queue
// (see firestore.ts), mirroring real Firestore's per-document contention/retry semantics, so
// whichever DELETE's transaction is queued second deterministically sees the already-deleted
// document via tx.getDoc and 404s - no artificial synchronization required to observe that.
test('exactly one of two genuinely concurrent DELETEs of the same file succeeds; the loser gets 404 and no audit event', async () => {
  const firestore = createInMemoryFirestoreClient();
  let fileId = '';
  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    const postRes = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/x', description: 'Plik' }),
    });
    fileId = ((await postRes.json()) as { file: { id: string } }).file.id;
  });

  await withServer(makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }), async baseUrl => {
    const firstRequest = fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const secondRequest = fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' });
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.deepEqual([first.status, second.status].sort(), [200, 404]);
  });
  assert.equal(await getFile(firestore, fileId), null);

  const events = await firestore.listDocs<{ action: string }>('auditEvents');
  const deleteEvents = events.map(e => e.data).filter(e => e.action === 'file.deleted');
  assert.equal(deleteEvents.length, 1);
});

test('/delete-drive-gallery rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    drive: makeFakeDrive({ deleteFolder: async () => { driveCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/delete-drive-gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'abc' }),
    });
    assert.equal(res.status, 401);
    assert.equal(driveCalled, false);
  });
});

// KRKG-0049: an ordinary allowlisted kruki-group member (passes the general `authenticate`,
// used elsewhere for upload/register) must NOT be able to delete a gallery just by being on
// that broader list - only someone the admin allowlist accepts can (KRKG-0027's separate
// moderator-group gate was dropped - it was never actually configured in production).
test('/delete-drive-gallery rejects a caller who passes the general allowlist but not the admin one', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'member-1', email: 'member@gmail.com' }),
    authenticateAdminWithStepUp: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    drive: makeFakeDrive({ deleteFolder: async () => { driveCalled = true; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/delete-drive-gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'abc' }),
    });
    assert.equal(res.status, 403);
    assert.equal(driveCalled, false);
  });
});

test('/delete-drive-gallery rejects a body missing folderId', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/delete-drive-gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test('/delete-drive-gallery deletes the folder via Drive', async () => {
  let deletedFolderId: string | null = null;
  const deps = makeDeps({
    drive: makeFakeDrive({ deleteFolder: async folderId => { deletedFolderId = folderId; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/delete-drive-gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'abc123' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.equal(deletedFolderId, 'abc123');
  });
});

test('/delete-drive-gallery invalidates the /galleries cache so the deletion is reflected immediately', async () => {
  let listCalls = 0;
  const deps = makeDeps({
    galleriesCacheTtlMs: 60_000,
    drive: makeFakeDrive({
      listGalleryFolders: async () => {
        listCalls++;
        return listCalls === 1 ? [{ id: 'g1', name: 'Folder', modifiedTime: '2026-01-01T00:00:00.000Z' }] : [];
      },
      deleteFolder: async () => {},
    }),
  });
  await withServer(deps, async baseUrl => {
    const first = await fetch(`${baseUrl}/galleries`).then(r => r.json());
    assert.equal(first.galleries.length, 1);

    await fetch(`${baseUrl}/delete-drive-gallery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'g1' }),
    });

    // Without the cache invalidation, this would still return the stale cached listing since
    // galleriesCacheTtlMs (60s) hasn't elapsed.
    const second = await fetch(`${baseUrl}/galleries`).then(r => r.json());
    assert.equal(second.galleries.length, 0);
    assert.equal(listCalls, 2);
  });
});

test('/start rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticate: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    drive: makeFakeDrive({ createAlbumFolder: async () => { driveCalled = true; return 'x'; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-09' }),
    });
    assert.equal(res.status, 401);
    assert.equal(driveCalled, false);
  });
});

test('/start creates a folder and returns a submission token bound to the caller and folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({ firestore, drive: makeFakeDrive({ createAlbumFolder: async () => 'folder-created-by-start' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-09', name: 'Wolin' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'folder-created-by-start');
    assert.ok(typeof body.submissionToken === 'string' && body.submissionToken.length > 0);
  });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; after: string }> }>('auditEvents');
  assert.equal(event.data.action, 'gallery.created');
  assert.equal(event.data.resource.key, 'gallery:folder-created-by-start');
  assert.deepEqual(event.data.changes.map(change => [change.field, change.after]), [['name', 'Wolin'], ['date', '2026-08-09']]);
});

test('/start makes the new folder public immediately, before any files are uploaded', async () => {
  let madePublicFolderId: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      createAlbumFolder: async () => 'folder-created-by-start',
      setFolderPublic: async folderId => { madePublicFolderId = folderId; },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-09', name: 'Wolin' }),
    });
    assert.equal(res.status, 200);
  });
  // Not deferred to /finalize: any file that does get uploaded must be visible in the gallery
  // detail view (which reads Drive with a public, anonymous key) even if the submission never
  // reaches /finalize at all.
  assert.equal(madePublicFolderId, 'folder-created-by-start');
});

test('/upload rejects a request with no X-Submission-Token', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/upload?folderId=${uniqueFolderId()}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 401);
  });
});

test('/upload rejects a submission token minted for a different folder', async () => {
  const deps = makeDeps();
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, 'some-other-folder');
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 403);
  });
});

test('/upload rejects a file whose bytes do not match the declared MIME type', async () => {
  const deps = makeDeps();
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: Buffer.from('not actually a jpeg, just text padded out past the sniff window......'),
    });
    assert.equal(res.status, 400);
  });
});

test('/upload rejects a file once the folder is already at the submission cap', async () => {
  const fullFolder: DriveFileInfo[] = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.jpg`, size: 10 }));
  const deps = makeDeps({
    maxFilesPerSubmission: 3,
    drive: makeFakeDrive({ listFiles: async () => fullFolder }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 400);
  });
});

test('/upload accepts a correctly labeled, correctly sized JPEG under the cap', async () => {
  let uploaded = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async (_f, _n, _m, stream) => {
        for await (const _chunk of stream) {
          // drain
        }
        uploaded = true;
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);
    assert.equal(uploaded, true);
  });
});

test('/upload skips a file that already exists in the folder with the same name and size, without writing it again', async () => {
  let uploadFileStreamCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: VALID_JPEG_BYTES.length }],
      uploadFileStream: async () => {
        uploadFileStreamCalled = true;
        return { id: 'should-not-be-reached' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, skipped: true });
  });
  assert.equal(uploadFileStreamCalled, false);
});

test('C1: POST /upload audits gallery.photo.added for a genuinely new file', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async (_f, _n, _m, stream) => {
        for await (const _chunk of stream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);
  });
  const events = await firestore.listDocs<{ action: string; actor: { email: string }; resource: { key: string; kind: string } }>('auditEvents');
  const uploadEvents = events.filter(e => e.data.action === 'gallery.photo.added');
  assert.equal(uploadEvents.length, 1, 'exactly one gallery.photo.added event per real upload');
  assert.equal(uploadEvents[0].data.actor.email, 'alice@gmail.com');
  assert.equal(uploadEvents[0].data.resource.key, `gallery:${folderId}`);
});

test('C1: POST /upload does not audit anything on the duplicate-skip fast path (no new state changed)', async () => {
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: VALID_JPEG_BYTES.length }],
      uploadFileStream: async () => {
        throw new Error('must not upload on the duplicate-skip path');
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, skipped: true });
  });
  const events = await firestore.listDocs<{ action?: string }>('auditEvents');
  assert.equal(events.length, 0, 'a skip changes no state, so it must not be audited');
});

test('/upload does not skip a same-named file whose size differs from what is already in the folder', async () => {
  let uploadFileStreamCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: VALID_JPEG_BYTES.length + 1 }],
      uploadFileStream: async (_f, _n, _m, stream) => {
        for await (const _chunk of stream) {
          // drain
        }
        uploadFileStreamCalled = true;
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);
  });
  assert.equal(uploadFileStreamCalled, true);
});

test('/upload releases its reserved duplicate key when the write fails, so a retry of that same file is not wrongly skipped', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async () => {
        throw new Error('Drive write failed');
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const firstAttempt = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(firstAttempt.status, 500);

    let retryReachedUpload = false;
    deps.drive.uploadFileStream = async (_f, _n, _m, stream) => {
      for await (const _chunk of stream) {
        // drain
      }
      retryReachedUpload = true;
      return { id: 'fake-uploaded-file-id' };
    };
    const retry = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(retry.status, 200);
    // Confirms the retry actually re-uploaded rather than being skipped as a "duplicate" of the
    // failed first attempt, which never made it into the folder.
    assert.equal(retryReachedUpload, true);
  });
});

test('/upload does not skip a same-named, same-sized file whose original last-modified time differs', async () => {
  let uploadFileStreamCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: VALID_JPEG_BYTES.length, modifiedTime: '2026-01-01T00:00:00.000Z' }],
      uploadFileStream: async (_f, _n, _m, stream) => {
        for await (const _chunk of stream) {
          // drain
        }
        uploadFileStreamCalled = true;
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const differentMoment = Date.parse('2026-02-02T00:00:00.000Z');
    const res = await fetch(
      `${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg&lastModifiedMs=${differentMoment}`,
      { method: 'POST', headers: { 'X-Submission-Token': token }, body: VALID_JPEG_BYTES },
    );
    assert.equal(res.status, 200);
  });
  assert.equal(uploadFileStreamCalled, true);
});

test('/upload does not tell a concurrent duplicate request "skipped" while the original upload could still fail', async () => {
  let uploadCalls = 0;
  let resolveFirstUpload: (() => void) | undefined;
  const firstUploadGate = new Promise<void>(resolve => {
    resolveFirstUpload = resolve;
  });
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async (_f, _n, _m, stream) => {
        uploadCalls++;
        if (uploadCalls === 1) {
          await firstUploadGate;
          throw new Error('Drive write failed');
        }
        for await (const _chunk of stream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const requestOptions = {
      method: 'POST' as const,
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    };
    const uploadUrl = `${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`;
    const firstRequest = fetch(uploadUrl, requestOptions);
    // Gives the first request time to reach and start waiting inside uploadFileStream before
    // the second fires, so this exercises the concurrent-duplicate path (the second request
    // finding the dedupe lock already held) rather than a plain sequential retry.
    await new Promise(resolve => setTimeout(resolve, 20));
    const secondRequest = fetch(uploadUrl, requestOptions);
    resolveFirstUpload?.();

    const [firstRes, secondRes] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(firstRes.status, 500);
    assert.equal(secondRes.status, 200);
    // Must not be "skipped" - the file the second request would be a duplicate of never
    // actually made it into Drive (the first attempt failed), so it has to upload for real.
    assert.deepEqual(await secondRes.json(), { ok: true });
  });
  assert.equal(uploadCalls, 2);
});

test('/upload drains an unread duplicate-upload request body, so a later request on the same connection still works', async () => {
  // Large enough that leaving it unread on the connection would actually matter - the small
  // VALID_JPEG_BYTES body used elsewhere comfortably fits in socket buffers even left unread,
  // so this needs its own, much bigger body to give an undrained body a real chance to wedge
  // the connection Node's fetch (undici) keeps alive and reuses across requests to the same
  // origin. A plain Buffer (rather than a stream) so `fetch` computes Content-Length itself,
  // same as every other test here - the duplicate check never reads the body regardless of size.
  const LARGE_DUPLICATE_BODY = Buffer.alloc(32 * 1024 * 1024, 0x42);
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: LARGE_DUPLICATE_BODY.length }],
      uploadFileStream: async (_f, _n, _m, stream) => {
        for await (const _chunk of stream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();

  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const timeout = () =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('request stalled - a prior duplicate body was left unread')), 5000),
      );

    const dupRes = await Promise.race([
      fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
        method: 'POST',
        headers: { 'X-Submission-Token': token },
        body: LARGE_DUPLICATE_BODY,
      }),
      timeout(),
    ]);
    assert.equal(dupRes.status, 200);
    assert.deepEqual(await dupRes.json(), { ok: true, skipped: true });

    // If the response above left its own request body unread, this next request on the same
    // keep-alive connection would stall or fail instead of completing normally.
    const followUpRes = await Promise.race([
      fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=b.jpg&mimeType=image/jpeg`, {
        method: 'POST',
        headers: { 'X-Submission-Token': token },
        body: VALID_JPEG_BYTES,
      }),
      timeout(),
    ]);
    assert.equal(followUpRes.status, 200);
  });
});

test('/upload does not leak a per-file dedupe lock entry once the request settles', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async (_f, _n, _m, stream) => {
        for await (const _chunk of stream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const before = getFolderLockKeyCountForTests();

    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);

    // The lock's own cleanup runs in a microtask chained off its settlement, which the fetch
    // response (real I/O) has already outlasted by the time it resolves - this extra tick is
    // just cheap insurance.
    await new Promise(resolve => setImmediate(resolve));
    // Without cleanup, this per-file (name, size, mtime) key - and reserveUploadSlot's own
    // folderId key - would sit in the module-level lock map for the rest of the process
    // lifetime, one entry per photo ever uploaded on a long-lived Cloud Run instance.
    assert.equal(getFolderLockKeyCountForTests(), before);
  });
});

test('/finalize rejects a folder with no uploaded files', async () => {
  const deps = makeDeps({ drive: makeFakeDrive({ listFiles: async () => [] }) });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId, date: '2026-08-09' }),
    });
    assert.equal(res.status, 400);
  });
});

test('/finalize writes a gallery manifest with name, date, and the uploader as contributor before publishing', async () => {
  let writtenFolderId: string | null = null;
  let writtenManifest: { name?: string; date: string; contributors: string[] } | null = null;
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: 10 }],
      writeManifest: async (folderId, manifest) => {
        writtenFolderId = folderId;
        writtenManifest = manifest;
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId, name: 'Zlot Wolin', date: '2026-08-09' }),
    });
    assert.equal(res.status, 200);
    assert.equal(writtenFolderId, folderId);
    assert.deepEqual(writtenManifest, { name: 'Zlot Wolin', date: '2026-08-09', contributors: ['alice@gmail.com'] });
  });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; after: string }> }>('auditEvents');
  assert.equal(event.data.action, 'gallery.finalized');
  assert.equal(event.data.resource.key, `gallery:${folderId}`);
  assert.deepEqual(event.data.changes.map(change => [change.field, change.after]), [['name', 'Zlot Wolin'], ['date', '2026-08-09'], ['finalized', 'true']]);
});

test('/finalize succeeds and does not touch GitHub', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: 10 }],
    }),
    github: makeFakeGithub({ appendAlbumToMain: async () => { githubCalled = true; } }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId, date: '2026-08-09' }),
    });
    assert.equal(res.status, 200);
    // The app owns this folder (it created it), so GET /galleries already discovers it live -
    // no albums.json/CI commit needed, unlike /register's path for externally-created folders.
    assert.equal(githubCalled, false);
  });
});

test('/finalize invalidates the /galleries cache so the new gallery shows up immediately', async () => {
  let listCalls = 0;
  const deps = makeDeps({
    galleriesCacheTtlMs: 60_000,
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: 10 }],
      listGalleryFolders: async () => {
        listCalls++;
        return listCalls === 1 ? [] : [{ id: 'g1', name: 'Nowa galeria', modifiedTime: '2026-01-01T00:00:00.000Z' }];
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const first = await fetch(`${baseUrl}/galleries`).then(r => r.json());
    assert.equal(first.galleries.length, 0);

    const token = await issueTestSubmissionToken(deps, folderId);
    await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId, date: '2026-08-09' }),
    });

    // Without the cache invalidation, this would still return the stale (empty) cached listing
    // since galleriesCacheTtlMs (60s) hasn't elapsed.
    const second = await fetch(`${baseUrl}/galleries`).then(r => r.json());
    assert.equal(second.galleries.length, 1);
    assert.equal(listCalls, 2);
  });
});

test('/upload records who uploaded the file and when', async () => {
  let writtenTo: string | undefined;
  let writtenContent: string | undefined;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com', name: 'Alice', picture: 'https://example.com/a.jpg' }),
    drive: makeFakeDrive({
      readTextFile: async () => null,
      writeTextFile: async (folderId, fileName, content) => {
        if (fileName === '.uploads.json') {
          writtenTo = folderId;
          writtenContent = content;
        }
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 200);
  });
  assert.equal(writtenTo, folderId);
  const log = JSON.parse(writtenContent ?? '[]');
  assert.equal(log.length, 1);
  assert.equal(log[0].fileId, 'fake-uploaded-file-id');
  assert.equal(log[0].email, 'alice@gmail.com');
  assert.equal(log[0].name, 'Alice');
  assert.equal(log[0].picture, 'https://example.com/a.jpg');
  assert.ok(typeof log[0].uploadedAt === 'string' && log[0].uploadedAt.length > 0);
});

test('/upload appends to an existing upload log instead of overwriting it', async () => {
  let writtenContent: string | undefined;
  const existingEntry = { fileId: 'old-file', email: 'bob@gmail.com', uploadedAt: '2026-01-01T00:00:00.000Z' };
  const deps = makeDeps({
    drive: makeFakeDrive({
      readTextFile: async () => JSON.stringify([existingEntry]),
      writeTextFile: async (_folderId, fileName, content) => {
        if (fileName === '.uploads.json') writtenContent = content;
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
  });
  const log = JSON.parse(writtenContent ?? '[]');
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], existingEntry);
  assert.equal(log[1].fileId, 'fake-uploaded-file-id');
});

test('POST /gallery-photos/start issues a token for an existing gallery folder', async () => {
  const deps = makeDeps({
    driveParentFolderId: 'parent-1',
    drive: makeFakeDrive({ listGalleryFolders: async () => [{ id: 'gallery-1', name: 'Wolin', modifiedTime: '2026-01-01' }] }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/gallery-photos/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'gallery-1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'gallery-1');
    assert.ok(typeof body.submissionToken === 'string' && body.submissionToken.length > 0);
  });
});

test('POST /gallery-photos/start rejects a folderId that is not an existing gallery', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({ listGalleryFolders: async () => [{ id: 'gallery-1', name: 'Wolin', modifiedTime: '2026-01-01' }] }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/gallery-photos/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: 'not-a-real-gallery' }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST /gallery-photos/finalize adds the uploader to contributors without duplicating or touching name/date', async () => {
  let writtenManifest: unknown;
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    drive: makeFakeDrive({
      readManifest: async () => ({ name: 'Wolin', date: '2026-01-01', contributors: ['bob@gmail.com', 'alice@gmail.com'] }),
      writeManifest: async (_folderId, manifest) => {
        writtenManifest = manifest;
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/gallery-photos/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId }),
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(writtenManifest, { name: 'Wolin', date: '2026-01-01', contributors: ['bob@gmail.com', 'alice@gmail.com'] });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string } }>('auditEvents');
  assert.equal(event.data.action, 'gallery.photo.contribution.finalized');
  assert.equal(event.data.resource.key, `gallery:${folderId}`);
});

test('POST /gallery-photos/finalize re-asserts public sharing, healing a gallery whose original /finalize was never reached', async () => {
  let madePublic = false;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    drive: makeFakeDrive({
      readManifest: async () => ({ name: 'Wolin', date: '2026-01-01', contributors: [] }),
      setFolderPublic: async () => { madePublic = true; },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/gallery-photos/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(madePublic, true);
});

test('POST /gallery-photos/finalize adds a new contributor when the gallery has no manifest yet', async () => {
  let writtenManifest: { name?: string; date: string; contributors: string[] } | undefined;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    drive: makeFakeDrive({
      readManifest: async () => null,
      writeManifest: async (_folderId, manifest) => {
        writtenManifest = manifest;
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    await fetch(`${baseUrl}/gallery-photos/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId }),
    });
  });
  assert.deepEqual(writtenManifest?.contributors, ['alice@gmail.com']);
  assert.equal(writtenManifest?.name, undefined);
});

test('POST /gallery-photos/finalize invalidates the /galleries cache so the added photo count shows up immediately', async () => {
  let listCalls = 0;
  const deps = makeDeps({
    galleriesCacheTtlMs: 60_000,
    drive: makeFakeDrive({
      listGalleryFolders: async () => {
        listCalls++;
        return [{ id: 'g1', name: 'Galeria', modifiedTime: '2026-01-01T00:00:00.000Z' }];
      },
      getCoverThumbnail: async () => (listCalls === 1 ? null : 'https://example.test/thumb=s220'),
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const first = await fetch(`${baseUrl}/galleries`).then(r => r.json());
    assert.equal(first.galleries[0].coverThumbnailLink, null);

    const token = await issueTestSubmissionToken(deps, folderId);
    await fetch(`${baseUrl}/gallery-photos/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId }),
    });

    // Without the cache invalidation, this would still return the stale cached listing since
    // galleriesCacheTtlMs (60s) hasn't elapsed.
    const second = await fetch(`${baseUrl}/galleries`).then(r => r.json());
    assert.equal(second.galleries[0].coverThumbnailLink, 'https://example.test/thumb=s220');
    assert.equal(listCalls, 2);
  });
});

test('GET /gallery-photos/uploaders rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticate: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
    drive: makeFakeDrive({ readTextFile: async () => { driveCalled = true; return null; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/gallery-photos/uploaders?folderId=gallery-1`);
    assert.equal(res.status, 401);
    assert.equal(driveCalled, false);
  });
});

test('GET /gallery-photos/uploaders returns the upload log for a folder', async () => {
  const entries = [{ fileId: 'f1', email: 'alice@gmail.com', uploadedAt: '2026-01-01T00:00:00.000Z' }];
  const deps = makeDeps({
    drive: makeFakeDrive({ readTextFile: async () => JSON.stringify(entries) }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/gallery-photos/uploaders?folderId=gallery-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.uploaders, entries);
  });
});

test('GET /gallery-photos/uploaders returns an empty list when there is no upload log yet', async () => {
  const deps = makeDeps({ drive: makeFakeDrive({ readTextFile: async () => null }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/gallery-photos/uploaders?folderId=gallery-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.uploaders, []);
  });
});

test('/upload enforces the exact file cap under real concurrency, not just the frontend\'s expected worker-pool size', async () => {
  const deps = makeDeps({
    maxFilesPerSubmission: 5,
    drive: makeFakeDrive({ listFiles: async () => [] }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const CONCURRENT_REQUESTS = 20; // far more than the frontend's own MAX_CONCURRENT_UPLOADS (4)
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
        fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=f${i}.jpg&mimeType=image/jpeg`, {
          method: 'POST',
          headers: { 'X-Submission-Token': token },
          body: VALID_JPEG_BYTES,
        }),
      ),
    );
    const succeeded = results.filter(r => r.status === 200);
    const rejected = results.filter(r => r.status === 400);
    assert.equal(succeeded.length, 5);
    assert.equal(rejected.length, CONCURRENT_REQUESTS - 5);
  });
});

test('/upload releases its reserved slot when the write itself fails, so a legitimate retry is not blocked', async () => {
  const deps = makeDeps({
    maxFilesPerSubmission: 1,
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async () => {
        throw new Error('Drive write failed');
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const firstAttempt = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(firstAttempt.status, 500);

    deps.drive.uploadFileStream = async (_f, _n, _m, stream) => {
      for await (const _chunk of stream) {
        // drain
      }
      return { id: 'fake-uploaded-file-id' };
    };
    const retry = await fetch(`${baseUrl}/upload?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(retry.status, 200);
  });
});

test('/start rejects a JSON body larger than maxJsonBodyBytes', async () => {
  const deps = makeDeps({ maxJsonBodyBytes: 32 });
  await withServer(deps, async baseUrl => {
    const oversizedName = 'x'.repeat(200);
    const res = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-09', name: oversizedName }),
    });
    assert.equal(res.status, 413);
  });
});

test('/wojownicy-upload/whoami rejects a caller not on the group allowlist', async () => {
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do przesyłania zdjęć.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/whoami`);
    assert.equal(res.status, 403);
  });
});

test('/wojownicy-upload/whoami returns the caller\'s email once authenticated', async () => {
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'ktos@gmail.com' });
  });
});

test('/wojownicy-docs rejects a caller not on the group allowlist', async () => {
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do przesyłania zdjęć.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-docs?key=zasady-bractwa`);
    assert.equal(res.status, 403);
  });
});

test('/wojownicy-docs returns the exported HTML for a known key', async () => {
  const deps = makeDeps({
    drive: makeFakeDrive({ exportDocHtml: async fileId => `<p>content of ${fileId}</p>` }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-docs?key=zasady-bractwa`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { html: '<p>content of doc-zasady-1</p>' });
  });
});

test('/wojownicy-docs rejects an unknown key without calling Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({ exportDocHtml: async () => { driveCalled = true; return ''; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-docs?key=nieznany`);
    assert.equal(res.status, 404);
    assert.equal(driveCalled, false);
  });
});

test('/wojownicy-docs rejects a missing key', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-docs`);
    assert.equal(res.status, 404);
  });
});

test('/wojownicy-upload/submit rejects a missing name before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({ createAlbumFolder: async () => { driveCalled = true; return 'x'; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(driveCalled, false);
  });
});

test('/wojownicy-upload/submit creates a folder named "Imię - email - data" under the upload root, and returns a submission token', async () => {
  resetAboutUsBootstrapForTests();
  let createdParent: string | undefined;
  let createdName: string | undefined;
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      ensureFolder: async (parent, name) => (name === 'upload' ? 'upload-root' : `ensured-${name}`),
      createAlbumFolder: async (parent, name) => {
        createdParent = parent;
        createdName = name;
        return 'submission-folder';
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Kowalski' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'submission-folder');
    assert.ok(typeof body.submissionToken === 'string' && body.submissionToken.length > 0);
    assert.equal(createdParent, 'upload-root');
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(createdName, `Jan Kowalski - ktos@gmail.com - ${today}`);
  });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; after: string }> }>('auditEvents');
  assert.equal(event.data.action, 'profile.photo_submission.created');
  assert.equal(event.data.resource.key, 'member:ktos@gmail.com:submission:submission-folder');
  assert.deepEqual(event.data.changes.map(change => [change.field, change.after]), [['name', 'Jan Kowalski']]);
});

function seedMemberDoc(overrides: Record<string, unknown> = {}) {
  return {
    email: 'ktos@gmail.com',
    fullName: 'Jan Kowalski',
    nickname: null,
    sectionId: 'sekcja-1',
    categoryId: null,
    driveFolderId: null,
    stagingFolderId: null,
    status: 'active',
    appliedAt: new Date().toISOString(),
    approvedAt: null,
    approvedBy: null,
    updatedAt: new Date().toISOString(),
    updatedBy: 'ktos@gmail.com',
    lastLoginAt: null,
    hidden: false,
    ...overrides,
  };
}

test('/wojownicy-upload/submit reuses the member\'s existing stagingFolderId while it is still unreviewed', async () => {
  resetAboutUsBootstrapForTests();
  let createAlbumFolderCalled = false;
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 'existing-folder' }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      createAlbumFolder: async () => {
        createAlbumFolderCalled = true;
        return 'should-not-be-created';
      },
      folderExists: async id => id === 'existing-folder',
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Kowalski' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'existing-folder');
  });
  assert.equal(createAlbumFolderCalled, false);
  const events = await firestore.listDocs<{ action?: string }>('auditEvents');
  assert.equal(events.length, 0);
});

test('/wojownicy-upload/submit reuses stagingFolderId even after the member has been published (KRKG-0070 bug fix)', async () => {
  resetAboutUsBootstrapForTests();
  let createAlbumFolderCalled = false;
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({
    stagingFolderId: 'existing-staging-folder',
    driveFolderId: 'existing-public-folder',
  }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      createAlbumFolder: async () => {
        createAlbumFolderCalled = true;
        return 'should-not-be-created';
      },
      folderExists: async id => id === 'existing-staging-folder',
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Kowalski' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'existing-staging-folder');
  });
  assert.equal(createAlbumFolderCalled, false);
  const updated = await firestore.getDoc<{ driveFolderId: string | null }>('members', 'ktos@gmail.com');
  assert.equal(updated?.driveFolderId, 'existing-public-folder', 'driveFolderId must never be touched by a submission');
});

test('/wojownicy-upload/submit creates a new stagingFolderId (never touching driveFolderId) for a member with none yet', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: null, driveFolderId: null }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root' : `folder-${name}`),
      createAlbumFolder: async () => 'new-staging-folder',
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Kowalski' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'new-staging-folder');
  });
  const updated = await firestore.getDoc<{ stagingFolderId: string | null; driveFolderId: string | null }>('members', 'ktos@gmail.com');
  assert.equal(updated?.stagingFolderId, 'new-staging-folder');
  assert.equal(updated?.driveFolderId, null);
});

test('/wojownicy-upload/submit creates a fresh staging folder for an already-published member with no stagingFolderId yet, leaving driveFolderId untouched (KRKG-0070)', async () => {
  resetAboutUsBootstrapForTests();
  let createAlbumFolderCalled = false;
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'approved-folder', stagingFolderId: null }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root' : `ensured-${name}`),
      createAlbumFolder: async () => {
        createAlbumFolderCalled = true;
        return 'new-folder';
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jan Kowalski' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'new-folder');
  });
  assert.equal(createAlbumFolderCalled, true);
  const member = await firestore.getDoc<{ driveFolderId: string | null; stagingFolderId: string | null }>('members', 'ktos@gmail.com');
  assert.equal(member?.stagingFolderId, 'new-folder');
  assert.equal(member?.driveFolderId, 'approved-folder', 'driveFolderId (public, admin-owned) must never be touched by a submission');
});

test('GET /lista-wyjazdowa/profile/photo returns both null when the member has neither folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: null, stagingFolderId: null }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.public, null);
    assert.equal(body.pending, null);
  });
});

test('GET /lista-wyjazdowa/profile/photo returns public and pending independently when both folders exist', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'public-folder', stagingFolderId: 'staging-folder' }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      folderExists: async id => id === 'public-folder' || id === 'staging-folder',
      listImageFiles: async id => {
        if (id === 'public-folder') return [{ id: 'pub-main', name: '!main.jpg', thumbnailLink: 'https://example.test/pub-main=s220' }];
        if (id === 'staging-folder') return [{ id: 'stg-main', name: '!main.jpg', thumbnailLink: 'https://example.test/stg-main=s220' }];
        return [];
      },
      readTextFile: async (id, fileName) => (id === 'public-folder' && fileName === 'Opis.txt' ? 'Opis publiczny.' : null),
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.public.mainPhoto.id, 'pub-main');
    assert.equal(body.public.description, 'Opis publiczny.');
    assert.equal(body.pending.photos[0].id, 'stg-main');
  });
});

test('DELETE /lista-wyjazdowa/profile/photo returns 404 when the caller has no stagingFolderId', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: null }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      deleteFolder: async () => {
        throw new Error('should not delete anything without a staging folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

test('DELETE /lista-wyjazdowa/profile/photo returns 404 for a fileId not listed in the caller\'s own staging folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1' }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async () => [{ id: 'other-file', name: 'other.jpg', thumbnailLink: 'https://example.test/other=s220' }],
      deleteFolder: async () => {
        throw new Error('should not delete a file not in the caller\'s own staging folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

test('DELETE /lista-wyjazdowa/profile/photo deletes a file that is listed in the caller\'s own staging folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1' }));
  let deletedId = '';
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async () => [{ id: 'f1', name: 'f1.jpg', thumbnailLink: 'https://example.test/f1=s220' }],
      deleteFolder: async id => {
        deletedId = id;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(deletedId, 'f1');
});

test('DELETE /lista-wyjazdowa/profile/photo invalidates the about-us category cache (review finding: admin upload view was serving a stale cached listing)', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ stagingFolderId: 's1' }));
  const deletedFileIds = new Set<string>();
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => (name === 'upload' ? 'upload-root-cache-test' : `folder-${name}`),
      listGalleryFolders: async parentId =>
        parentId === 'upload-root-cache-test'
          ? [{ id: 's1', name: 'Ktos - ktos@gmail.com - 2026-01-01', modifiedTime: '2026-01-01T00:00:00Z' }]
          : [],
      listImageFiles: async folderId =>
        folderId === 's1' && !deletedFileIds.has('f1')
          ? [{ id: 'f1', name: 'f1.jpg', thumbnailLink: 'https://example.test/f1=s220' }]
          : [],
      readTextFile: async () => null,
      deleteFolder: async fileId => {
        deletedFileIds.add(fileId);
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const first = await fetch(`${baseUrl}/admin/people?category=upload`).then(r => r.json());
    assert.equal(first.people[0].mainPhoto?.id, 'f1');

    const del = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?fileId=f1`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    // Without invalidateAboutUsCache() in the DELETE handler, this would still return the stale
    // cached listing (f1 still present) since CATEGORY_CACHE_TTL_MS (20 min) hasn't elapsed.
    const second = await fetch(`${baseUrl}/admin/people?category=upload`).then(r => r.json());
    assert.equal(second.people[0].mainPhoto, null);
  });
});

// KRKG-0083: DELETE .../profile/photo?source=public extends self-service delete to an already-
// approved photo, previously admin-only (handleAdminDeletePhoto). The folder is always resolved
// from the member doc, never a client-supplied id - these tests mirror the staging-source ones
// above exactly, just against driveFolderId instead of stagingFolderId.

test('DELETE /lista-wyjazdowa/profile/photo?source=public returns 404 when the caller has no driveFolderId', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: null }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      deleteFolder: async () => {
        throw new Error('should not delete anything without a public folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?source=public&fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

test('DELETE /lista-wyjazdowa/profile/photo?source=public returns 404 for a fileId not listed in the caller\'s own public folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'pub-1' }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async () => [{ id: 'other-file', name: 'other.jpg', thumbnailLink: 'https://example.test/other=s220' }],
      deleteFolder: async () => {
        throw new Error('should not delete a file not in the caller\'s own public folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?source=public&fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

test('DELETE /lista-wyjazdowa/profile/photo?source=public deletes a file listed in the caller\'s own public folder and audits it as profile.person.photo.deleted', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'pub-1' }));
  let deletedId = '';
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async () => [{ id: 'f1', name: 'f1.jpg', thumbnailLink: 'https://example.test/f1=s220' }],
      deleteFolder: async id => {
        deletedId = id;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?source=public&fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(deletedId, 'f1');
  const events = await firestore.listDocs<{ action: string; resource: { key: string } }>('auditEvents');
  const event = events.find(e => e.data.action === 'profile.person.photo.deleted')!.data;
  assert.equal(event.resource.key, 'person:pub-1');
});

test('DELETE /lista-wyjazdowa/profile/photo rejects an invalid source value with 400, before touching Drive', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'pub-1', stagingFolderId: 's1' }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async () => {
        throw new Error('should not read Drive for an invalid source');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo?source=bogus&fileId=f1`, { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});

// KRKG-0083: POST .../profile/photo/main lets a member pick which of their own already-approved
// photos is "main" - self-service equivalent of the admin "Ustaw główne" action
// (handleAdminSetMainPhoto), reusing the same auditedSetMainPhoto helper and folder-membership
// check pattern as the public-delete tests above.

test('POST /lista-wyjazdowa/profile/photo/main rejects a missing fileId with 400', async () => {
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /lista-wyjazdowa/profile/photo/main returns 404 when the caller has no driveFolderId', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: null }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      renameFolder: async () => {
        throw new Error('should not rename anything without a public folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'f1' }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST /lista-wyjazdowa/profile/photo/main returns 404 for a fileId not listed in the caller\'s own public folder', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'pub-1' }));
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async () => [{ id: 'other-file', name: 'other.jpg', thumbnailLink: null }],
      renameFolder: async () => {
        throw new Error('should not rename a file not in the caller\'s own public folder');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'f1' }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST /lista-wyjazdowa/profile/photo/main prefixes the target and strips the previous main, and audits profile.person.photo.main.changed', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'pub-1' }));
  // Stateful for the same reason as the admin "Ustaw główne" tests: auditedSetMainPhoto re-lists
  // after renaming to verify the postcondition (exactly one "!"-prefixed file).
  const images = [
    { id: 'photo-1', name: '!IMG_0001.jpg', thumbnailLink: 'https://example.test/1=s220' },
    { id: 'photo-2', name: 'IMG_0002.jpg', thumbnailLink: 'https://example.test/2=s220' },
  ];
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listImageFiles: async id => (id === 'pub-1' ? images.map(image => ({ ...image })) : []),
      renameFolder: async (fileId, newName) => {
        const image = images.find(img => img.id === fileId);
        if (image) image.name = newName;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'photo-2' }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(images.find(image => image.id === 'photo-1')!.name, 'IMG_0001.jpg');
  assert.equal(images.find(image => image.id === 'photo-2')!.name, '!IMG_0002.jpg');

  const events = await firestore.listDocs<{ action: string; resource: { key: string }; actor: { email: string } }>('auditEvents');
  const event = events.find(e => e.data.action === 'profile.person.photo.main.changed')!.data;
  assert.equal(event.resource.key, 'person:pub-1');
  assert.equal(event.actor.email, 'ktos@gmail.com');
});

test('POST /lista-wyjazdowa/profile/photo/main fails the request and records a failed audited operation when the postcondition re-list finds more than one "!"-prefixed file (KRKG-0083 design review: Drive has no multi-file atomic rename, so a concurrent set-main - or a stale read - can leave the folder inconsistent even though this call\'s own rename loop succeeded)', async () => {
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'pub-1' }));
  let listCall = 0;
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      // Calls 1-2 (the handler's own membership check, then auditedSetMainPhoto's rename-loop
      // listing) see photo-2 as not yet main - consistent with a normal request. Call 3 (the
      // postcondition re-list, after the rename loop's own renameFolder calls - mocked as no-ops
      // below, since what matters here is what the NEXT list returns) sees photo-1 STILL
      // "!"-prefixed as well, simulating another writer's rename landing in between.
      listImageFiles: async () => {
        listCall += 1;
        if (listCall <= 2) return [
          { id: 'photo-1', name: '!IMG_0001.jpg', thumbnailLink: 'https://example.test/1=s220' },
          { id: 'photo-2', name: 'IMG_0002.jpg', thumbnailLink: 'https://example.test/2=s220' },
        ];
        return [
          { id: 'photo-1', name: '!IMG_0001.jpg', thumbnailLink: 'https://example.test/1=s220' },
          { id: 'photo-2', name: '!IMG_0002.jpg', thumbnailLink: 'https://example.test/2=s220' },
        ];
      },
      renameFolder: async () => {},
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile/photo/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'photo-2' }),
    });
    assert.equal(res.status, 500);
  });
  const outcomes = (await firestore.listDocs('auditOperationOutcomes')).map(doc => doc.data as { state: string });
  assert.ok(outcomes.some(o => o.state === 'failed'), 'an inconsistent postcondition must be recorded as a failed audited operation, never silently reported as success');
});

// Every "plain member" test below explicitly overrides authenticateAdminOrModerator to throw -
// makeDeps' own default resolves it as a successful admin identity (server.test.ts:167), which
// would otherwise silently take the admin/moderator code path and skip the allowlist/hidden
// checks these tests exist to exercise. Only the dedicated admin/moderator tests near the bottom
// rely on that default.

test('GET /member-profile returns basic fields, no photos, no description when the member has no driveFolderId', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({
    fullName: 'Jan Kowalski',
    nickname: 'Kowal',
    sectionId: 'sekcja-1',
    categoryId: 'kandydat',
    driveFolderId: null,
  }));
  await firestore.setDoc('lookupLists', 'sections', { items: [{ id: 'sekcja-1', label: 'Kraków', retired: false }] });
  await firestore.setDoc('lookupLists', 'categories', { items: [{ id: 'kandydat', label: 'Kandydat', retired: false }] });
  await firestore.setDoc('lookupLists', 'weapons', { items: [{ id: 'miecz', label: 'Miecz', retired: false }] });
  await firestore.setDoc('listaWyjazdowaProfile', 'ktos@gmail.com', {
    weaponIds: ['miecz'],
    companions: [],
    wpisowePaid: false,
    updatedAt: new Date().toISOString(),
    updatedBy: 'ktos@gmail.com',
  });
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fullName, 'Jan Kowalski');
    assert.equal(body.nickname, 'Kowal');
    assert.equal(body.sectionId, 'sekcja-1');
    assert.equal(body.sectionLabel, 'Kraków');
    assert.equal(body.categoryId, 'kandydat');
    assert.equal(body.categoryLabel, 'Kandydat');
    assert.deepEqual(body.weaponIds, ['miecz']);
    assert.deepEqual(body.weapons, ['Miecz']);
    assert.equal(body.mainPhoto, null);
    assert.deepEqual(body.photos, []);
    assert.equal(body.description, null);
    assert.equal(body.published, false);
    assert.deepEqual(body.pendingPhotos, []);
  });
});

test('GET /member-profile includes wpisowePaid and the current year\'s składka roczna status', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  const currentYear = new Date().getFullYear();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: null }));
  await firestore.setDoc('listaWyjazdowaProfile', 'ktos@gmail.com', {
    weaponIds: [], companions: [], wpisowePaid: true,
    updatedAt: new Date().toISOString(), updatedBy: 'ktos@gmail.com',
  });
  await firestore.setDoc('duesAnnual', `ktos@gmail.com_${currentYear}`, {
    email: 'ktos@gmail.com', year: currentYear, paid: true,
    updatedBy: 'accountant', updatedAt: new Date().toISOString(),
  });
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.wpisowePaid, true);
    assert.equal(body.duesYear, currentYear);
    assert.equal(body.duesStatus, 'paid');
  });
});

test('GET /member-profile defaults an Emeryt with no dues record for the year to duesStatus not_applicable', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'emeryt@gmail.com', seedMemberDoc({ email: 'emeryt@gmail.com', driveFolderId: null, categoryId: 'emeryt' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['emeryt@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=emeryt@gmail.com`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duesStatus, 'not_applicable');
  });
});

test('GET /member-profile defaults wpisowePaid to false and duesStatus to unpaid for a member with neither a profile nor a dues record', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['bezprofilu@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=bezprofilu@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.wpisowePaid, false);
    assert.equal(body.duesStatus, 'unpaid');
  });
});

test('GET /member-profile returns pendingPhotos alongside a published profile when both folders are set', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'public-folder', stagingFolderId: 'staging-folder' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      folderExists: async id => id === 'public-folder' || id === 'staging-folder',
      listImageFiles: async id => {
        if (id === 'public-folder') return [{ id: 'pub-main', name: '!main.jpg', thumbnailLink: 'https://example.test/pub-main=s220' }];
        if (id === 'staging-folder') return [{ id: 'stg-main', name: '!main.jpg', thumbnailLink: 'https://example.test/stg-main=s220' }];
        return [];
      },
      readTextFile: async (id, fileName) => (id === 'public-folder' && fileName === 'Opis.txt' ? 'Opis publiczny.' : null),
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.published, true);
    assert.equal(body.mainPhoto.id, 'pub-main');
    assert.equal(body.description, 'Opis publiczny.');
    assert.equal(body.pendingPhotos[0].id, 'stg-main');
  });
});

test('GET /member-profile returns photos and description when driveFolderId is under a public category', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'person-folder' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => `folder-${name}`,
      folderExists: async id => id === 'person-folder',
      getFolderParentId: async id => (id === 'person-folder' ? 'folder-Kandydaci' : null),
      listImageFiles: async id =>
        id === 'person-folder'
          ? [
              { id: 'img-main', name: '!main.jpg', thumbnailLink: 'https://example.com/main.jpg' },
              { id: 'img-2', name: '2.jpg', thumbnailLink: 'https://example.com/2.jpg' },
            ]
          : [],
      readTextFile: async (id, fileName) => (id === 'person-folder' && fileName === 'Opis.txt' ? 'Krótki opis.' : null),
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.published, true);
    assert.equal(body.description, 'Krótki opis.');
    assert.equal(body.mainPhoto.id, 'img-main');
    assert.equal(body.photos.length, 1);
    assert.equal(body.photos[0].id, 'img-2');
  });
});

test('GET /member-profile returns pendingPhotos with no description when the member only has a stagingFolderId, no driveFolderId (KRKG-0070)', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: null, stagingFolderId: 'pending-folder' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
    drive: makeFakeDrive({
      folderExists: async id => id === 'pending-folder',
      listImageFiles: async id => (id === 'pending-folder' ? [{ id: 'img-pending', name: '!main.jpg', thumbnailLink: 'https://example.com/p.jpg' }] : []),
      readTextFile: async () => {
        throw new Error('should not read a description for a non-published member');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.published, false);
    assert.equal(body.description, null);
    assert.equal(body.mainPhoto, null);
    assert.deepEqual(body.photos, []);
    assert.equal(body.pendingPhotos[0].id, 'img-pending');
  });
});

test('GET /member-profile reads no Drive images and stays unpublished when driveFolderId points at a folder that no longer exists', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ driveFolderId: 'deleted-folder' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
    drive: makeFakeDrive({
      folderExists: async () => false,
      listImageFiles: async () => {
        throw new Error('should not list images for a folder that does not exist');
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.published, false);
    assert.equal(body.mainPhoto, null);
    assert.deepEqual(body.photos, []);
  });
});

test('GET /member-profile returns a minimal profile (name from email) when the target has no members document', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['bezprofilu@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=bezprofilu@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fullName, 'bezprofilu');
    assert.equal(body.nickname, null);
    assert.equal(body.sectionLabel, null);
    assert.equal(body.categoryLabel, null);
    assert.deepEqual(body.weapons, []);
    assert.equal(body.published, false);
  });
});

test('GET /member-profile returns 404 for an email not on the active allowlist, for a plain active caller', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc());
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => [],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 404);
  });
});

test('GET /member-profile returns 404 for a hidden member when the caller is a plain active member', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ukryty@gmail.com', seedMemberDoc({ hidden: true }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ukryty@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ukryty@gmail.com`);
    assert.equal(res.status, 404);
  });
});

test('GET /member-profile rejects a plain caller who is not an active member', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ktos@gmail.com`);
    assert.equal(res.status, 403);
  });
});

// --- Admin/moderator path: relies on makeDeps' default authenticateAdminOrModerator (succeeds
// as an admin identity) and deliberately makes authenticateWojownicyUpload fail, to prove the
// admin/moderator branch never calls it - an admin/moderator need not be an active club member
// themselves, matching handleAdminListMembers's own gate (server.ts:888-895).

test('GET /member-profile returns the full profile for a suspended member when the caller is admin/moderator but not an active member', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'zawieszony@gmail.com', seedMemberDoc({ status: 'suspended', fullName: 'Zawieszony Nowak' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => [], // not on the active allowlist - must not matter for admin/moderator
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    // authenticateAdminOrModerator uses makeDeps' default (succeeds as admin@gmail.com).
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=zawieszony@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fullName, 'Zawieszony Nowak');
  });
});

test('GET /member-profile returns the full profile for a hidden member when the caller is admin/moderator but not an active member', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ukryty@gmail.com', seedMemberDoc({ hidden: true, fullName: 'Ukryty Kowalski' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => [],
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    // authenticateAdminOrModerator uses makeDeps' default (succeeds as admin@gmail.com).
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=ukryty@gmail.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fullName, 'Ukryty Kowalski');
  });
});

test('GET /member-profile returns 404 for an admin/moderator caller querying an arbitrary email with no members document', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => [],
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
    // authenticateAdminOrModerator uses makeDeps' default (succeeds as admin@gmail.com).
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=nieistnieje@gmail.com`);
    assert.equal(res.status, 404);
  });
});

test('GET /member-profile normalizes email case before comparing against the allowlist and Firestore', async () => {
  resetAboutUsBootstrapForTests();
  const firestore = createInMemoryFirestoreClient();
  await firestore.setDoc('members', 'ktos@gmail.com', seedMemberDoc({ fullName: 'Jan Kowalski' }));
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'viewer@gmail.com' }),
    authenticateAdminOrModerator: async () => {
      throw new AuthError('Brak uprawnień administracyjnych.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/member-profile?email=${encodeURIComponent('  KTOS@Gmail.com  ')}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.fullName, 'Jan Kowalski');
  });
});

test('/wojownicy-upload/photo rejects a request with no X-Submission-Token', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/photo?folderId=${uniqueFolderId()}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 401);
  });
});

test('/wojownicy-upload/photo rejects a submission token minted for a different folder', async () => {
  const deps = makeDeps();
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, 'some-other-folder');
    const res = await fetch(`${baseUrl}/wojownicy-upload/photo?folderId=${folderId}&fileName=a.jpg&mimeType=image/jpeg`, {
      method: 'POST',
      headers: { 'X-Submission-Token': token },
      body: VALID_JPEG_BYTES,
    });
    assert.equal(res.status, 403);
  });
});

test('/wojownicy-upload/photo with isMain=true uploads the file as !main.<ext>, ignoring the original filename', async () => {
  let uploadedName: string | undefined;
  const firestore = createInMemoryFirestoreClient();
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async (_f, fileName, _m, stream) => {
        uploadedName = fileName;
        for await (const _chunk of stream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(
      `${baseUrl}/wojownicy-upload/photo?folderId=${folderId}&fileName=IMG_1234.jpg&mimeType=image/jpeg&isMain=true`,
      { method: 'POST', headers: { 'X-Submission-Token': token }, body: VALID_JPEG_BYTES },
    );
    assert.equal(res.status, 200);
    assert.equal(uploadedName, '!main.jpg');
  });
  const [event] = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; after: string }> }>('auditEvents');
  assert.equal(event.data.action, 'profile.photo_submission.photo_added');
  // I4: matches profile.photo_submission.created's own final resource key shape so both halves
  // of the same submission share one resourceKey filter.
  assert.equal(event.data.resource.key, `member:ktos@gmail.com:submission:${folderId}`);
  assert.deepEqual(event.data.changes.map(change => [change.field, change.after]), [['fileId', 'fake-uploaded-file-id']]);
});

test('/wojownicy-upload/photo without isMain keeps the original filename', async () => {
  let uploadedName: string | undefined;
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'sub-1', email: 'ktos@gmail.com' }),
    drive: makeFakeDrive({
      listFiles: async () => [],
      uploadFileStream: async (_f, fileName, _m, stream) => {
        uploadedName = fileName;
        for await (const _chunk of stream) {
          // drain
        }
        return { id: 'fake-uploaded-file-id' };
      },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(
      `${baseUrl}/wojownicy-upload/photo?folderId=${folderId}&fileName=IMG_1234.jpg&mimeType=image/jpeg`,
      { method: 'POST', headers: { 'X-Submission-Token': token }, body: VALID_JPEG_BYTES },
    );
    assert.equal(res.status, 200);
    assert.equal(uploadedName, 'IMG_1234.jpg');
  });
});

// KRKG-0036 Phase 1 cutover audit: design-v2.md requires reauthAt step-up on every
// authenticateAdmin/authenticateAdminOrModerator-gated *mutation*, plus the one member-level case
// (adding photos to a gallery the caller didn't create) - "enumerate all of them in the test,
// not a sample". Every handler checks auth before touching the request body/query/any service
// (an established, consistently-followed pattern in this file, confirmed by grep against
// server.ts), so overriding just the auth dep to throw and hitting the route with no real
// payload is enough to prove which dep function actually gates it, without needing full
// realistic request bodies for all 17 routes.
const STEP_UP_GATED_ROUTES: { method: string; path: string; stepUpDep: keyof ServerDeps }[] = [
  { method: 'POST', path: '/admin/social-media/refresh', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'POST', path: '/admin/redirects', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'DELETE', path: '/admin/redirects', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/people/description', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/people/order', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/people/category', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'DELETE', path: '/admin/people', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'POST', path: '/admin/people/photo', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'DELETE', path: '/admin/people/photo', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/people/photo/main', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/people/photo/transfer', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/people/in-memoriam', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'POST', path: '/admin/settings', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'POST', path: '/delete-drive-gallery', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'POST', path: '/unregister', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'POST', path: '/gallery-photos/start', stepUpDep: 'authenticateWithStepUp' },
  { method: 'POST', path: '/admin/members/transition', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'PUT', path: '/admin/members/drive-folder', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'PUT', path: '/admin/members/profile', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'PUT', path: '/admin/members/weapons', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'POST', path: '/admin/members/synchronize', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'PUT', path: '/admin/roles', stepUpDep: 'authenticateAdminWithStepUp' },
];

// The read-only counterparts - must keep working even when the step-up variant would reject,
// proving they call the plain (non-step-up) dep and aren't accidentally over-gated.
const READ_ONLY_ROUTES_SHARING_A_ROLE: { method: string; path: string; stepUpDep: keyof ServerDeps }[] = [
  { method: 'GET', path: '/admin/whoami', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/redirects', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/people', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/settings', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/members?status=active', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/members/whoami', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/lookup-lists', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/roles', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/members/group-sync', stepUpDep: 'authenticateAdminWithStepUp' },
];

for (const { method, path, stepUpDep } of STEP_UP_GATED_ROUTES) {
  test(`${method} ${path} is gated by ${stepUpDep} (step-up required)`, async () => {
    const deps = makeDeps({
      [stepUpDep]: async () => {
        throw new AuthError('Ta czynność wymaga ponownego zalogowania.', 401);
      },
    } as Partial<ServerDeps>);
    await withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401, `expected ${method} ${path} to be rejected by ${stepUpDep}`);
    });
  });
}

for (const { method, path, stepUpDep } of READ_ONLY_ROUTES_SHARING_A_ROLE) {
  test(`${method} ${path} does not require step-up (still succeeds when ${stepUpDep} would reject)`, async () => {
    const deps = makeDeps({
      [stepUpDep]: async () => {
        throw new AuthError('Ta czynność wymaga ponownego zalogowania.', 401);
      },
    } as Partial<ServerDeps>);
    await withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.notEqual(res.status, 401, `expected ${method} ${path} to succeed via the plain (non-step-up) dep`);
    });
  });
}

// Both Lista Wyjazdowa PUTs validate the submitted sectionId/weaponIds against lookupLists
// (Firestore has no foreign keys — design.md §5), so every write test needs the lists seeded.
// 'czukcze' is seeded as retired on purpose: retired means "not offered for new selection in the
// UI", not "rejected by the server", so members already in it can still re-save.
function makeListaWyjazdowaFirestore() {
  const firestore = makeFakeFirestore();
  firestore.seed('lookupLists', 'sections', {
    items: [
      { id: 'krakow', label: 'Kraków', retired: false },
      { id: 'czukcze', label: 'Czukcze', retired: true },
    ],
  });
  firestore.seed('lookupLists', 'weapons', {
    items: [
      { id: 'tarczownik', label: 'Tarczownik', retired: false },
      { id: 'wlocznik', label: 'Włócznik', retired: false },
    ],
  });
  return firestore;
}

// PUT /lista-wyjazdowa/signups only requires memberEmail to be on the live allowlist (see
// makeDeps' listMemberEmails override) - this members/{email} document isn't required for that
// check, but several tests below still want a real fullName/sectionId on the roster for the
// target. Written straight through seed() rather than through PUT /lista-wyjazdowa/member because
// the target is usually somebody other than the test's authenticated caller, and that route only
// ever writes the caller's own record.
function seedMember(firestore: ReturnType<typeof makeListaWyjazdowaFirestore>, email: string): void {
  firestore.seed('members', email.toLowerCase(), {
    fullName: email,
    nickname: null,
    sectionId: 'krakow',
    categoryId: null,
    driveFolderId: null,
    updatedAt: '2027-01-01T00:00:00.000Z',
    updatedBy: email.toLowerCase(),
  });
}

function putListaWyjazdowa(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /lista-wyjazdowa/member returns null when the caller has no record yet', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/member`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { member: null });
  });
});

test('GET /lista-wyjazdowa/profile returns null when the caller has no profile yet', async () => {
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/profile`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { profile: null });
  });
});

test('PUT /lista-wyjazdowa/member creates the caller\'s own record, ignoring categoryId in the body', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', {
      fullName: 'Ala Kowalska',
      nickname: 'Alka',
      sectionId: 'krakow',
      categoryId: 'blacha', // must be ignored — not member-writable
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.fullName, 'Ala Kowalska');
    assert.equal(body.member.categoryId, null);
  });
});

for (const [label, body] of [
  ['a missing fullName', { sectionId: 'krakow' }],
  ['a whitespace-only fullName', { fullName: '   ', sectionId: 'krakow' }],
  ['a missing sectionId', { fullName: 'Ala Kowalska' }],
  ['a whitespace-only sectionId', { fullName: 'Ala Kowalska', sectionId: ' ' }],
  ['a non-string fullName', { fullName: 42, sectionId: 'krakow' }],
] as const) {
  test(`PUT /lista-wyjazdowa/member rejects ${label} with 400`, async () => {
    const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
    await withServer(deps, async baseUrl => {
      const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', body);
      assert.equal(res.status, 400);
    });
  });
}

test('PUT /lista-wyjazdowa/member rejects both fullName and nickname missing with 400', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { sectionId: 'krakow' });
    assert.equal(res.status, 400);
  });
});

test('PUT /lista-wyjazdowa/member backfills fullName from nickname when fullName is omitted', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', {
      nickname: 'Wilk',
      sectionId: 'krakow',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.fullName, 'Wilk');
    assert.equal(body.member.nickname, 'Wilk');
  });
});

test('PUT /lista-wyjazdowa/member does not backfill nickname from fullName when nickname is omitted', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', {
      fullName: 'Ala Kowalska',
      sectionId: 'krakow',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.fullName, 'Ala Kowalska');
    assert.equal(body.member.nickname, null);
  });
});

test('PUT /lista-wyjazdowa/member rejects a sectionId that is not in lookupLists', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', {
      fullName: 'Ala Kowalska',
      sectionId: 'atlantyda',
    });
    assert.equal(res.status, 400);
    const stored = await (await fetch(`${baseUrl}/lista-wyjazdowa/member`)).json();
    assert.equal(stored.member, null, 'a rejected write must not have been persisted');
  });
});

test('PUT /lista-wyjazdowa/member still accepts a retired section the member is already in', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', {
      fullName: 'Ala Kowalska',
      sectionId: 'czukcze',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).member.sectionId, 'czukcze');
  });
});

test('PUT /lista-wyjazdowa/member?memberEmail= requires accountant, 403 for a plain member', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member?memberEmail=inny@example.test', {
      fullName: 'Inna Osoba',
      sectionId: 'krakow',
    });
    assert.equal(res.status, 403);
  });
});

test('PUT /lista-wyjazdowa/member?memberEmail= lets an accountant edit another member, recording the accountant as updatedBy', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member?memberEmail=inny@example.test', {
      fullName: 'Inna Osoba',
      nickname: 'Inna',
      sectionId: 'krakow',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.member.fullName, 'Inna Osoba');
    assert.equal(body.member.email, 'inny@example.test');
    assert.equal(body.member.updatedBy, 'wojownik@gmail.com', 'updatedBy must be the accountant, not the edited member');
  });
});

test('GET /lista-wyjazdowa/lookup-lists returns seeded lists', async () => {
  const firestore = makeFakeFirestore();
  firestore.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/lookup-lists`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sections.length, 1);
  });
});

test('PUT /lista-wyjazdowa/profile creates the caller\'s own profile', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
      weaponIds: ['tarczownik'],
      companions: [],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.profile.weaponIds, ['tarczownik']);
    assert.equal(body.profile.wpisowePaid, false);
  });
});

// wpisowePaid is the accountant/admin-only field (design.md §7a/§9); the module-level
// "preserved on update" test would still pass if the HTTP handler started trusting the request
// body, so the ignore-the-body invariant is asserted here, at the edge that receives it.
test('PUT /lista-wyjazdowa/profile ignores wpisowePaid sent in the body', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const created = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
      weaponIds: ['tarczownik'],
      companions: [],
      wpisowePaid: true, // must be ignored — accountant/admin-only
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).profile.wpisowePaid, false);

    // ...and again on an update, where the stored value is what has to win.
    const updated = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
      weaponIds: ['wlocznik'],
      companions: [],
      wpisowePaid: true,
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).profile.wpisowePaid, false);

    const stored = await (await fetch(`${baseUrl}/lista-wyjazdowa/profile`)).json();
    assert.equal(stored.profile.wpisowePaid, false, 'the stored document must not have been flipped either');
  });
});

for (const [label, body] of [
  ['a non-array weaponIds', { weaponIds: 'tarczownik' }],
] as const) {
  test(`PUT /lista-wyjazdowa/profile rejects ${label} with 400 rather than crashing`, async () => {
    const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
    await withServer(deps, async baseUrl => {
      const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', body);
      assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    });
  });
}

test('PUT /lista-wyjazdowa/profile rejects a weaponId that is not in lookupLists', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
      weaponIds: ['tarczownik', 'miotacz-ognia'],
      companions: [],
    });
    assert.equal(res.status, 400);
    const stored = await (await fetch(`${baseUrl}/lista-wyjazdowa/profile`)).json();
    assert.equal(stored.profile, null, 'a rejected write must not have been persisted');
  });
});

// Plan B: events & sign-up routes. Same makeListaWyjazdowaFirestore()/putListaWyjazdowa() fixtures
// as Plan A's tests above. makeDeps()'s default authenticateWojownicyUpload identity is
// wojownik@gmail.com (see fakeSessionClaims's caller above) - used below as the caller/viewer.
function postListaWyjazdowa(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /lista-wyjazdowa/events creates an active event', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.event.name, 'Zjazd');
    assert.equal(body.event.status, 'active');
  });
});

test('POST /lista-wyjazdowa/events rejects a malformed startDate with 400', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '01-05-2027' });
    assert.equal(res.status, 400);
  });
});

test('GET /lista-wyjazdowa/events includes attendingCount and the caller\'s own viewerAttending', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=wojownik@gmail.com`, {
      attending: true,
      companionIds: [],
    });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/events`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.events[0].attendingCount, 1);
    assert.equal(body.events[0].viewerAttending, true, 'the test identity from makeDeps() is wojownik@gmail.com — see fakeSessionClaims');
  });
});

test('PUT /lista-wyjazdowa/events?eventId= updates only the given fields', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { status: 'cancelled' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.event.status, 'cancelled');
    assert.equal(body.event.name, 'Zjazd');
  });
});

test('PUT /lista-wyjazdowa/events?eventId= returns 404 for an unknown event', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events?eventId=nope', { status: 'cancelled' });
    assert.equal(res.status, 404);
  });
});

test('PUT /lista-wyjazdowa/signups accepts open-edit by a different member and records canonical evidence', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'inny@example.test');
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com', 'inny@example.test'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=inny@example.test`,
      { attending: true, companionIds: [] },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signup.memberEmail, 'inny@example.test');
    assert.equal(body.signup.lastChangedBy, 'wojownik@gmail.com', 'lastChangedBy reflects the caller, not the target member');

    const [audit] = await firestore.listDocs<{ action: string; actor: { email: string }; resource: { key: string } }>('auditEvents');
    assert.equal(audit.data.action, 'event.created');
    const signupAudit = (await firestore.listDocs<{ action: string; actor: { email: string }; resource: { key: string } }>('auditEvents'))
      .find(entry => entry.data.action === 'signup.created');
    assert.equal(signupAudit?.data.actor.email, 'wojownik@gmail.com');
    assert.equal(signupAudit?.data.resource.key, `signup:${created.event.id}:inny@example.test`);
  });
});

test('GET /lista-wyjazdowa/event-equipment joins all equipment with per-event going state', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('equipment', 'tent-1', {
    id: 'tent-1', categoryId: 'tent', sectionId: 'krakow', belongsToPersonId: null,
    description: 'Duży namiot', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'ala@example.test',
  });
  firestore.seed('equipment', 'shelter-1', {
    id: 'shelter-1', categoryId: 'shelter', sectionId: 'warszawa', belongsToPersonId: null,
    description: '', createdAt: '2026-01-02T00:00:00.000Z', createdBy: 'ala@example.test',
  });
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const write = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/event-equipment?eventId=${created.event.id}&equipmentId=tent-1`,
      { going: true },
    );
    assert.equal(write.status, 200);

    const response = await fetch(`${baseUrl}/lista-wyjazdowa/event-equipment?eventId=${created.event.id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.items.find((item: { id: string }) => item.id === 'tent-1').going, true);
    assert.equal(body.items.find((item: { id: string }) => item.id === 'shelter-1').going, false);

    const evidence = await firestore.listDocs<{ action: string; eventId?: string; resource: { key: string } }>('auditEvents');
    const toggleAudit = evidence.find(entry => entry.data.action === 'equipment.event_going.changed');
    assert.equal(toggleAudit?.data.eventId, created.event.id);
    assert.equal(toggleAudit?.data.resource.key, `eventEquipment:${created.event.id}:tent-1`);
  });
});

test('PUT /lista-wyjazdowa/event-equipment rejects an unknown event without persisting state', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const response = await putListaWyjazdowa(
      baseUrl,
      '/lista-wyjazdowa/event-equipment?eventId=missing&equipmentId=tent-1',
      { going: true },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await firestore.listDocs('eventEquipment'), []);
  });
});

// Open-edit lets any member sign up any *other* member, but not an address that is nobody: such a
// signup is counted by attendingCount on the events list yet invisible to the roster/per-section
// breakdown on the event page, leaving the two pages disagreeing about the attendee total.
test('PUT /lista-wyjazdowa/signups returns 404 for a memberEmail not on the allowlist, and persists nothing', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=nikt@example.test`,
      { attending: true, companionIds: [] },
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'Nie znaleziono takiego członka.');

    const stored = await (await fetch(`${baseUrl}/lista-wyjazdowa/signups?eventId=${created.event.id}`)).json();
    assert.deepEqual(stored.signups, [], 'a rejected signup must not have been persisted');

    const events = await (await fetch(`${baseUrl}/lista-wyjazdowa/events`)).json();
    assert.equal(events.events[0].attendingCount, 0, 'and must not be counted towards the event total');
  });
});

// The fix for "can't sign up a member who never opened Mój profil": the gate used to require a
// members/{email} document (getMember), which such a member has never created. It now checks the
// live allowlist instead - the same one GET /lista-wyjazdowa/roster enumerates - so a real club
// member with no document at all can still be marked attending.
test('PUT /lista-wyjazdowa/signups succeeds for an allowlisted member with no members document', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com', 'bezdokumentu@example.test'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=bezdokumentu@example.test`,
      { attending: true, companionIds: [] },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signup.memberEmail, 'bezdokumentu@example.test');
    assert.equal(body.signup.attending, true);
  });
});

test('GET /lista-wyjazdowa/roster joins members with their listaWyjazdowaProfile', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore(), listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Ala Kowalska', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: ['tarczownik'] });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/roster`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roster.length, 1);
    assert.equal(body.roster[0].fullName, 'Ala Kowalska');
    assert.deepEqual(body.roster[0].weaponIds, ['tarczownik']);
  });
});

// KRKG-0087: a person without an account is a roster row of its own, keyed by personId and with no
// e-mail - the event page needs them next to members so their own "jadę / nie jadę" and składka
// are visible, and so the summary can count them by section, weapon and category.
test('GET /lista-wyjazdowa/roster unions members with people who have no account', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  firestore.seed('persons', 'person-uuid-1', {
    personId: 'person-uuid-1', ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: ['tarczownik'],
    ownerPersonId: 'wojownik@gmail.com', email: null, deletedAt: null,
    createdAt: 'x', createdBy: 'x',
  });

  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/roster`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roster.length, 2);

    const member = body.roster.find((r: { personId: string }) => r.personId === 'wojownik@gmail.com');
    assert.equal(member.accountless, false);
    assert.equal(member.email, 'wojownik@gmail.com');

    const person = body.roster.find((r: { personId: string }) => r.personId === 'person-uuid-1');
    assert.equal(person.accountless, true, 'a person without an account must be flagged');
    assert.equal(person.email, null, 'a person without an account has no e-mail');
    assert.equal(person.fullName, 'Jan Kowalski');
    // KRKG-0087: the separate name parts are exposed too, so Mój profil can edit them individually.
    assert.equal(person.firstName, 'Jan');
    assert.equal(person.lastName, 'Kowalski');
    assert.equal(person.nickname, 'Wilk');
    assert.equal(person.ownerPersonId, 'wojownik@gmail.com');
    assert.deepEqual(person.weaponIds, ['tarczownik']);
    assert.equal(person.categoryId, 'thing');
    assert.equal(person.sectionId, 'krakow');
  });
});

test('GET /lista-wyjazdowa/roster omits tombstoned people', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('persons', 'person-uuid-2', {
    personId: 'person-uuid-2', ksywka: 'Cień', firstName: '', lastName: '',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: [],
    ownerPersonId: null, email: null, deletedAt: '2027-01-01T00:00:00.000Z',
    createdAt: 'x', createdBy: 'x',
  });

  const deps = makeDeps({ firestore, listMemberEmails: async () => [] });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    assert.deepEqual(body.roster, [], 'a tombstoned person must not appear on the current roster');
  });
});

// KRKG-0087: the profile drawer is keyed by e-mail for a member; a person without an account has
// none, so their drawer reads this person-keyed endpoint instead. Same public fields, read-only.
test('GET /lista-wyjazdowa/person-profile returns an accountless person and 404s a tombstone', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('persons', 'person-uuid-1', {
    personId: 'person-uuid-1', ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: ['tarczownik'],
    ownerPersonId: 'wojownik@gmail.com', email: null, deletedAt: null,
    createdAt: 'x', createdBy: 'x',
  });
  // KRKG-0089: the owner's display name is shown in the drawer.
  firestore.seed('members', 'wojownik@gmail.com', {
    fullName: 'Adam Król', nickname: 'Kruk', sectionId: 'krakow', categoryId: 'thing',
    driveFolderId: null, updatedAt: 'x', updatedBy: 'x',
  });
  firestore.seed('persons', 'person-gone', {
    personId: 'person-gone', ksywka: 'Cień', firstName: '', lastName: '',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: [],
    ownerPersonId: null, email: null, deletedAt: '2027-01-01T00:00:00.000Z',
    createdAt: 'x', createdBy: 'x',
  });

  const deps = makeDeps({ firestore, listMemberEmails: async () => [] });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/person-profile?personId=person-uuid-1`);
    assert.equal(res.status, 200);
    const { profile } = await res.json();
    assert.equal(profile.accountless, true);
    assert.equal(profile.fullName, 'Jan Kowalski');
    assert.equal(profile.nickname, 'Wilk');
    assert.equal(profile.sectionId, 'krakow');
    assert.equal(profile.categoryId, 'thing');
    assert.deepEqual(profile.weaponIds, ['tarczownik']);
    assert.equal(profile.ownerPersonId, 'wojownik@gmail.com');
    assert.equal(profile.ownerName, 'Kruk', "the owner's nickname is shown in the drawer");
    assert.equal(profile.mainPhoto, null);
    assert.deepEqual(profile.photos, []);

    assert.equal((await fetch(`${baseUrl}/lista-wyjazdowa/person-profile?personId=person-gone`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/lista-wyjazdowa/person-profile?personId=nope`)).status, 404);
  });
});

// KRKG-0087: the event-scoped read is the historical one. A person who has left the club must still
// appear on a trip they were signed up for, or that past trip's summary and audit would change.
test('GET /lista-wyjazdowa/roster?eventId= keeps a tombstoned person who signed up for that trip', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('persons', 'person-uuid-3', {
    personId: 'person-uuid-3', ksywka: 'Cień', firstName: 'Jan', lastName: 'Kowalski',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: [],
    ownerPersonId: null, email: null, deletedAt: '2027-01-01T00:00:00.000Z',
    createdAt: 'x', createdBy: 'x',
  });
  firestore.seed('signups', 'event-1_person-uuid-3', {
    eventId: 'event-1', memberEmail: 'person-uuid-3', attending: true, skladkaPaid: false,
  });

  const deps = makeDeps({ firestore, listMemberEmails: async () => [] });
  await withServer(deps, async baseUrl => {
    const historical = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster?eventId=event-1`)).json();
    assert.equal(historical.roster.length, 1, 'the removed person must still count on the trip they attended');
    assert.equal(historical.roster[0].personId, 'person-uuid-3');
    assert.equal(historical.roster[0].accountless, true);
    assert.equal(historical.roster[0].fullName, 'Jan Kowalski');
  });
});

test('GET /lista-wyjazdowa/roster?eventId= returns the live roster plus the eligible tombstone with its dues', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const duesYear = new Date().getFullYear();
  firestore.seed('persons', 'person-live', {
    personId: 'person-live', ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: ['tarczownik'],
    ownerPersonId: null, email: null, deletedAt: null, createdAt: 'x', createdBy: 'x',
  });
  firestore.seed('persons', 'person-gone', {
    personId: 'person-gone', ksywka: 'Cień', firstName: 'Anna', lastName: 'Nowak',
    categoryId: 'emeryt', sectionId: 'warszawa', weaponIds: [],
    ownerPersonId: null, email: null, deletedAt: '2027-01-01T00:00:00.000Z', createdAt: 'x', createdBy: 'x',
  });
  firestore.seed('signups', 'event-1_person-gone', {
    eventId: 'event-1', memberEmail: 'person-gone', attending: true, skladkaPaid: false,
  });
  firestore.seed('duesAnnual', `person-gone_${duesYear}`, { email: 'person-gone', year: duesYear, status: 'paid' });

  const deps = makeDeps({ firestore, listMemberEmails: async () => [] });
  await withServer(deps, async baseUrl => {
    const historical = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster?eventId=event-1`)).json();
    assert.equal(historical.roster.length, 2, 'the historical roster is the live roster plus the eligible tombstone');

    const live = historical.roster.find((r: { personId: string }) => r.personId === 'person-live');
    assert.ok(live, 'a live accountless person must stay on the event roster');
    assert.equal(live.accountless, true);
    assert.deepEqual(live.weaponIds, ['tarczownik']);

    const gone = historical.roster.find((r: { personId: string }) => r.personId === 'person-gone');
    assert.ok(gone, 'the tombstoned person signed up for this trip must be kept');
    assert.equal(gone.fullName, 'Anna Nowak');
    assert.equal(gone.nickname, 'Cień');
    assert.equal(gone.sectionId, 'warszawa');
    assert.equal(gone.categoryId, 'emeryt');
    assert.equal(gone.duesStatus, 'paid', 'the tombstone keeps its stored due state');
  });
});

test('GET /lista-wyjazdowa/roster?eventId= still omits a tombstoned person with no signup on that trip', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('persons', 'person-uuid-4', {
    personId: 'person-uuid-4', ksywka: 'Cień', firstName: '', lastName: '',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: [],
    ownerPersonId: null, email: null, deletedAt: '2027-01-01T00:00:00.000Z',
    createdAt: 'x', createdBy: 'x',
  });
  firestore.seed('signups', 'event-2_person-uuid-4', {
    eventId: 'event-2', memberEmail: 'person-uuid-4', attending: true, skladkaPaid: false,
  });

  const deps = makeDeps({ firestore, listMemberEmails: async () => [] });
  await withServer(deps, async baseUrl => {
    const historical = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster?eventId=event-1`)).json();
    assert.deepEqual(historical.roster, [], 'a tombstoned person belongs only to the trips they attended');
  });
});

// KRKG-0087: the accountless-person record routes. Staff (admin/moderator/accountant) manage any
// person; a plain member only their own attached person; merging with an account is admin-only.
const personBody = {
  ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski',
  categoryId: 'thing', sectionId: 'krakow', weaponIds: ['tarczownik'],
};

function jsonRequest(baseUrl: string, method: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A plain member (no staff role): both staff authorizers reject. */
function memberDeps(firestore: ReturnType<typeof makeListaWyjazdowaFirestore>, email: string): ServerDeps {
  return makeDeps({
    firestore,
    listMemberEmails: async () => [email.toLowerCase()],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'w1', email }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
}

function seedEvent(firestore: ReturnType<typeof makeListaWyjazdowaFirestore>, eventId: string): void {
  firestore.seed('events', eventId, { name: 'Wolin', startDate: '2026-01-01', status: 'active' });
}

function seedPerson(
  firestore: ReturnType<typeof makeListaWyjazdowaFirestore>,
  personId: string,
  ownerPersonId: string | null,
): void {
  firestore.seed('persons', personId, {
    personId, ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski',
    categoryId: 'thing', sectionId: 'krakow', weaponIds: ['tarczownik'],
    ownerPersonId, email: null, deletedAt: null, createdAt: 'x', createdBy: 'x',
  });
}

test('POST /lista-wyjazdowa/persons lets a moderator create a person for anyone and audits it', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/persons', { ...personBody, ownerPersonId: 'wojownik@gmail.com' });
    assert.equal(res.status, 201);
    const { person } = await res.json();
    assert.equal(person.ownerPersonId, 'wojownik@gmail.com');
    assert.equal(person.categoryId, 'thing');
    assert.ok((await firestore.listDocs<{ action?: string }>('auditEvents')).some((d) => d.data.action === 'person.created'));
  });
});

test('POST /lista-wyjazdowa/persons lets a member create their own person but not an unowned or foreign one', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = memberDeps(firestore, 'wojownik@gmail.com');
  await withServer(deps, async baseUrl => {
    const own = await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/persons', { ...personBody, ownerPersonId: 'Wojownik@Gmail.com' });
    assert.equal(own.status, 201, 'the owner may attach a person to themselves (case-insensitive)');

    assert.equal((await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/persons', personBody)).status, 403, 'a member may not create an unowned person');
    assert.equal(
      (await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/persons', { ...personBody, ownerPersonId: 'ktos@gmail.com' })).status,
      403,
      'a member may not attach a person to someone else',
    );
    assert.equal((await firestore.listDocs('persons')).length, 1, 'the denied requests must not have created anything');
  });
});

test('PUT /lista-wyjazdowa/persons lets the owner edit their own person, clears weapons for Niewiasta, and rejects a stranger', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    const res = await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons', {
      personId: 'p1', ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski',
      categoryId: 'niewiasta', sectionId: 'krakow', weaponIds: ['tarczownik'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).person.weaponIds, [], 'switching to Niewiasta must clear the weapon');
    assert.ok((await firestore.listDocs<{ action?: string }>('auditEvents')).some((d) => d.data.action === 'person.updated'));
  });
  await withServer(memberDeps(firestore, 'ktos@gmail.com'), async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons', { personId: 'p1', ...personBody })).status, 403);
  });
});

test('DELETE /lista-wyjazdowa/persons tombstones the owner\'s person, detaches it and audits it', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    const res = await jsonRequest(baseUrl, 'DELETE', '/lista-wyjazdowa/persons', { personId: 'p1' });
    assert.equal(res.status, 200);
    const { person } = await res.json();
    assert.ok(person.deletedAt, 'delete must tombstone, not remove');
    assert.equal(person.ownerPersonId, null, 'a deactivated person is detached from its owner');
    assert.ok((await firestore.listDocs<{ action?: string }>('auditEvents')).some((d) => d.data.action === 'person.deleted'));
  });
});

// KRKG-0091: staff-only listing of every person including deactivated ones, so Zarządzanie ludźmi
// can show and permanently remove them.
test('GET /lista-wyjazdowa/persons is staff-only and lists deactivated people with their owner name', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('members', 'wojownik@gmail.com', {
    fullName: 'Adam Król', nickname: 'Kruk', sectionId: 'krakow', categoryId: 'thing',
    driveFolderId: null, updatedAt: 'x', updatedBy: 'x',
  });
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  firestore.seed('persons', 'p2', {
    personId: 'p2', ksywka: 'Cień', firstName: '', lastName: '', categoryId: 'thing',
    sectionId: 'krakow', weaponIds: [], ownerPersonId: null, email: null,
    deletedAt: '2027-01-01T00:00:00.000Z', createdAt: 'x', createdBy: 'x',
  });

  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/lista-wyjazdowa/persons`)).status, 403, 'a plain member cannot list people');
  });

  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/lista-wyjazdowa/persons`)).json();
    const live = body.persons.find((p: { personId: string }) => p.personId === 'p1');
    const gone = body.persons.find((p: { personId: string }) => p.personId === 'p2');
    assert.equal(live.deleted, false);
    assert.equal(live.ownerName, 'Kruk');
    assert.equal(gone.deleted, true);
    assert.ok(gone.deletedAt);
  });
});

test('DELETE /lista-wyjazdowa/persons/permanent purges the person, profile, signups and dues', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedEvent(firestore, 'event-1');
  seedPerson(firestore, 'p1', null);
  firestore.seed('listaWyjazdowaProfile', 'p1', { email: 'p1', weaponIds: [], wpisowePaid: false });
  firestore.seed('signups', 'event-1_p1', { eventId: 'event-1', memberEmail: 'p1', attending: true, skladkaPaid: false });
  firestore.seed('duesAnnual', 'p1_2027', { email: 'p1', year: 2027, status: 'paid' });

  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await jsonRequest(baseUrl, 'DELETE', '/lista-wyjazdowa/persons/permanent', { personId: 'p1' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { personId: 'p1', deletedSignups: 1, deletedDues: 1 });
    assert.equal((await firestore.listDocs('persons')).length, 0, 'the person record is gone');
    assert.equal((await firestore.listDocs('signups')).length, 0, 'their signups are gone (past-trip counts change)');
    assert.equal((await firestore.listDocs('duesAnnual')).length, 0, 'their dues are gone');
    assert.equal((await firestore.listDocs('listaWyjazdowaProfile')).length, 0, 'their profile is gone');
    assert.ok((await firestore.listDocs<{ action?: string }>('auditEvents')).some((d) => d.data.action === 'person.purged'));
  });
});

test('DELETE /lista-wyjazdowa/persons/permanent is staff-only and 404s an unknown person', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'DELETE', '/lista-wyjazdowa/persons/permanent', { personId: 'p1' })).status, 403);
    assert.ok(await firestore.getDoc('persons', 'p1'), 'a denied purge must not remove the person');
  });
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
  });
  await withServer(deps, async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'DELETE', '/lista-wyjazdowa/persons/permanent', { personId: 'nie-ma' })).status, 404);
  });
});

test('PUT /lista-wyjazdowa/persons/owner detaches and requires ownerPersonId null', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/owner', { personId: 'p1', ownerPersonId: 'ktos' })).status, 400);
    const res = await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/owner', { personId: 'p1', ownerPersonId: null });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).person.ownerPersonId, null);
    assert.ok((await firestore.listDocs<{ action?: string }>('auditEvents')).some((d) => d.data.action === 'person.detached'));
  });
});

test('PUT /lista-wyjazdowa/persons/account merges for an admin, rejects a moderator, and refuses a second merge', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  seedMember(firestore, 'nowak@gmail.com');
  firestore.seed('signups', 'event-1_p1', { eventId: 'event-1', memberEmail: 'p1', attending: true, skladkaPaid: false });

  const moderator = makeDeps({ firestore, authenticateAdminWithStepUp: async () => { throw new AuthError('Brak uprawnień.', 403); } });
  await withServer(moderator, async baseUrl => {
    assert.equal(
      (await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/account', { personId: 'p1', accountEmail: 'nowak@gmail.com' })).status,
      403,
      'only an administrator may merge',
    );
  });

  await withServer(makeDeps({ firestore }), async baseUrl => {
    const res = await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/account', { personId: 'p1', accountEmail: 'Nowak@Gmail.com' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).person.mergedInto, 'nowak@gmail.com');

    const events = await firestore.listDocs<{ action?: string; changes?: Array<{ field: string; after?: unknown }> }>('auditEvents');
    const merged = events.find((d) => d.data.action === 'person.merged');
    assert.ok(merged, 'the merge must be audited');
    assert.equal(merged?.data.changes?.find((c) => c.field === 'movedSignups')?.after, 1, 'the audit must record the documents it moved');
    assert.equal(merged?.data.changes?.find((c) => c.field === 'ownerPersonId')?.after, null);

    assert.equal(
      (await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/account', { personId: 'p1', accountEmail: 'nowak@gmail.com' })).status,
      409,
      'a second merge must be refused',
    );
  });
});

test('PUT /lista-wyjazdowa/persons/account refuses to merge a deactivated person', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('persons', 'p-del', {
    personId: 'p-del', ksywka: 'Cień', firstName: '', lastName: '', categoryId: 'thing',
    sectionId: 'krakow', weaponIds: [], ownerPersonId: null, email: null,
    deletedAt: '2027-01-01T00:00:00.000Z', createdAt: 'x', createdBy: 'x',
  });
  seedMember(firestore, 'nowak@gmail.com');
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const res = await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/account', { personId: 'p-del', accountEmail: 'nowak@gmail.com' });
    assert.equal(res.status, 409, 'a deactivated person cannot be merged');
    const stored = await firestore.getDoc<{ mergedInto?: string }>('persons', 'p-del');
    assert.equal(stored?.mergedInto ?? null, null, 'the deactivated person is left untouched');
  });
});

test('an accountant is staff on the person routes', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('userRoles', 'ksiegowa@example.com', { roles: ['accountant'] });
  const deps = makeDeps({
    firestore,
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'k1', email: 'ksiegowa@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await withServer(deps, async baseUrl => {
    const res = await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/persons', { ...personBody, ownerPersonId: 'wojownik@gmail.com' });
    assert.equal(res.status, 201, 'an accountant may create a person for anyone');
  });
});

test('DELETE /persons and PUT /persons/owner reject a non-owner non-staff caller without mutating', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'ktos@gmail.com'), async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'DELETE', '/lista-wyjazdowa/persons', { personId: 'p1' })).status, 403);
    assert.equal((await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/owner', { personId: 'p1', ownerPersonId: null })).status, 403);
    const stored = await firestore.getDoc<{ deletedAt?: string | null; ownerPersonId?: string | null }>('persons', 'p1');
    assert.equal(stored?.deletedAt ?? null, null, 'a denied delete must not tombstone');
    assert.equal(stored?.ownerPersonId, 'wojownik@gmail.com', 'a denied detach must not change the owner');
  });
});

test('person routes return 404 for an unknown person', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore }), async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons', { personId: 'nie-ma', ...personBody })).status, 404);
    assert.equal((await jsonRequest(baseUrl, 'DELETE', '/lista-wyjazdowa/persons', { personId: 'nie-ma' })).status, 404);
    assert.equal((await jsonRequest(baseUrl, 'PUT', '/lista-wyjazdowa/persons/account', { personId: 'nie-ma', accountEmail: 'a@b.test' })).status, 404);
  });
});

test('POST /lista-wyjazdowa/signups/quick-add mode=new creates an attached person and signs them up in one transaction', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedEvent(firestore, 'event-1');
  // KRKG-0089 regression guard: real Firestore rejects a read after the first write in a
  // transaction. The in-memory fake does not enforce that, so this wraps it to do so - quick-add
  // must write the signup (which reads first) before the write-only person, or this throws.
  const guarded = {
    ...firestore,
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => firestore.runTransaction(async tx => {
      let wrote = false;
      const guardedTx = {
        getDoc: async (collection: string, id: string) => {
          if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          return tx.getDoc(collection, id);
        },
        setDoc: async (collection: string, id: string, data: object) => { wrote = true; return tx.setDoc(collection, id, data); },
        createDoc: async (collection: string, id: string, data: object) => { wrote = true; return tx.createDoc(collection, id, data); },
        deleteDoc: async (collection: string, id: string) => { wrote = true; return tx.deleteDoc(collection, id); },
      };
      return fn(guardedTx);
    }),
  } as unknown as typeof firestore;
  await withServer(memberDeps(guarded, 'wojownik@gmail.com'), async baseUrl => {
    const res = await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', {
      eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'new', ksywka: 'Wilk', categoryId: 'thing',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.person.ownerPersonId, 'wojownik@gmail.com');
    assert.equal(body.person.sectionId, 'krakow', 'the new person inherits the owner section');
    assert.equal(body.person.email, null, 'a quick-added person has no account');
    assert.equal(body.signup.attending, true, 'quick-add signs the person up right away');

    const events = await firestore.listDocs<{ action?: string }>('auditEvents');
    assert.ok(events.some((d) => d.data.action === 'person.created'));
    assert.ok(events.some((d) => d.data.action === 'signup.created'));
  });
});

test('POST /lista-wyjazdowa/signups/quick-add mode=existing signs up an attached person and is idempotent', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedEvent(firestore, 'event-1');
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    const body = { eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'existing', personId: 'p1' };
    const first = await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', body);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).signup.attending, true);

    const second = await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', body);
    assert.equal(second.status, 200, 'a repeat call must not fail');
    assert.equal((await firestore.listDocs('signups')).length, 1, 'a repeat call must not duplicate the signup');
  });
});

test('POST /lista-wyjazdowa/signups/quick-add enforces the owner and attachment rules', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedMember(firestore, 'ktos@gmail.com');
  seedEvent(firestore, 'event-1');
  seedPerson(firestore, 'p1', 'ktos@gmail.com');
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['wojownik@gmail.com', 'ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'w1', email: 'wojownik@gmail.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await withServer(deps, async baseUrl => {
    assert.equal(
      (await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', { eventId: 'event-1', ownerPersonId: 'ktos@gmail.com', mode: 'new', ksywka: 'X', categoryId: 'thing' })).status,
      403,
      'a member may not quick-add for someone else',
    );
    assert.equal(
      (await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', { eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'existing', personId: 'p1' })).status,
      403,
      'the existing person must be attached to the given owner',
    );
    assert.equal((await firestore.listDocs('signups')).length, 0, 'denied calls must not sign anyone up');
  });
});

test('POST /lista-wyjazdowa/signups/quick-add validates mode and event', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    assert.equal(
      (await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', { eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'bogus' })).status,
      400,
    );
    assert.equal(
      (await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', { eventId: 'nie-ma', ownerPersonId: 'wojownik@gmail.com', mode: 'new', ksywka: 'X', categoryId: 'thing' })).status,
      404,
    );
  });
});

test('POST /lista-wyjazdowa/signups/quick-add returns 400/404 for the remaining validation paths', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedEvent(firestore, 'event-1');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    const post = (body: unknown) => jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', body);
    assert.equal((await post({ eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'new', categoryId: 'thing' })).status, 400, 'ksywka is required');
    assert.equal((await post({ eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'new', ksywka: 'Wilk' })).status, 400, 'category is required');
    assert.equal((await post({ eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'existing', personId: 'nie-ma' })).status, 404, 'unknown person');
  });
});

test('POST /lista-wyjazdowa/signups/quick-add rejects an owner that is not an account, and an owner without a section', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  firestore.seed('members', 'bezsekcji@gmail.com', { fullName: 'B', nickname: null, sectionId: '', categoryId: null });
  seedEvent(firestore, 'event-1');
  seedPerson(firestore, 'p1', null);
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com', 'bezsekcji@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const post = (body: unknown) => jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', body);
    assert.equal(
      (await post({ eventId: 'event-1', ownerPersonId: 'p1', mode: 'new', ksywka: 'Wilk', categoryId: 'thing' })).status,
      400,
      'an accountless person cannot own anyone',
    );
    assert.equal(
      (await post({ eventId: 'event-1', ownerPersonId: 'bezsekcji@gmail.com', mode: 'new', ksywka: 'Wilk', categoryId: 'thing' })).status,
      400,
      'the new person needs a section to inherit',
    );
  });
});

test('POST /lista-wyjazdowa/signups/quick-add lets staff quick-add for someone else', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'ktos@gmail.com');
  seedEvent(firestore, 'event-1');
  firestore.seed('userRoles', 'ksiegowa@example.com', { roles: ['accountant'] });
  const request = { eventId: 'event-1', ownerPersonId: 'ktos@gmail.com', mode: 'new', ksywka: 'Wilk', categoryId: 'thing' };
  const run = (deps: ServerDeps) => withServer(deps, async baseUrl => {
    assert.equal((await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', request)).status, 201);
  });

  await run(makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@example.com' }),
  }));
  await run(makeDeps({
    firestore,
    listMemberEmails: async () => ['ktos@gmail.com'],
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'k1', email: 'ksiegowa@example.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  }));
  await run(makeDeps({ firestore, listMemberEmails: async () => ['ktos@gmail.com'] }));
});

test('POST /lista-wyjazdowa/signups/quick-add mode=existing audits signup.created then signup.updated', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedEvent(firestore, 'event-1');
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  await withServer(memberDeps(firestore, 'wojownik@gmail.com'), async baseUrl => {
    const body = { eventId: 'event-1', ownerPersonId: 'wojownik@gmail.com', mode: 'existing', personId: 'p1' };
    await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', body);
    await jsonRequest(baseUrl, 'POST', '/lista-wyjazdowa/signups/quick-add', body);
    const actions = (await firestore.listDocs<{ action?: string }>('auditEvents')).map((d) => d.data.action);
    assert.equal(actions.filter((a) => a === 'signup.created').length, 1, 'the first call creates');
    assert.equal(actions.filter((a) => a === 'signup.updated').length, 1, 'the repeat updates rather than creating again');
  });
});

// KRKG-0087: the existing write routes now take a personId, which for a member is their e-mail and
// for an accountless person is their UUID. A tombstoned person is not a writable target.
test('existing write routes accept an accountless personId and reject a tombstoned one', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedEvent(firestore, 'event-1');
  seedPerson(firestore, 'p1', 'wojownik@gmail.com');
  firestore.seed('persons', 'p2', {
    personId: 'p2', ksywka: 'Cień', firstName: '', lastName: '', categoryId: 'thing', sectionId: 'krakow',
    weaponIds: [], ownerPersonId: null, email: null, deletedAt: '2027-01-01T00:00:00.000Z', createdAt: 'x', createdBy: 'x',
  });
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const signup = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/signups?eventId=event-1&personId=p1', { attending: true });
    assert.equal(signup.status, 200);
    assert.equal((await signup.json()).signup.memberEmail, 'p1', 'a person signup is keyed by their personId');

    assert.equal((await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=p1', { paid: true })).status, 200);
    assert.equal((await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=p1&year=2027', { status: 'paid' })).status, 200);

    assert.equal(
      (await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/signups?eventId=event-1&personId=p2', { attending: true })).status,
      404,
      'a tombstoned person is not a writable target',
    );

    const events = await firestore.listDocs<{ resource?: { key?: string } }>('auditEvents');
    assert.ok(events.some((d) => d.data.resource?.key === 'signup:event-1:p1'));
    assert.ok(events.some((d) => d.data.resource?.key === 'due:p1'));
  });
});

test('existing write routes reject a merged person\'s retired UUID', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  seedMember(firestore, 'nowak@gmail.com');
  seedEvent(firestore, 'event-1');
  firestore.seed('persons', 'p-merged', {
    personId: 'p-merged', ksywka: 'Jan', firstName: 'Jan', lastName: 'Kowalski', categoryId: 'thing', sectionId: 'krakow',
    weaponIds: [], ownerPersonId: null, email: 'nowak@gmail.com', deletedAt: '2027-01-01T00:00:00.000Z',
    mergedInto: 'nowak@gmail.com', createdAt: 'x', createdBy: 'x',
  });
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com', 'nowak@gmail.com'] });
  await withServer(deps, async baseUrl => {
    assert.equal(
      (await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/signups?eventId=event-1&personId=p-merged', { attending: true })).status,
      404,
    );
    assert.equal((await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/signups/skladka?eventId=event-1&personId=p-merged', { paid: true })).status, 404);
    assert.equal((await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=p-merged', { paid: true })).status, 404);
    assert.equal((await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=p-merged&year=2027', { status: 'paid' })).status, 404);
    assert.deepEqual(await firestore.listDocs('signups'), [], 'no signup may be written for a retired UUID');
    assert.deepEqual(await firestore.listDocs('duesAnnual'), [], 'no dues may be written for a retired UUID');
  });
});

// KRKG-0074: the event page's roster badge needs the current year's składka roczna status per
// member - stored record wins, an Emeryt without one defaults to not_applicable, everyone else
// without one defaults to unpaid (same effectiveDuesStatus contract as GET /member-profile).
test('GET /lista-wyjazdowa/roster includes the current year\'s składka roczna status per member', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const year = new Date().getFullYear();
  seedMember(firestore, 'wojownik@gmail.com');
  firestore.seed('members', 'emeryt@example.test', {
    fullName: 'Emeryt', nickname: null, sectionId: 'krakow', categoryId: 'emeryt',
    driveFolderId: null, updatedAt: '2027-01-01T00:00:00.000Z', updatedBy: 'x',
  });
  firestore.seed('duesAnnual', `wojownik@gmail.com_${year}`, {
    email: 'wojownik@gmail.com', year, status: 'paid', updatedBy: 'x', updatedAt: 'x',
  });
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['wojownik@gmail.com', 'emeryt@example.test', 'bezprofilu@example.test'],
  });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    const byEmail = new Map<string, { duesStatus: string }>(
      body.roster.map((r: { email: string; duesStatus: string }) => [r.email, r]),
    );
    assert.equal(byEmail.get('wojownik@gmail.com')?.duesStatus, 'paid');
    assert.equal(byEmail.get('emeryt@example.test')?.duesStatus, 'not_applicable');
    assert.equal(byEmail.get('bezprofilu@example.test')?.duesStatus, 'unpaid');
  });
});

// The roster now enumerates the live allowlist (like GET /members/directory), not just
// members/{email} docs - a club member who never opened "Mój profil" must still get a row so the
// event page's "Wszyscy" filter can offer them an attending checkbox.
test('GET /lista-wyjazdowa/roster includes allowlisted members with no members/{email} document', async () => {
  const deps = makeDeps({
    firestore: makeListaWyjazdowaFirestore(),
    listMemberEmails: async () => ['wojownik@gmail.com', 'bezprofilu@example.test'],
  });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    assert.equal(body.roster.length, 2);
    const noProfile = body.roster.find((r: { email: string }) => r.email === 'bezprofilu@example.test');
    assert.equal(noProfile.fullName, null);
    assert.equal(noProfile.nickname, null);
    assert.equal(noProfile.sectionId, null);
    assert.equal(noProfile.categoryId, null);
    assert.deepEqual(noProfile.weaponIds, []);
    assert.equal(noProfile.wpisowePaid, false);
  });
});

test('GET /lista-wyjazdowa/roster excludes a member marked hidden', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  firestore.seed('members', 'skryty@gmail.com', {
    fullName: 'Skryty Wojownik',
    nickname: null,
    sectionId: 'krakow',
    categoryId: null,
    driveFolderId: null,
    updatedAt: '2027-01-01T00:00:00.000Z',
    updatedBy: 'skryty@gmail.com',
    hidden: true,
  });
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com', 'skryty@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    assert.equal(body.roster.length, 1);
    assert.equal(body.roster[0].email, 'wojownik@gmail.com');
  });
});

test('GET /lista-wyjazdowa/signups returns the full raw roster of signups for an event', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=wojownik@gmail.com`, {
      attending: true,
      companionIds: [],
    });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/signups?eventId=${created.event.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signups.length, 1);
    assert.equal(body.signups[0].memberEmail, 'wojownik@gmail.com');
  });
});

test('GET /lista-wyjazdowa/signups/mine returns null when the caller has not signed up for the event', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/signups/mine?eventId=${created.event.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { signup: null });
  });
});

test('GET /lista-wyjazdowa/signups/mine returns the caller\'s own signup after signing up', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=wojownik@gmail.com`, {
      attending: true,
      companionIds: [],
    });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/signups/mine?eventId=${created.event.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signup.memberEmail, 'wojownik@gmail.com');
    assert.equal(body.signup.attending, true);
  });
});

// Plan C (składki/dues): makeDeps()'s default caller (wojownik@gmail.com) has no userRoles doc,
// so it is a plain member for every test below unless makeDepsWithRole seeds one.
function makeDepsWithRole(
  role: 'accountant' | 'admin',
  firestore = makeListaWyjazdowaFirestore(),
  overrides: Partial<ServerDeps> = {},
) {
  firestore.seed('userRoles', 'wojownik@gmail.com', { roles: [role] });
  return makeDeps({ firestore, ...overrides });
}

test('GET /lista-wyjazdowa/my-role reflects granted roles', async () => {
  await withServer(makeDeps({
    firestore: makeListaWyjazdowaFirestore(),
    // Plain member: no userRoles grant, and not on the env admin allowlist or a moderator either.
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  }), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: false, canManagePeople: false });
  });
  await withServer(makeDepsWithRole('accountant'), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: true, canManagePeople: true });
  });
  await withServer(makeDepsWithRole('admin'), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: true, canManagePeople: true });
  });
  // A moderator (authenticateAdminOrModerator, no składki grant) still manages people, so the
  // event page can offer them the "+" control on every account row.
  await withServer(makeDeps({
    firestore: makeListaWyjazdowaFirestore(),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
  }), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: false, canManagePeople: true });
  });
});

// The env admin allowlist (deps.authenticateAdmin) is a second, independent way in - a site
// administrator configured only there, with no userRoles doc at all, must still be able to manage
// składki (requireSkladkiAccess's fallback, mirroring resolveAdminAuditAuth for /admin/audyt/).
test('GET /lista-wyjazdowa/my-role also grants canManageSkladki via the env admin allowlist alone', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore() }); // default authenticateAdmin succeeds
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: true, canManagePeople: true });
  });
});

test('PUT /lista-wyjazdowa/events with skladkaFee requires accountant, 403 for a plain member', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDeps({ firestore, authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); } });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { skladkaFee: '50 zł' });
    assert.equal(res.status, 403);
  });
});

test('PUT /lista-wyjazdowa/events with skladkaFee succeeds for accountant and is not required for name/startDate/status edits', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { skladkaFee: '50 zł' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).event.skladkaFee, '50 zł');
  });
});

test('PUT /lista-wyjazdowa/events sets dueDate independently, without requiring skladkaFee', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zlot', startDate: '2027-06-12' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { dueDate: '2027-06-01' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.event.dueDate, '2027-06-01');
    assert.equal(body.event.skladkaFee, null);
  });
});

test('PUT /lista-wyjazdowa/events with only dueDate requires accountant, 403 for a plain member', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  // NOTE: event creation must not go through makeDepsWithRole('accountant', firestore) here —
  // that seeds a persistent 'userRoles' grant for wojownik@gmail.com (the fixed test identity)
  // in the shared firestore, which would make the "plain member" PUT below pass the role check
  // in requireSkladkiAccess before authenticateAdmin is ever consulted, defeating this test.
  const created = await withServer(makeDeps({ firestore }), async baseUrl =>
    (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zlot', startDate: '2027-06-12' })).json());
  const deps = makeDeps({ firestore, authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); } });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { dueDate: '2027-06-01' });
    assert.equal(res.status, 403);
  });
});

test('PUT /lista-wyjazdowa/events with only dueDate still requires at least one field overall', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zlot', startDate: '2027-06-12' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, {});
    assert.equal(res.status, 400);
  });
});

test('GET /lista-wyjazdowa/events reports viewerSkladkaPaid for the caller', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  const created = await withServer(deps, async baseUrl => {
    const event = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zlot', startDate: '2027-06-12' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${event.event.id}&personId=wojownik@gmail.com`, {
      attending: true,
      companionIds: [],
    });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/events`);
    const body = await res.json();
    assert.equal(body.events[0].viewerSkladkaPaid, false);
    return event;
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&personId=wojownik@gmail.com`, { paid: true });
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/events`);
    const body = await res.json();
    assert.equal(body.events[0].viewerSkladkaPaid, true);
  });
});

test('PUT /lista-wyjazdowa/signups/skladka requires accountant and 404s for a member with no signup', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore, authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); } }), async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&personId=wojownik@gmail.com`, { paid: true });
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&personId=wojownik@gmail.com`, { paid: true });
    assert.equal(res.status, 404);
  });
});

test('PUT /lista-wyjazdowa/signups/skladka succeeds for accountant against an existing signup', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  // PUT /lista-wyjazdowa/signups 404s unless memberEmail is on the live allowlist (see
  // handleListaWyjazdowaPutSignup) - seed one so the signup below is actually created, matching
  // the seedMember/listMemberEmails pattern used by the other signups tests above.
  seedMember(firestore, 'wojownik@gmail.com');
  const deps = makeDepsWithRole('accountant', firestore, { listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=wojownik@gmail.com`, {
      attending: true, companionIds: [],
    });
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&personId=wojownik@gmail.com`, { paid: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).signup.skladkaPaid, true);
  });
});

test('PUT /lista-wyjazdowa/wpisowe requires accountant', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore, authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); } }), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=wojownik@gmail.com', { paid: true });
    assert.equal(res.status, 403);
  });
});

// Wpisowe is a club due, not a Lista Wyjazdowa feature: whether this member has ever filled in
// "Mój profil" must not gate whether it can be marked paid. setWpisowePaid upserts a profile
// document with empty weaponIds/companions rather than 404ing.
test('PUT /lista-wyjazdowa/wpisowe succeeds and creates a profile for a member with none yet', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore, {
    listMemberEmails: async () => ['wojownik@gmail.com', 'bezprofilu@example.test'],
  });
  await withServer(deps, async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=bezprofilu@example.test', { paid: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.profile.wpisowePaid, true);
    assert.deepEqual(body.profile.weaponIds, []);

    const roster = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    const member = roster.roster.find((r: { email: string }) => r.email === 'bezprofilu@example.test');
    assert.equal(member.wpisowePaid, true);
  });
});

test('PUT /lista-wyjazdowa/wpisowe succeeds for accountant against an existing profile', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    // makeDepsWithRole's caller (wojownik@gmail.com) is itself the accountant here, so it can
    // create its own listaWyjazdowaProfile via the self-service PUT before targeting that same
    // email with the accountant-only wpisowe toggle.
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], companions: [] });
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=wojownik@gmail.com', { paid: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).profile.wpisowePaid, true);
  });
});

test('PUT /lista-wyjazdowa/dues requires accountant, validates member exists, and GET reflects it for the right year', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore, authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); } }), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { status: 'paid' });
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const unknown = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=nikt@example.test&year=2027', { status: 'paid' });
    assert.equal(unknown.status, 404);

    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { status: 'paid' });
    assert.equal(res.status, 200);

    const getRes = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2027`);
    const body = await getRes.json();
    assert.equal(body.dues.length, 1);
    assert.equal(body.dues[0].status, 'paid');
    // KRKG-0087: the canonical key is exposed under personId (not just the legacy-named email field).
    assert.equal(body.dues[0].personId, 'wojownik@gmail.com');

    const wrongYear = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2026`);
    assert.deepEqual((await wrongYear.json()).dues, []);
  });
});

test('PUT /lista-wyjazdowa/dues rejects a status outside unpaid/paid/not_applicable, and accepts not_applicable', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });

    const invalid = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { status: 'yes' });
    assert.equal(invalid.status, 400);
    const legacyBoolean = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { paid: true });
    assert.equal(legacyBoolean.status, 400);

    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { status: 'not_applicable' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).dues.status, 'not_applicable');

    const getRes = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2027`);
    assert.equal((await getRes.json()).dues[0].status, 'not_applicable');
  });
});

test('new dues writes are canonical audit events (legacy dues audit-log endpoint removed)', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], companions: [] });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=wojownik@gmail.com', { paid: true });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { status: 'paid' });
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { skladkaFee: '50 zł' });

    const canonical = await firestore.listDocs<{ action: string }>('auditEvents');
    assert.ok(canonical.some(entry => entry.data.action === 'dues.entry_fee.changed'));
    assert.ok(canonical.some(entry => entry.data.action === 'dues.annual.changed'));
    assert.ok(canonical.some(entry => entry.data.action === 'dues.event_fee.changed'));
  });
});

test('PUT /lista-wyjazdowa/events without skladkaFee in the body does not append a dues audit entry', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { name: 'Zjazd zimowy' });
    const canonical = await firestore.listDocs<{ action: string }>('auditEvents');
    assert.ok(!canonical.some(entry => entry.data.action === 'dues.event_fee.changed'));
  });
});

test('PUT /lista-wyjazdowa/dues/year-fee requires accountant and sets a shared per-year note', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore, authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); } }), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', { note: '100 zł' });
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', { note: '100 zł dla mężczyzn, 50 zł dla kobiet' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).yearFee.note, '100 zł dla mężczyzn, 50 zł dla kobiet');

    const getRes = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2027`);
    assert.equal((await getRes.json()).yearFee.note, '100 zł dla mężczyzn, 50 zł dla kobiet');

    const wrongYear = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2026`);
    assert.equal((await wrongYear.json()).yearFee, null);

    const cleared = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', { note: null });
    assert.equal((await cleared.json()).yearFee.note, null);

    const canonical = (await firestore.listDocs<{ action: string; changes: Array<{ field: string; after: unknown }> }>('auditEvents'))
      .filter(entry => entry.data.action === 'dues.year_fee.changed');
    assert.equal(canonical.length, 2);
    assert.deepEqual(canonical[0].data.changes, [{ field: 'note', after: '100 zł dla mężczyzn, 50 zł dla kobiet', visibility: 'roleRestricted' }]);
    assert.deepEqual(canonical[1].data.changes, [
      { field: 'note', before: '100 zł dla mężczyzn, 50 zł dla kobiet', after: null, visibility: 'roleRestricted' },
    ]);
  });
});

test('PUT /lista-wyjazdowa/dues/year-fee accepts and round-trips dueDate independently of note', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', { note: '100 zł', dueDate: '2027-03-31' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).yearFee.dueDate, '2027-03-31');

    // Sending note alone must leave the previously-set dueDate untouched (preserve-on-omit).
    const noteOnly = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', { note: '120 zł' });
    const noteOnlyBody = await noteOnly.json();
    assert.equal(noteOnlyBody.yearFee.note, '120 zł');
    assert.equal(noteOnlyBody.yearFee.dueDate, '2027-03-31');
  });
});

test('PUT /lista-wyjazdowa/dues/year-fee rejects a malformed dueDate with 400', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', { dueDate: '31-03-2027' });
    assert.equal(res.status, 400);
  });
});

test('PUT /lista-wyjazdowa/dues/year-fee with neither note nor dueDate returns 400, not 500', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues/year-fee?year=2027', {});
    assert.equal(res.status, 400);
  });
});

test('GET /lista-wyjazdowa/dues/mine returns only the caller\'s own dues for the requested year', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const empty = await fetch(`${baseUrl}/lista-wyjazdowa/dues/mine?year=2027`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { dues: null });
  });

  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', { status: 'paid' });
    // A different member's 2027 dues must not leak into this caller's own /mine read. Seeded with
    // the legacy paid-only shape on purpose - also covers normalizeDuesStatus reading a
    // pre-existing record through this same endpoint, not just dues.test.ts's direct unit tests.
    firestore.seed('members', 'inny@example.test', {
      fullName: 'Inny', nickname: null, sectionId: 'krakow', categoryId: null, driveFolderId: null,
      updatedAt: '2027-01-01T00:00:00.000Z', updatedBy: 'inny@example.test',
    });
    await firestore.setDoc('duesAnnual', 'inny@example.test_2027', {
      email: 'inny@example.test', year: 2027, paid: false, updatedBy: 'accountant', updatedAt: '2027-01-01T00:00:00.000Z',
    });

    const res = await fetch(`${baseUrl}/lista-wyjazdowa/dues/mine?year=2027`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dues.email, 'wojownik@gmail.com');
    assert.equal(body.dues.status, 'paid');

    const wrongYear = await fetch(`${baseUrl}/lista-wyjazdowa/dues/mine?year=2026`);
    assert.deepEqual((await wrongYear.json()).dues, null);
  });
});

test('GET /lista-wyjazdowa/roster includes wpisowePaid per member', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore(), listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Ala Kowalska', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], companions: [] });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/roster`);
    const body = await res.json();
    assert.equal(body.roster[0].wpisowePaid, false);
  });
});

// KRKG-0050 Batch 2: this is deliberately a route-level contract rather than a unit test of
// audit.ts. It proves the actor came from the route's verified identity, business writes and the
// canonical record committed together, and the retired per-feature audit collections stay
// read-only while their GET endpoints remain available for migration in Batch 6.
test('Firestore member and Wyjazdy mutations emit canonical audit records and leave legacy logs read-only', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore, {
    authenticateSessionOnly: async () => fakeSessionClaims({ sub: 'applicant-1', email: 'applicant@example.test' }),
    listMemberEmails: async () => ['wojownik@gmail.com'],
  });

  await withServer(deps, async baseUrl => {
    const application = await postListaWyjazdowa(baseUrl, '/membership/apply', {
      fullName: 'Kandydat',
      sectionId: 'krakow',
    });
    assert.equal(application.status, 200);

    const transition = await postListaWyjazdowa(baseUrl, '/admin/members/transition', {
      email: 'applicant@example.test',
      transition: 'approve',
    });
    assert.equal(transition.status, 200);

    const eventResponse = await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', {
      name: 'Zjazd',
      startDate: '2027-05-01',
    });
    assert.equal(eventResponse.status, 200);
    const { event } = await eventResponse.json();

    const signup = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${event.id}&personId=wojownik@gmail.com`,
      { attending: true, companionIds: [] },
    );
    assert.equal(signup.status, 200);

    const paid = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups/skladka?eventId=${event.id}&personId=wojownik@gmail.com`,
      { paid: true },
    );
    assert.equal(paid.status, 200);

    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], companions: [] });
    const entryFee = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=wojownik@gmail.com', { paid: true });
    assert.equal(entryFee.status, 200);

    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    const annualDue = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?personId=wojownik@gmail.com&year=2027', {
      status: 'paid',
    });
    assert.equal(annualDue.status, 200);

    const auditEvents = (await firestore.listDocs<{ action?: string }>('auditEvents')).map(doc => doc.data as {
      actor: { email: string };
      category: string;
      action: string;
      audience: string;
      resource: { key: string };
      changes: Array<{ field: string; before?: string | boolean | null; after?: string | boolean | null; visibility: string }>;
      value: string;
    });
    const byAction = new Map(auditEvents.map(auditEvent => [auditEvent.action, auditEvent]));

    const membershipApplication = byAction.get('membership.application.submitted');
    assert.ok(membershipApplication);
    assert.deepEqual({
      actor: membershipApplication.actor,
      category: membershipApplication.category,
      action: membershipApplication.action,
      audience: membershipApplication.audience,
      resource: { ...membershipApplication.resource, display: 'member' },
      changes: membershipApplication.changes,
      value: membershipApplication.value,
    }, {
      actor: { email: 'applicant@example.test' },
      category: 'membership',
      action: 'membership.application.submitted',
      audience: 'admin',
      resource: { kind: 'member', key: 'member:applicant@example.test', display: 'member' },
      changes: [{ field: 'status', after: 'pending', visibility: 'roleRestricted' }],
      value: 'member.status=pending',
    });
    assert.equal(byAction.get('membership.status.approved')?.actor.email, 'admin@gmail.com');
    assert.equal(byAction.get('event.created')?.category, 'events');
    assert.equal(byAction.get('event.created')?.audience, 'members');
    assert.equal(byAction.get('signup.created')?.actor.email, 'wojownik@gmail.com');
    assert.equal(byAction.get('signup.created')?.resource.key, `signup:${event.id}:wojownik@gmail.com`);
    assert.equal(byAction.get('signup.created')?.value, 'wojownik@gmail.com.attending=true');
    assert.deepEqual(byAction.get('signup.created')?.changes, [
      { field: 'attending', after: true, visibility: 'memberVisible' },
    ]);
    assert.equal(byAction.get('dues.event_fee.changed')?.audience, 'adminOrAccountant');
    assert.equal(byAction.get('dues.entry_fee.changed')?.changes[0]?.field, 'paid');
    assert.deepEqual(byAction.get('dues.annual.changed')?.changes, [
      { field: 'status', after: 'paid', visibility: 'roleRestricted' },
      { field: 'year', after: 2027, visibility: 'roleRestricted' },
    ]);
    assert.equal((await firestore.listDocs('signupAuditLog')).length, 0);
    assert.equal((await firestore.listDocs('duesAuditLog')).length, 0);
    assert.equal((await firestore.listDocs('rolesAuditLog')).length, 0);
  });
});

// GET /members/directory (KRKG-0045).
test('GET /members/directory requires the same gate as authenticateWojownicyUpload', async () => {
  const deps = makeDeps({
    authenticateWojownicyUpload: async () => {
      throw new AuthError('Brak uprawnień.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/members/directory`);
    assert.equal(res.status, 403);
  });
});

test('GET /members/directory excludes a member marked hidden', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'zprofilem@example.test');
  firestore.seed('members', 'skryty@example.test', {
    fullName: 'Skryty',
    nickname: null,
    sectionId: 'krakow',
    categoryId: null,
    driveFolderId: null,
    updatedAt: '2027-01-01T00:00:00.000Z',
    updatedBy: 'skryty@example.test',
    hidden: true,
  });
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['zprofilem@example.test', 'skryty@example.test'],
  });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/members/directory`)).json();
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].email, 'zprofilem@example.test');
  });
});

// Unlike the roster above, the directory is driven by the live group allowlist, not by who has a
// members/{email} doc - a group member who never filled in a profile must still be listed, just
// with blank fields, instead of being absent.
test('GET /members/directory lists every allowlisted email, filling in profile fields when present', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'zprofilem@example.test');
  const deps = makeDeps({
    firestore,
    listMemberEmails: async () => ['zprofilem@example.test', 'bezprofilu@example.test'],
  });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/members/directory`)).json();
    assert.equal(body.members.length, 2);
    const withProfile = body.members.find((m: { email: string }) => m.email === 'zprofilem@example.test');
    const withoutProfile = body.members.find((m: { email: string }) => m.email === 'bezprofilu@example.test');
    assert.equal(withProfile.fullName, 'zprofilem@example.test');
    assert.equal(withProfile.sectionId, 'krakow');
    assert.equal(withProfile.sectionLabel, 'Kraków');
    assert.equal(withoutProfile.fullName, null);
    assert.equal(withoutProfile.nickname, null);
    assert.equal(withoutProfile.sectionId, null);
    assert.equal(withoutProfile.sectionLabel, null);
  });
});

test('GET /members/directory includes categoryId/categoryLabel ("typ członka", KRKG-0050)', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('lookupLists', 'categories', { items: [{ id: 'thing', label: 'Thing', retired: false }] });
  firestore.seed('members', 'wojownik@gmail.com', {
    fullName: 'Ktoś', nickname: null, sectionId: 'krakow', categoryId: 'thing', driveFolderId: null,
    updatedAt: 'x', updatedBy: 'x',
  });
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/members/directory`)).json();
    assert.equal(body.members[0].categoryId, 'thing');
    assert.equal(body.members[0].categoryLabel, 'Thing');
  });
});

test('GET /members/directory falls back to the raw sectionId when it has no matching lookup-list entry', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  firestore.seed('members', 'wojownik@gmail.com', {
    fullName: 'Ktoś',
    nickname: null,
    sectionId: 'usunieta-sekcja',
    categoryId: null,
    driveFolderId: null,
    updatedAt: '2027-01-01T00:00:00.000Z',
    updatedBy: 'wojownik@gmail.com',
  });
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const body = await (await fetch(`${baseUrl}/members/directory`)).json();
    assert.equal(body.members[0].sectionLabel, 'usunieta-sekcja');
  });
});

// setWpisowePaid now upserts a profile with empty weaponIds/companions rather than 404ing, so a
// signup for such a member still succeeds instead of crashing.
test('PUT /lista-wyjazdowa/signups still works for a member with no listaWyjazdowaProfile', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'bezprofilu@example.test');
  const deps = makeDepsWithRole('accountant', firestore, { listMemberEmails: async () => ['bezprofilu@example.test'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?personId=bezprofilu@example.test', { paid: true });
    const res = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&personId=bezprofilu@example.test`,
      { attending: true, companionIds: [] },
    );
    assert.equal(res.status, 200);
  });
});

test('PUT /lista-wyjazdowa/events preserves combined metadata and fee edits as two atomic canonical events', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', {
      name: 'Zjazd', startDate: '2027-05-01',
    })).json();

    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, {
      name: 'Zjazd zimowy',
      skladkaFee: '100 zł',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).event.name, 'Zjazd zimowy');

    const events = (await firestore.listDocs<{ action?: string }>('auditEvents')).map(doc => doc.data as { action: string; changes: Array<{ field: string }> });
    const updateEvents = events.filter(event => event.action !== 'event.created');
    assert.deepEqual(updateEvents.map(event => event.action).sort(), ['dues.event_fee.changed', 'event.updated']);
    assert.deepEqual(updateEvents.find(event => event.action === 'event.updated')?.changes, [{ field: 'name', before: 'Zjazd', after: 'Zjazd zimowy', visibility: 'memberVisible' }]);
    assert.deepEqual(updateEvents.find(event => event.action === 'dues.event_fee.changed')?.changes, [
      { field: 'feeDigest', before: null, after: createHash('sha256').update('100 zł').digest('hex'), visibility: 'roleRestricted' },
      { field: 'feeLength', before: null, after: 6, visibility: 'roleRestricted' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// KRKG-0050 batch 4/6: audit query, diagnostics, and reconciliation routes.
// ---------------------------------------------------------------------------------------------

async function seedAuditEvent(firestore: ReturnType<typeof createInMemoryFirestoreClient>, id: string, timestampIso: string) {
  await executeAuditedFirestoreMutation(
    firestore,
    {
      action: 'event.created',
      actor: { email: 'maja@example.test' },
      resource: { kind: 'event', key: `event:${id}`, display: `Wyjazd ${id}` },
      changes: [{ field: 'name', after: `Wyjazd ${id}` }],
    },
    async () => {},
    { createId: () => id, now: () => new Date(timestampIso) },
  );
}

test('GET /admin/audyt/events lists events for an admin viewer and rejects two primary selectors with 400', async () => {
  const firestore = createInMemoryFirestoreClient();
  await seedAuditEvent(firestore, 'evt-a', '2026-01-01T00:00:00.000Z');
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/audyt/events`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].id, 'evt-a');
    assert.equal(body.rows[0].actor.email, 'maja@example.test');

    const rejected = await fetch(`${baseUrl}/admin/audyt/events?category=events&actorEmail=maja@example.test`);
    assert.equal(rejected.status, 400);
  });
});

test('GET /admin/audyt/events: action without category is a deterministic 400, and every single supported selector (category, category+action, actorEmail, resourceKey, q) is individually accepted', async () => {
  const firestore = createInMemoryFirestoreClient();
  await seedAuditEvent(firestore, 'evt-a', '2026-01-01T00:00:00.000Z');
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    // action alone, with no category, is rejected before Firestore is ever touched.
    const actionWithoutCategory = await fetch(`${baseUrl}/admin/audyt/events?action=event.created`);
    assert.equal(actionWithoutCategory.status, 400);

    // Each of the six selector shapes is independently accepted (zero-or-one primary selector).
    const byCategory = await fetch(`${baseUrl}/admin/audyt/events?category=events`);
    assert.equal(byCategory.status, 200);
    const byCategoryAction = await fetch(`${baseUrl}/admin/audyt/events?category=events&action=event.created`);
    assert.equal(byCategoryAction.status, 200);
    const byActor = await fetch(`${baseUrl}/admin/audyt/events?actorEmail=maja@example.test`);
    assert.equal(byActor.status, 200);
    const byResource = await fetch(`${baseUrl}/admin/audyt/events?resourceKey=event:evt-a`);
    assert.equal(byResource.status, 200);
    const byEventId = await fetch(`${baseUrl}/admin/audyt/events?eventId=evt-a`);
    assert.equal(byEventId.status, 200);
    const byQuery = await fetch(`${baseUrl}/admin/audyt/events?q=evt`);
    assert.equal(byQuery.status, 200);

    // A primary selector still composes with date-range and cursor query params, and combining
    // two of the other primary-selector kinds is rejected regardless of which two.
    const withDateRange = await fetch(`${baseUrl}/admin/audyt/events?actorEmail=maja@example.test&from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z`);
    assert.equal(withDateRange.status, 200);
    const resourceAndQuery = await fetch(`${baseUrl}/admin/audyt/events?resourceKey=event:evt-a&q=evt`);
    assert.equal(resourceAndQuery.status, 400);
    const eventIdAndResource = await fetch(`${baseUrl}/admin/audyt/events?eventId=evt-a&resourceKey=event:evt-a`);
    assert.equal(eventIdAndResource.status, 400);
  });
});

test('GET /admin/audyt/events?eventId= returns event, eventFee, and signup rows for one trip only', async () => {
  const firestore = createInMemoryFirestoreClient();
  await seedAuditEvent(firestore, 'evt-a', '2026-01-01T00:00:00.000Z');
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'dues.event_fee.changed', actor: { email: 'skarbnik@example.test' }, resource: { kind: 'eventFee', key: 'eventFee:evt-a', display: 'Wyjazd evt-a' }, changes: [{ field: 'feeDigest', after: 'abc' }] },
    async () => {},
    { createId: () => 'evt-a-fee', now: () => new Date('2026-01-02T00:00:00.000Z') },
  );
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'signup.created', actor: { email: 'maja@example.test' }, resource: { kind: 'signup', key: 'signup:evt-a:ula@example.test', display: 'ula@example.test' }, changes: [{ field: 'attending', after: true }] },
    async () => {},
    { createId: () => 'evt-a-signup', now: () => new Date('2026-01-03T00:00:00.000Z') },
  );
  await seedAuditEvent(firestore, 'evt-b', '2026-01-04T00:00:00.000Z');
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/audyt/events?eventId=evt-a`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.rows.map((r: { id: string }) => r.id), ['evt-a-signup', 'evt-a-fee', 'evt-a']);
  });
});

test('GET /audyt/events (member-zone) never exposes actor and hides an admin-only category entirely', async () => {
  const firestore = createInMemoryFirestoreClient();
  await seedAuditEvent(firestore, 'evt-public', '2026-01-01T00:00:00.000Z');
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'dues.annual.changed', actor: { email: 'skarbnik@example.test' }, resource: { kind: 'due', key: 'due:ula@example.test:2026', display: 'Ula 2026' }, changes: [{ field: 'paid', after: true }] },
    async () => {},
    { createId: () => 'evt-dues', now: () => new Date('2026-01-01T00:01:00.000Z') },
  );
  const deps = makeDeps({ firestore });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/audyt/events`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.rows.map((r: { id: string }) => r.id), ['evt-public']);
    assert.equal(body.rows[0].actor, undefined);
  });
});

test('GET /admin/audyt list and detail give a Firestore-only moderator full audit access, an accountant-only viewer dues-category-only access, and reject an ordinary member', async () => {
  const firestore = createInMemoryFirestoreClient();
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'dues.annual.changed', actor: { email: 'skarbnik@example.test' }, resource: { kind: 'due', key: 'due:ula@example.test:2026', display: 'Ula 2026' }, changes: [{ field: 'paid', after: true }] },
    async () => {},
    { createId: () => 'evt-dues', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'role.replaced', actor: { email: 'admin@example.test' }, resource: { kind: 'member', key: 'member:ula@example.test', display: 'Ula' }, changes: [{ field: 'roles', after: 'Moderator' }] },
    async () => {},
    { createId: () => 'evt-roles', now: () => new Date('2026-01-01T00:01:00.000Z') },
  );
  await firestore.setDoc('userRoles', 'wojownik@gmail.com', { roles: ['moderator'] });
  const moderatorDeps = makeDeps({
    firestore,
    // The audit shell reaches its reader through the admin-or-moderator boundary. A moderator
    // need not be an active member, so the general member gate is deliberately rejecting here.
    authenticate: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ sub: 'mod-1', email: 'wojownik@gmail.com' }),
  });
  await withServer(moderatorDeps, async baseUrl => {
    const list = await fetch(`${baseUrl}/admin/audyt/events`);
    assert.equal(list.status, 200);
    const rows = (await list.json()).rows;
    assert.deepEqual(rows.map((row: { id: string }) => row.id), ['evt-roles', 'evt-dues']);
    assert.equal(rows[0].actor.email, 'admin@example.test');
    assert.equal(rows[0].changes[0].field, 'roles');
    assert.equal(rows[0].changes[0].after, 'Moderator');

    const detail = await fetch(`${baseUrl}/admin/audyt/event?id=evt-dues`);
    assert.equal(detail.status, 200);
    const event = await detail.json();
    assert.equal(event.actor.email, 'skarbnik@example.test');
    assert.equal(event.changes[0].field, 'paid');
    assert.equal(event.changes[0].after, true);
  });

  // Accountant-only: fails the admin-or-moderator gate entirely, but resolveAdminAuditAuth's
  // fallback branch still authenticates them through deps.authenticate and grants dues-category-
  // only access - the one category their role covers (viewerCanSeeCategory). They see the dues
  // event but not the permissions one, and its detail 404s (projectAuditEvent returns null for an
  // invisible category, never a 403 that would confirm the event's existence).
  await firestore.setDoc('userRoles', 'accountant@example.test', { roles: ['accountant'] });
  const accountantDeps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ email: 'accountant@example.test' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await withServer(accountantDeps, async baseUrl => {
    const list = await fetch(`${baseUrl}/admin/audyt/events`);
    assert.equal(list.status, 200);
    const rows = (await list.json()).rows;
    assert.deepEqual(rows.map((row: { id: string }) => row.id), ['evt-dues']);

    assert.equal((await fetch(`${baseUrl}/admin/audyt/event?id=evt-dues`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/admin/audyt/event?id=evt-roles`)).status, 404);
  });

  // Plain member: neither admin-or-moderator nor accountant - rejected by both branches.
  await firestore.setDoc('userRoles', 'member@example.test', { roles: [] });
  const memberDeps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ email: 'member@example.test' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await withServer(memberDeps, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/admin/audyt/events`)).status, 403);
    assert.equal((await fetch(`${baseUrl}/admin/audyt/event?id=evt-dues`)).status, 403);
  });

  await firestore.setDoc('userRoles', 'combined@example.test', { roles: ['accountant', 'moderator'] });
  const combinedDeps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ email: 'combined@example.test' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
    authenticateAdminOrModerator: async () => fakeSessionClaims({ email: 'combined@example.test' }),
  });
  await withServer(combinedDeps, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/admin/audyt/events`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/admin/audyt/event?id=evt-dues`)).status, 200);
  });

  const unauthenticatedDeps = makeDeps({
    firestore,
    authenticate: async () => { throw new AuthError('Brak sesji.', 401); },
    authenticateAdminOrModerator: async () => { throw new AuthError('Brak sesji.', 401); },
  });
  await withServer(unauthenticatedDeps, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/admin/audyt/events`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/admin/audyt/event?id=evt-dues`)).status, 401);
  });
});

test('GET /admin/audyt/diagnostics is administrator-only and filters by correlation id', async () => {
  const firestore = createInMemoryFirestoreClient();
  await startExternalOperation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] },
    { correlationId: 'diag-1', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  const adminDeps = makeDeps({ firestore });
  await withServer(adminDeps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/audyt/diagnostics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].correlationId, 'diag-1');

    const filtered = await fetch(`${baseUrl}/admin/audyt/diagnostics?correlationId=diag-1`);
    assert.equal((await filtered.json()).rows.length, 1);
    const empty = await fetch(`${baseUrl}/admin/audyt/diagnostics?correlationId=does-not-exist`);
    assert.equal((await empty.json()).rows.length, 0);
  });

  // An accountant-only (non-admin) viewer must not reach diagnostics - it's administrator-only,
  // unlike the list/detail routes.
  const accountantDeps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ sub: 'acc-1', email: 'wojownik@gmail.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await withServer(accountantDeps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/audyt/diagnostics`);
    assert.equal(res.status, 403);
  });

  const moderatorDeps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ sub: 'mod-1', email: 'moderator@example.test' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await firestore.setDoc('userRoles', 'moderator@example.test', { roles: ['moderator'] });
  await withServer(moderatorDeps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/audyt/diagnostics`);
    assert.equal(res.status, 403);
  });
});

test('POST /internal/audit/reconcile fails closed (503) when the reconciler secrets are not configured, and 401s a request with no bearer token once they are', async () => {
  const notConfigured = makeDeps();
  await withServer(notConfigured, async baseUrl => {
    const res = await fetch(`${baseUrl}/internal/audit/reconcile`, { method: 'POST' });
    assert.equal(res.status, 503);
  });

  const configured = makeDeps({
    auditReconcilerServiceAccountEmail: 'audit-reconciler@project.iam.gserviceaccount.com',
    auditReconcileAudience: 'https://upload-service-xyz.run.app',
  });
  await withServer(configured, async baseUrl => {
    const res = await fetch(`${baseUrl}/internal/audit/reconcile`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
});

// --- Real OIDC round-trip for the reconcile dispatch loop past the fail-closed cases above -----
//
// `handleInternalAuditReconcile` verifies its Bearer token against the real Google JWKS endpoint
// (auth.ts's `fetchGoogleJwks`, not something `ServerDeps` lets tests inject), so exercising the
// route's actual dispatch loop - not just its 503/401 short-circuits - means signing a real RS256
// token and intercepting only the JWKS fetch, letting every other request (including the test's
// own calls into the loopback test server) go through unmodified.

function base64UrlForReconcilerTest(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const { publicKey: reconcilerPublicKey, privateKey: reconcilerPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const reconcilerJwk = (() => {
  const exported = reconcilerPublicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string };
  return { kid: 'reconciler-test-kid', kty: exported.kty, n: exported.n, e: exported.e };
})();

function makeReconcilerOidcToken(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: reconcilerJwk.kid };
  const headerB64 = base64UrlForReconcilerTest(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlForReconcilerTest(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), reconcilerPrivateKey);
  return `${signingInput}.${base64UrlForReconcilerTest(signature)}`;
}

// Intercepts only the Google JWKS endpoint; every other URL (including the test's own requests
// into the loopback server started by withServer) is delegated to the real, captured fetch.
async function withMockedGoogleJwks<T>(run: () => Promise<T>): Promise<T> {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [reconcilerJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return nodeFetch(input as never, init as never);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = wrapped;
  try {
    return await run();
  } finally {
    globalThis.fetch = nodeFetch;
  }
}

const RECONCILER_EMAIL = 'audit-reconciler@project.iam.gserviceaccount.com';
const RECONCILER_AUDIENCE = 'https://upload-service-xyz.run.app';

function makeValidReconcilerBearer(): string {
  return makeReconcilerOidcToken({
    iss: 'https://accounts.google.com',
    aud: RECONCILER_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
    email: RECONCILER_EMAIL,
  });
}

test('POST /internal/audit/reconcile: a previously-uncovered kind (redirect) that never settles reaches requires_review after the 24h boundary via the real dispatch loop', async () => {
  const firestore = createInMemoryFirestoreClient();
  // Backdated well past both the 30-minute request lease and the 24-hour requires_review
  // boundary, so a single real-time reconcile call resolves it immediately.
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'site.redirect.created',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' },
      changes: [{ field: 'path', after: 'discord' }],
    },
    { correlationId: 'redirect-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The redirect never actually landed in redirects.json, so `buildReconciliationProbes`'s
    // redirect probe keeps reporting `pending` - proving this is the real probe/dispatch path,
    // not a stub that always resolves.
    github: makeFakeGithub({ listRedirects: async () => [] }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const outcome = await firestore.getDoc<{ state: string; determinedBy: string }>('auditOperationOutcomes', correlationId);
  assert.equal(outcome!.state, 'requires_review');
  assert.equal(outcome!.determinedBy, 'reconciler');
});

test('POST /internal/audit/reconcile: the redirect probe recognizes a genuinely completed operation as succeeded, not just pending-forever', async () => {
  const firestore = createInMemoryFirestoreClient();
  // Past the 30-minute request lease (so it's eligible), but well within the 24h boundary - the
  // only way this resolves as `claimed_succeeded` is the probe actually finding the redirect.
  const startedAt = new Date(Date.now() - 45 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'site.redirect.created',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' },
      changes: [{ field: 'path', after: 'discord' }],
    },
    { correlationId: 'redirect-done-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    github: makeFakeGithub({ listRedirects: async () => [{ path: 'discord', target: 'https://discord.gg/abc123' }] }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_succeeded' }]);
    }),
  );

  const outcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(outcome!.state, 'succeeded');
  assert.equal(outcome!.determinedBy, 'reconciler');
  assert.ok(outcome!.auditEventId);
});

// GPT-5 follow-up review (Finding 1, Critical): `gallery.photo.added` shares the `gallery`
// resource kind with `gallery.created`, but its gallery folder already exists *before* the photo
// upload starts - so a folder-existence probe is trivially always true for it and would fabricate
// `succeeded` for an interrupted/ambiguous upload that never actually added a photo. The two
// tests below prove: (1) that false positive no longer happens - reconciling a stuck
// `gallery.photo.added` operation whose gallery folder genuinely exists still does NOT resolve as
// `claimed_succeeded`, and instead only ever resolves via the 24h `requires_review` boundary, same
// as the always-pending `member`/`settings` kinds; and (2) `gallery.created`'s own reconciliation
// is unchanged - it still resolves `claimed_succeeded` via a real folder-existence probe.

test('POST /internal/audit/reconcile: gallery.photo.added never resolves claimed_succeeded via folder existence (false positive), and reaches requires_review after the 24h boundary', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'gallery-folder-1';
  // Backdated well past both the 30-minute request lease and the 24-hour requires_review
  // boundary, so a single real-time reconcile call resolves it immediately.
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'gallery.photo.added',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId },
      changes: [{ field: 'photoCount', after: 1 }],
    },
    { correlationId: 'gallery-photo-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The gallery folder DOES genuinely exist here - this is the exact scenario that used to
    // fabricate a false `claimed_succeeded` via `driveFolderProbe`'s existence check, even though
    // the interrupted upload never actually added a photo. Before the fix, this test's assertion
    // below would have failed (outcome would have been 'claimed_succeeded' instead).
    drive: makeFakeDrive({ folderExists: async () => true }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const outcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(outcome!.state, 'requires_review', 'must never be fabricated as succeeded merely because the (pre-existing) gallery folder exists');
  assert.equal(outcome!.determinedBy, 'reconciler');
  assert.equal(outcome!.auditEventId, undefined, 'no audit event should be manufactured for an unconfirmed upload');
});

test('POST /internal/audit/reconcile: gallery.created is unaffected by the gallery.photo.added fix - still resolves claimed_succeeded via a real folder-existence probe', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'gallery-folder-2';
  // Past the 30-minute request lease (so it's eligible), but well within the 24h boundary - the
  // only way this resolves as `claimed_succeeded` is the probe actually finding the folder.
  const startedAt = new Date(Date.now() - 45 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'gallery.created',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId },
      changes: [{ field: 'name', after: 'Test Album' }],
    },
    { correlationId: 'gallery-created-done-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({ folderExists: async id => id === folderId }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_succeeded' }]);
    }),
  );

  const outcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(outcome!.state, 'succeeded');
  assert.equal(outcome!.determinedBy, 'reconciler');
  assert.ok(outcome!.auditEventId);
});

// GPT-5 follow-up review (Apply Review batch): widening driveFolderProbe's guard from a
// `gallery.photo.added`-only blocklist to a `gallery.created`-only allowlist. The blocklist fix
// above left the exact same false-positive class open for every OTHER action sharing the
// `gallery` resource kind - `gallery.finalized` and `gallery.photo.contribution.finalized` reuse
// a folder that already existed before finalization ran, and `gallery.deleted` is the inverted
// case: the folder still existing means the deletion did NOT happen, so folder existence must
// never be read as `succeeded` there either. Before this fix, both tests below would have failed
// (outcome would have been 'claimed_succeeded' instead of 'claimed_requires_review').

test('POST /internal/audit/reconcile: gallery.finalized never resolves claimed_succeeded via folder existence (the gallery folder pre-exists regardless of whether finalization ran)', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'gallery-folder-3';
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'gallery.finalized',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId },
      changes: [{ field: 'finalized', after: 'true' }],
    },
    { correlationId: 'gallery-finalized-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The gallery folder DOES genuinely exist here - it was created by the earlier /start call,
    // long before this (stuck) /finalize attempt. This is the exact scenario that would fabricate
    // a false `claimed_succeeded` if driveFolderProbe still only excluded gallery.photo.added.
    drive: makeFakeDrive({ folderExists: async () => true }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const finalizedOutcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(finalizedOutcome!.state, 'requires_review', 'must never be fabricated as succeeded merely because the (pre-existing) gallery folder exists');
  assert.equal(finalizedOutcome!.determinedBy, 'reconciler');
  assert.equal(finalizedOutcome!.auditEventId, undefined, 'no audit event should be manufactured for an unconfirmed finalize');
});

test('POST /internal/audit/reconcile: gallery.deleted never resolves claimed_succeeded via folder existence - the folder still existing means the deletion did NOT happen', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'gallery-folder-4';
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'gallery.deleted',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'gallery', key: `gallery:${folderId}`, display: folderId },
      changes: [{ field: 'name', after: folderId }],
    },
    { correlationId: 'gallery-deleted-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The folder STILL exists - i.e. the deletion never actually happened. A probe that reads
    // existence as success would get this exactly backwards.
    drive: makeFakeDrive({ folderExists: async () => true }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const deletedOutcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(deletedOutcome!.state, 'requires_review', 'must never be fabricated as succeeded merely because the (undeleted) gallery folder still exists');
  assert.equal(deletedOutcome!.determinedBy, 'reconciler');
  assert.equal(deletedOutcome!.auditEventId, undefined, 'no audit event should be manufactured for a deletion that never happened');
});

// GPT-5 follow-up review: the same allowlist-vs-blocklist bug exists for the `person` resource
// kind, which shares `driveFolderProbe` with `gallery`. Only `profile.person.created` is the case
// where "the person's Drive folder now exists" proves that operation's own effect (its intent
// always carries a provisional `person:pending:{correlationId}` key - see
// handleAdminCreatePerson - mirroring `gallery.created`). Every other `person`-kind action reuses
// a folder that already existed before it ran, and `profile.person.deleted` is the inverted case:
// the folder still existing means the deletion did NOT happen. Before this fix, both tests below
// would have failed (outcome would have been 'claimed_succeeded' instead of
// 'claimed_requires_review').

test('POST /internal/audit/reconcile: profile.person.deleted never resolves claimed_succeeded via folder existence - the folder still existing means the deletion did NOT happen', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'person-folder-1';
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'profile.person.deleted',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'person', key: `person:${folderId}`, display: folderId },
      changes: [{ field: 'name', after: folderId }],
    },
    { correlationId: 'person-deleted-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The folder STILL exists - i.e. the deletion never actually happened. A probe that reads
    // existence as success would get this exactly backwards.
    drive: makeFakeDrive({ folderExists: async () => true }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const deletedOutcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(deletedOutcome!.state, 'requires_review', 'must never be fabricated as succeeded merely because the (undeleted) person folder still exists');
  assert.equal(deletedOutcome!.determinedBy, 'reconciler');
  assert.equal(deletedOutcome!.auditEventId, undefined, 'no audit event should be manufactured for a deletion that never happened');
});

test('POST /internal/audit/reconcile: profile.person.description.updated never resolves claimed_succeeded via folder existence (the person folder pre-exists regardless of whether the update ran)', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'person-folder-2';
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'profile.person.description.updated',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'person', key: `person:${folderId}`, display: folderId },
      changes: [{ field: 'descriptionLength', after: 42 }],
    },
    { correlationId: 'person-description-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The person folder DOES genuinely exist here - it was created long before this (stuck)
    // description update. This is the exact scenario that would fabricate a false
    // `claimed_succeeded` if driveFolderProbe's allowlist didn't cover `person` too.
    drive: makeFakeDrive({ folderExists: async () => true }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const updatedOutcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(updatedOutcome!.state, 'requires_review', 'must never be fabricated as succeeded merely because the (pre-existing) person folder exists');
  assert.equal(updatedOutcome!.determinedBy, 'reconciler');
  assert.equal(updatedOutcome!.auditEventId, undefined, 'no audit event should be manufactured for an unconfirmed description update');
});

// GPT-5 follow-up review: the same allowlist-vs-blocklist bug exists a third time, for the
// `memberSubmission` resource kind, which shares `ACTION_REGISTRY`'s two `profile.photo_submission.*`
// actions. Only `profile.photo_submission.created` (handleWojownicyUploadSubmit) is the case where
// "the submission folder now exists" proves that operation's own effect - its intent starts with a
// provisional `memberSubmission:pending:{correlationId}` key that only upgrades to the real
// `member:{email}:submission:{folderId}` key on success, mirroring `gallery.created`/
// `profile.person.created`. `profile.photo_submission.photo_added` (handleWojownicyUploadPhoto)
// reuses the submission folder that `.created` already made, and - per the I4 fix - uses that same
// real, non-provisional key from the very start, so folder existence there is trivially always true
// and proves nothing about whether that specific photo upload completed. Before this fix, the test
// below would have failed (outcome would have been 'claimed_succeeded' instead of
// 'claimed_requires_review').

test('POST /internal/audit/reconcile: profile.photo_submission.photo_added never resolves claimed_succeeded via folder existence (the submission folder pre-exists regardless of whether the photo upload ran)', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'submission-folder-1';
  const startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'profile.photo_submission.photo_added',
      actor: { email: 'member@example.test' },
      resource: { kind: 'memberSubmission', key: `member:member@example.test:submission:${folderId}`, display: folderId },
      changes: [{ field: 'fileId', after: 'pending' }],
    },
    { correlationId: 'submission-photo-added-stuck-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    // The submission folder DOES genuinely exist here - it was created long before this (stuck)
    // photo-add attempt, by the earlier .created call. This is the exact scenario that would
    // fabricate a false `claimed_succeeded` if memberSubmissionProbe still only excluded via the
    // provisional-key check instead of allowlisting the action itself.
    drive: makeFakeDrive({ folderExists: async () => true }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_requires_review' }]);
    }),
  );

  const outcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(outcome!.state, 'requires_review', 'must never be fabricated as succeeded merely because the (pre-existing) submission folder exists');
  assert.equal(outcome!.determinedBy, 'reconciler');
  assert.equal(outcome!.auditEventId, undefined, 'no audit event should be manufactured for an unconfirmed photo upload');
});

test('POST /internal/audit/reconcile: profile.photo_submission.created is unaffected by the photo_added fix - still resolves claimed_succeeded via a real folder-existence probe', async () => {
  const firestore = createInMemoryFirestoreClient();
  const folderId = 'submission-folder-2';
  // Past the 30-minute request lease (so it's eligible), but well within the 24h boundary - the
  // only way this resolves as `claimed_succeeded` is the probe actually finding the folder.
  const startedAt = new Date(Date.now() - 45 * 60 * 1000);
  const { correlationId } = await startExternalOperation(
    firestore,
    {
      action: 'profile.photo_submission.created',
      actor: { email: 'member@example.test' },
      resource: { kind: 'memberSubmission', key: `member:member@example.test:submission:${folderId}`, display: 'Jan Kowalski' },
      changes: [{ field: 'name', after: 'Jan Kowalski' }],
    },
    { correlationId: 'submission-created-done-1', now: () => startedAt },
  );

  const deps = makeDeps({
    firestore,
    drive: makeFakeDrive({ folderExists: async id => id === folderId }),
    auditReconcilerServiceAccountEmail: RECONCILER_EMAIL,
    auditReconcileAudience: RECONCILER_AUDIENCE,
  });

  await withMockedGoogleJwks(() =>
    withServer(deps, async baseUrl => {
      const res = await fetch(`${baseUrl}/internal/audit/reconcile`, {
        method: 'POST',
        headers: { authorization: `Bearer ${makeValidReconcilerBearer()}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, [{ correlationId, outcome: 'claimed_succeeded' }]);
    }),
  );

  const outcome = await firestore.getDoc<{ state: string; determinedBy: string; auditEventId?: string }>('auditOperationOutcomes', correlationId);
  assert.equal(outcome!.state, 'succeeded');
  assert.equal(outcome!.determinedBy, 'reconciler');
  assert.ok(outcome!.auditEventId);
});

// KRKG-0096: /equipment HTTP-route tests. Mirrors the /files route tests above (createInMemoryFirestoreClient
// + makeDeps + withServer, jsonRequest-shaped fetch calls), covering the gaps the final-review flagged
// rather than /files's full depth: auth gating, the "any member can edit anything" trust decision,
// the PUT-unknown-id 404, and that a create actually emits an audit event with the right shape.
function makeEquipmentFirestore() {
  const firestore = makeFakeFirestore();
  firestore.seed('lookupLists', 'equipmentCategories', {
    items: [{ id: 'namiot', label: 'Namiot', retired: false }],
  });
  firestore.seed('lookupLists', 'sections', {
    items: [{ id: 'krakow', label: 'Kraków', retired: false }],
  });
  return firestore;
}

test('GET /equipment rejects an unauthenticated caller', async () => {
  const deps = makeDeps({
    authenticate: async () => { throw new AuthError('Brak sesji.', 401); },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment`);
    assert.equal(res.status, 401);
  });
});

// design.md's headline trust decision for this feature: unlike /files (owner-or-moderator), any
// signed-in member may edit or delete any equipment item, private or team-owned - canEdit/canDelete
// must come back true even for a private item belonging to somebody else.
test('GET /equipment marks a private item owned by a different member as editable and deletable', async () => {
  const firestore = makeEquipmentFirestore();
  const listMemberEmails = async () => ['ala@example.test', 'bob@example.test'];
  await withServer(
    makeDeps({ firestore, listMemberEmails, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) }),
    async baseUrl => {
      const postRes = await fetch(`${baseUrl}/equipment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: 'namiot', sectionId: 'krakow', description: 'Namiot Ali', belongsToPersonId: 'ala@example.test' }),
      });
      assert.equal(postRes.status, 200);
    },
  );
  await withServer(
    makeDeps({ firestore, listMemberEmails, authenticate: async () => fakeSessionClaims({ email: 'bob@example.test' }) }),
    async baseUrl => {
      const res = await fetch(`${baseUrl}/equipment`);
      assert.equal(res.status, 200);
      const { equipment } = (await res.json()) as { equipment: Array<{ belongsToPersonId: string | null; canEdit: boolean; canDelete: boolean }> };
      assert.equal(equipment.length, 1);
      assert.equal(equipment[0].belongsToPersonId, 'ala@example.test');
      assert.equal(equipment[0].canEdit, true, 'any member may edit a private item they do not own');
      assert.equal(equipment[0].canDelete, true, 'any member may delete a private item they do not own');
    },
  );
});

test('PUT /equipment returns 404 for an unknown id', async () => {
  const deps = makeDeps({ firestore: makeEquipmentFirestore(), authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment?id=nie-ma-takiego`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'namiot', sectionId: 'krakow', description: 'x', belongsToPersonId: null }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST /equipment records an equipment.added audit event with the resource key and created fields', async () => {
  const firestore = makeEquipmentFirestore();
  const deps = makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  let equipmentId = '';
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'namiot', sectionId: 'krakow', description: 'Wiata drużynowa', belongsToPersonId: null }),
    });
    assert.equal(res.status, 200);
    const { equipment } = (await res.json()) as { equipment: { id: string } };
    equipmentId = equipment.id;
  });

  const events = await firestore.listDocs<{ action: string; resource: { key: string }; changes: Array<{ field: string; after?: unknown }> }>('auditEvents');
  const addedEvent = events.map(e => e.data).find(e => e.action === 'equipment.added');
  assert.ok(addedEvent, 'expected an equipment.added audit event');
  assert.equal(addedEvent!.resource.key, `equipment:${equipmentId}`);
  const changesByField = new Map(addedEvent!.changes.map(c => [c.field, c.after]));
  assert.equal(changesByField.get('categoryId'), 'namiot');
  assert.equal(changesByField.get('sectionId'), 'krakow');
  assert.equal(changesByField.get('belongsToPersonId'), null);
  assert.equal(changesByField.get('description'), 'Wiata drużynowa');
});

// KRKG-0096 final review, Finding 5: categoryId/sectionId/belongsToPersonId referential validation.
// design.md §5 requires categoryId/sectionId to exist in their lookup lists, and belongsToPersonId
// (when given) to resolve to a live member or a non-deleted person. These mirror the existing
// requireKnownLookupId convention (parseMemberWritableFields/handleListaWyjazdowaPutProfile): a
// never-valid id is rejected, but a retired id already in use on an existing item stays valid.
test('POST /equipment rejects a categoryId that is not in lookupLists', async () => {
  const deps = makeDeps({ firestore: makeEquipmentFirestore(), authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'nie-ma-takiej', sectionId: 'krakow', description: '', belongsToPersonId: null }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /equipment rejects a sectionId that is not in lookupLists', async () => {
  const deps = makeDeps({ firestore: makeEquipmentFirestore(), authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'namiot', sectionId: 'nie-ma-takiej', description: '', belongsToPersonId: null }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /equipment rejects a belongsToPersonId that resolves to neither a live member nor an existing person', async () => {
  const deps = makeDeps({ firestore: makeEquipmentFirestore(), listMemberEmails: async () => [], authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'namiot', sectionId: 'krakow', description: '', belongsToPersonId: 'nikt-taki@example.test' }),
    });
    assert.equal(res.status, 404);
  });
});

// The whole point of reusing requireKnownLookupId instead of a naive membership check: an item
// that already carries a since-retired categoryId must still be editable (e.g. changing only its
// description), not locked out because the category it already has is no longer offered for new
// selection.
test('PUT /equipment accepts a retired categoryId that the item already has', async () => {
  const firestore = makeEquipmentFirestore();
  const deps = makeDeps({ firestore, authenticate: async () => fakeSessionClaims({ email: 'ala@example.test' }) });
  let equipmentId = '';
  await withServer(deps, async baseUrl => {
    const postRes = await fetch(`${baseUrl}/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'namiot', sectionId: 'krakow', description: 'Stary namiot', belongsToPersonId: null }),
    });
    equipmentId = ((await postRes.json()) as { equipment: { id: string } }).equipment.id;
  });

  // Retire the category after the item was created, exactly like an admin editing lookupLists
  // directly in Firestore (design.md - no admin UI for this list).
  await firestore.setDoc('lookupLists', 'equipmentCategories', {
    items: [{ id: 'namiot', label: 'Namiot', retired: true }],
  });

  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/equipment?id=${equipmentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: 'namiot', sectionId: 'krakow', description: 'Stary namiot, opisany na nowo', belongsToPersonId: null }),
    });
    assert.equal(res.status, 200, 'a retired categoryId already on the item must still be accepted');
    const { equipment } = (await res.json()) as { equipment: { description: string } };
    assert.equal(equipment.description, 'Stary namiot, opisany na nowo');
  });
});
