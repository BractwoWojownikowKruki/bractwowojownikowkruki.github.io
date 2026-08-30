import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendAlbumToMain,
  appendRedirectToMain,
  buildAlbumsJsonWithout,
  buildRedirectsJsonWithout,
  buildUpdatedAlbumsJson,
  buildUpdatedRedirectsJson,
  fetchRedirectsJson,
  isValidRedirectPath,
  isValidRedirectTarget,
  removeAlbumFromMain,
  removeRedirectFromMain,
} from './github.ts';

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

test('buildAlbumsJsonWithout removes the matching entry and keeps the rest untouched', () => {
  const current = JSON.stringify([
    { url: 'https://x/1', dateOverride: '2026-08-09' },
    { url: 'https://x/2', dateOverride: '2026-08-10' },
  ], null, 2) + '\n';
  const result = buildAlbumsJsonWithout(current, 'https://x/1');
  const parsed = JSON.parse(result);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, 'https://x/2');
});

test('buildAlbumsJsonWithout is a no-op when the URL is not present (idempotent retry)', () => {
  const current = JSON.stringify([{ url: 'https://x/1', dateOverride: '2026-08-09' }], null, 2) + '\n';
  const result = buildAlbumsJsonWithout(current, 'https://x/does-not-exist');
  assert.equal(result, current);
});

test('removeAlbumFromMain succeeds on the first attempt when nothing else has written concurrently', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, { content: Buffer.from(JSON.stringify([{ url: 'https://x/1', dateOverride: '2026-08-09' }])).toString('base64'), sha: 'sha-1' });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await removeAlbumFromMain({ token: 't', repo: 'r/r' }, 'https://x/1', fetchImpl);
  assert.equal(calls.length, 2);
});

test('removeAlbumFromMain retries on a 409 conflict by re-fetching sha and writing again', async () => {
  let putAttempts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, { content: Buffer.from(JSON.stringify([{ url: 'https://x/1', dateOverride: '2026-08-09' }])).toString('base64'), sha: `sha-${putAttempts}` });
    }
    putAttempts++;
    if (putAttempts === 1) {
      return jsonResponse(409, { message: 'conflict' });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await removeAlbumFromMain({ token: 't', repo: 'r/r' }, 'https://x/1', fetchImpl);
  assert.equal(putAttempts, 2);
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

test('isValidRedirectPath accepts lowercase slugs with digits and hyphens', () => {
  assert.equal(isValidRedirectPath('discord'), true);
  assert.equal(isValidRedirectPath('kruczy-turniej-2026'), true);
});

test('isValidRedirectPath rejects uppercase, slashes, and empty strings', () => {
  assert.equal(isValidRedirectPath('Discord'), false);
  assert.equal(isValidRedirectPath('discord/invite'), false);
  assert.equal(isValidRedirectPath(''), false);
  assert.equal(isValidRedirectPath('-discord'), false);
  assert.equal(isValidRedirectPath('discord-'), false);
});

test('isValidRedirectPath rejects aliases reserved by existing top-level site pages', () => {
  assert.equal(isValidRedirectPath('galerie'), false);
  assert.equal(isValidRedirectPath('admin'), false);
});

test('isValidRedirectTarget accepts absolute http(s) URLs', () => {
  assert.equal(isValidRedirectTarget('https://discord.gg/abc123'), true);
  assert.equal(isValidRedirectTarget('http://example.com'), true);
});

test('isValidRedirectTarget rejects non-http(s) schemes and malformed URLs', () => {
  assert.equal(isValidRedirectTarget('javascript:alert(1)'), false);
  assert.equal(isValidRedirectTarget('not-a-url'), false);
  assert.equal(isValidRedirectTarget(''), false);
});

test('buildUpdatedRedirectsJson appends a new entry and keeps existing ones untouched', () => {
  const current = JSON.stringify([{ path: 'facebook', target: 'https://facebook.com/kruki' }], null, 2) + '\n';
  const result = buildUpdatedRedirectsJson(current, { path: 'discord', target: 'https://discord.gg/abc123' });
  const parsed = JSON.parse(result);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], { path: 'discord', target: 'https://discord.gg/abc123' });
});

test('buildUpdatedRedirectsJson replaces the target when the alias already exists', () => {
  const current = JSON.stringify([{ path: 'discord', target: 'https://discord.gg/old' }], null, 2) + '\n';
  const result = buildUpdatedRedirectsJson(current, { path: 'discord', target: 'https://discord.gg/new' });
  const parsed = JSON.parse(result);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { path: 'discord', target: 'https://discord.gg/new' });
});

test('buildRedirectsJsonWithout removes the matching entry and keeps the rest untouched', () => {
  const current = JSON.stringify([
    { path: 'discord', target: 'https://discord.gg/abc123' },
    { path: 'facebook', target: 'https://facebook.com/kruki' },
  ], null, 2) + '\n';
  const result = buildRedirectsJsonWithout(current, 'discord');
  const parsed = JSON.parse(result);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'facebook');
});

test('buildRedirectsJsonWithout is a no-op when the alias is not present (idempotent retry)', () => {
  const current = JSON.stringify([{ path: 'discord', target: 'https://discord.gg/abc123' }], null, 2) + '\n';
  const result = buildRedirectsJsonWithout(current, 'does-not-exist');
  assert.equal(result, current);
});

test('fetchRedirectsJson reads and parses redirects.json from GitHub', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      content: Buffer.from(JSON.stringify([{ path: 'discord', target: 'https://discord.gg/abc123' }])).toString('base64'),
      sha: 'sha-1',
    })) as typeof fetch;

  const entries = await fetchRedirectsJson({ token: 't', repo: 'r/r' }, fetchImpl);
  assert.deepEqual(entries, [{ path: 'discord', target: 'https://discord.gg/abc123' }]);
});

test('appendRedirectToMain succeeds on the first attempt when nothing else has written concurrently', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, { content: Buffer.from('[]').toString('base64'), sha: 'sha-1' });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await appendRedirectToMain({ token: 't', repo: 'r/r' }, { path: 'discord', target: 'https://discord.gg/abc123' }, fetchImpl);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('contents/redirects.json'));
});

test('removeRedirectFromMain retries on a 409 conflict by re-fetching sha and writing again', async () => {
  let putAttempts = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      return jsonResponse(200, {
        content: Buffer.from(JSON.stringify([{ path: 'discord', target: 'https://discord.gg/abc123' }])).toString('base64'),
        sha: `sha-${putAttempts}`,
      });
    }
    putAttempts++;
    if (putAttempts === 1) {
      return jsonResponse(409, { message: 'conflict' });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await removeRedirectFromMain({ token: 't', repo: 'r/r' }, 'discord', fetchImpl);
  assert.equal(putAttempts, 2);
});
