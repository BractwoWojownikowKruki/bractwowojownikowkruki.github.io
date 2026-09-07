import type { FirestoreLikeClient } from './firestore.ts';

export type MembershipStatus = 'pending' | 'active' | 'suspended' | 'removed' | 'rejected';

export interface MemberDoc {
  email: string;
  fullName: string;
  nickname: string | null;
  sectionId: string;
  categoryId: string | null;
  driveFolderId: string | null;
  status: MembershipStatus;
  appliedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
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
  const now = new Date().toISOString();
  const writable = {
    fullName: fields.fullName,
    nickname: fields.nickname,
    sectionId: fields.sectionId,
    updatedAt: now,
    updatedBy: id,
  };
  // KRKG-0046: preserves status/appliedAt/approvedAt/approvedBy across a self-service profile
  // edit, the same way categoryId/driveFolderId were already preserved - a member editing their
  // own name/nickname/section must never reset their own membership status. A brand-new doc
  // (existing === null) should not occur in practice once KRKG-0046 ships, since reaching this
  // function requires already passing an active-status gate - handled defensively regardless.
  const record: MemberDoc = existing
    ? { ...existing, ...writable }
    : {
        ...writable,
        email: id,
        categoryId: null,
        driveFolderId: null,
        status: 'active',
        appliedAt: now,
        approvedAt: null,
        approvedBy: null,
      };
  await client.setDoc(COLLECTION, id, record);
  return record;
}

// Plan B (roster join, GET /lista-wyjazdowa/roster). KRKG-0046 added `email` to MemberDoc
// itself, written by every function in this file - but falls back to the doc id for documents
// seeded before that field existed (or seeded directly in tests without it), rather than
// returning an undefined email for them.
export async function listAllMembers(client: FirestoreLikeClient): Promise<Array<MemberDoc & { email: string }>> {
  const docs = await client.listDocs<MemberDoc>(COLLECTION);
  return docs.map((d) => ({ ...d.data, email: d.data.email ?? d.id }));
}
