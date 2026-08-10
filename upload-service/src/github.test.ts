import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendAlbumToMain, buildUpdatedAlbumsJson } from './github.ts';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

test('buildUpdatedAlbumsJson appends a new entry and keeps existing ones untouched', () => {
  const current = JSON.stringify([{ url: 'https://drive.google.com/drive/folders/existing' }], null, 2) + '\n';
  const result = buildUpdatedAlbumsJson(current, {
    url: 'https://drive.google.com/drive/folders/new123',
    nameOverride: 'Wolin',
    dateOverride: '2026-08-09',
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], {
    url: 'https://drive.google.com/drive/folders/new123',
    nameOverride: 'Wolin',
    dateOverride: '2026-08-09',
  });
});

test('buildUpdatedAlbumsJson is a no-op when the URL already exists (idempotent finalize retry)', () => {
  const current = JSON.stringify([{ url: 'https://drive.google.com/drive/folders/new123', dateOverride: '2026-08-09' }], null, 2) + '\n';
  const result = buildUpdatedAlbumsJson(current, {
    url: 'https://drive.google.com/drive/folders/new123',
    dateOverride: '2026-08-09',
  });
  assert.equal(JSON.parse(result).length, 1);
});

test('buildUpdatedAlbumsJson omits nameOverride when not provided', () => {
  const result = buildUpdatedAlbumsJson('[]', { url: 'https://drive.google.com/drive/folders/abc', dateOverride: '2026-08-09' });
  const [entry] = JSON.parse(result);
  assert.equal('nameOverride' in entry, false);
});

test('appendAlbumToMain succeeds on the first attempt when nothing else has written concurrently', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, { content: Buffer.from('[]').toString('base64'), sha: 'sha-1' });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await appendAlbumToMain({ token: 't', repo: 'r/r' }, { url: 'https://x/1', dateOverride: '2026-08-09' }, fetchImpl);
  assert.equal(calls.length, 2);
});

test('appendAlbumToMain retries on a 409 conflict by re-fetching sha and writing again', async () => {
  let putAttempts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, { content: Buffer.from('[]').toString('base64'), sha: `sha-${putAttempts}` });
    }
    putAttempts++;
    if (putAttempts === 1) {
      return jsonResponse(409, { message: 'conflict' });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await appendAlbumToMain({ token: 't', repo: 'r/r' }, { url: 'https://x/1', dateOverride: '2026-08-09' }, fetchImpl);
  assert.equal(putAttempts, 2);
});

test('appendAlbumToMain gives up after the retry limit on persistent conflicts', async () => {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, { content: Buffer.from('[]').toString('base64'), sha: 'sha-x' });
    }
    return jsonResponse(409, { message: 'conflict' });
  }) as typeof fetch;

  await assert.rejects(
    appendAlbumToMain({ token: 't', repo: 'r/r' }, { url: 'https://x/1', dateOverride: '2026-08-09' }, fetchImpl),
  );
});
