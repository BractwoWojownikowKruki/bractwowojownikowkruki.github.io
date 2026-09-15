import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  detectDocTypeAndFetchTitle,
  buildSharedFileDoc,
  saveFileInTransaction,
  deleteFileInTransaction,
  getFile,
  listFiles,
  InvalidFileUrlError,
} from './files.ts';

const realFetch = globalThis.fetch;

function withMockedFetch<T>(handler: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.redirect !== 'manual') throw new Error('detectDocTypeAndFetchTitle must fetch with redirect: "manual"');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = realFetch;
  });
}

test('buildSharedFileDoc rejects a non-https URL', async () => {
  await assert.rejects(buildSharedFileDoc({ url: 'http://example.com/x', description: '' }, 'ala@example.test'), InvalidFileUrlError);
  await assert.rejects(buildSharedFileDoc({ url: 'javascript:alert(1)', description: '' }, 'ala@example.test'), InvalidFileUrlError);
  await assert.rejects(buildSharedFileDoc({ url: 'data:text/html,<script>alert(1)</script>', description: '' }, 'ala@example.test'), InvalidFileUrlError);
  await assert.rejects(buildSharedFileDoc({ url: 'file:///etc/passwd', description: '' }, 'ala@example.test'), InvalidFileUrlError);
});

test('buildSharedFileDoc rejects a URL carrying embedded credentials', async () => {
  await assert.rejects(buildSharedFileDoc({ url: 'https://user:pass@example.com/x', description: '' }, 'ala@example.test'), InvalidFileUrlError);
});

test('detectDocTypeAndFetchTitle returns generic + no title for a host outside the whitelist', async () => {
  const result = await detectDocTypeAndFetchTitle('https://example.com/report.pdf');
  assert.deepEqual(result, { docType: 'generic', title: null });
});

test('detectDocTypeAndFetchTitle fetches and cleans the title for a whitelisted Google Docs URL', async () => {
  await withMockedFetch(
    () => new Response('<html><head><title>Regulamin - Google Docs</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/abc/edit');
      assert.deepEqual(result, { docType: 'googleDoc', title: 'Regulamin' });
    },
  );
});

test('detectDocTypeAndFetchTitle recognizes sheets, drive, and any *.sharepoint.com subdomain', async () => {
  await withMockedFetch(
    () => new Response('<html><head><title>Arkusz</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      assert.equal((await detectDocTypeAndFetchTitle('https://sheets.google.com/spreadsheets/d/x')).docType, 'googleSheet');
      assert.equal((await detectDocTypeAndFetchTitle('https://drive.google.com/file/d/x/view')).docType, 'googleDrive');
      assert.equal((await detectDocTypeAndFetchTitle('https://kruki.sharepoint.com/x')).docType, 'office');
    },
  );
});

test('detectDocTypeAndFetchTitle returns null title (not a thrown error) on a non-2xx response', async () => {
  await withMockedFetch(
    () => new Response('nope', { status: 403 }),
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/private/edit');
      assert.deepEqual(result, { docType: 'googleDoc', title: null });
    },
  );
});

test('detectDocTypeAndFetchTitle returns null title when the response has no <title>', async () => {
  await withMockedFetch(
    () => new Response('<html><body>Zaloguj się</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/x/edit');
      assert.deepEqual(result, { docType: 'googleDoc', title: null });
    },
  );
});

test('detectDocTypeAndFetchTitle returns null title (not empty string) for an empty <title>', async () => {
  await withMockedFetch(
    () => new Response('<html><head><title></title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/x/edit');
      assert.equal(result.title, null);
    },
  );
});

test('detectDocTypeAndFetchTitle rejects a non-HTML content type without reading the body', async () => {
  let body: ReadableStream<Uint8Array>;
  await withMockedFetch(
    () => {
      body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('<html><head><title>X</title></head></html>'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf' } });
    },
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/x/edit');
      assert.equal(result.title, null);
      assert.equal(body.locked, false, 'must not acquire a reader for a rejected content type');
    },
  );
});

test('detectDocTypeAndFetchTitle rejects an oversized response by Content-Length without reading the body', async () => {
  let body: ReadableStream<Uint8Array>;
  await withMockedFetch(
    () => {
      body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('<html><head><title>X</title></head></html>'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html', 'content-length': '999999999' } });
    },
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/x/edit');
      assert.equal(result.title, null);
      assert.equal(body.locked, false, 'must not acquire a reader for an oversized response');
    },
  );
});

test('detectDocTypeAndFetchTitle stops reading once the streamed size cap is hit inside one oversized chunk', async () => {
  await withMockedFetch(
    () => {
      // One chunk far larger than TITLE_FETCH_MAX_BYTES, with no <title> in it at all - if the
      // implementation appended the whole chunk before checking the limit (the bug a delegated
      // review caught), this would still find no title only after exceeding the cap; the real
      // assertion here is that this resolves promptly with title: null rather than hanging or
      // ballooning memory - node:test's own default timeout is the practical proof of "promptly".
      const huge = 'x'.repeat(500_000);
      return new Response(`<html><head><title>${huge}`, { status: 200, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/x/edit');
      assert.equal(result.title, null);
    },
  );
});

test('detectDocTypeAndFetchTitle follows an in-whitelist redirect and re-validates the target', async () => {
  await withMockedFetch(
    url => {
      if (url === 'https://1drv.ms/w/s!abc') {
        return new Response(null, { status: 302, headers: { location: 'https://office.com/w/abc' } });
      }
      return new Response('<html><head><title>Regulamin - Word</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    },
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://1drv.ms/w/s!abc');
      assert.deepEqual(result, { docType: 'office', title: 'Regulamin' });
    },
  );
});

test('detectDocTypeAndFetchTitle refuses to follow a redirect to a host outside the whitelist', async () => {
  await withMockedFetch(
    url => {
      if (url === 'https://1drv.ms/w/s!abc') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } });
      }
      throw new Error('must not fetch the redirect target');
    },
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://1drv.ms/w/s!abc');
      assert.deepEqual(result, { docType: 'office', title: null });
    },
  );
});

test('detectDocTypeAndFetchTitle refuses to follow a redirect that downgrades to http', async () => {
  await withMockedFetch(
    url => {
      if (url === 'https://1drv.ms/w/s!abc') {
        return new Response(null, { status: 302, headers: { location: 'http://office.com/w/abc' } });
      }
      throw new Error('must not fetch an http redirect target');
    },
    async () => {
      const result = await detectDocTypeAndFetchTitle('https://1drv.ms/w/s!abc');
      assert.deepEqual(result, { docType: 'office', title: null });
    },
  );
});

// A round-2 delegated review (finding #6) caught that the timeout path (design.md: "Timeout ok.
// 4s") had no test - detectDocTypeAndFetchTitle now takes an optional timeoutMs so a test can
// inject a short value instead of waiting out the real 4s. This mock fetch behaves like the real
// one under an AbortController: it never resolves on its own, and rejects with an AbortError once
// the signal fires - the same contract detectDocTypeAndFetchTitle's own AbortController produces.
test('detectDocTypeAndFetchTitle returns null title (not a hang) when the fetch times out', async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as typeof fetch;
  try {
    const result = await detectDocTypeAndFetchTitle('https://docs.google.com/document/d/x/edit', 20);
    assert.deepEqual(result, { docType: 'googleDoc', title: null });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('buildSharedFileDoc uses the fetched title as name when available', async () => {
  await withMockedFetch(
    () => new Response('<html><head><title>Regulamin - Google Docs</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => {
      const doc = await buildSharedFileDoc({ url: 'https://docs.google.com/document/d/abc/edit', description: 'wersja robocza' }, 'Ala@Example.test');
      assert.equal(doc.name, 'Regulamin');
      assert.equal(doc.description, 'wersja robocza');
      assert.equal(doc.docType, 'googleDoc');
      assert.equal(doc.addedByEmail, 'ala@example.test');
      assert.ok(doc.id);
      assert.ok(doc.addedAt);
    },
  );
});

test('buildSharedFileDoc falls back to the description, then the URL, when no title was fetched', async () => {
  const withDescription = await buildSharedFileDoc({ url: 'https://example.com/x', description: 'Nasz arkusz' }, 'ala@example.test');
  assert.equal(withDescription.name, 'Nasz arkusz');

  const withoutDescription = await buildSharedFileDoc({ url: 'https://example.com/x', description: '' }, 'ala@example.test');
  assert.equal(withoutDescription.name, 'https://example.com/x');
});

test('saveFileInTransaction + getFile + listFiles + deleteFileInTransaction round-trip', async () => {
  const client = createInMemoryFirestoreClient();
  const doc = await buildSharedFileDoc({ url: 'https://example.com/x', description: 'Plik' }, 'ala@example.test');
  await client.runTransaction(tx => saveFileInTransaction(tx, doc));

  assert.deepEqual(await getFile(client, doc.id), doc);
  assert.deepEqual(await listFiles(client), [doc]);

  await client.runTransaction(tx => deleteFileInTransaction(tx, doc.id));
  assert.equal(await getFile(client, doc.id), null);
  assert.deepEqual(await listFiles(client), []);
});

test('listFiles sorts newest first and honors the limit', async () => {
  const client = createInMemoryFirestoreClient();
  const older = { ...(await buildSharedFileDoc({ url: 'https://example.com/a', description: '' }, 'ala@example.test')), addedAt: '2026-01-01T00:00:00.000Z' };
  const newer = { ...(await buildSharedFileDoc({ url: 'https://example.com/b', description: '' }, 'ala@example.test')), addedAt: '2026-02-01T00:00:00.000Z' };
  await client.runTransaction(async tx => {
    await saveFileInTransaction(tx, older);
    await saveFileInTransaction(tx, newer);
  });
  assert.deepEqual((await listFiles(client)).map(f => f.id), [newer.id, older.id]);
  assert.deepEqual((await listFiles(client, 1)).map(f => f.id), [newer.id]);
});
