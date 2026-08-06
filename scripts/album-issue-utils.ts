import { parseAlbumsTxt } from './utils.ts';

// GitHub Issue Forms render each field as "### <Label>\n\n<value>\n\n" (or "_No response_" if left blank).
function extractField(body: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`### ${escapedLabel}\\s*\\n\\s*\\n([^\\n]+)`);
  const match = body.match(re);
  if (!match) return null;
  const value = match[1].trim();
  return value && value !== '_No response_' ? value : null;
}

export function parseIssueForm(body: string): { url: string | null; name: string | null } {
  return {
    url: extractField(body, 'Link do albumu Google Photos'),
    name: extractField(body, 'Własna nazwa (opcjonalnie)'),
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

export function validateAlbumName(name: string | null): string | null {
  if (!name) return null;
  if (name.startsWith('#')) {
    return `Nazwa "${name}" nie może zaczynać się od "#" (ten znak jest zarezerwowany w pliku albums.txt).`;
  }
  if (name.includes('|')) {
    return `Nazwa "${name}" nie może zawierać znaku "|" (ten znak jest zarezerwowany w pliku albums.txt).`;
  }
  return null;
}

export function isDuplicate(url: string, albumsTxtContent: string): boolean {
  return parseAlbumsTxt(albumsTxtContent).some(e => e.url === url);
}
