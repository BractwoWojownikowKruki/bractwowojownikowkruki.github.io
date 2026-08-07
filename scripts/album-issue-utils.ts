import { parseAlbumsJson } from './utils.ts';

// GitHub Issue Forms render each field as "### <Label>\n\n<value>\n\n" (or "_No response_" if left blank).
function extractField(body: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`### ${escapedLabel}\\s*\\n\\s*\\n([^\\n]+)`);
  const match = body.match(re);
  if (!match) return null;
  const value = match[1].trim();
  return value && value !== '_No response_' ? value : null;
}

export function parseIssueForm(body: string): { url: string | null; name: string | null; date: string | null } {
  return {
    url: extractField(body, 'Link do albumu Google Photos'),
    name: extractField(body, 'Własna nazwa (opcjonalnie)'),
    date: extractField(body, 'Data'),
  };
}

export function validateAlbumUrl(url: string | null): string | null {
  if (!url) return 'Nie podano linku do albumu.';
  const valid = /^https:\/\/photos\.app\.goo\.gl\/\S+$/.test(url)
    || /^https:\/\/photos\.google\.com\/share\/\S+$/.test(url);
  if (!valid) {
    return `Link "${url}" nie wygląda na udostępniony album Google Photos. Oczekiwany format: https://photos.app.goo.gl/XYZ (lub https://photos.google.com/share/...).`;
  }
  return null;
}

export function validateAlbumDate(date: string | null): string | null {
  if (!date) return 'Nie podano daty albumu.';
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return `Data "${date}" ma zły format. Oczekiwany format: RRRR-MM-DD (np. 2024-08-03).`;
  }
  const [, y, m, d] = match;
  const parsed = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const roundTrips = parsed.getUTCFullYear() === Number(y)
    && parsed.getUTCMonth() + 1 === Number(m)
    && parsed.getUTCDate() === Number(d);
  if (!roundTrips) {
    return `Data "${date}" nie istnieje. Oczekiwany format: RRRR-MM-DD (np. 2024-08-03).`;
  }
  return null;
}

export function isDuplicate(url: string, albumsJsonContent: string): boolean {
  return parseAlbumsJson(albumsJsonContent).some(e => e.url === url);
}
