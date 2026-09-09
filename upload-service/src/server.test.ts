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
import { listRoleAuditLog, createRoleAuthorizer } from './roles.ts';
import { executeAuditedFirestoreMutation, startExternalOperation, completeExternalOperation } from './audit.ts';

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
//
// NOTE: this does not fully eliminate the intermittent "wrong response for this request" flake
// this suite exhibits roughly 1 in 10-20 runs. Investigation (see the story's flake-fix report)
// traced it to at least two distinct causes, neither of which is fixable from inside this file:
// (1) other local processes on the development machine (confirmed: a Python debugpy/ptvsd
// debug adapter in an unrelated repo) occasionally emit non-HTTP data that collides with the
// ephemeral TCP ports Node's listen(0) hands out during this suite's ~180 rapid create/destroy
// cycles, and (2) a smaller number of clean-but-wrong-status responses that reproduce
// identically whether the client is undici's fetch() or a hand-rolled node:http client with no
// connection pooling at all, meaning it isn't specific to undici's pool. Kept anyway as correct
// practice independent of the flake.
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

test('POST /admin/people creates a numbered folder and writes the description', async () => {
  resetAboutUsBootstrapForTests();
  let createdFolderName: string | undefined;
  let writtenDescription: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      ensureFolder: async (_parent, name) => {
        if (name === 'Ragnar') createdFolderName = name;
        return `folder-${name}`;
      },
      createAlbumFolder: async (_parent, name) => {
        createdFolderName = name;
        return 'new-person-folder';
      },
      writeTextFile: async (_folderId, fileName, content) => {
        if (fileName === 'Opis.txt') writtenDescription = content;
      },
    }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'Blachowi', name: 'Ragnar', order: 1, description: 'Krótki opis.' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.folderId, 'new-person-folder');
  });
  assert.equal(createdFolderName, '1. Ragnar');
  assert.equal(writtenDescription, 'Krótki opis.');
});

test('POST /admin/people rejects an invalid category', async () => {
  resetAboutUsBootstrapForTests();
  const deps = makeDeps();
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'NieIstnieje', name: 'Ragnar', order: null, description: '' }),
    });
    assert.equal(res.status, 400);
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
  const renamedTo: Record<string, string> = {};
  const deps = makeDeps({
    drive: makeFakeDrive({
      listImageFiles: async () => [
        { id: 'photo-1', name: '!IMG_0001.jpg', thumbnailLink: null },
        { id: 'photo-2', name: 'IMG_0002.jpg', thumbnailLink: null },
      ],
      renameFolder: async (fileId, newName) => {
        renamedTo[fileId] = newName;
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
  assert.equal(renamedTo['photo-1'], 'IMG_0001.jpg');
  assert.equal(renamedTo['photo-2'], '!IMG_0002.jpg');
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
  const { entries } = await withServer(makeDeps({ firestore: client }), baseUrl =>
    fetch(`${baseUrl}/admin/roles/audit-log`).then(r => r.json()),
  );
  assert.deepEqual(entries, []);
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
  assert.deepEqual(await listRoleAuditLog(client), []);
  const [audit] = await client.listDocs<{ action: string; changes: Array<{ field: string; before: string; after: string }> }>('auditEvents');
  assert.equal(audit.data.action, 'role.revoked');
  assert.deepEqual(audit.data.changes, [{ field: 'roles', before: 'Księgowy', after: 'Brak', visibility: 'roleRestricted' }]);
});

test('GET /admin/roles/audit-log lists entries', async () => {
  const client = createInMemoryFirestoreClient();
  const deps = makeDeps({ firestore: client });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles/audit-log`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.entries, []);
  });
});

test('GET /admin/roles/audit-log rejects an unauthenticated caller', async () => {
  const deps = makeDeps({
    authenticateAdmin: async () => {
      throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/roles/audit-log`);
    assert.equal(res.status, 401);
  });
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
    authenticateAdminOrModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@example.com' }),
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
    authenticateAdminOrModeratorWithStepUp: async () => {
      throw new AuthError('Wymagane ponowne logowanie.', 401);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/members/synchronize`, { method: 'POST', headers: { origin: ALLOWED_ORIGIN_FOR_TESTS } });
    assert.equal(res.status, 401);
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
  const events = await firestore.listDocs('auditEvents');
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
  { method: 'POST', path: '/admin/people', stepUpDep: 'authenticateAdminWithStepUp' },
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
  { method: 'POST', path: '/admin/members/synchronize', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'PUT', path: '/admin/roles', stepUpDep: 'authenticateAdminWithStepUp' },
];

// The read-only counterparts - must keep working even when the step-up variant would reject,
// proving they call the plain (non-step-up) dep and aren't accidentally over-gated.
const READ_ONLY_ROUTES_SHARING_A_ROLE: { method: string; path: string; stepUpDep: keyof ServerDeps }[] = [
  { method: 'GET', path: '/admin/whoami', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/redirects', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/people', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/settings', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/members?status=active', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/members/whoami', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/lookup-lists', stepUpDep: 'authenticateAdminOrModeratorWithStepUp' },
  { method: 'GET', path: '/admin/roles', stepUpDep: 'authenticateAdminWithStepUp' },
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
      equipment: [],
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
      equipment: [],
      companions: [],
      wpisowePaid: true, // must be ignored — accountant/admin-only
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).profile.wpisowePaid, false);

    // ...and again on an update, where the stored value is what has to win.
    const updated = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
      weaponIds: ['wlocznik'],
      equipment: [],
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
  ['a non-array equipment', { weaponIds: [], equipment: 'x', companions: [] }],
  ['a non-array companions', { weaponIds: [], equipment: [], companions: { name: 'Jaś' } }],
  ['a non-array weaponIds', { weaponIds: 'tarczownik', equipment: [], companions: [] }],
  ['a non-object equipment entry', { weaponIds: [], equipment: [null], companions: [] }],
  ['a nameless equipment entry', { weaponIds: [], equipment: [{ id: '', name: '  ', description: '' }], companions: [] }],
  ['a nameless companion entry', { weaponIds: [], equipment: [], companions: [{ id: '', name: '' }] }],
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
      equipment: [],
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
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, {
      attending: true,
      equipmentIds: [],
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

test('PUT /lista-wyjazdowa/signups rejects an equipmentId that does not belong to the target member', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'wojownik@gmail.com');
  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    // wojownik@gmail.com has no listaWyjazdowaProfile yet in this fixture, so any equipmentId is "not theirs".
    const res = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`,
      { attending: true, equipmentIds: ['not-mine'], companionIds: [] },
    );
    assert.equal(res.status, 400);
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
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=inny@example.test`,
      { attending: true, equipmentIds: [], companionIds: [] },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signup.memberEmail, 'inny@example.test');
    assert.equal(body.signup.lastChangedBy, 'wojownik@gmail.com', 'lastChangedBy reflects the caller, not the target member');

    const auditRes = await fetch(`${baseUrl}/lista-wyjazdowa/signups/audit-log?eventId=${created.event.id}`);
    const auditBody = await auditRes.json();
    assert.deepEqual(auditBody.entries, []);
    const [audit] = await firestore.listDocs<{ action: string; actor: { email: string }; resource: { key: string } }>('auditEvents');
    assert.equal(audit.data.action, 'event.created');
    const signupAudit = (await firestore.listDocs<{ action: string; actor: { email: string }; resource: { key: string } }>('auditEvents'))
      .find(entry => entry.data.action === 'signup.created');
    assert.equal(signupAudit?.data.actor.email, 'wojownik@gmail.com');
    assert.equal(signupAudit?.data.resource.key, `signup:${created.event.id}:inny@example.test`);
  });
});

// The open-edit test above only exercises an empty equipmentIds/companionIds against a
// profile-less target, so it can't catch a handler bug that looks up the *caller's* profile
// instead of the *target's* (e.g. an accidental memberEmail -> identity.email swap in the
// getProfile call) - that bug would still pass every existing test since neither identity has a
// profile there. This test gives both a real, distinct target profile and a real, distinct
// caller profile with different equipment/companion ids, so the referential check is actually
// exercised against genuine data on both sides.
test("PUT /lista-wyjazdowa/signups validates equipment/companion ids against the target member's own profile, not the caller's", async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const targetEmail = 'inny@example.test';
  seedMember(firestore, targetEmail);

  // Register the target member's own profile - acting AS the target (not the caller) via a
  // separate authenticateWojownicyUpload override, same pattern used elsewhere in this file
  // (e.g. '/wojownicy-upload/whoami returns the caller's email once authenticated') for a second
  // test identity. Shares the same firestore instance across withServer calls so the write
  // persists into the next session.
  let targetEquipmentId = '';
  let targetCompanionId = '';
  await withServer(
    makeDeps({ firestore, authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'target-1', email: targetEmail }) }),
    async baseUrl => {
      const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
        weaponIds: [],
        equipment: [{ id: '', name: 'Namiot', description: '' }],
        companions: [{ id: '', name: 'Jan (syn)' }],
      });
      const body = await res.json();
      targetEquipmentId = body.profile.equipment[0].id;
      targetCompanionId = body.profile.companions[0].id;
    },
  );

  // Register the caller's own profile (wojownik@gmail.com - makeDeps()'s default
  // authenticateWojownicyUpload identity) with a *different* equipment item - its id is used
  // below as the negative case: it must not validate just because it happens to belong to some
  // real profile, only the target's.
  let callerEquipmentId = '';
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', {
      weaponIds: [],
      equipment: [{ id: '', name: 'Plecak', description: '' }],
      companions: [],
    });
    callerEquipmentId = (await res.json()).profile.equipment[0].id;
  });

  const deps = makeDeps({ firestore, listMemberEmails: async () => ['wojownik@gmail.com', targetEmail] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();

    // Positive case: the target's own real equipment/companion ids are accepted.
    const ok = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=${targetEmail}`,
      { attending: true, equipmentIds: [targetEquipmentId], companionIds: [targetCompanionId] },
    );
    assert.equal(ok.status, 200, "the target member's own equipment/companion ids must be accepted");

    // Negative case: the caller's own equipment id (not the target's) is rejected against that
    // same target - the case that would catch a memberEmail-for-identity.email swap regression.
    const rejected = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=${targetEmail}`,
      { attending: true, equipmentIds: [callerEquipmentId], companionIds: [] },
    );
    assert.equal(rejected.status, 400, "the caller's own equipment id must not validate against a different target member");
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
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=nikt@example.test`,
      { attending: true, equipmentIds: [], companionIds: [] },
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
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=bezdokumentu@example.test`,
      { attending: true, equipmentIds: [], companionIds: [] },
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
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: ['tarczownik'], equipment: [], companions: [] });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/roster`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roster.length, 1);
    assert.equal(body.roster[0].fullName, 'Ala Kowalska');
    assert.deepEqual(body.roster[0].weaponIds, ['tarczownik']);
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
    assert.equal(noProfile.hasProfile, false);
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
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, {
      attending: true,
      equipmentIds: [],
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
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, {
      attending: true,
      equipmentIds: [],
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
  await withServer(makeDeps({ firestore: makeListaWyjazdowaFirestore() }), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: false });
  });
  await withServer(makeDepsWithRole('accountant'), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: true });
  });
  await withServer(makeDepsWithRole('admin'), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/my-role`);
    assert.deepEqual(await res.json(), { canManageSkladki: true });
  });
});

test('PUT /lista-wyjazdowa/events with skladkaFee requires accountant, 403 for a plain member', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDeps({ firestore });
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

test('PUT /lista-wyjazdowa/signups/skladka requires accountant and 404s for a member with no signup', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, { paid: true });
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, { paid: true });
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
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, {
      attending: true, equipmentIds: [], companionIds: [],
    });
    const res = await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/signups/skladka?eventId=${created.event.id}&memberEmail=wojownik@gmail.com`, { paid: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).signup.skladkaPaid, true);
  });
});

test('PUT /lista-wyjazdowa/wpisowe requires accountant and 404s without a profile', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=wojownik@gmail.com', { paid: true });
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=wojownik@gmail.com', { paid: true });
    assert.equal(res.status, 404);
  });
});

test('PUT /lista-wyjazdowa/wpisowe succeeds for accountant against an existing profile', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    // makeDepsWithRole's caller (wojownik@gmail.com) is itself the accountant here, so it can
    // create its own listaWyjazdowaProfile via the self-service PUT before targeting that same
    // email with the accountant-only wpisowe toggle.
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], equipment: [], companions: [] });
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=wojownik@gmail.com', { paid: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).profile.wpisowePaid, true);
  });
});

test('PUT /lista-wyjazdowa/dues requires accountant, validates member exists, and GET reflects it for the right year', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=wojownik@gmail.com&year=2027', { paid: true });
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const unknown = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=nikt@example.test&year=2027', { paid: true });
    assert.equal(unknown.status, 404);

    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=wojownik@gmail.com&year=2027', { paid: true });
    assert.equal(res.status, 200);

    const getRes = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2027`);
    const body = await getRes.json();
    assert.equal(body.dues.length, 1);
    assert.equal(body.dues[0].paid, true);

    const wrongYear = await fetch(`${baseUrl}/lista-wyjazdowa/dues?year=2026`);
    assert.deepEqual((await wrongYear.json()).dues, []);
  });
});

test('GET /lista-wyjazdowa/dues/audit-log retains readable legacy entries while new dues writes are canonical', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], equipment: [], companions: [] });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=wojownik@gmail.com', { paid: true });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=wojownik@gmail.com&year=2027', { paid: true });
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, `/lista-wyjazdowa/events?eventId=${created.event.id}`, { skladkaFee: '50 zł' });

    firestore.seed('duesAuditLog', 'legacy-entry-fee', {
      context: 'wpisowe', targetMemberEmail: 'legacy@example.test', eventId: null, eventName: null, year: null,
      changedBy: 'legacy-admin@example.test', changedAt: '2026-01-01T00:00:00.000Z', changeSummary: 'legacy wpisowe',
    });
    firestore.seed('duesAuditLog', 'legacy-annual', {
      context: 'roczna', targetMemberEmail: 'legacy@example.test', eventId: null, eventName: null, year: 2026,
      changedBy: 'legacy-admin@example.test', changedAt: '2026-01-02T00:00:00.000Z', changeSummary: 'legacy roczna',
    });
    firestore.seed('duesAuditLog', 'legacy-event', {
      context: 'eventFee', targetMemberEmail: null, eventId: 'legacy-event', eventName: 'Legacy', year: null,
      changedBy: 'legacy-admin@example.test', changedAt: '2026-01-03T00:00:00.000Z', changeSummary: 'legacy event fee',
    });

    const res = await fetch(`${baseUrl}/lista-wyjazdowa/dues/audit-log`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.entries.length, 3);
    assert.equal(body.entries[0].context, 'wpisowe');
    assert.equal(body.entries[0].targetMemberEmail, 'legacy@example.test');
    assert.equal(body.entries[1].context, 'roczna');
    assert.equal(body.entries[1].year, 2026);
    assert.equal(body.entries[2].context, 'eventFee');
    assert.equal(body.entries[2].eventId, 'legacy-event');
    assert.equal(body.entries[2].eventName, 'Legacy');
    assert.equal(body.entries[2].changeSummary, 'legacy event fee');
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
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/dues/audit-log`);
    assert.deepEqual((await res.json()).entries, []);
  });
});

test('GET /lista-wyjazdowa/dues/audit-log requires accountant, 403 for a plain member (KRKG-0047)', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  await withServer(makeDeps({ firestore }), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/dues/audit-log`);
    assert.equal(res.status, 403);
  });
  await withServer(makeDepsWithRole('accountant', firestore), async baseUrl => {
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/dues/audit-log`);
    assert.equal(res.status, 200);
  });
});

test('PUT /lista-wyjazdowa/dues can set/clear amount independently of paid with canonical audit entries', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  const deps = makeDepsWithRole('accountant', firestore);
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });

    const res = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=wojownik@gmail.com&year=2027', { amount: '100 zł' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dues.amount, '100 zł');
    assert.equal(body.dues.paid, false, 'paid must be untouched when only amount is sent');

    const toggled = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=wojownik@gmail.com&year=2027', { paid: true });
    assert.equal((await toggled.json()).dues.amount, '100 zł', 'amount must be untouched when only paid is sent');

    const auditRes = await fetch(`${baseUrl}/lista-wyjazdowa/dues/audit-log`);
    const entries = (await auditRes.json()).entries;
    assert.deepEqual(entries, []);
    const canonical = (await firestore.listDocs<{ action: string; changes: Array<{ field: string; after: string | boolean }> }>('auditEvents'))
      .filter(entry => entry.data.action === 'dues.annual.changed');
    assert.equal(canonical.length, 2);
    assert.deepEqual(canonical[0].data.changes, [{ field: 'amount', after: '100 zł', visibility: 'roleRestricted' }]);
    assert.deepEqual(canonical[1].data.changes, [{ field: 'paid', before: false, after: true, visibility: 'roleRestricted' }]);
  });
});

test('GET /lista-wyjazdowa/roster includes wpisowePaid per member', async () => {
  const deps = makeDeps({ firestore: makeListaWyjazdowaFirestore(), listMemberEmails: async () => ['wojownik@gmail.com'] });
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Ala Kowalska', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], equipment: [], companions: [] });
    const res = await fetch(`${baseUrl}/lista-wyjazdowa/roster`);
    const body = await res.json();
    assert.equal(body.roster[0].wpisowePaid, false);
    assert.equal(body.roster[0].hasProfile, true);
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
      `/lista-wyjazdowa/signups?eventId=${event.id}&memberEmail=wojownik@gmail.com`,
      { attending: true, equipmentIds: [], companionIds: [] },
    );
    assert.equal(signup.status, 200);

    const paid = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups/skladka?eventId=${event.id}&memberEmail=wojownik@gmail.com`,
      { paid: true },
    );
    assert.equal(paid.status, 200);

    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], equipment: [], companions: [] });
    const entryFee = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=wojownik@gmail.com', { paid: true });
    assert.equal(entryFee.status, 200);

    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Wojownik', sectionId: 'krakow' });
    const annualDue = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/dues?memberEmail=wojownik@gmail.com&year=2027', {
      paid: true,
      amount: '100 zł',
    });
    assert.equal(annualDue.status, 200);

    const auditEvents = (await firestore.listDocs('auditEvents')).map(doc => doc.data as {
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
      { field: 'equipmentCount', after: 0, visibility: 'memberVisible' },
      { field: 'companionCount', after: 0, visibility: 'memberVisible' },
    ]);
    assert.equal(byAction.get('dues.event_fee.changed')?.audience, 'adminOrAccountant');
    assert.equal(byAction.get('dues.entry_fee.changed')?.changes[0]?.field, 'paid');
    assert.deepEqual(byAction.get('dues.annual.changed')?.changes, [
      { field: 'paid', after: true, visibility: 'roleRestricted' },
      { field: 'amount', after: '100 zł', visibility: 'roleRestricted' },
    ]);
    assert.equal((await firestore.listDocs('signupAuditLog')).length, 0);
    assert.equal((await firestore.listDocs('duesAuditLog')).length, 0);
    assert.equal((await firestore.listDocs('rolesAuditLog')).length, 0);
  });
});

// wpisowePaid alone cannot express "there is no profile document to record this on", and the
// Składki page needs that distinction: PUT /lista-wyjazdowa/wpisowe is a 404 for a member with no
// listaWyjazdowaProfile, so the page must not offer a toggle for one. Both members below report
// wpisowePaid: false; only hasProfile tells them apart.
test('GET /lista-wyjazdowa/roster reports hasProfile: false for a member with no listaWyjazdowaProfile', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'bezprofilu@example.test');
  const deps = makeDepsWithRole('accountant', firestore, {
    listMemberEmails: async () => ['wojownik@gmail.com', 'bezprofilu@example.test'],
  });
  await withServer(deps, async baseUrl => {
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/member', { fullName: 'Ala Kowalska', sectionId: 'krakow' });
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/profile', { weaponIds: [], equipment: [], companions: [] });

    const body = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    const withProfile = body.roster.find((r: { email: string }) => r.email === 'wojownik@gmail.com');
    const withoutProfile = body.roster.find((r: { email: string }) => r.email === 'bezprofilu@example.test');
    assert.equal(withProfile.hasProfile, true);
    assert.equal(withProfile.wpisowePaid, false);
    assert.equal(withoutProfile.hasProfile, false, 'a member with no profile document must be distinguishable');
    assert.equal(withoutProfile.wpisowePaid, false, 'and still reports the same wpisowePaid as an unpaid member with a profile');

    // The 404 that hasProfile: false exists to keep the UI from walking into.
    const toggled = await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=bezprofilu@example.test', { paid: true });
    assert.equal(toggled.status, 404);

    // And that refusal must leave no partial profile document behind: a listaWyjazdowaProfile with
    // only wpisowePaid on it would have no equipment array for PUT /lista-wyjazdowa/signups to read.
    const after = await (await fetch(`${baseUrl}/lista-wyjazdowa/roster`)).json();
    assert.equal(after.roster.find((r: { email: string }) => r.email === 'bezprofilu@example.test').hasProfile, false);
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

// The reason setWpisowePaid must never upsert: a signup for a profile-less member is legitimate and
// reads targetProfile.equipment/companions. A profile document containing only wpisowePaid would
// make that read a TypeError (500) instead of the clean 200 below.
test('PUT /lista-wyjazdowa/signups still works for a member with no listaWyjazdowaProfile', async () => {
  const firestore = makeListaWyjazdowaFirestore();
  seedMember(firestore, 'bezprofilu@example.test');
  const deps = makeDepsWithRole('accountant', firestore, { listMemberEmails: async () => ['bezprofilu@example.test'] });
  await withServer(deps, async baseUrl => {
    const created = await (await postListaWyjazdowa(baseUrl, '/lista-wyjazdowa/events', { name: 'Zjazd', startDate: '2027-05-01' })).json();
    await putListaWyjazdowa(baseUrl, '/lista-wyjazdowa/wpisowe?memberEmail=bezprofilu@example.test', { paid: true });
    const res = await putListaWyjazdowa(
      baseUrl,
      `/lista-wyjazdowa/signups?eventId=${created.event.id}&memberEmail=bezprofilu@example.test`,
      { attending: true, equipmentIds: [], companionIds: [] },
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

    const events = (await firestore.listDocs('auditEvents')).map(doc => doc.data as { action: string; changes: Array<{ field: string }> });
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

    // Each of the five selector shapes is independently accepted (zero-or-one primary selector).
    const byCategory = await fetch(`${baseUrl}/admin/audyt/events?category=events`);
    assert.equal(byCategory.status, 200);
    const byCategoryAction = await fetch(`${baseUrl}/admin/audyt/events?category=events&action=event.created`);
    assert.equal(byCategoryAction.status, 200);
    const byActor = await fetch(`${baseUrl}/admin/audyt/events?actorEmail=maja@example.test`);
    assert.equal(byActor.status, 200);
    const byResource = await fetch(`${baseUrl}/admin/audyt/events?resourceKey=event:evt-a`);
    assert.equal(byResource.status, 200);
    const byQuery = await fetch(`${baseUrl}/admin/audyt/events?q=evt`);
    assert.equal(byQuery.status, 200);

    // A primary selector still composes with date-range and cursor query params, and combining
    // two of the other primary-selector kinds is rejected regardless of which two.
    const withDateRange = await fetch(`${baseUrl}/admin/audyt/events?actorEmail=maja@example.test&from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z`);
    assert.equal(withDateRange.status, 200);
    const resourceAndQuery = await fetch(`${baseUrl}/admin/audyt/events?resourceKey=event:evt-a&q=evt`);
    assert.equal(resourceAndQuery.status, 400);
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

test('GET /admin/audyt/event returns 404 for an id the viewer cannot see, and the projected row otherwise', async () => {
  const firestore = createInMemoryFirestoreClient();
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'dues.annual.changed', actor: { email: 'skarbnik@example.test' }, resource: { kind: 'due', key: 'due:ula@example.test:2026', display: 'Ula 2026' }, changes: [{ field: 'paid', after: true }] },
    async () => {},
    { createId: () => 'evt-dues', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  // A moderator-only (non-admin) viewer cannot see the dues category.
  const firestoreWithModerator = firestore;
  await firestoreWithModerator.setDoc('userRoles', 'wojownik@gmail.com', { roles: ['moderator'] });
  const deps = makeDeps({
    firestore,
    authenticate: async () => fakeSessionClaims({ sub: 'mod-1', email: 'wojownik@gmail.com' }),
    authenticateAdmin: async () => { throw new AuthError('Brak uprawnień.', 403); },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/audyt/event?id=evt-dues`);
    assert.equal(res.status, 404);
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
