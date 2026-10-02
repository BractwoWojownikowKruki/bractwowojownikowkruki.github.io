import type { FirestoreLikeClient, FirestoreTransaction } from './firestore.ts';

export interface LookupItem {
  id: string;
  label: string;
  /** equipmentCategories only: id of the equipmentGroups item this category belongs to, or null. */
  groupId?: string | null;
  retired: boolean;
}

export type LookupListName = 'sections' | 'categories' | 'weapons' | 'equipmentCategories' | 'equipmentGroups';

const COLLECTION = 'lookupLists';
const LIST_NAMES: LookupListName[] = ['sections', 'categories', 'weapons', 'equipmentCategories', 'equipmentGroups'];

export async function getLookupList(client: FirestoreLikeClient, name: LookupListName): Promise<LookupItem[]> {
  const doc = await client.getDoc<{ items: LookupItem[] }>(COLLECTION, name);
  return doc?.items ?? [];
}

export async function getAllLookupLists(
  client: FirestoreLikeClient,
): Promise<Record<LookupListName, LookupItem[]>> {
  const entries = await Promise.all(LIST_NAMES.map(async (name) => [name, await getLookupList(client, name)] as const));
  return Object.fromEntries(entries) as Record<LookupListName, LookupItem[]>;
}

export async function getLookupListInTransaction(tx: FirestoreTransaction, name: LookupListName): Promise<LookupItem[]> {
  const doc = await tx.getDoc<{ items: LookupItem[] }>(COLLECTION, name);
  return doc?.items ?? [];
}

export async function saveLookupListInTransaction(tx: FirestoreTransaction, name: LookupListName, items: LookupItem[]): Promise<void> {
  await tx.setDoc(COLLECTION, name, { items });
}

/** Lower-case ASCII slug of a label ("Misa ogniowa" -> "misa-ogniowa"), same folding as the seed script. */
export function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

/** A slug of `label` that collides with no id in `items` (appends -2, -3, ... when needed). */
export function uniqueLookupId(items: readonly { id: string }[], label: string): string {
  const base = slugifyLabel(label);
  const taken = new Set(items.map((item) => item.id));
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}
