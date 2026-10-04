// Pure logic for the nightly people-photo cache (scripts/sync-people-photos.ts). Kept free of
// I/O so the "what is cached / what must be fetched / what is stale" decisions are unit-testable.
//
// Content-addressed naming is what makes the job idempotent: a cached file is called
// <driveFileId>-<size>-<md5 prefix>.<ext>, so "is this photo up to date?" is just "does this exact
// file name exist?". A photo edited in place gets a new md5 -> a new name -> it is fetched once
// and the old file becomes unreferenced and is pruned. Nothing is ever downloaded twice.

export const PEOPLE_PHOTO_CATEGORIES = ['Założyciele', 'Blachowi', 'Niewiasty', 'Emeryci', 'Kandydaci'] as const;

// Same sizes the public pages already request from Drive: 800 for a person's main photo, 300
// for gallery thumbnails. The 1600px lightbox size is deliberately not cached (repo size).
export const PHOTO_SIZES = [800, 300] as const;

// Tiny round avatar shown in name pills (and equipment pills). Not part of PHOTO_SIZES: that list
// filters which API-supplied URLs are cached, while the avatar URL is derived (see
// collectAvatarPhotos) from a person's main photo, or - for equipment - generated from the item's
// Cloud Storage photo.
export const AVATAR_SIZE = 64;

export interface RemotePhoto {
  id: string;
  url: string;
  md5?: string;
}

export interface RemotePerson {
  mainPhoto: RemotePhoto | null;
  photos: RemotePhoto[];
}

export interface WantedPhoto {
  id: string;
  size: number;
  version: string;
  sourceUrl: string;
  // True when the source is not a Drive thumbnail link (which Drive resizes for us) but a full
  // image that has to be scaled down and re-encoded locally (equipment photos in Cloud Storage).
  resize?: boolean;
}

export type Manifest = {
  version: 1;
  photos: Record<string, { v: string; files: Record<string, string> }>;
};

// Drive file ids are [A-Za-z0-9_-]; the id ends up in a file name, so anything else (data comes
// from an HTTP response) is refused rather than sanitised.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const NO_MD5_VERSION = '0';

export function versionOf(md5: string | undefined): string {
  return md5 && /^[0-9a-f]{32}$/i.test(md5) ? md5.slice(0, 10).toLowerCase() : NO_MD5_VERSION;
}

export function sizeFromUrl(url: string): number | null {
  const m = /=s(\d+)$/.exec(url);
  return m ? Number(m[1]) : null;
}

export function fileNameFor(w: Pick<WantedPhoto, 'id' | 'size' | 'version'>, ext: string): string {
  return `${w.id}-${w.size}-${w.version}.${ext}`;
}

// Every distinct (file id, size) pair across all people, deduplicated: the same Drive file can
// be listed twice (e.g. category fetched twice) and must be stored once.
export function collectWantedPhotos(people: RemotePerson[]): WantedPhoto[] {
  const wanted = new Map<string, WantedPhoto>();
  for (const person of people) {
    for (const photo of [person.mainPhoto, ...person.photos]) {
      if (!photo || !SAFE_ID.test(photo.id)) continue;
      const size = sizeFromUrl(photo.url);
      if (size === null || !(PHOTO_SIZES as readonly number[]).includes(size)) continue;
      wanted.set(`${photo.id}-${size}`, { id: photo.id, size, version: versionOf(photo.md5), sourceUrl: photo.url });
    }
  }
  return [...wanted.values()];
}

// One 64px avatar per person, derived from the main photo: Drive serves any size by swapping the
// "=sN" suffix of the thumbnail link, so no extra API data is needed. Keyed by the main photo's
// own id and md5, so changing the main photo yields a new file and the old one is pruned.
export function collectAvatarPhotos(people: RemotePerson[]): WantedPhoto[] {
  const wanted = new Map<string, WantedPhoto>();
  for (const person of people) {
    const photo = person.mainPhoto;
    if (!photo || !SAFE_ID.test(photo.id) || sizeFromUrl(photo.url) === null) continue;
    wanted.set(photo.id, {
      id: photo.id,
      size: AVATAR_SIZE,
      version: versionOf(photo.md5),
      sourceUrl: photo.url.replace(/=s\d+$/, `=s${AVATAR_SIZE}`),
    });
  }
  return [...wanted.values()];
}

// ---- Equipment avatars -------------------------------------------------------------------------
// Equipment photos live in Cloud Storage (not Drive), under a unique, immutable URL per upload, so
// the photo id alone identifies the content (version '0'). They are cached through the same
// manifest as person photos: manifest.photos[<photoId>].files['64'].

export interface RemoteEquipmentAvatar {
  id: string; // equipment item id
  photoId: string;
  url: string;
}

export interface EquipmentAvatarsSnapshot {
  version: 1;
  // equipment item id -> photo id; the image itself is looked up in the photo manifest.
  items: Record<string, string>;
}

export function collectEquipmentAvatarPhotos(items: RemoteEquipmentAvatar[]): WantedPhoto[] {
  const wanted = new Map<string, WantedPhoto>();
  for (const item of items) {
    if (!SAFE_ID.test(item.photoId) || !/^https:\/\//.test(item.url)) continue;
    wanted.set(item.photoId, { id: item.photoId, size: AVATAR_SIZE, version: NO_MD5_VERSION, sourceUrl: item.url, resize: true });
  }
  return [...wanted.values()];
}

// Only items whose avatar really is cached are listed, so the snapshot never points at a file that
// is not deployed. Sorted by item id so an unchanged cache never rewrites the file.
export function buildEquipmentAvatarsSnapshot(items: RemoteEquipmentAvatar[], manifest: Manifest): EquipmentAvatarsSnapshot {
  const out: Record<string, string> = {};
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (SAFE_ID.test(item.id) && manifest.photos[item.photoId]?.files[String(AVATAR_SIZE)]) out[item.id] = item.photoId;
  }
  return { version: 1, items: out };
}

const FILE_RE = /^([A-Za-z0-9_-]+)-(\d+)-([0-9a-f]+)\.(jpg|png|webp)$/;

export function parseFileName(name: string): { id: string; size: number; version: string; ext: string } | null {
  const m = FILE_RE.exec(name);
  return m ? { id: m[1], size: Number(m[2]), version: m[3], ext: m[4] } : null;
}

export interface SyncPlan {
  toDownload: WantedPhoto[];
  toDelete: string[];
  upToDate: number;
}

// existingFiles: names currently in public/people-photos (excluding the manifest). A wanted
// photo counts as cached when any extension of its exact name exists; every existing file that
// is not the cached copy of a wanted photo is stale (removed person, replaced photo, resized).
export function planSync(wanted: WantedPhoto[], existingFiles: string[]): SyncPlan {
  const keep = new Set<string>();
  const toDownload: WantedPhoto[] = [];
  for (const w of wanted) {
    const hit = existingFiles.find(f => {
      const p = parseFileName(f);
      return p && p.id === w.id && p.size === w.size && p.version === w.version;
    });
    if (hit) keep.add(hit);
    else toDownload.push(w);
  }
  const toDelete = existingFiles.filter(f => !keep.has(f));
  return { toDownload, toDelete, upToDate: keep.size };
}

// Rebuilt from the files actually on disk after a run, so the manifest can never claim a file
// that is not there. Only wanted photos are listed (a file left over from a failed prune is not).
export function buildManifest(wanted: WantedPhoto[], filesOnDisk: string[]): Manifest {
  const photos: Manifest['photos'] = {};
  // Sorted so the output never depends on the order the API happened to list photos in (it
  // reorders people), otherwise an unchanged cache would rewrite the manifest every night.
  const ordered = [...wanted].sort((a, b) => a.id.localeCompare(b.id) || a.size - b.size);
  for (const w of ordered) {
    const name = filesOnDisk.find(f => {
      const p = parseFileName(f);
      return p && p.id === w.id && p.size === w.size && p.version === w.version;
    });
    if (!name) continue;
    const entry = (photos[w.id] ??= { v: w.version, files: {} });
    entry.files[String(w.size)] = `people-photos/${name}`;
  }
  return { version: 1, photos };
}

export function extensionForContentType(contentType: string | null): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return null;
}

// ---- Static people data (public/people-data/<slug>.json) --------------------------------------
// The About Us pages read these files first and only fall back to the live /about-us API when a
// file is missing or invalid, so the common case needs no Cloud Run round trip at all.

// ASCII file names for the category pages; the key is the category name the API/pages use.
export const CATEGORY_SLUGS: Record<(typeof PEOPLE_PHOTO_CATEGORIES)[number], string> = {
  'Założyciele': 'zalozyciele',
  Blachowi: 'blachowi',
  Niewiasty: 'niewiasty',
  Emeryci: 'emeryci',
  Kandydaci: 'kandydaci',
};

export interface RemotePersonFull extends RemotePerson {
  folderId: string;
  name: string;
  order: number | null;
  description: string;
  inMemoriam: boolean;
}

export interface StaticPhoto {
  id: string;
  url: string;
}

export interface StaticPerson {
  // 64px round avatar for name pills, derived from the main photo (null when not cached yet).
  avatar: StaticPhoto | null;
  // The public About-Us Drive folder id: lets the profile drawer find a person's snapshot entry
  // without any e-mail (or e-mail-derived value) in this public file.
  folderId: string;
  name: string;
  order: number | null;
  description: string;
  inMemoriam: boolean;
  mainPhoto: StaticPhoto | null;
  photos: StaticPhoto[];
}

export interface PeopleSnapshot {
  version: 1;
  people: StaticPerson[];
}

// The API's order among people sharing an order number is arbitrary and can differ per request. A
// snapshot must be deterministic (or every nightly run would produce a different file and a
// pointless commit), so it is sorted stably here: numbered people by order then name, then
// unnumbered people by name.
export function sortPeopleDeterministically<T extends { name: string; order: number | null }>(people: T[]): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'pl');
  const numbered = people.filter(p => p.order !== null).sort((a, b) => a.order! - b.order! || byName(a, b));
  const unnumbered = people.filter(p => p.order === null).sort(byName);
  return [...numbered, ...unnumbered];
}

// A photo is included only if its cached copy is in the manifest, so the snapshot never points
// at an image that is not deployed (a failed download just leaves it out until tomorrow). Drive
// thumbnail URLs are deliberately not stored: they expire within about an hour.
export function buildSnapshot(people: RemotePersonFull[], manifest: Manifest): PeopleSnapshot {
  const toStatic = (photo: RemotePhoto | null, forcedSize?: number): StaticPhoto | null => {
    if (!photo) return null;
    const size = forcedSize ?? sizeFromUrl(photo.url);
    const file = size === null ? undefined : manifest.photos[photo.id]?.files[String(size)];
    return file ? { id: photo.id, url: `/${file}` } : null;
  };
  const sorted = sortPeopleDeterministically(people);
  return {
    version: 1,
    people: sorted.map(p => ({
      avatar: toStatic(p.mainPhoto, AVATAR_SIZE),
      folderId: p.folderId,
      name: p.name,
      order: p.order,
      description: p.description,
      inMemoriam: p.inMemoriam,
      mainPhoto: toStatic(p.mainPhoto),
      photos: p.photos.map(ph => toStatic(ph)).filter((x): x is StaticPhoto => x !== null),
    })),
  };
}
