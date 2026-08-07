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

export function extractThumbUrls(html: string, limit = 24): string[] {
  return extractPhotoEntries(html)
    .slice(0, limit)
    .map(e => `${e.url}=w220-h220-c`);
}

export function makeSearchText(title: string): string {
  return title.toLowerCase().replace(/[–—]/g, '-');
}

export interface AlbumEntry {
  url: string;
  nameOverride?: string;
  dateOverride?: string;
  hiddenComment?: string;
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
      nameOverride: entry.nameOverride,
      dateOverride: entry.dateOverride,
      hiddenComment: entry.hiddenComment,
    });
  }
  return entries;
}
