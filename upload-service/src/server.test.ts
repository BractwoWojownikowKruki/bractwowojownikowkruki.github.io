import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthError } from './auth.ts';
import { createRequestListener, readSessionCookie, verifySessionRequest, type ServerDeps, type SessionVerifyConfig } from './server.ts';
import { issueSessionToken, verifySessionToken, type SessionClaims, type SessionSigningKey } from './session.ts';
import type { SheetAllowlist } from './allowlist.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DriveClient, DriveFileInfo } from './drive.ts';
import type { GithubClient } from './github.ts';
import { resetAboutUsBootstrapForTests } from './about-us.ts';
import { resetSettingsBootstrapForTests } from './settings.ts';
import { resetRateLimitForTests } from './rate-limit.ts';

// Every real caller has sent Origin on every state-changing request since Phase 0 made
// www.kruki.org -> api.kruki.org cross-origin (cross-origin fetches always include it) - the
// central requireAllowedOrigin guard in server.ts relies on that. Defaulting it here means the
// ~150 test call sites written before that guard existed don't each need updating individually;
// `rawFetch` is the escape hatch for the handful of tests that specifically exercise the guard
// itself (missing Origin) - a test that sets its own Origin header (e.g. a wrong one) doesn't
// need it, since an explicit header is never overridden below.
const rawFetch = globalThis.fetch;
const ALLOWED_ORIGIN_FOR_TESTS = 'https://example.test'; // matches makeDeps()'s allowedOrigin

async function fetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has('Origin')) {
    headers.set('Origin', ALLOWED_ORIGIN_FOR_TESTS);
  }
  return rawFetch(url, { ...options, headers });
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
    renameFolder: async () => {},
    moveFolder: async () => ({ name: 'Test Person' }),
    moveFile: async () => {},
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
    authenticate: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    authenticateWithStepUp: async () => fakeSessionClaims({ sub: 'sub-1', email: 'alice@gmail.com' }),
    authenticateAdmin: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@gmail.com' }),
    authenticateAdminWithStepUp: async () => fakeSessionClaims({ sub: 'admin-1', email: 'admin@gmail.com' }),
    authenticateWojownicyUpload: async () => fakeSessionClaims({ sub: 'wojownik-1', email: 'wojownik@gmail.com' }),
    authenticateModerator: async () => fakeSessionClaims({ sub: 'moderator-1', email: 'moderator@gmail.com' }),
    authenticateModeratorWithStepUp: async () => fakeSessionClaims({ sub: 'moderator-1', email: 'moderator@gmail.com' }),
    authenticateSessionLogin: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
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
    () => verifySessionRequest(fakeRequestWithSessionCookie(null), res, SESSION_CONFIG, fakeAllowlist(['alice@gmail.com'])),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionRequest returns the session claims for a valid, allowlisted cookie', async () => {
  const now = Date.now();
  const token = issueSessionToken({ sub: 'sub-1', email: 'alice@gmail.com' }, SESSION_KEY, now, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res, setCookie } = fakeResponseRecordingHeaders();
  const claims = await verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fakeAllowlist(['alice@gmail.com']));
  assert.equal(claims.sub, 'sub-1');
  assert.equal(claims.email, 'alice@gmail.com');
  assert.equal(setCookie(), undefined); // not yet due for renewal - no Set-Cookie written
});

test('verifySessionRequest rejects a caller who is no longer on the allowlist', async () => {
  const now = Date.now();
  const token = issueSessionToken({ sub: 'sub-1', email: 'removed@gmail.com' }, SESSION_KEY, now, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res } = fakeResponseRecordingHeaders();
  await assert.rejects(
    () => verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fakeAllowlist(['alice@gmail.com'])),
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
    () => verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fakeAllowlist(['alice@gmail.com'])),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
  assert.equal(setCookie(), undefined);
});

test('verifySessionRequest rejects a malformed/expired cookie the same way verifySessionToken would', async () => {
  const { res } = fakeResponseRecordingHeaders();
  await assert.rejects(
    () => verifySessionRequest(fakeRequestWithSessionCookie('not-a-valid-token'), res, SESSION_CONFIG, fakeAllowlist(['alice@gmail.com'])),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('verifySessionRequest renews the cookie past the halfway point of the sliding window, preserving identity', async () => {
  const issuedAt = Date.now() - (SESSION_CONFIG.sessionSlidingWindowMs / 2 + 1000);
  const token = issueSessionToken({ sub: 'sub-1', email: 'alice@gmail.com' }, SESSION_KEY, issuedAt, SESSION_CONFIG.sessionSlidingWindowMs);
  const { res, setCookie } = fakeResponseRecordingHeaders();
  const claims = await verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, fakeAllowlist(['alice@gmail.com']));
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
  await verifySessionRequest(fakeRequestWithSessionCookie(token), res, SESSION_CONFIG, allowlist, { forceRefresh: true });
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

test('POST /session/login passes through an AuthError from authenticateSessionLogin (e.g. not on the allowlist)', async () => {
  const deps = makeDeps({
    authenticateSessionLogin: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
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

test('GET /moderator/whoami returns the moderator email when authenticateModerator succeeds', async () => {
  const deps = makeDeps({ authenticateModerator: async () => fakeSessionClaims({ sub: 'm1', email: 'moderator@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/moderator/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'moderator@gmail.com' });
  });
});

test('GET /moderator/whoami rejects a caller who is not a moderator', async () => {
  const deps = makeDeps({
    authenticateModerator: async () => {
      throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/moderator/whoami`);
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
    const res = await fetch(`${baseUrl}/admin/people/photo?fileId=photo-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
  });
  assert.equal(deletedId, 'photo-1');
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
    authenticateModeratorWithStepUp: async () => {
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
test('/unregister rejects a caller who passes the general allowlist but not the moderator one', async () => {
  let githubCalled = false;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'member-1', email: 'member@gmail.com' }),
    authenticateModeratorWithStepUp: async () => {
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
  const deps = makeDeps({
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
  const deps = makeDeps({
    github: makeFakeGithub({ removeRedirectFromMain: async path => { removedPath = path; } }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/redirects?path=discord`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.deepEqual(body, { ok: true });
    assert.equal(removedPath, 'discord');
  });
});

test('/delete-drive-gallery rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticateModeratorWithStepUp: async () => {
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

// KRKG-0027: an ordinary allowlisted kruki-group member (passes the general `authenticate`,
// used elsewhere for upload/register) must NOT be able to delete a gallery just by being on
// that broader list - only someone the narrower authenticateModerator gate accepts can.
test('/delete-drive-gallery rejects a caller who passes the general allowlist but not the moderator one', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticate: async () => fakeSessionClaims({ sub: 'member-1', email: 'member@gmail.com' }),
    authenticateModeratorWithStepUp: async () => {
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
  const deps = makeDeps({ drive: makeFakeDrive({ createAlbumFolder: async () => 'folder-created-by-start' }) });
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
  const deps = makeDeps({
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
});

test('/finalize fails before granting public access when writing the manifest fails', async () => {
  let madePublic = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: 10 }],
      writeManifest: async () => {
        throw new Error('Drive is down');
      },
      setFolderPublic: async () => { madePublic = true; },
    }),
  });
  const folderId = uniqueFolderId();
  await withServer(deps, async baseUrl => {
    const token = await issueTestSubmissionToken(deps, folderId);
    const res = await fetch(`${baseUrl}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Submission-Token': token },
      body: JSON.stringify({ folderId, date: '2026-08-09' }),
    });
    assert.equal(res.status, 500);
    assert.equal(madePublic, false);
  });
});

test('/finalize succeeds, publishes the folder, and does not touch GitHub', async () => {
  let madePublic = false;
  let githubCalled = false;
  const deps = makeDeps({
    drive: makeFakeDrive({
      listFiles: async () => [{ name: 'a.jpg', size: 10 }],
      setFolderPublic: async () => { madePublic = true; },
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
    assert.equal(madePublic, true);
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
  const deps = makeDeps({
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
  const deps = makeDeps({
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
      `${baseUrl}/wojownicy-upload/photo?folderId=${folderId}&fileName=IMG_1234.jpg&mimeType=image/jpeg&isMain=true`,
      { method: 'POST', headers: { 'X-Submission-Token': token }, body: VALID_JPEG_BYTES },
    );
    assert.equal(res.status, 200);
    assert.equal(uploadedName, '!main.jpg');
  });
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
// authenticateAdmin/authenticateModerator-gated *mutation*, plus the one member-level case
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
  { method: 'POST', path: '/delete-drive-gallery', stepUpDep: 'authenticateModeratorWithStepUp' },
  { method: 'POST', path: '/unregister', stepUpDep: 'authenticateModeratorWithStepUp' },
  { method: 'POST', path: '/gallery-photos/start', stepUpDep: 'authenticateWithStepUp' },
];

// The read-only counterparts - must keep working even when the step-up variant would reject,
// proving they call the plain (non-step-up) dep and aren't accidentally over-gated.
const READ_ONLY_ROUTES_SHARING_A_ROLE: { method: string; path: string; stepUpDep: keyof ServerDeps }[] = [
  { method: 'GET', path: '/admin/whoami', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/redirects', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/people', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/admin/settings', stepUpDep: 'authenticateAdminWithStepUp' },
  { method: 'GET', path: '/moderator/whoami', stepUpDep: 'authenticateModeratorWithStepUp' },
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
