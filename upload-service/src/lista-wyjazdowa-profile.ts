import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

export interface EquipmentItem {
  id: string;
  name: string;
  description: string;
}

export interface Companion {
  id: string;
  name: string;
}

export interface ListaWyjazdowaProfileDoc {
  weaponIds: string[];
  equipment: EquipmentItem[];
  companions: Companion[];
  wpisowePaid: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface ProfileWritableFields {
  weaponIds: string[];
  equipment: Array<{ id: string; name: string; description: string }>;
  companions: Array<{ id: string; name: string }>;
}

const COLLECTION = 'listaWyjazdowaProfile';

export async function getProfile(
  client: FirestoreLikeClient,
  email: string,
): Promise<ListaWyjazdowaProfileDoc | null> {
  return client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, email.toLowerCase());
}

/**
 * Self-service write of the caller's own Lista Wyjazdowa profile.
 *
 * `wpisowePaid` is accountant/admin-only (design.md §7a/§9), so - exactly like `members.categoryId`
 * in `saveMember` - it is deliberately left out of the update payload and relies on the merging
 * write in `FirestoreLikeClient.setDoc` to survive untouched; it is only written on first creation,
 * to give a brand-new document its complete shape.
 */
export async function saveProfile(
  client: FirestoreWriteContext,
  email: string,
  fields: ProfileWritableFields,
): Promise<ListaWyjazdowaProfileDoc> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, id);
  const writable = {
    weaponIds: fields.weaponIds,
    equipment: fields.equipment.map((e) => ({ ...e, id: e.id || randomUUID() })),
    companions: fields.companions.map((c) => ({ ...c, id: c.id || randomUUID() })),
    updatedAt: new Date().toISOString(),
    updatedBy: id,
  };
  await client.setDoc(COLLECTION, id, existing ? writable : { ...writable, wpisowePaid: false });
  return { ...writable, wpisowePaid: existing?.wpisowePaid ?? false };
}

export async function setWpisowePaid(
  client: FirestoreWriteContext,
  email: string,
  paid: boolean,
  updatedBy: string,
): Promise<ListaWyjazdowaProfileDoc | null> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, id);
  if (!existing) return null;
  const writable = { wpisowePaid: paid, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(COLLECTION, id, writable);
  return { ...existing, ...writable };
}

// Plan B (roster join, GET /lista-wyjazdowa/roster): unlike getProfile, callers here need the
// email too, since ListaWyjazdowaProfileDoc itself doesn't carry it - it's only known via the doc id.
export async function listAllProfiles(client: FirestoreLikeClient): Promise<Array<ListaWyjazdowaProfileDoc & { email: string }>> {
  const docs = await client.listDocs<ListaWyjazdowaProfileDoc>(COLLECTION);
  return docs.map((d) => ({ email: d.id, ...d.data }));
}
