import { createFirestoreClient, type FirestoreLikeClient } from '../src/firestore.ts';

/**
 * One-off, idempotent cleanup of the legacy Lista Wyjazdowa companion fields (KRKG-0087).
 *
 * KRKG-0087 removed `listaWyjazdowaProfile.companions` and `signups.companionIds` from the model:
 * companions are now real person records (`persons.ts`), so these fields are no longer read or
 * written anywhere. This script deletes them from documents that still carry them.
 *
 * This is **destructive and cannot be undone**. It is deliberately not a data migration - nothing
 * is moved into the new model. Attendance marks for people who used to be companions are gone
 * afterwards, which is the accepted consequence of the story's "no migration" decision.
 *
 * Run it once after deploying batch 1-2:
 *   npx tsx scripts/remove-legacy-companions.ts
 *
 * Safe to re-run: it only writes to documents that still have the field, so a second run reports
 * zero changes.
 */

export interface CleanupReport {
  profilesWithCompanions: number;
  signupsWithCompanionIds: number;
  sampleProfileIds: string[];
  sampleSignupIds: string[];
}

const SAMPLE_LIMIT = 5;

export async function removeLegacyCompanionFields(client: FirestoreLikeClient): Promise<CleanupReport> {
  const [profiles, signups] = await Promise.all([
    client.listDocs<Record<string, unknown>>('listaWyjazdowaProfile'),
    client.listDocs<Record<string, unknown>>('signups'),
  ]);

  const profilesWithField = profiles.filter((d) => 'companions' in d.data);
  const signupsWithField = signups.filter((d) => 'companionIds' in d.data);

  for (const doc of profilesWithField) {
    // setDoc merges, so writing the field as an empty array would leave it in place. The only way
    // to drop a field with this client is to rewrite the document without it - read the remaining
    // fields and write them back over the same id.
    const { companions: _dropped, ...rest } = doc.data;
    await client.deleteDoc('listaWyjazdowaProfile', doc.id);
    await client.setDoc('listaWyjazdowaProfile', doc.id, rest);
  }
  for (const doc of signupsWithField) {
    const { companionIds: _dropped, ...rest } = doc.data;
    await client.deleteDoc('signups', doc.id);
    await client.setDoc('signups', doc.id, rest);
  }

  return {
    profilesWithCompanions: profilesWithField.length,
    signupsWithCompanionIds: signupsWithField.length,
    sampleProfileIds: profilesWithField.slice(0, SAMPLE_LIMIT).map((d) => d.id),
    sampleSignupIds: signupsWithField.slice(0, SAMPLE_LIMIT).map((d) => d.id),
  };
}

async function main(): Promise<void> {
  const report = await removeLegacyCompanionFields(createFirestoreClient());
  console.log('Legacy companion cleanup');
  console.log(`  listaWyjazdowaProfile documents with companions: ${report.profilesWithCompanions}`);
  console.log(`  signups documents with companionIds:            ${report.signupsWithCompanionIds}`);
  if (report.sampleProfileIds.length) console.log(`  sample profile ids: ${report.sampleProfileIds.join(', ')}`);
  if (report.sampleSignupIds.length) console.log(`  sample signup ids:  ${report.sampleSignupIds.join(', ')}`);
  if (!report.profilesWithCompanions && !report.signupsWithCompanionIds) {
    console.log('  nothing to do - already clean.');
  }
}

if (process.argv[1] && process.argv[1].endsWith('remove-legacy-companions.ts')) {
  main().catch((err) => {
    console.error('Cleanup failed:', err);
    process.exitCode = 1;
  });
}
