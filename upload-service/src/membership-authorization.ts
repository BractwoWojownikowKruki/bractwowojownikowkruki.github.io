import { AuthError } from './auth.ts';
import type { FirestoreLikeClient } from './firestore.ts';
import { getMember, listAllMembers } from './members.ts';
import type { Authorizer } from './server.ts';

/**
 * Single-document authorization check (KRKG-0046) - one `getMember` read per call, never a
 * collection scan. Replaces the Apps-Script/Google-Group-backed check that hit Google's daily
 * Groups-read quota in production. Same error shape as `checkAllowlist` (403, same Polish
 * message) so callers see identical behavior to the old check.
 */
export function createFirestoreMemberAuthorizer(client: FirestoreLikeClient): Authorizer {
  return {
    async authorize(identity) {
      const member = await getMember(client, identity.email);
      if (member?.status !== 'active') {
        throw new AuthError('Ten adres e-mail nie ma uprawnień do wykonania tej operacji.', 403);
      }
    },
  };
}

/**
 * Full-list enumeration - deliberately separate from the authorizer above. Used only where
 * listing every active member is actually the point (the member directory,
 * `ServerDeps.listMemberEmails`), never for a per-request auth check.
 */
export async function listActiveMemberEmails(client: FirestoreLikeClient): Promise<string[]> {
  try {
    const members = await listAllMembers(client);
    return members.filter(m => m.status === 'active').map(m => m.email);
  } catch (err) {
    console.error('Nie udało się pobrać listy aktywnych członków z Firestore:', err);
    return [];
  }
}
