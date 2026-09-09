// KRKG-0050 batch 4/6: CLI wrapper for src/audit-migration.ts - migrates the three legacy
// per-feature audit-log collections (rolesAuditLog, signupAuditLog, duesAuditLog) into the
// canonical auditEvents collection. Legacy collections stay read-only through this and every
// later step; nothing here deletes or rewrites them.
//
// Per plan-addendum-2.md ("Batch and legacy sequencing"), batch 4 builds and unit-tests this tool
// only - actual execution against production Firestore, and removal of the legacy read
// endpoints/widgets, happen in batch 6. Always run --preflight first, read its report, and run
// without --execute (the default is dry-run) before ever passing --execute.
//
// Usage:
//   cd upload-service
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-audit.ts --preflight
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-audit.ts               # dry run - logs the plan only
//   FIRESTORE_PROJECT_ID=... npx tsx scripts/migrate-audit.ts --execute
import { migrateAuditLogs, preflightAuditMigration } from '../src/audit-migration.ts';

async function main(): Promise<void> {
  const mode = process.argv.includes('--preflight') ? 'preflight' : process.argv.includes('--execute') ? 'execute' : 'dry-run';

  const { createFirestoreClient } = await import('../src/firestore.ts');
  const client = createFirestoreClient(process.env.FIRESTORE_PROJECT_ID);

  if (mode === 'preflight') {
    const report = await preflightAuditMigration(client);
    console.log(`Dokumentów: ${report.totalDocuments}, OK: ${report.okCount}, do odrzucenia: ${report.abortCount}.`);
    for (const row of report.rows) {
      if (row.parseStatus !== 'ok') {
        console.warn(`[${row.parseStatus}] ${row.collection}/${row.documentId}: ${row.reason}`);
      }
    }
    console.log(report.canProceed ? 'Preflight OK - migracja może być uruchomiona.' : 'Preflight NIE PRZESZEDŁ - migracja zostanie odrzucona, dopóki powyższe dokumenty nie zostaną wyjaśnione.');
    return;
  }

  const dryRun = mode !== 'execute';
  const report = await migrateAuditLogs(client, { dryRun });
  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Utworzono: ${report.createdCount}, już zmigrowanych wcześniej: ${report.alreadyMigratedCount}, łącznie wierszy: ${report.rows.length}.`,
  );
  if (dryRun) {
    console.log('To był przebieg próbny - nic nie zostało zapisane. Uruchom z --execute, aby faktycznie zmigrować dane (dopiero po autoryzacji w ramach batcha 6).');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
