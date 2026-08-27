import type { DriveClient } from './drive.ts';
import { resizeThumbnailUrl } from './drive.ts';

// "Blachowi" - warriors who've earned their Kruczy Wisior badge (see kruki.org's "Po tym nas
// poznacie" section) - was originally named "Wojownicy" before the nav was restructured to
// put a "Wojownicy" menu item above these four categories instead.
export const ABOUT_US_CATEGORIES = ['Blachowi', 'Niewiasty', 'Emeryci', 'Kandydaci'] as const;
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

// The order a person's folder should be renamed to when moved into a *public* department (see
// handleAdminMovePerson) - moving into "upload"/"deleted" never calls this, since order is
// meaningless there (neither is publicly listed). Every department appends to the end (the
// highest existing order + 1, so sortPeopleByFolderName shows the newcomer last) except
// Emeryci, which by design prepends instead (the lowest existing order - 1, shown first) -
// retiring warriors join at the top of that list, not the bottom.
export function computeOrderForDepartmentMove(department: AboutUsCategory, existingFolderNames: string[]): number {
  const orders = existingFolderNames
    .map(name => parsePersonFolderName(name).order)
    .filter((order): order is number => order !== null);
  if (orders.length === 0) return 1;
  return department === 'Emeryci' ? Math.min(...orders) - 1 : Math.max(...orders) + 1;
}

// Allows an optional leading "-": computeOrderForDepartmentMove can legitimately produce a
// negative order (Emeryci prepends via lowest-existing-order - 1, and repeated moves there walk
// that value below zero) - a pattern that didn't accept "-" silently failed to parse a folder
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

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Orders numbered folders ascending (ties broken randomly, per spec - re-shuffled on every
// cache refresh rather than pinned, which is an acceptable trade for staying simple), then
// unnumbered folders alphabetically at the end.
export function sortPeopleByFolderName<T extends { folderName: string }>(items: T[]): T[] {
  const parsed = items.map(item => ({ item, ...parsePersonFolderName(item.folderName) }));
  const numbered = parsed.filter((p): p is typeof p & { order: number } => p.order !== null);
  const unnumbered = parsed.filter(p => p.order === null);

  const groups = new Map<number, typeof numbered>();
  for (const entry of numbered) {
    const group = groups.get(entry.order) ?? [];
    group.push(entry);
    groups.set(entry.order, group);
  }
  const sortedOrders = [...groups.keys()].sort((a, b) => a - b);
  const numberedSorted = sortedOrders.flatMap(order => shuffle(groups.get(order)!));

  unnumbered.sort((a, b) => a.name.localeCompare(b.name, 'pl'));

  return [...numberedSorted, ...unnumbered].map(p => p.item);
}

export interface PersonPhoto {
  id: string;
  url: string;
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

const CATEGORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
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
        mainImage?.thumbnailLink != null ? { id: mainImage.id, url: resizeThumbnailUrl(mainImage.thumbnailLink, 800) } : null;
      const photos: PersonPhoto[] = restImages
        .filter((img): img is typeof img & { thumbnailLink: string } => img.thumbnailLink != null)
        .map(img => ({ id: img.id, url: resizeThumbnailUrl(img.thumbnailLink, 300) }));
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
