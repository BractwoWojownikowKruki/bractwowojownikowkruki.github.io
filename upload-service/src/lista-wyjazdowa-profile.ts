import type { FirestoreLikeClient } from './firestore.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

/**
 * A member's Lista Wyjazdowa profile. The key is the canonical `personId` (KRKG-0087): for a
 * member it equals the e-mail, for a person without an account it is their UUID. The legacy
 * `companions` list lived here until KRKG-0087 - companions are now real person records
 * (`persons.ts`), not entries owned by a member's profile.
 */
export interface ListaWyjazdowaProfileDoc {
  weaponIds: string[];
  wpisowePaid: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface ProfileWritableFields {
  weaponIds: string[];
}

const COLLECTION = 'listaWyjazdowaProfile';

export async function getProfile(
  client: FirestoreLikeClient,
  personId: string,
): Promise<ListaWyjazdowaProfileDoc | null> {
  return client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, personId.toLowerCase());
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
  personId: string,
  fields: ProfileWritableFields,
): Promise<ListaWyjazdowaProfileDoc> {
  const id = personId.toLowerCase();
  const existing = await client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, id);
  const writable = {
    weaponIds: fields.weaponIds,
    updatedAt: new Date().toISOString(),
    updatedBy: id,
  };
  await client.setDoc(COLLECTION, id, existing ? writable : { ...writable, wpisowePaid: false });
  return { ...writable, wpisowePaid: existing?.wpisowePaid ?? false };
}

/**
 * Wpisowe is a club due, not a Lista Wyjazdowa feature - whether a member has ever filled in
 * "Mój profil" (weaponIds) must not gate whether they can be marked as having paid it.
 * For a member with no existing document this creates one with empty defaults, the same "give a
 * brand-new document its complete shape" approach saveProfile above already uses for a
 * self-service first save.
 */
export async function setWpisowePaid(
  client: FirestoreWriteContext,
  personId: string,
  paid: boolean,
  updatedBy: string,
): Promise<ListaWyjazdowaProfileDoc> {
  const id = personId.toLowerCase();
  const existing = await client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, id);
  const writable = { wpisowePaid: paid, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(COLLECTION, id, existing ? writable : { ...writable, weaponIds: [] });
  return {
    weaponIds: existing?.weaponIds ?? [],
    ...writable,
  };
}

/**
 * Admin/moderator write of another member's weaponIds, from Zarządzanie ludźmi's own weapon
 * checkboxes - unlike weaponIds via saveProfile above (self-service, the member's own "Mój
 * profil"), this lets an admin/moderator correct or set it on someone else's behalf, e.g. for a
 * member who hasn't filled in their profile yet. Same upsert shape as setWpisowePaid: creates a
 * document with empty defaults if the member has none yet.
 */
export async function setProfileWeaponIds(
  client: FirestoreWriteContext,
  personId: string,
  weaponIds: string[],
  updatedBy: string,
): Promise<ListaWyjazdowaProfileDoc> {
  const id = personId.toLowerCase();
  const existing = await client.getDoc<ListaWyjazdowaProfileDoc>(COLLECTION, id);
  const writable = { weaponIds, updatedBy, updatedAt: new Date().toISOString() };
  await client.setDoc(COLLECTION, id, existing ? writable : { ...writable, wpisowePaid: false });
  return {
    wpisowePaid: existing?.wpisowePaid ?? false,
    ...writable,
  };
}

// Plan B (roster join, GET /lista-wyjazdowa/roster): unlike getProfile, callers here need the
// key too, since ListaWyjazdowaProfileDoc itself doesn't carry it - it's only known via the doc id.
export async function listAllProfiles(client: FirestoreLikeClient): Promise<Array<ListaWyjazdowaProfileDoc & { email: string }>> {
  const docs = await client.listDocs<ListaWyjazdowaProfileDoc>(COLLECTION);
  return docs.map((d) => ({ email: d.id, ...d.data }));
}
