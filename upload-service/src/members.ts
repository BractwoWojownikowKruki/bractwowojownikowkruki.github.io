import type { FirestoreLikeClient } from './firestore.ts';

export interface MemberDoc {
  fullName: string;
  nickname: string | null;
  sectionId: string;
  categoryId: string | null;
  driveFolderId: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface MemberWritableFields {
  fullName: string;
  nickname: string | null;
  sectionId: string;
}

const COLLECTION = 'members';

export async function getMember(client: FirestoreLikeClient, email: string): Promise<MemberDoc | null> {
  return client.getDoc<MemberDoc>(COLLECTION, email.toLowerCase());
}

/**
 * Self-service write of the caller's own identity record.
 *
 * Only the member-writable fields are sent to Firestore; `categoryId` and `driveFolderId` are
 * admin-owned (design.md §7) and are never named in the update, so the merging write
 * (`FirestoreLikeClient.setDoc`) leaves whatever the admin set there - including a value written
 * concurrently with this save, and including fields this codebase does not model - untouched.
 * They are only written on first creation, to give a brand-new document its complete shape.
 */
export async function saveMember(
  client: FirestoreLikeClient,
  email: string,
  fields: MemberWritableFields,
): Promise<MemberDoc> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>(COLLECTION, id);
  const writable = {
    fullName: fields.fullName,
    nickname: fields.nickname,
    sectionId: fields.sectionId,
    updatedAt: new Date().toISOString(),
    updatedBy: id,
  };
  await client.setDoc(
    COLLECTION,
    id,
    existing ? writable : { ...writable, categoryId: null, driveFolderId: null },
  );
  return {
    ...writable,
    categoryId: existing?.categoryId ?? null,
    driveFolderId: existing?.driveFolderId ?? null,
  };
}

// Plan B (roster join, GET /lista-wyjazdowa/roster): unlike getMember, callers here need the
// email too, since MemberDoc itself doesn't carry it - it's only known via the doc id.
export async function listAllMembers(client: FirestoreLikeClient): Promise<Array<MemberDoc & { email: string }>> {
  const docs = await client.listDocs<MemberDoc>(COLLECTION);
  return docs.map((d) => ({ email: d.id, ...d.data }));
}
