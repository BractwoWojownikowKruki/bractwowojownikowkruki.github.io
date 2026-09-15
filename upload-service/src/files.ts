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
const KNOWN_HOSTS: ReadonlyMap<string, SharedFileDocType> = new Map<string, SharedFileDocType>([
  ['docs.google.com', 'googleDoc'],
  ['sheets.google.com', 'googleSheet'],
  ['drive.google.com', 'googleDrive'],
  ['1drv.ms', 'office'],
  ['office.com', 'office'],
]);

function detectDocType(url: URL): SharedFileDocType | null {
  const known = KNOWN_HOSTS.get(url.hostname);
  if (known) return known;
  if (url.hostname.endsWith('.sharepoint.com')) return 'office';
  return null;
}

/** https-only, standard-port, no-embedded-credentials, whitelisted-host check - applied to the
 * original URL and, again, to every redirect hop, so a whitelisted host can never hand off the
 * fetch to somewhere else, and a redirect can never smuggle credentials into the next request
 * (mirrors the same check parseAllowedUrl makes on the original URL; final review finding #5). */
function isFetchableWhitelistedUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.port !== '') return false;
  if (url.username || url.password) return false;
  return detectDocType(url) !== null;
}

// English and Polish product names Google/Office append to a shared doc's own <title> - this
// club's Google Workspace is Polish-locale, so a real fetched title is typically "Nazwa -
// Dokumenty Google"/"Nazwa - Arkusze Google", not the English form; both are listed so the
// stripped tile name never carries a leftover "- Arkusze Google" fragment regardless of the
// viewing member's own locale (KRKG-0076 UI feedback: the icon alone should say what kind of
// file it is, not repeated as text after the name). A plain string-suffix version of this (an
// earlier revision) still left the fragment on a follow-up report - matched against a real public
// Google Sheet (`curl`'d directly: "Example Spreadsheet - Arkusze Google"), the plain-hyphen
// English/Polish list itself was never the problem, but Google is known to render this separator
// as a plain hyphen "-", an en dash "–", or (rarely) an em dash "—" depending on product/locale,
// and .trim() alone doesn't collapse a non-breaking space some of those pages use before it - a
// regex normalizes whitespace and accepts any of the three dash characters instead of hard-coding
// one, so a locale/product variant this list hasn't seen verbatim still gets stripped.
const TITLE_SUFFIX_PRODUCTS = ['Google Docs', 'Dokumenty Google', 'Google Sheets', 'Arkusze Google', 'Google Drive', 'Dysk Google', 'Word', 'Excel', 'PowerPoint', 'Office'];
// The dash/space normalization happens in two steps: `\s+` in the replace below already folds a
// non-breaking space (JS's `\s` matches U+00A0) down to a plain space before this pattern ever
// runs, so only the dash character itself needs the [-–—] alternation here.
const TITLE_SUFFIX_PATTERN = new RegExp(` [-\\u2013\\u2014] (${TITLE_SUFFIX_PRODUCTS.join('|')})$`, 'i');

function cleanTitle(rawTitle: string): string | null {
  const normalized = rawTitle.replace(/\s+/g, ' ').trim();
  const title = normalized.replace(TITLE_SUFFIX_PATTERN, '').trim();
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
    try {
      let response: Response;
      try {
        response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
      } catch {
        return { docType, title: null };
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
        try {
          if (response.body) await response.body.getReader().cancel();
        } catch {}
        continue;
      }

      if (response.status < 200 || response.status >= 300) return { docType, title: null };

      if (!isHtmlContentType(response)) return { docType, title: null };

      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > TITLE_FETCH_MAX_BYTES) return { docType, title: null };

      let html: string;
      try {
        html = await readBoundedText(response);
      } catch {
        return { docType, title: null };
      }
      const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      return { docType, title: match ? cleanTitle(match[1]) : null };
    } finally {
      clearTimeout(timeout);
    }
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

/** Transactional read counterpart to getFile - lets a caller read-then-decide inside the same
 * transaction that later writes (e.g. a CanonicalAuditEventInputFactory that must see the same
 * document version the mutation itself acts on, so a concurrent delete is caught before any
 * write rather than racing a pre-transaction read, KRKG-0076 P2). */
export async function getFileInTransaction(tx: FirestoreTransaction, id: string): Promise<SharedFileDoc | null> {
  return tx.getDoc<SharedFileDoc>(COLLECTION, id);
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
