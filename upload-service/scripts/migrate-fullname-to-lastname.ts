// One-off rename for KRKG-0103: copies each members/{email} doc's legacy `fullName` verbatim
// into `lastName`, sets `firstName: ''`, and clears `fullName` to null. Pure key rename, zero
// content interpretation - splitting the combined name into real first/last name is a manual
// admin task done afterwards in Zarządzanie ludźmi, not by this script (see design.md).
//
// `fullName` is set to null rather than truly removed: FirestoreLikeClient.setDoc is always a
// merging write (Firestore's set(..., { merge: true })), and this codebase has no per-field-delete
// primitive - only whole-document deleteDoc. No code reads `fullName` any more after this story,
// so a stray null key is harmless; "already migrated" is judged by `lastName` being present, not
// by `fullName` being literally absent.
//
// Usage:
//   cd upload-service
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-fullname-to-lastname.ts            # dry run - logs the plan only
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-fullname-to-lastname.ts --execute
import type { FirestoreLikeClient } from '../src/firestore.ts';

interface LegacyMemberDoc {
  fullName?: string;
  lastName?: string;
  firstName?: string;
  [key: string]: unknown;
}

export interface RenameResult {
  renamed: number;
  alreadyDone: number;
  skippedNoFullName: number;
}

export async function migrateFullNameToLastName(
  client: FirestoreLikeClient,
  options: { dryRun: boolean },
): Promise<RenameResult> {
  const docs = await client.listDocs<LegacyMemberDoc>('members');
  let renamed = 0;
  let alreadyDone = 0;
  let skippedNoFullName = 0;
  for (const { id, data } of docs) {
    // lastName present means this doc already went through the rename (possibly on a previous
    // run of this same script) - never re-touch it, regardless of what fullName still holds.
    if (data.lastName !== undefined) {
      alreadyDone++;
      continue;
    }
    if (data.fullName == null) {
      skippedNoFullName++;
      continue;
    }
    renamed++;
    if (!options.dryRun) {
      await client.setDoc('members', id, { lastName: data.fullName, firstName: data.firstName ?? '', fullName: null });
    }
  }
  return { renamed, alreadyDone, skippedNoFullName };
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes('--execute');
  const { createFirestoreClient } = await import('../src/firestore.ts');
  const client = createFirestoreClient(process.env.FIRESTORE_PROJECT_ID);
  const result = await migrateFullNameToLastName(client, { dryRun });
  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Przemianowano: ${result.renamed}, już gotowe: ${result.alreadyDone}, bez fullName: ${result.skippedNoFullName}.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
