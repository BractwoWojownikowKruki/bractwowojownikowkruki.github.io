import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import https from 'https';
import { join } from 'path';
import { AlbumEntry, extractCoverUrl, extractDriveFolderId, extractPhotoCount, extractThumbEntries, extractTitle, makeSearchText, parseAlbumsJson, parseDate } from './utils.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const ALBUMS_JSON = join(ROOT, 'albums.json');
const GENERATED_JSON = join(ROOT, 'public/data/albums.generated.json');
const COVERS_DIR = join(ROOT, 'public/covers');
const THUMBS_DIR = join(ROOT, 'public/thumbs');

interface AlbumRecord {
  url: string;
  title: string;
  date: string | null;
  cover: string;
  photoCount: number | null;
  thumbs: string[];
  searchText: string;
  lastSyncedAt: string;
  syncStatus: 'ok' | 'failed';
  source?: 'drive';
  driveFolderId?: string;
}

function coverHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 8);
}

// Google Photos short URLs (photos.app.goo.gl) return 302 only to minimal UAs.
// Full browser UAs get a Firebase DurableDeepLink page (200) with no metadata.
// Fix: resolve the short URL with a minimal UA first, then fetch the real album page.
function resolveShortUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      resolve(res.headers.location ?? url);
      res.destroy();
    }).on('error', reject);
  });
}

async function fetchHtml(url: string): Promise<string> {
  const resolvedUrl = await resolveShortUrl(url);
  const res = await fetch(resolvedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function downloadImage(imageUrl: string, destPath: string): Promise<void> {
  const res = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KruczeGalery/1.0)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
}

async function syncAlbum({ url, nameOverride, dateOverride }: AlbumEntry, cached: AlbumRecord | undefined): Promise<AlbumRecord> {
  const hash = coverHash(url);
  const coverFile = `${hash}.jpg`;
  const coverPath = join(COVERS_DIR, coverFile);
  const coverPublic = `covers/${coverFile}`;
  const now = new Date().toISOString();

  try {
    console.log(`[sync] ${url}`);
    const html = await fetchHtml(url);

    const title = nameOverride ?? extractTitle(html) ?? cached?.title ?? 'Album bez tytułu';
    const date = dateOverride ?? parseDate(title);
    const coverUrl = extractCoverUrl(html);
    const photoCount = extractPhotoCount(html);

    if (coverUrl) {
      try {
        await downloadImage(coverUrl, coverPath);
      } catch (e) {
        console.warn(`[warn] Nie udało się pobrać okładki: ${(e as Error).message}`);
      }
    }

    const cover = existsSync(coverPath)
      ? coverPublic
      : (cached?.cover ?? 'covers/placeholder.jpg');

    const thumbEntries = extractThumbEntries(html);
    const thumbs: string[] = [];
    const keepFiles = new Set<string>();
    let downloaded = 0;
    let reused = 0;
    for (const entry of thumbEntries) {
      const thumbFile = `${hash}-${coverHash(entry.id)}.jpg`;
      const thumbPath = join(THUMBS_DIR, thumbFile);
      keepFiles.add(thumbFile);
      if (existsSync(thumbPath)) {
        thumbs.push(`thumbs/${thumbFile}`);
        reused++;
        continue;
      }
      try {
        await downloadImage(entry.url, thumbPath);
        thumbs.push(`thumbs/${thumbFile}`);
        downloaded++;
      } catch (e) {
        console.warn(`[warn] Nie udało się pobrać miniaturki ${entry.id}: ${(e as Error).message}`);
      }
    }

    let removed = 0;
    for (const file of readdirSync(THUMBS_DIR)) {
      if (file.startsWith(`${hash}-`) && !keepFiles.has(file)) {
        unlinkSync(join(THUMBS_DIR, file));
        removed++;
      }
    }
    console.log(`[sync]   miniatury: ${downloaded} pobrano, ${reused} z cache, ${removed} usunięto`);

    return {
      url,
      title,
      date,
      cover,
      photoCount: photoCount ?? cached?.photoCount ?? null,
      thumbs: thumbs.length > 0 ? thumbs : (cached?.thumbs ?? []),
      searchText: makeSearchText(title),
      lastSyncedAt: now,
      syncStatus: 'ok',
    };
  } catch (e) {
    console.error(`[error] ${url}: ${(e as Error).message}`);
    return {
      url,
      title: cached?.title ?? 'Album bez tytułu',
      date: cached?.date ?? null,
      cover: cached?.cover ?? 'covers/placeholder.jpg',
      photoCount: cached?.photoCount ?? null,
      thumbs: cached?.thumbs ?? [],
      searchText: cached?.searchText ?? '',
      lastSyncedAt: now,
      syncStatus: 'failed',
    };
  }
}

async function main(): Promise<void> {
  mkdirSync(COVERS_DIR, { recursive: true });
  mkdirSync(THUMBS_DIR, { recursive: true });

  const entries = parseAlbumsJson(readFileSync(ALBUMS_JSON, 'utf8'));
  console.log(`[sync] Znaleziono ${entries.length} album(ów) w albums.json`);

  const existing: AlbumRecord[] = existsSync(GENERATED_JSON)
    ? JSON.parse(readFileSync(GENERATED_JSON, 'utf8'))
    : [];

  const cache = new Map(existing.map(a => [a.url, a]));

  const results: AlbumRecord[] = [];
  for (const entry of entries) {
    // Drive-folder galleries are now discovered dynamically by upload-service's
    // GET /galleries (KRKG-0025) instead of synced through albums.json - a Drive URL still
    // listed here is a pre-migration leftover, skipped rather than mis-processed as a Photos
    // album scrape.
    if (extractDriveFolderId(entry.url)) {
      console.warn(`[warn] Pomijam wpis Drive w albums.json (odkrywane teraz dynamicznie) — przenieś folder pod korzeń odkrywania i usuń ten wpis: ${entry.url}`);
      continue;
    }
    results.push(await syncAlbum(entry, cache.get(entry.url)));
  }

  writeFileSync(GENERATED_JSON, JSON.stringify(results, null, 2) + '\n');
  console.log(`[sync] Zapisano ${results.length} rekord(ów) do albums.generated.json`);

  const failed = results.filter(r => r.syncStatus === 'failed').length;
  if (failed > 0) {
    console.warn(`[sync] ${failed} album(ów) nie udało się zsynchronizować — zachowano dane z cache`);
  }
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
