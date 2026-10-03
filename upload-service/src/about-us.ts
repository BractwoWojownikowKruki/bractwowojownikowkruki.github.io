import type { DriveClient, DriveImageInfo } from './drive.ts';
import { resizeThumbnailUrl } from './drive.ts';

// The public "My, Wojownicy" person categories, in canonical display order. "Założyciele" (the
// club's founders) sits first; "Blachowi" - warriors who've earned their Kruczy Wisior badge
// (see kruki.org's "Po tym nas poznacie" section) - was originally named "Wojownicy" before the
// nav was restructured to put a "Wojownicy" menu item above these categories instead.
export const ABOUT_US_CATEGORIES = ['Założyciele', 'Blachowi', 'Niewiasty', 'Emeryci', 'Kandydaci'] as const;
export type AboutUsCategory = (typeof ABOUT_US_CATEGORIES)[number];

export function isAboutUsCategory(value: string): value is AboutUsCategory {
  return (ABOUT_US_CATEGORIES as readonly string[]).includes(value);
}

// The admin panel's "department" concept is the 4 public categories plus two staging/archive
// folders - "upload" (see AboutUsFolders.uploadRoot) and "deleted" (see AboutUsFolders.deletedRoot,
// the admin panel's "remove from site" action - a soft delete, moving the folder aside rather
// than actually deleting it from Drive) - kept distinct from AboutUsCategory/isAboutUsCategory,
// which gate the *public* /about-us endpoint and must never accept either (neither unreviewed
// submissions nor removed people should ever become publicly fetchable by category name).
export type AdminDepartment = AboutUsCategory | 'upload' | 'deleted';

export function isAdminDepartment(value: string): value is AdminDepartment {
  return value === 'upload' || value === 'deleted' || isAboutUsCategory(value);
}

export function departmentFolderId(folders: AboutUsFolders, department: AdminDepartment): string {
  if (department === 'upload') return folders.uploadRoot;
  if (department === 'deleted') return folders.deletedRoot;
  return folders.categories[department];
}

// The order a person's folder should be renamed to when it joins a *public* department - via a
// move (see handleAdminMovePerson) or a first-time creation there (see handleAdminApprovePhoto);
// "upload"/"deleted" never call this, since order is meaningless there (neither is publicly
// listed). Only the moment of joining that category matters, never how long the person has been
// on the site or has had an account. Every department appends to the end (the highest existing
// order + 1, so sortPeopleByFolderName shows the newcomer last) except Emeryci, which by design
// prepends instead (the lowest existing order - 1, shown first) - retiring warriors join at the
// top of their list, not the bottom.
export function computeOrderForDepartmentMove(department: AboutUsCategory, existingFolderNames: string[]): number {
  const orders = existingFolderNames
    .map(name => parsePersonFolderName(name).order)
    .filter((order): order is number => order !== null);
  if (orders.length === 0) return 1;
  return department === 'Emeryci' ? Math.min(...orders) - 1 : Math.max(...orders) + 1;
}

export interface FolderRename {
  folderId: string;
  newName: string;
}

export interface NewcomerPlan {
  newcomerOrder: number;
  // Siblings that had no number at all (sorted last, alphabetically) - given one, in the order
  // they are displayed today, *before* the newcomer is placed. Without this a newcomer numbered
  // after the highest existing order would still show up ahead of every unnumbered sibling.
  renames: FolderRename[];
}

// The order for a person joining `department` next to `siblings` (the folders already there,
// newcomer excluded). Numbers every unnumbered sibling first (keeping its current position:
// after all numbered ones), then asks computeOrderForDepartmentMove, so the newcomer really
// lands last (or first, for Emeryci).
export function planNewcomerOrder(department: AboutUsCategory, siblings: { id: string; name: string }[]): NewcomerPlan {
  const parsed = siblings.map(s => ({ ...s, ...parsePersonFolderName(s.name) }));
  const unnumbered = parsed
    .filter(p => p.order === null)
    .sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  const renames: FolderRename[] = [];
  const names = parsed.filter(p => p.order !== null).map(p => buildPersonFolderName(p.name, p.order));
  let next = Math.max(0, ...parsed.map(p => p.order ?? 0));
  for (const p of unnumbered) {
    next += 1;
    const newName = buildPersonFolderName(p.name, next);
    renames.push({ folderId: p.id, newName });
    names.push(newName);
  }
  return { newcomerOrder: computeOrderForDepartmentMove(department, names), renames };
}

// Renames that make a category's folders numbered 1..N in exactly the order of `orderedFolderIds`
// (the admin panel's "Zarządzanie kolejnością"). `folders` is what Drive currently holds in the
// category; the list must contain each of them exactly once - otherwise someone was added,
// moved or removed while the admin was dragging, and saving the stale list would silently
// misplace them, so this throws instead. Folders already carrying the right number are skipped.
export function planCategoryReorder(folders: { id: string; name: string }[], orderedFolderIds: string[]): FolderRename[] {
  const byId = new Map(folders.map(f => [f.id, f]));
  const unique = new Set(orderedFolderIds);
  if (unique.size !== orderedFolderIds.length || unique.size !== byId.size || orderedFolderIds.some(id => !byId.has(id))) {
    throw new Error('Lista osób zmieniła się w międzyczasie.');
  }
  const renames: FolderRename[] = [];
  orderedFolderIds.forEach((id, index) => {
    const folder = byId.get(id)!;
    const newName = buildPersonFolderName(parsePersonFolderName(folder.name).name, index + 1);
    if (newName !== folder.name) renames.push({ folderId: id, newName });
  });
  return renames;
}

// Allows an optional leading "-": computeOrderForDepartmentMove can legitimately produce a
// negative order (Emeryci/Założyciele prepend via lowest-existing-order - 1, and repeated moves
// there walk that value below zero) - a pattern that didn't accept "-" silently failed to parse a folder
// like "-1. Ragnar" back out, treating the *entire* "-1. Ragnar" as an unnumbered name instead
// (which also meant it sorted to the end of the list, alongside every other real unnumbered
// entry, rather than at the top as intended).
const PERSON_FOLDER_NAME_PATTERN = /^(-?\d+)\.\s*(.+)$/;

export interface ParsedPersonFolderName {
  order: number | null;
  name: string;
}

// "1. Ragnar" -> {order: 1, name: "Ragnar"}; "Ragnar" (no leading "N. ") -> {order: null, name: "Ragnar"}.
export function parsePersonFolderName(folderName: string): ParsedPersonFolderName {
  const match = folderName.match(PERSON_FOLDER_NAME_PATTERN);
  if (!match) return { order: null, name: folderName.trim() };
  return { order: Number(match[1]), name: match[2].trim() };
}

export function buildPersonFolderName(name: string, order: number | null): string {
  const trimmedName = name.trim();
  return order === null ? trimmedName : `${order}. ${trimmedName}`;
}

// Orders numbered folders ascending (folders sharing a number by name), then unnumbered folders
// alphabetically at the end.
export function sortPeopleByFolderName<T extends { folderName: string }>(items: T[]): T[] {
  const parsed = items.map(item => ({ item, ...parsePersonFolderName(item.folderName) }));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'pl');
  const numbered = parsed
    .filter((p): p is typeof p & { order: number } => p.order !== null)
    .sort((a, b) => a.order - b.order || byName(a, b));
  const unnumbered = parsed.filter(p => p.order === null).sort(byName);

  return [...numbered, ...unnumbered].map(p => p.item);
}

export interface PersonPhoto {
  id: string;
  url: string;
  // Drive content checksum (see DriveImageInfo.md5Checksum) - lets the static photo cache know
  // whether its stored copy is still current. Omitted when Drive has none.
  md5?: string;
}

function toPersonPhoto(img: DriveImageInfo & { thumbnailLink: string }, size: number): PersonPhoto {
  return {
    id: img.id,
    url: resizeThumbnailUrl(img.thumbnailLink, size),
    ...(img.md5Checksum ? { md5: img.md5Checksum } : {}),
  };
}

// Shared by handleListaWyjazdowaGetProfilePhoto and handleMemberProfile (server.ts) - both read
// a single Drive folder's images and split them into a main photo + extras the same way
// fetchCategoryPeople does inline just below. Not reused by fetchCategoryPeople itself: that
// function interleaves the description read into the same Promise.all and has its own,
// separately-tested shape - not worth the churn for a third caller that doesn't exist.
export function mapDriveImagesToPhotos(images: DriveImageInfo[]): { mainPhoto: PersonPhoto | null; photos: PersonPhoto[] } {
  const [mainImage, ...restImages] = images;
  const mainPhoto: PersonPhoto | null =
    mainImage?.thumbnailLink != null ? toPersonPhoto({ ...mainImage, thumbnailLink: mainImage.thumbnailLink }, 800) : null;
  const photos: PersonPhoto[] = restImages
    .filter((img): img is typeof img & { thumbnailLink: string } => img.thumbnailLink != null)
    .map(img => toPersonPhoto(img, 300));
  return { mainPhoto, photos };
}

export interface Person {
  folderId: string;
  name: string;
  // Parsed straight from the folder name (see parsePersonFolderName) - null for an unnumbered
  // folder. Exposed so the admin panel can prefill a "Kolejność" input with the current value
  // when offering to change it (see handleAdminUpdatePersonOrder in server.ts).
  order: number | null;
  description: string;
  mainPhoto: PersonPhoto | null;
  photos: PersonPhoto[];
  // Set via the admin panel's "Oznacz jako in memoriam" toggle (handleAdminSetInMemoriam) -
  // the public site renders this person's photos in grayscale with a black diagonal ribbon
  // (see person-tile.js). Stored as a small marker file (IN_MEMORIAM_FILE_NAME) rather than in
  // the folder name, so it doesn't interact with the "N. Imię" order-prefix parsing at all.
  inMemoriam: boolean;
}

export const IN_MEMORIAM_FILE_NAME = '.in-memoriam';

export interface AboutUsFolders {
  root: string;
  categories: Record<AboutUsCategory, string>;
  // Holds self-service submissions from the Wojownicy "Wrzucam swoje zdjęcie" flow, for
  // Bartosz to review and move into an actual category manually, rather than publishing
  // straight to a live category (see handleWojownicyUploadSubmit in server.ts). Lives under a
  // *separate* private root (see bootstrapAboutUsStructure), not under `root`/"O Nas" itself
  // (KRKG-0029): Drive permissions are inherited by every descendant of a shared folder
  // regardless of when they're created, so merely never calling setFolderPublic on this folder
  // was not enough - it still inherited "O Nas"'s own public-reader grant by being nested under
  // it. Being a sibling of "O Nas" instead, under an unshared parent, is what actually keeps it
  // private.
  uploadRoot: string;
  // Another child of the same private root, holding people removed from the site via the admin
  // panel's "move to department" action (see handleAdminMovePerson) - a soft delete: the folder
  // and its photos stay in Drive, just moved out of any publicly-listed category, rather than
  // being deleted outright. Same private-root placement as uploadRoot above, for the same reason.
  deletedRoot: string;
}

// Memoized for the process lifetime: the folder tree, once created, never needs to be
// recreated or re-looked-up - ensureFolder's own find-before-create already makes a cold
// start safe, this just avoids redoing that round-trip on every request within one instance.
let bootstrapPromise: Promise<AboutUsFolders> | null = null;

export function bootstrapAboutUsStructure(drive: DriveClient): Promise<AboutUsFolders> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const stronaId = await drive.ensureFolder('root', 'Strona');
      const oNasId = await drive.ensureFolder(stronaId, 'O Nas');
      // Readable by anyone with the link (so mainPhoto/photos URLs work in a public <img>),
      // write access stays limited to whoever holds this service's OAuth token plus the human
      // owner - setFolderPublic only ever grants a reader role.
      await drive.setFolderPublic(oNasId);
      const categories = {} as Record<AboutUsCategory, string>;
      for (const category of ABOUT_US_CATEGORIES) {
        categories[category] = await drive.ensureFolder(oNasId, category);
      }
      // A sibling of "O Nas" under "Strona", not a descendant of "O Nas" itself (KRKG-0029) -
      // see AboutUsFolders.uploadRoot for why that placement matters. `stronaId` itself is never
      // passed to setFolderPublic, so nothing under it is public by inheritance either.
      const privateRootId = await drive.ensureFolder(stronaId, 'O Nas (prywatne)');
      const uploadRoot = await drive.ensureFolder(privateRootId, 'upload');
      const deletedRoot = await drive.ensureFolder(privateRootId, 'deleted');
      return { root: oNasId, categories, uploadRoot, deletedRoot };
    })();
  }
  return bootstrapPromise;
}

// Test-only seam: production never needs to un-memoize this, but a test that calls
// bootstrapAboutUsStructure more than once with different fake drives needs to reset it.
export function resetAboutUsBootstrapForTests(): void {
  bootstrapPromise = null;
}

// KRKG-0069: was 6h, which is longer than a Drive API thumbnailLink actually stays valid
// (undocumented by Google, but commonly observed to expire within about an hour) - a cached
// Person's mainPhoto/photos URLs would start 403ing in the browser well before this cache
// entry itself expired and got a fresh thumbnailLink. 20 minutes keeps a comfortable margin
// below that real-world expiry while still meaningfully reducing Drive API calls for a
// low-traffic public page.
const CATEGORY_CACHE_TTL_MS = 20 * 60 * 1000;
const categoryCache = new Map<string, { expiresAt: number; data: Person[] }>();

export async function fetchCategoryPeople(drive: DriveClient, categoryFolderId: string): Promise<Person[]> {
  const now = Date.now();
  const cached = categoryCache.get(categoryFolderId);
  if (cached && cached.expiresAt > now) return cached.data;

  const personFolders = await drive.listGalleryFolders(categoryFolderId);
  const sortedFolders = sortPeopleByFolderName(personFolders.map(f => ({ folderName: f.name, folder: f }))).map(
    x => x.folder,
  );

  const people = await Promise.all(
    sortedFolders.map(async folder => {
      const { name, order } = parsePersonFolderName(folder.name);
      const [description, images, inMemoriamMarker] = await Promise.all([
        drive.readTextFile(folder.id, 'Opis.txt'),
        drive.listImageFiles(folder.id),
        drive.readTextFile(folder.id, IN_MEMORIAM_FILE_NAME),
      ]);
      const [mainImage, ...restImages] = images;
      const mainPhoto: PersonPhoto | null =
        mainImage?.thumbnailLink != null ? toPersonPhoto({ ...mainImage, thumbnailLink: mainImage.thumbnailLink }, 800) : null;
      const photos: PersonPhoto[] = restImages
        .filter((img): img is typeof img & { thumbnailLink: string } => img.thumbnailLink != null)
        .map(img => toPersonPhoto(img, 300));
      return {
        folderId: folder.id,
        name,
        order,
        description: description ?? '',
        mainPhoto,
        photos,
        inMemoriam: inMemoriamMarker === 'true',
      };
    }),
  );

  categoryCache.set(categoryFolderId, { expiresAt: now + CATEGORY_CACHE_TTL_MS, data: people });
  return people;
}

// Cheap and coarse on purpose: an admin write is rare (nowhere near request-per-second
// volume), so clearing every category's cache on any single change is simpler than tracking
// which category a given folderId belongs to, and costs nothing beyond one extra Drive
// round-trip apiece the next time each category page is loaded.
export function invalidateAboutUsCache(): void {
  categoryCache.clear();
}
