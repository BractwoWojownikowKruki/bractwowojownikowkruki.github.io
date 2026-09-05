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
