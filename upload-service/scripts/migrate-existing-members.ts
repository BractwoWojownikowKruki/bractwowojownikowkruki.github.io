// One-off cutover migration for KRKG-0046: backfills status: "active" in Firestore for every
// email currently in the kruki Google Group, since the Firestore-based authorization cutover
// (batch 3) already shipped to production ahead of this migration - see design.md's migration
// contract. Never overwrites an existing member's own fullName/nickname/sectionId/categoryId/
// driveFolderId; only sets/confirms status and the approval audit fields.
//
// Usage:
//   cd upload-service
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-existing-members.ts <emails.txt>            # dry run - logs the plan only
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-existing-members.ts <emails.txt> --execute
//
// <emails.txt> is a plain text file, one email per line (any surrounding whitespace/case is
// normalized). Run the dry run first and read its reconciliation counts before ever passing
// --execute.
import { readFileSync } from 'node:fs';
import type { FirestoreLikeClient } from '../src/firestore.ts';
import type { MemberDoc } from '../src/members.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmailList(raw: string[]): { valid: string[]; invalid: string[]; duplicatesRemoved: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicatesRemoved = 0;
  for (const entry of raw) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    if (!EMAIL_RE.test(normalized)) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(normalized)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(normalized);
    valid.push(normalized);
  }
  return { valid, invalid, duplicatesRemoved };
}

export interface MigrationResult {
  created: number;
  updated: number;
  finalActiveCount: number;
}

export async function migrateActiveMembers(
  client: FirestoreLikeClient,
  emails: string[],
  options: { dryRun: boolean },
): Promise<MigrationResult> {
  let created = 0;
  let updated = 0;
  for (const email of emails) {
    const existing = await client.getDoc<MemberDoc>('members', email);
    const now = new Date().toISOString();
    if (existing) {
      updated++;
      if (!options.dryRun) {
        const record: MemberDoc = {
          ...existing,
          status: 'active',
          appliedAt: existing.appliedAt ?? now,
          approvedAt: existing.approvedAt ?? now,
          approvedBy: existing.approvedBy ?? 'migration-script',
          updatedAt: now,
          updatedBy: 'migration-script',
        };
        await client.setDoc('members', email, record);
      }
    } else {
      created++;
      if (!options.dryRun) {
        const record: MemberDoc = {
          email,
          fullName: email,
          nickname: null,
          sectionId: 'nieznana',
          categoryId: null,
          driveFolderId: null,
          status: 'active',
          appliedAt: now,
          approvedAt: now,
          approvedBy: 'migration-script',
          updatedAt: now,
          updatedBy: 'migration-script',
        };
        await client.setDoc('members', email, record);
      }
    }
  }
  const finalActiveCount = options.dryRun
    ? created + updated
    : (await client.listDocs<MemberDoc>('members')).filter(d => d.data.status === 'active').length;
  return { created, updated, finalActiveCount };
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  const dryRun = !process.argv.includes('--execute');
  if (!filePath) {
    console.error('Użycie: npx tsx scripts/migrate-existing-members.ts <plik-z-emailami.txt> [--execute]');
    process.exit(1);
  }
  const raw = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const { valid, invalid, duplicatesRemoved } = normalizeEmailList(raw);
  console.log(`Wejście: ${raw.filter(l => l.trim()).length} niepustych linii, ${valid.length} poprawnych, ${invalid.length} niepoprawnych, ${duplicatesRemoved} duplikatów usuniętych.`);
  if (invalid.length > 0) console.log('Niepoprawne adresy:', invalid);

  const { createFirestoreClient } = await import('../src/firestore.ts');
  const client = createFirestoreClient(process.env.FIRESTORE_PROJECT_ID);
  const result = await migrateActiveMembers(client, valid, { dryRun });
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Utworzono: ${result.created}, zaktualizowano: ${result.updated}, aktywnych łącznie: ${result.finalActiveCount}.`);
  if (!dryRun && result.finalActiveCount < valid.length) {
    console.warn(`UWAGA: liczba aktywnych (${result.finalActiveCount}) jest mniejsza niż lista wejściowa (${valid.length}) - sprawdź ręcznie przed dalszymi krokami cutover.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
