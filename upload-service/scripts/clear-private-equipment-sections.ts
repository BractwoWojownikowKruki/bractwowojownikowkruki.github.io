import { createFirestoreClient, type FirestoreLikeClient } from '../src/firestore.ts';

/**
 * One-off, idempotent cleanup: sets `sectionId` to null on every prywatny equipment item.
 *
 * Private equipment no longer has a section of its own - it always follows its owner's current
 * section (equipment.ts), so the snapshot each item took when it was added could only go stale.
 * Drużynowy equipment (belongsToPersonId === null) is left untouched.
 *
 * Nothing is lost that is still used: no page reads the stored section of a private item any
 * more. Run it once after deploying the change:
 *   npx tsx scripts/clear-private-equipment-sections.ts
 *
 * Safe to re-run: it only writes to items that still have a section, so a second run reports
 * zero changes.
 */

export interface ClearReport {
  privateItemsCleared: number;
  sampleIds: string[];
}

const SAMPLE_LIMIT = 5;

export async function clearPrivateEquipmentSections(client: FirestoreLikeClient): Promise<ClearReport> {
  const items = await client.listDocs<Record<string, unknown>>('equipment');
  const stale = items.filter((d) => d.data.belongsToPersonId != null && d.data.sectionId != null);
  for (const doc of stale) {
    // setDoc merges, so this only changes sectionId.
    await client.setDoc('equipment', doc.id, { sectionId: null });
  }
  return {
    privateItemsCleared: stale.length,
    sampleIds: stale.slice(0, SAMPLE_LIMIT).map((d) => d.id),
  };
}

async function main(): Promise<void> {
  const report = await clearPrivateEquipmentSections(createFirestoreClient());
  console.log('Private equipment section cleanup');
  console.log(`  private items cleared: ${report.privateItemsCleared}`);
  if (report.sampleIds.length) console.log(`  sample ids: ${report.sampleIds.join(', ')}`);
  if (!report.privateItemsCleared) console.log('  nothing to do - already clean.');
}

if (process.argv[1] && process.argv[1].endsWith('clear-private-equipment-sections.ts')) {
  main().catch((err) => {
    console.error('Cleanup failed:', err);
    process.exitCode = 1;
  });
}
