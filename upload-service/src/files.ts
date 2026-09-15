import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';

export type SharedFileDocType = 'googleDoc' | 'googleSheet' | 'googleDrive' | 'office' | 'generic';

export interface SharedFileDoc {
  id: string;
  url: string;
  name: string;
  description: string;
  docType: SharedFileDocType;
  addedByEmail: string;
  addedAt: string;
}

/** A submitted file URL that fails the https-only, no-credentials contract (KRKG-0076). */
export class InvalidFileUrlError extends Error {}

const COLLECTION = 'sharedFiles';
const MAX_LISTED_FILES = 500;

const TITLE_FETCH_TIMEOUT_MS = 4000;
const TITLE_FETCH_MAX_BYTES = 200_000;
const TITLE_FETCH_MAX_REDIRECTS = 3;

/**
 * Validates the https-only, no-embedded-credentials URL contract (KRKG-0076, fixing a stored-XSS
 * finding from a delegated plan review: new URL() alone accepts javascript:/data:/file: schemes,
 * and this codebase renders file.url straight into an <a href> - so the scheme is enforced here,
 * once, for both storage and the title-fetch redirect chain below.
 */
function parseAllowedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InvalidFileUrlError('Nieprawidłowy adres URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new InvalidFileUrlError('Dozwolone są tylko adresy https: bez danych logowania w URL-u.');
  }
  return url;
}

// KRKG-0076: fetching an arbitrary user-supplied URL server-side is an SSRF vector, so a title
// fetch only ever runs for one of these known doc-provider hosts - everything else gets 'generic'
// and no fetch attempt at all. '*.sharepoint.com' is matched separately below (any subdomain),
// every other entry is an exact hostname match.
const KNOWN_HOSTS: Record<string, SharedFileDocType> = {
  'docs.google.com': 'googleDoc',
  'sheets.google.com': 'googleSheet',
  'drive.google.com': 'googleDrive',
  '1drv.ms': 'office',
  'office.com': 'office',
};

function detectDocType(url: URL): SharedFileDocType | null {
  if (KNOWN_HOSTS[url.hostname]) return KNOWN_HOSTS[url.hostname];
  if (url.hostname.endsWith('.sharepoint.com')) return 'office';
  return null;
}

/** https-only, standard-port, whitelisted-host check - applied to the original URL and, again,
 * to every redirect hop, so a whitelisted host can never hand off the fetch to somewhere else. */
function isFetchableWhitelistedUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.port !== '') return false;
  return detectDocType(url) !== null;
}

const TITLE_SUFFIXES = [' - Google Docs', ' - Google Sheets', ' - Google Drive', ' - Word', ' - Excel', ' - PowerPoint', ' - Office'];

function cleanTitle(rawTitle: string): string | null {
  let title = rawTitle.trim();
  for (const suffix of TITLE_SUFFIXES) {
    if (title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length).trim();
      break;
    }
  }
  return title || null;
}

/** Reads at most TITLE_FETCH_MAX_BYTES from the response body, truncating (not appending-then-
 * checking) so a single oversized chunk can never push the buffer past the cap - fixes a finding
 * from a delegated plan review where the prior version appended a whole chunk before checking. */
async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytesRead = 0;
  try {
    while (bytesRead < TITLE_FETCH_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = TITLE_FETCH_MAX_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      html += decoder.decode(chunk, { stream: true });
      if (/<\/title>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html;
}

function isHtmlContentType(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return /text\/html|application\/xhtml\+xml/i.test(contentType);
}

/**
 * Best-effort title fetch for a whitelisted doc-provider host only (KRKG-0076). Uses
 * redirect: 'manual' and re-validates every hop against the same https/standard-port/whitelist
 * check as the original URL - fetch() follows redirects by default, and a whitelisted host
 * (1drv.ms is itself a URL shortener) could otherwise hand the request off anywhere. Any failure -
 * unrecognized host, network error, timeout, non-2xx, non-HTML content type, oversized response,
 * a disallowed redirect, or no non-empty <title> - returns a null title rather than throwing; a
 * file link is still useful without an auto-detected name.
 */
export async function detectDocTypeAndFetchTitle(
  rawUrl: string,
  // Defaults to the real 4s budget in production; a test injects a short value instead of
  // waiting out the real timeout (round-2 delegated review, finding #6 - the pre-round-2 version
  // had no seam to test the timeout path at all).
  timeoutMs: number = TITLE_FETCH_TIMEOUT_MS,
): Promise<{ docType: SharedFileDocType; title: string | null }> {
  const url = parseAllowedUrl(rawUrl);
  const docType = detectDocType(url);
  if (!docType) return { docType: 'generic', title: null };

  let currentUrl = url;
  for (let hop = 0; hop <= TITLE_FETCH_MAX_REDIRECTS; hop++) {
    if (!isFetchableWhitelistedUrl(currentUrl)) return { docType, title: null };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
    } catch {
      return { docType, title: null };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        try {
          if (response.body) await response.body.getReader().cancel();
        } catch {}
        return { docType, title: null };
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        try {
          if (response.body) await response.body.getReader().cancel();
        } catch {}
        return { docType, title: null };
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) return { docType, title: null };

    if (!isHtmlContentType(response)) return { docType, title: null };

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > TITLE_FETCH_MAX_BYTES) return { docType, title: null };

    const html = await readBoundedText(response);
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return { docType, title: match ? cleanTitle(match[1]) : null };
  }
  return { docType, title: null };
}

export async function buildSharedFileDoc(input: { url: string; description: string }, addedByEmail: string): Promise<SharedFileDoc> {
  parseAllowedUrl(input.url); // throws InvalidFileUrlError before any fetch or write is attempted
  const { docType, title } = await detectDocTypeAndFetchTitle(input.url);
  return {
    id: randomUUID(),
    url: input.url,
    name: title ?? (input.description || input.url),
    description: input.description,
    docType,
    addedByEmail: addedByEmail.toLowerCase(),
    addedAt: new Date().toISOString(),
  };
}

export async function saveFileInTransaction(tx: FirestoreTransaction, doc: SharedFileDoc): Promise<void> {
  await tx.createDoc(COLLECTION, doc.id, doc);
}

export async function deleteFileInTransaction(tx: FirestoreTransaction, id: string): Promise<void> {
  await tx.deleteDoc(COLLECTION, id);
}

export async function getFile(client: FirestoreLikeClient, id: string): Promise<SharedFileDoc | null> {
  return client.getDoc<SharedFileDoc>(COLLECTION, id);
}

export async function listFiles(client: FirestoreLikeClient, limit: number = MAX_LISTED_FILES): Promise<SharedFileDoc[]> {
  const all = await client.listDocs<SharedFileDoc>(COLLECTION);
  return all
    .map(d => d.data)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, limit);
}
