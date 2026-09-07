// One-off cutover migration for KRKG-0046: backfills status: "active" in Firestore for every
// email currently in the kruki Google Group, since the Firestore-based authorization cutover
// (batch 3) already shipped to production ahead of this migration - see design.md's migration
// contract. Never overwrites an existing member's own nickname/sectionId/categoryId/
// driveFolderId; only sets/confirms status, fullName (see below), and the approval audit fields.
//
// fullName correction (2026-09-07): fullName IS updated on re-run, but only when the existing
// doc's fullName still literally equals its email - the exact, narrow signature of the first
// run's bug (it used the bare email as fullName for every newly-created doc, having discarded
// the Google Group export's "Pseudonim" column). This is deliberately NOT based on `updatedBy`:
// an earlier version of this script stamped updatedBy: "migration-script" on every doc it
// touched, including ones it left fullName alone on (a real member's own "Mój profil" edit) -
// checking updatedBy therefore risks treating a real name as migration-owned and overwriting it,
// which is exactly what happened once in production before this fix (see the story's incident
// note) and was corrected by hand. fullName === email cannot make that mistake: no genuine
// member's real name is their own email address.
//
// Usage:
//   cd upload-service
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-existing-members.ts <members.txt>            # dry run - logs the plan only
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-existing-members.ts <members.txt> --execute
//
// <members.txt> is a plain text file, one member per line: `email` or `email,fullName`. When
// fullName is omitted, it falls back to the email itself. Run the dry run first and read its
// reconciliation counts before ever passing --execute.
import { readFileSync } from 'node:fs';
import type { FirestoreLikeClient } from '../src/firestore.ts';
import type { MemberDoc } from '../src/members.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NormalizedMember {
  email: string;
  fullName: string;
}

export function normalizeMemberList(raw: string[]): { valid: NormalizedMember[]; invalid: string[]; duplicatesRemoved: number } {
  const seen = new Set<string>();
  const valid: NormalizedMember[] = [];
  const invalid: string[] = [];
  let duplicatesRemoved = 0;
  for (const line of raw) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const commaIndex = trimmedLine.indexOf(',');
    const emailPart = commaIndex === -1 ? trimmedLine : trimmedLine.slice(0, commaIndex);
    const namePart = commaIndex === -1 ? '' : trimmedLine.slice(commaIndex + 1).trim();
    const email = emailPart.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalid.push(line);
      continue;
    }
    if (seen.has(email)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(email);
    valid.push({ email, fullName: namePart || email });
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
  members: NormalizedMember[],
  options: { dryRun: boolean },
): Promise<MigrationResult> {
  let created = 0;
  let updated = 0;
  for (const { email, fullName } of members) {
    const existing = await client.getDoc<MemberDoc>('members', email);
    const now = new Date().toISOString();
    if (existing) {
      updated++;
      if (!options.dryRun) {
        // Only overwrite fullName if it still exactly matches the email - see the file header
        // for why this signature, not updatedBy, is the safe check.
        const looksLikeUnfixedMigrationBug = existing.fullName === existing.email;
        const record: MemberDoc = {
          ...existing,
          fullName: looksLikeUnfixedMigrationBug ? fullName : existing.fullName,
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
          fullName,
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
    console.error('Użycie: npx tsx scripts/migrate-existing-members.ts <plik-z-czlonkami.txt> [--execute]');
    process.exit(1);
  }
  const raw = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const { valid, invalid, duplicatesRemoved } = normalizeMemberList(raw);
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
