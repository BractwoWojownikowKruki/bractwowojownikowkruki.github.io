import type { FirestoreLikeClient } from './firestore.ts';

export interface LookupItem {
  id: string;
  label: string;
  retired: boolean;
}

export type LookupListName = 'sections' | 'categories' | 'weapons';

const COLLECTION = 'lookupLists';
const LIST_NAMES: LookupListName[] = ['sections', 'categories', 'weapons'];

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
