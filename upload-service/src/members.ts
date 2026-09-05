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

export async function saveMember(
  client: FirestoreLikeClient,
  email: string,
  fields: MemberWritableFields,
): Promise<MemberDoc> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>(COLLECTION, id);
  const doc: MemberDoc = {
    fullName: fields.fullName,
    nickname: fields.nickname,
    sectionId: fields.sectionId,
    categoryId: existing?.categoryId ?? null,
    driveFolderId: existing?.driveFolderId ?? null,
    updatedAt: new Date().toISOString(),
    updatedBy: id,
  };
  await client.setDoc(COLLECTION, id, doc);
  return doc;
}
