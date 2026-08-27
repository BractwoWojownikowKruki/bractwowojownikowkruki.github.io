// One-off migration for KRKG-0029: moves the "O Nas" self-service staging folder (`upload`) and
// soft-delete archive (`deleted`) out from under the public "Strona/O Nas" folder into a new,
// separate private root ("Strona/O Nas (prywatne)") that is never made public. See
// about-us.ts's bootstrapAboutUsStructure for why this matters - Google Drive permissions are
// inherited by every descendant of a shared folder regardless of when they were created, so
// unreviewed self-service submissions and removed people's photos were reachable by anyone with
// the folder/file link even though nothing ever linked to them from the public site.
//
// The application code (about-us.ts) already creates NEW upload/deleted folders in the correct
// private location. This script only needs to run once, against the real production Drive, to
// relocate whatever already exists at the old location - it is a no-op (nothing to move) on any
// Drive where bootstrapAboutUsStructure has never run under the old layout.
//
// Usage:
//   cd upload-service
//   DRIVE_CLIENT_ID=... DRIVE_CLIENT_SECRET=... DRIVE_REFRESH_TOKEN=... \
//     npx tsx scripts/migrate-private-about-us-root.ts            # dry run - logs the plan only
//   ...                                                            npx tsx scripts/migrate-private-about-us-root.ts --execute
//
// Run the dry run first and read its output before ever passing --execute. This moves real
// members' photos and self-service submissions; there is no automatic rollback beyond moving
// the folders back by hand (their ids are printed by the dry run - keep that output).
import { createDriveClient, getAccessToken, type DriveDeps } from '../src/drive.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Brak wymaganej zmiennej środowiskowej: ${name}`);
  return value;
}

async function findChild(drive: ReturnType<typeof createDriveClient>, parentFolderId: string, name: string): Promise<string | null> {
  return drive.findFolderByName(parentFolderId, name);
}

async function auditNoPublicPermission(driveDeps: DriveDeps, folderId: string, label: string): Promise<void> {
  const accessToken = await getAccessToken(driveDeps.clientId, driveDeps.clientSecret, driveDeps.refreshToken);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=permissions(id,type,role)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się odczytać uprawnień folderu ${label} (${folderId}): HTTP ${res.status}`);
  }
  const data = (await res.json()) as { permissions: { id: string; type: string; role: string }[] };
  const publicGrant = data.permissions.find(p => p.type === 'anyone');
  if (publicGrant) {
    console.warn(
      `UWAGA: folder ${label} (${folderId}) ma bezpośrednie uprawnienie "anyone" (rola: ${publicGrant.role}, id: ${publicGrant.id}). ` +
        `To uprawnienie NIE zostało automatycznie usunięte przez ten skrypt - usuń je ręcznie w Drive, jeśli nie jest zamierzone.`,
    );
  } else {
    console.log(`OK: folder ${label} (${folderId}) nie ma bezpośredniego uprawnienia "anyone".`);
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const driveDeps: DriveDeps = {
    clientId: requireEnv('DRIVE_CLIENT_ID'),
    clientSecret: requireEnv('DRIVE_CLIENT_SECRET'),
    refreshToken: requireEnv('DRIVE_REFRESH_TOKEN'),
  };
  const drive = createDriveClient(driveDeps);

  const stronaId = await drive.findFolderByName('root', 'Strona');
  if (!stronaId) {
    console.log('Nie znaleziono folderu "Strona" - nic do migracji (środowisko jeszcze nie bootstrapowało struktury O Nas).');
    return;
  }
  const oNasId = await findChild(drive, stronaId, 'O Nas');
  if (!oNasId) {
    console.log('Nie znaleziono folderu "O Nas" - nic do migracji.');
    return;
  }

  const oldUploadId = await findChild(drive, oNasId, 'upload');
  const oldDeletedId = await findChild(drive, oNasId, 'deleted');
  if (!oldUploadId && !oldDeletedId) {
    console.log('Foldery "upload"/"deleted" nie istnieją pod starą, publiczną lokalizacją "O Nas" - nic do migracji.');
    return;
  }

  console.log(`Plan migracji (KRKG-0029):`);
  console.log(`  Strona: ${stronaId}`);
  console.log(`  O Nas (publiczny): ${oNasId}`);
  if (oldUploadId) console.log(`  upload  ${oldUploadId}  ->  nowy prywatny root "O Nas (prywatne)" pod Strona (${stronaId})`);
  if (oldDeletedId) console.log(`  deleted ${oldDeletedId}  ->  nowy prywatny root "O Nas (prywatne)" pod Strona (${stronaId})`);

  if (!execute) {
    console.log('\nTo był dry run - nic nie zostało przeniesione. Zapisz powyższe id folderów, a następnie uruchom ponownie z flagą --execute.');
    return;
  }

  const privateRootId = await drive.ensureFolder(stronaId, 'O Nas (prywatne)');
  console.log(`Prywatny root gotowy: ${privateRootId}`);

  if (oldUploadId) {
    await drive.moveFolder(oldUploadId, privateRootId);
    console.log(`Przeniesiono "upload" (${oldUploadId}) pod prywatny root.`);
  }
  if (oldDeletedId) {
    await drive.moveFolder(oldDeletedId, privateRootId);
    console.log(`Przeniesiono "deleted" (${oldDeletedId}) pod prywatny root.`);
  }

  console.log('\nAudyt uprawnień po migracji:');
  await auditNoPublicPermission(driveDeps, privateRootId, 'O Nas (prywatne)');
  if (oldUploadId) await auditNoPublicPermission(driveDeps, oldUploadId, 'upload');
  if (oldDeletedId) await auditNoPublicPermission(driveDeps, oldDeletedId, 'deleted');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
