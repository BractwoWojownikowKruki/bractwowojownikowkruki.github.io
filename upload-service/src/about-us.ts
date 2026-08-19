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

const PERSON_FOLDER_NAME_PATTERN = /^(\d+)\.\s*(.+)$/;

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
  description: string;
  mainPhoto: PersonPhoto | null;
  photos: PersonPhoto[];
}

export interface AboutUsFolders {
  root: string;
  categories: Record<AboutUsCategory, string>;
  // Sibling of the categories, not one of them - self-service submissions from the Wojownicy
  // "Wrzucam swoje zdjęcie" flow land here for Bartosz to review and move into an actual
  // category manually, rather than publishing straight to a live category (see
  // handleWojownicyUploadSubmit in server.ts). Deliberately not made public via
  // setFolderPublic below - nothing here is meant to be linked from the public site.
  uploadRoot: string;
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
      const uploadRoot = await drive.ensureFolder(oNasId, 'upload');
      return { root: oNasId, categories, uploadRoot };
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
      const { name } = parsePersonFolderName(folder.name);
      const [description, images] = await Promise.all([
        drive.readTextFile(folder.id, 'Opis.txt'),
        drive.listImageFiles(folder.id),
      ]);
      const [mainImage, ...restImages] = images;
      const mainPhoto: PersonPhoto | null =
        mainImage?.thumbnailLink != null ? { id: mainImage.id, url: resizeThumbnailUrl(mainImage.thumbnailLink, 800) } : null;
      const photos: PersonPhoto[] = restImages
        .filter((img): img is typeof img & { thumbnailLink: string } => img.thumbnailLink != null)
        .map(img => ({ id: img.id, url: resizeThumbnailUrl(img.thumbnailLink, 300) }));
      return { folderId: folder.id, name, description: description ?? '', mainPhoto, photos };
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
