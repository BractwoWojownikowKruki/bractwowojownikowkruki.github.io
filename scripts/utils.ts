export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function extractMeta(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
  }
  return null;
}

export function extractTitle(html: string): string | null {
  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) return ogTitle.replace(/\s*·.*$/, '').trim();

  const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  if (pageTitle) return pageTitle.replace(/\s*-\s*Google Photos$/i, '').trim();

  return null;
}

export function extractCoverUrl(html: string): string | null {
  return extractMeta(html, 'og:image') ?? extractMeta(html, 'twitter:image') ?? null;
}

// Finds a date anywhere in the title. Supports separators - . /
// Returns YYYY-MM-DD for full dates, YYYY-MM for month-only.
// Also recognizes the DD-DD.MM.YYYY day-range form (e.g. "12-14.06.2026"), returning its start date.
export function parseDate(title: string): string | null {
  // Day range: DD-DD.MM.YYYY anywhere in title (e.g. "12-14.06.2026")
  const dayRange = title.match(/(\d{2})-\d{2}\.(\d{2})\.(\d{4})/);
  if (dayRange) return `${dayRange[3]}-${dayRange[2]}-${dayRange[1]}`;
  // Full date: YYYY[-./]MM[-./]DD anywhere in title
  const full = title.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  // Month-only: YYYY[-./]MM anywhere, not followed by another separator+digit
  const month = title.match(/(\d{4})[-./](\d{2})(?=[^-./\d]|$)/);
  if (month) return `${month[1]}-${month[2]}`;
  return null;
}

// Strips a date from anywhere in the title (prefix, suffix, or inline).
// Handles YYYY-MM-DD-DD ranges, the DD-DD.MM.YYYY range form, and separators - . /
// After stripping, trims leading non-letter characters (orphan fragments like "-04").
export function displayTitle(title: string): string {
  const clean = (s: string) =>
    s.replace(/^[^\p{L}]+/u, '').replace(/[\s,\-–—]+$/g, '').trim();
  // Day range DD-DD.MM.YYYY (e.g. "12-14.06.2026")
  let s = title.replace(/\d{2}-\d{2}\.\d{2}\.\d{4}/, '');
  if (s !== title) return clean(s) || title;
  // Full date with optional range end-day
  s = title.replace(/\d{4}[-./]\d{2}[-./]\d{2}(?:-\d{2})?/, '');
  if (s !== title) return clean(s) || title;
  // Month-only
  s = title.replace(/\d{4}[-./]\d{2}(?=[^-./\d]|$)/, '');
  if (s !== title) return clean(s) || title;
  return title;
}

interface PhotoEntry {
  id: string;
  url: string;
}

function extractPhotoEntries(html: string): PhotoEntry[] {
  const matches = [...html.matchAll(/"(AF1Qip[^"]+)",\["(https:\/\/lh3[^"]+)"/g)];
  const seen = new Map<string, string>();
  for (const m of matches) if (!seen.has(m[1])) seen.set(m[1], m[2]);
  return [...seen.entries()].map(([id, url]) => ({ id, url }));
}

export function extractPhotoCount(html: string): number | null {
  const n = extractPhotoEntries(html).length;
  return n > 0 ? n : null;
}

export interface ThumbEntry {
  id: string;
  url: string;
}

export function extractThumbEntries(html: string, limit = 24): ThumbEntry[] {
  return extractPhotoEntries(html)
    .slice(0, limit)
    .map(e => ({ id: e.id, url: `${e.url}=w220-h220-c` }));
}

export function extractDriveFolderId(url: string): string | null {
  const m = url.match(/^https:\/\/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

export function makeSearchText(title: string): string {
  return title.toLowerCase().replace(/[–—]/g, '-');
}

// Decides whether a cover image must be (re)downloaded. The cover is keyed by
// its source identity rather than by its bytes, because image hosts re-encode
// the same picture differently on every fetch — byte comparison would always
// report a change. Returns true only when a source is known and either the
// local file is missing or the recorded source identity changed (for example
// the album's cover photo was replaced). When no source has been recorded yet
// (records generated before this field existed), an already-present file is
// trusted so the migration does not re-download every album once.
export function shouldRefreshCover(
  cachedSource: string | undefined,
  source: string | undefined,
  fileExists: boolean,
): boolean {
  if (!source) return false;
  if (!fileExists) return true;
  if (cachedSource === undefined) return false;
  return cachedSource !== source;
}

// Keeps generated records stable across sync runs. A fresh `lastSyncedAt` is
// produced on every run, so writing it unconditionally yields a diff (and a
// bot commit) even when nothing changed. When every field except the timestamp
// matches the cached record, the cached timestamp is reused so the record — and
// therefore the generated JSON file — stays byte-identical.
export function stableSyncTime<T extends { lastSyncedAt: string }>(next: T, cached: T | undefined): T {
  if (!cached) return next;
  if (canonicalRecord(next) === canonicalRecord(cached)) {
    return { ...next, lastSyncedAt: cached.lastSyncedAt };
  }
  return next;
}

function canonicalRecord(record: { lastSyncedAt: string }): string {
  const { lastSyncedAt: _ignored, ...rest } = record;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export interface AlbumEntry {
  url: string;
  nameOverride?: string;
  dateOverride?: string;
  hiddenComment?: string;
}

// KRKG-0108: albums.json is written by upload-service's /register (which now validates these
// fields) but also by hand, and whatever passes here is copied into albums.generated.json and shown
// on the gallery page - so an override that isn't a plain date (YYYY-MM or YYYY-MM-DD, the two
// shapes the generated data already uses) or a plain one-line name is dropped with a warning
// instead of being published.
const DATE_OVERRIDE_PATTERN = /^\d{4}-\d{2}(-\d{2})?$/;
const NAME_OVERRIDE_MAX_LENGTH = 120;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function safeDateOverride(value: unknown, url: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && DATE_OVERRIDE_PATTERN.test(value)) return value;
  console.warn(`[warn] Pominięto nieprawidłowy "dateOverride" dla ${url}:`, value);
  return undefined;
}

function safeNameOverride(value: unknown, url: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length <= NAME_OVERRIDE_MAX_LENGTH && !CONTROL_CHARACTERS.test(value)) return value;
  console.warn(`[warn] Pominięto nieprawidłowy "nameOverride" dla ${url}:`, value);
  return undefined;
}

export function parseAlbumsJson(content: string): AlbumEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`Nie udało się sparsować albums.json: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('albums.json musi być tablicą.');
  }

  const seen = new Set<string>();
  const entries: AlbumEntry[] = [];
  for (const item of parsed) {
    const url = (item as { url?: unknown })?.url;
    if (typeof url !== 'string' || !url) {
      console.warn('[warn] Pominięto wpis bez poprawnego "url":', item);
      continue;
    }
    if (seen.has(url)) {
      console.warn(`[warn] Duplikat pominięty: ${url}`);
      continue;
    }
    seen.add(url);
    const entry = item as AlbumEntry;
    entries.push({
      url,
      nameOverride: safeNameOverride(entry.nameOverride, url),
      dateOverride: safeDateOverride(entry.dateOverride, url),
      hiddenComment: entry.hiddenComment,
    });
  }
  return entries;
}
