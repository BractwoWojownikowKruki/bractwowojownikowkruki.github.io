// Rejected self-service photos. A member's staging folder (members.ts stagingFolderId) holds
// their pending photos directly; a rejected photo is moved one level down, into the staging
// folder's own "Odrzucone" subfolder. Everything that lists pending photos (the admin Upload
// queue and its dashboard/banner counts, /profil/'s pending section, the approve handler's
// membership check) reads only the staging folder's direct images via listImageFiles, so a
// rejected photo drops out of all of them without any of those call sites changing.
//
// The admin's comment for each rejected file lives in a small JSON sidecar next to the photos,
// the same Drive-text-file approach as `.owner-email`/`Opis.txt`. It stays there until the
// member removes the photo.
import { resizeThumbnailUrl, type DriveClient } from './drive.ts';

export const REJECTED_FOLDER_NAME = 'Odrzucone';
const REJECTIONS_FILE_NAME = '.odrzucone.json';

export interface PhotoRejection {
  comment: string | null;
  rejectedAt: string;
  rejectedBy: string;
}

export interface RejectedPhoto {
  id: string;
  // null while Drive hasn't generated a thumbnail yet - the member must still be able to see
  // (and remove) it, so it is never filtered out the way the public listings do.
  url: string | null;
  comment: string | null;
  rejectedAt: string | null;
}

export function findRejectedFolder(drive: DriveClient, stagingFolderId: string): Promise<string | null> {
  return drive.findFolderByName(stagingFolderId, REJECTED_FOLDER_NAME);
}

export function ensureRejectedFolder(drive: DriveClient, stagingFolderId: string): Promise<string> {
  return drive.ensureFolder(stagingFolderId, REJECTED_FOLDER_NAME);
}

// A missing or corrupt sidecar reads as "no comments" - the photos themselves are still shown
// as rejected (their location is what makes them rejected), just with the generic message.
export async function readRejections(drive: DriveClient, rejectedFolderId: string): Promise<Record<string, PhotoRejection>> {
  const raw = await drive.readTextFile(rejectedFolderId, REJECTIONS_FILE_NAME);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function recordRejections(
  drive: DriveClient,
  rejectedFolderId: string,
  fileIds: readonly string[],
  rejection: PhotoRejection,
): Promise<void> {
  const rejections = await readRejections(drive, rejectedFolderId);
  for (const fileId of fileIds) rejections[fileId] = rejection;
  await drive.writeTextFile(rejectedFolderId, REJECTIONS_FILE_NAME, JSON.stringify(rejections));
}

export async function forgetRejection(drive: DriveClient, rejectedFolderId: string, fileId: string): Promise<void> {
  const rejections = await readRejections(drive, rejectedFolderId);
  if (!(fileId in rejections)) return;
  delete rejections[fileId];
  await drive.writeTextFile(rejectedFolderId, REJECTIONS_FILE_NAME, JSON.stringify(rejections));
}

/** A staging folder's rejected photos with their comments, oldest-named first (Drive's order). */
export async function listRejectedPhotos(drive: DriveClient, stagingFolderId: string): Promise<RejectedPhoto[]> {
  const rejectedFolderId = await findRejectedFolder(drive, stagingFolderId);
  if (!rejectedFolderId) return [];
  const [images, rejections] = await Promise.all([drive.listImageFiles(rejectedFolderId), readRejections(drive, rejectedFolderId)]);
  return images.map(image => ({
    id: image.id,
    url: image.thumbnailLink ? resizeThumbnailUrl(image.thumbnailLink, 300) : null,
    comment: typeof rejections[image.id]?.comment === 'string' ? rejections[image.id].comment : null,
    rejectedAt: typeof rejections[image.id]?.rejectedAt === 'string' ? rejections[image.id].rejectedAt : null,
  }));
}
