import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthError } from './auth.ts';
import { createRequestListener, type ServerDeps } from './server.ts';
import type { DriveClient, DriveFileInfo } from './drive.ts';
import type { GithubClient } from './github.ts';
import { resetAboutUsBootstrapForTests } from './about-us.ts';

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
    },
    listFiles: async () => [],
    setFolderPublic: async () => {},
    deleteFolder: async () => {},
    writeManifest: async () => {},
    readManifest: async () => null,
    listGalleryFolders: async () => [],
    getCoverThumbnail: async () => null,
    findFolderByName: async () => null,
    ensureFolder: async () => 'ensured-folder-id',
    readTextFile: async () => null,
    writeTextFile: async () => {},
    listImageFiles: async () => [],
    ...overrides,
  };
}

function makeFakeGithub(overrides: Partial<GithubClient> = {}): GithubClient {
  return {
    appendAlbumToMain: async () => {},
    removeAlbumFromMain: async () => {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    drive: makeFakeDrive(),
    github: makeFakeGithub(),
    authenticate: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
    authenticateAdmin: async () => ({ sub: 'admin-1', email: 'admin@gmail.com' }),
    submissionTokenSecret: 'test-secret',
    driveParentFolderId: 'parent-1',
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

test('/galleries merges each discovered folder with its manifest, unauthenticated', async () => {
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
        if (parentId !== 'folder-Wojownicy') return [];
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
    const res = await fetch(`${baseUrl}/about-us?category=Wojownicy`);
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

test('GET /admin/whoami returns the admin email when authenticateAdmin succeeds', async () => {
  const deps = makeDeps({ authenticateAdmin: async () => ({ sub: 'a1', email: 'admin@gmail.com' }) });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'admin@gmail.com' });
  });
});

test('POST /admin/social-media/refresh requires admin auth and returns ok', async () => {
  let authenticatedAsAdmin = false;
  const deps = makeDeps({
    authenticateAdmin: async () => {
      authenticatedAsAdmin = true;
      return { sub: 'a1', email: 'admin@gmail.com' };
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
    authenticateAdmin: async () => {
      throw new AuthError('Brak uprawnień.', 403);
    },
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/admin/social-media/refresh`, { method: 'POST' });
    assert.equal(res.status, 403);
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
      body: JSON.stringify({ category: 'Wojownicy', name: 'Ragnar', order: 1, description: 'Krótki opis.' }),
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

test('POST /admin/people/photo streams an uploaded file into the person folder', async () => {
  let uploadedTo: string | undefined;
  const deps = makeDeps({
    drive: makeFakeDrive({
      uploadFileStream: async (folderId, _fileName, _mimeType, bodyStream) => {
        uploadedTo = folderId;
        for await (const _chunk of bodyStream) {
          // drain
        }
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
    authenticate: async () => {
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

test('/delete-drive-gallery rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticate: async () => {
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
