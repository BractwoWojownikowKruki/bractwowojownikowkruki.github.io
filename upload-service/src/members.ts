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
  // KRKG-0049: set by recordLastLogin below, called from handleSessionLogin on every real
  // Google Sign-In (not every page load - the session cookie carries an existing sign-in past
  // that). null until this member's first login recorded under this field, which for anyone
  // approved before KRKG-0049 shipped means null-until-next-sign-in, not "never signed in".
  lastLoginAt: string | null;
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
 * Write of a member's identity record - either self-service (the caller editing their own
 * record) or an accountant/admin editing someone else's from the Lista Członków page (KRKG-0047).
 * `updatedBy` is always the *acting* identity, which for self-service happens to equal `email`
 * but for an admin edit does not - see server.ts's handleListaWyjazdowaPutMember.
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
  updatedBy: string,
): Promise<MemberDoc> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>(COLLECTION, id);
  const now = new Date().toISOString();
  const writable = {
    fullName: fields.fullName,
    nickname: fields.nickname,
    sectionId: fields.sectionId,
    updatedAt: now,
    updatedBy: updatedBy.toLowerCase(),
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
        lastLoginAt: null,
      };
  await client.setDoc(COLLECTION, id, record);
  return record;
}

/**
 * Admin-only write of the one deliberate exception to `driveFolderId` being admin-owned
 * (see saveMember's comment): an admin linking a member's account to their existing Drive
 * About-Us folder from the admin panel (KRKG-0037's deferred driveFolderId gap). Uses the same
 * merging `setDoc` as saveMember, so no other field is touched. Throws if the member doc doesn't
 * exist yet - there's no member identity to attach a folder to.
 */
export async function setMemberDriveFolderId(
  client: FirestoreLikeClient,
  email: string,
  folderId: string | null,
): Promise<void> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>(COLLECTION, id);
  if (!existing) throw new Error(`Nie znaleziono członka: ${id}`);
  await client.setDoc(COLLECTION, id, { driveFolderId: folderId });
}

// KRKG-0050: the "typ członka" (Brokuł/Kandydat/Blacha/Thing/Niewiasta/Bobo/Inne, sourced from
// lookupLists/categories - "Rola" in the original sheet) is the other admin-owned field besides
// driveFolderId (see saveMember's comment) - self-service never sends it. Same shape as
// setMemberDriveFolderId: throws if the member doc doesn't exist, since this is only ever called
// from the admin panel's Zarządzanie ludźmi page, editing someone already in the list.
export async function setMemberCategoryId(
  client: FirestoreLikeClient,
  email: string,
  categoryId: string | null,
): Promise<void> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>(COLLECTION, id);
  if (!existing) throw new Error(`Nie znaleziono członka: ${id}`);
  await client.setDoc(COLLECTION, id, { categoryId });
}

// KRKG-0049: called from handleSessionLogin on every real Google Sign-In. Silently does nothing
// for an email with no members/{email} doc (never applied, or a stray/unrelated Google account) -
// unlike setMemberDriveFolderId above, a login must never fail because of this side effect, and
// creating a bare partial doc via a merging setDoc on a nonexistent id would otherwise plant a
// garbage member record missing every other required field.
export async function recordLastLogin(client: FirestoreLikeClient, email: string): Promise<void> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>(COLLECTION, id);
  if (!existing) return;
  await client.setDoc(COLLECTION, id, { lastLoginAt: new Date().toISOString() });
}

// Plan B (roster join, GET /lista-wyjazdowa/roster). KRKG-0046 added `email` to MemberDoc
// itself, written by every function in this file - but falls back to the doc id for documents
// seeded before that field existed (or seeded directly in tests without it), rather than
// returning an undefined email for them.
export async function listAllMembers(client: FirestoreLikeClient): Promise<Array<MemberDoc & { email: string }>> {
  const docs = await client.listDocs<MemberDoc>(COLLECTION);
  return docs.map((d) => ({ ...d.data, email: d.data.email ?? d.id }));
}
