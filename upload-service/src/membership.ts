import { AuthError } from './auth.ts';
import type { FirestoreLikeClient } from './firestore.ts';
import { listAllMembers, type MemberDoc, type MembershipStatus } from './members.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

export interface ApplyFields {
  fullName: string;
  nickname: string | null;
  sectionId: string;
}

/**
 * Self-service registration/re-registration (KRKG-0046). Branches on the *existing* doc's
 * status: never lets a self-service call downgrade an active or suspended member back to
 * pending (409 instead, since that would silently revoke a live membership from a request the
 * member themselves controls), and never resets `appliedAt` on a re-submit while still pending
 * (that's an edit of an in-flight application, not a new one). Re-applying from `rejected`/
 * `removed` is allowed and starts a fresh application.
 */
export async function applyForMembership(
  client: FirestoreLikeClient,
  email: string,
  fields: ApplyFields,
): Promise<MemberDoc> {
  // KRKG-0046: read-validate-write inside a transaction so two concurrent submissions (or a
  // submission racing an admin transition) can't both read the same "before" status, both pass
  // validation, and silently overwrite each other - same reasoning as applyAdminTransition below.
  return client.runTransaction(tx => applyForMembershipInTransaction(tx, email, fields));
}

/** Applies one membership application through the caller's enclosing Firestore transaction. */
export async function applyForMembershipInTransaction(
  client: FirestoreWriteContext,
  email: string,
  fields: ApplyFields,
): Promise<MemberDoc> {
  const id = email.toLowerCase();
  const existing = await client.getDoc<MemberDoc>('members', id);
  if (existing?.status === 'active') {
    throw new AuthError('Jesteś już członkiem. Zmień dane w "Mój profil".', 409);
  }
  if (existing?.status === 'suspended') {
    throw new AuthError('Twoje konto jest zawieszone. Skontaktuj się z administratorem.', 409);
  }
  const now = new Date().toISOString();
  const appliedAt = existing?.status === 'pending' ? existing.appliedAt : now;
  const record: MemberDoc = {
    email: id,
    fullName: fields.fullName,
    nickname: fields.nickname,
    sectionId: fields.sectionId,
    categoryId: existing?.categoryId ?? null,
    driveFolderId: existing?.driveFolderId ?? null,
    stagingFolderId: existing?.stagingFolderId ?? null,
    status: 'pending',
    appliedAt,
    approvedAt: existing?.approvedAt ?? null,
    approvedBy: existing?.approvedBy ?? null,
    updatedAt: now,
    updatedBy: id,
    lastLoginAt: existing?.lastLoginAt ?? null,
    hidden: existing?.hidden ?? false,
  };
  await client.setDoc('members', id, record);
  return record;
}

export type AdminTransition = 'approve' | 'reject' | 'suspend' | 'reactivate' | 'remove';

interface TransitionRule {
  from: MembershipStatus[];
  to: MembershipStatus;
}

const TRANSITIONS: Record<AdminTransition, TransitionRule> = {
  approve: { from: ['pending'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'active' },
  remove: { from: ['active', 'suspended'], to: 'removed' },
};

/**
 * Every admin-driven status change, table-driven so the full set of legal transitions lives in
 * one place. Never deletes the document - "removed"/"rejected" are statuses, not deletions, so
 * the record (and its history of who approved it, when) stays for audit.
 */
export async function applyAdminTransition(
  client: FirestoreLikeClient,
  email: string,
  transition: AdminTransition,
  adminEmail: string,
): Promise<MemberDoc> {
  return client.runTransaction(tx => applyAdminTransitionInTransaction(tx, email, transition, adminEmail));
}

/** Applies a validated administrative status transition within an enclosing transaction. */
export async function applyAdminTransitionInTransaction(
  client: FirestoreWriteContext,
  email: string,
  transition: AdminTransition,
  adminEmail: string,
): Promise<MemberDoc> {
  const id = email.toLowerCase();
  // KRKG-0046: read-validate-write inside a transaction, so two admins (or two rapid requests)
  // acting on the same member can't both read the same source status, both pass the transition
  // guard, and then overwrite each other - whichever commits second re-reads the *already
  // updated* status and correctly 409s instead of silently clobbering the first result.
  const existing = await client.getDoc<MemberDoc>('members', id);
  const rule = TRANSITIONS[transition];
  if (!existing || !rule.from.includes(existing.status)) {
    throw new AuthError(
      `Nie można wykonać "${transition}" - obecny status: ${existing?.status ?? 'brak rekordu'}.`,
      409,
    );
  }
  const now = new Date().toISOString();
  const record: MemberDoc = {
    ...existing,
    status: rule.to,
    approvedAt: transition === 'approve' ? now : existing.approvedAt,
    approvedBy: transition === 'approve' ? adminEmail : existing.approvedBy,
    updatedAt: now,
    updatedBy: adminEmail,
  };
  await client.setDoc('members', id, record);
  return record;
}

export async function listMembersByStatus(
  client: FirestoreLikeClient,
  status: MembershipStatus,
): Promise<Array<MemberDoc & { email: string }>> {
  const all = await listAllMembers(client);
  return all.filter(m => m.status === status);
}
