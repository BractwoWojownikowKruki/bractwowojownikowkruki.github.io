import type { FirestoreLikeClient } from './firestore.ts';
import { AuthError } from './auth.ts';

export type AccessRole = 'member' | 'accountant' | 'admin';

interface UserRolesDoc {
  roles: string[];
}

export async function getGrantedRoles(client: FirestoreLikeClient, email: string): Promise<string[]> {
  const doc = await client.getDoc<UserRolesDoc>('userRoles', email.toLowerCase());
  return doc?.roles ?? [];
}

// KRKG-0049: the first way to grant userRoles other than a direct Firestore-console edit (see
// design notes on KRKG-0037's Plan C, which deliberately left this out). Admin-only at the
// server.ts route level - this function itself does no authorization, same division of
// responsibility as saveMember/setMemberDriveFolderId in members.ts.
export async function setGrantedRoles(client: FirestoreLikeClient, email: string, roles: string[]): Promise<void> {
  await client.setDoc('userRoles', email.toLowerCase(), { roles });
}

export async function listAllGrantedRoles(client: FirestoreLikeClient): Promise<Array<{ email: string; roles: string[] }>> {
  const docs = await client.listDocs<UserRolesDoc>('userRoles');
  return docs.map((d) => ({ email: d.id, roles: d.data.roles ?? [] }));
}

export function satisfiesRole(grantedRoles: string[], required: AccessRole): boolean {
  if (required === 'member') return true;
  if (required === 'accountant') return grantedRoles.includes('accountant') || grantedRoles.includes('admin');
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
