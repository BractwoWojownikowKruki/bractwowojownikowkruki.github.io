import { randomUUID } from 'node:crypto';
import type { FirestoreLikeClient } from './firestore.ts';
import { AuthError } from './auth.ts';
import type { Authorizer } from './server.ts';

type FirestoreWriteContext = Pick<FirestoreLikeClient, 'getDoc' | 'setDoc'>;

// 'moderator' (KRKG-0049) replaces the old Google-Group-backed moderator mechanism (KRKG-0027,
// which gated gallery deletion and was never actually configured in production - see the removed
// moderatorGroupUrl/authenticateModerator in server.ts/config.ts). It's scoped to people
// management - admin-like powers over the Zarządzanie ludźmi page (member status/profile/Drive-
// folder, not galleries), deliberately excluding role assignment itself (see ASSIGNABLE_ROLES in
// server.ts - only an admin can grant/revoke any role, including 'moderator').
export type AccessRole = 'member' | 'accountant' | 'moderator' | 'admin';

interface UserRolesDoc {
  roles: string[];
}

// KRKG-0049: role grants are the most privilege-sensitive write in the admin panel, so every
// change is logged - mirrors dues.ts's DuesAuditEntry/appendDuesAuditEntry/listDuesAuditLog
// (this codebase's existing pattern: a small collection dedicated to one sensitive write path,
// rather than one generic action log for everything).
export interface RoleAuditEntry {
  targetEmail: string;
  previousRoles: string[];
  newRoles: string[];
  changedBy: string;
  changedAt: string;
  changeSummary: string;
}

const ROLE_AUDIT_COLLECTION = 'rolesAuditLog';

export async function appendRoleAuditEntry(client: FirestoreLikeClient, entry: Omit<RoleAuditEntry, 'changedAt'>): Promise<void> {
  const id = randomUUID();
  const full: RoleAuditEntry = { ...entry, changedAt: new Date().toISOString() };
  await client.setDoc(ROLE_AUDIT_COLLECTION, id, full);
}

export async function listRoleAuditLog(client: FirestoreLikeClient): Promise<RoleAuditEntry[]> {
  const all = await client.listDocs<RoleAuditEntry>(ROLE_AUDIT_COLLECTION);
  return all.map((d) => d.data).sort((a, b) => a.changedAt.localeCompare(b.changedAt));
}

export async function getGrantedRoles(client: FirestoreLikeClient, email: string): Promise<string[]> {
  const doc = await client.getDoc<UserRolesDoc>('userRoles', email.toLowerCase());
  return doc?.roles ?? [];
}

// KRKG-0049: the first way to grant userRoles other than a direct Firestore-console edit (see
// design notes on KRKG-0037's Plan C, which deliberately left this out). Admin-only at the
// server.ts route level - this function itself does no authorization, same division of
// responsibility as saveMember/setMemberDriveFolderId in members.ts.
export async function setGrantedRoles(client: FirestoreWriteContext, email: string, roles: string[]): Promise<void> {
  await client.setDoc('userRoles', email.toLowerCase(), { roles });
}

export async function listAllGrantedRoles(client: FirestoreLikeClient): Promise<Array<{ email: string; roles: string[] }>> {
  const docs = await client.listDocs<UserRolesDoc>('userRoles');
  return docs.map((d) => ({ email: d.id, roles: d.data.roles ?? [] }));
}

export function satisfiesRole(grantedRoles: string[], required: AccessRole): boolean {
  if (required === 'member') return true;
  if (required === 'accountant') return grantedRoles.includes('accountant') || grantedRoles.includes('admin');
  if (required === 'moderator') return grantedRoles.includes('moderator') || grantedRoles.includes('admin');
  return grantedRoles.includes('admin');
}

export async function requireRole(
  client: FirestoreLikeClient,
  email: string,
  required: AccessRole,
): Promise<void> {
  const granted = await getGrantedRoles(client, email);
  if (!satisfiesRole(granted, required)) {
    throw new AuthError('Brak uprawnień do tej operacji.', 403);
  }
}

// An Authorizer (server.ts) backed by a Firestore userRoles doc, for composing into
// authenticateAdminOrModerator alongside the admin-allowlist Authorizer via server.ts's anyOf() -
// same role check as requireRole above, wrapped to fit the Authorizer shape verifySessionRequest
// expects.
export function createRoleAuthorizer(client: FirestoreLikeClient, required: AccessRole): Authorizer {
  return {
    async authorize(identity) {
      await requireRole(client, identity.email, required);
    },
  };
}
