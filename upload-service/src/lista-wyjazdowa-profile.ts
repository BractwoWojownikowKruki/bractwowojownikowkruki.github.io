import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';

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

export async function saveProfile(
  client: FirestoreLikeClient,
  email: string,
  fields: ProfileWritableFields,
): Promise<ListaWyjazdowaProfileDoc> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, id);
  const doc: ListaWyjazdowaProfileDoc = {
    weaponIds: fields.weaponIds,
    equipment: fields.equipment.map((e) => ({ ...e, id: e.id || randomUUID() })),
    companions: fields.companions.map((c) => ({ ...c, id: c.id || randomUUID() })),
    wpisowePaid: existing?.wpisowePaid ?? false,
    updatedAt: new Date().toISOString(),
    updatedBy: id,
  };
  await client.setDoc(COLLECTION, id, doc);
  return doc;
}
