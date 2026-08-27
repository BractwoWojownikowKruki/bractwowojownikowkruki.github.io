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
    authenticateWojownicyUpload: async () => ({ sub: 'wojownik-1', email: 'wojownik@gmail.com' }),
    authenticateModerator: async () => ({ sub: 'moderator-1', email: 'moderator@gmail.com' }),
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
    authenticateModerator: async () => {
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
    authenticate: async () => ({ sub: 'member-1', email: 'member@gmail.com' }),
    authenticateModerator: async () => {
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

test('/delete-drive-gallery rejects an unauthenticated caller before touching Drive', async () => {
  let driveCalled = false;
  const deps = makeDeps({
    authenticateModerator: async () => {
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
    authenticate: async () => ({ sub: 'member-1', email: 'member@gmail.com' }),
    authenticateModerator: async () => {
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
    authenticate: async () => ({ sub: 'sub-1', email: 'alice@gmail.com', name: 'Alice', picture: 'https://example.com/a.jpg' }),
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
    authenticate: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
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
    authenticate: async () => ({ sub: 'sub-1', email: 'alice@gmail.com' }),
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
    authenticateWojownicyUpload: async () => ({ sub: 'sub-1', email: 'ktos@gmail.com' }),
  });
  await withServer(deps, async baseUrl => {
    const res = await fetch(`${baseUrl}/wojownicy-upload/whoami`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'ktos@gmail.com' });
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
    authenticateWojownicyUpload: async () => ({ sub: 'sub-1', email: 'ktos@gmail.com' }),
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
    authenticateWojownicyUpload: async () => ({ sub: 'sub-1', email: 'ktos@gmail.com' }),
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
    authenticateWojownicyUpload: async () => ({ sub: 'sub-1', email: 'ktos@gmail.com' }),
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
