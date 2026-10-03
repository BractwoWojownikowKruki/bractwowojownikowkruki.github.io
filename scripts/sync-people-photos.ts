import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  CATEGORY_SLUGS,
  PEOPLE_PHOTO_CATEGORIES,
  buildManifest,
  buildSnapshot,
  collectWantedPhotos,
  extensionForContentType,
  fileNameFor,
  parseFileName,
  planSync,
  type RemotePersonFull,
  type WantedPhoto,
} from './people-photos-utils.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const PHOTOS_DIR = join(ROOT, 'public/people-photos');
const MANIFEST_PATH = join(PHOTOS_DIR, 'manifest.json');
const DATA_DIR = join(ROOT, 'public/people-data');

// Same public, unauthenticated endpoint the About Us pages call - so this job needs no Drive
// credentials of its own, and by construction only ever sees approved, public photos (pending
// uploads in a member's staging folder are never part of /about-us).
const BACKEND_URL = process.env.PEOPLE_PHOTOS_BACKEND_URL ?? 'https://krucze-galery-upload-x6mr6ilyha-ew.a.run.app';
const CONCURRENCY = 6;

async function fetchCategory(category: string): Promise<RemotePersonFull[]> {
  const res = await fetch(`${BACKEND_URL}/about-us?category=${encodeURIComponent(category)}`);
  if (!res.ok) throw new Error(`/about-us?category=${category}: HTTP ${res.status}`);
  const data = (await res.json()) as { people?: RemotePersonFull[] };
  if (!Array.isArray(data.people)) throw new Error(`/about-us?category=${category}: unexpected response`);
  return data.people;
}

// Thumbnail links expire (roughly an hour), so each is downloaded right after listing.
async function download(w: WantedPhoto): Promise<string | null> {
  try {
    const res = await fetch(w.sourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = extensionForContentType(res.headers.get('content-type'));
    if (!ext) throw new Error(`unsupported content-type ${res.headers.get('content-type')}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty body');
    const name = fileNameFor(w, ext);
    writeFileSync(join(PHOTOS_DIR, name), buf);
    return name;
  } catch (e) {
    // Not fatal: the photo is simply absent from the manifest (pages fall back to Drive) and is
    // retried tomorrow.
    console.warn(`[warn] ${w.id} (${w.size}px): ${(e as Error).message}`);
    return null;
  }
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
    }),
  );
}

const listPhotoFiles = (): string[] => readdirSync(PHOTOS_DIR).filter(f => parseFileName(f) !== null);

async function main(): Promise<void> {
  mkdirSync(PHOTOS_DIR, { recursive: true });

  // All-or-nothing listing: if any category fails we abort *before* touching the cache, so a
  // transient backend error can never be mistaken for "everyone was removed" and wipe it.
  console.log(`[sync-people-photos] Pobieranie list z ${BACKEND_URL}/about-us`);
  const byCategory = await Promise.all(PEOPLE_PHOTO_CATEGORIES.map(fetchCategory));
  const people = byCategory.flat();

  const wanted = collectWantedPhotos(people);
  const existing = listPhotoFiles();
  if (wanted.length === 0 && existing.length > 0) {
    throw new Error('Backend zwrócił zero zdjęć, a cache nie jest pusty - przerywam bez usuwania.');
  }

  const plan = planSync(wanted, existing);
  console.log(
    `[sync-people-photos] ${wanted.length} zdjęć: ${plan.upToDate} aktualnych, ${plan.toDownload.length} do pobrania, ${plan.toDelete.length} do usunięcia`,
  );

  await runPool(plan.toDownload, download);
  for (const name of plan.toDelete) unlinkSync(join(PHOTOS_DIR, name));

  const manifest = buildManifest(wanted, listPhotoFiles());
  writeIfChanged(MANIFEST_PATH, JSON.stringify(manifest) + '\n');

  // Static snapshot per category, built only from photos that really are cached.
  mkdirSync(DATA_DIR, { recursive: true });
  PEOPLE_PHOTO_CATEGORIES.forEach((category, i) => {
    const snapshot = buildSnapshot(byCategory[i], manifest);
    writeIfChanged(join(DATA_DIR, `${CATEGORY_SLUGS[category]}.json`), JSON.stringify(snapshot, null, 1) + '\n');
  });
}

// Written only when the content changed, so an up-to-date run leaves a clean working tree (=> no commit).
function writeIfChanged(path: string, content: string): void {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (content !== previous) writeFileSync(path, content);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
