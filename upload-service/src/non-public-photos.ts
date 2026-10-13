import { resizeThumbnailUrl, type DriveClient } from './drive.ts';

export const NON_PUBLIC_PHOTOS_FOLDER_NAME = 'Nie na publiczną stronę';

/** An image kept in the member-only photo area rather than awaiting public approval. */
export interface NonPublicPhoto {
  id: string;
  url: string | null;
}

export function findNonPublicPhotosFolder(drive: DriveClient, stagingFolderId: string): Promise<string | null> {
  return drive.findFolderByName(stagingFolderId, NON_PUBLIC_PHOTOS_FOLDER_NAME);
}

export function ensureNonPublicPhotosFolder(drive: DriveClient, stagingFolderId: string): Promise<string> {
  return drive.ensureFolder(stagingFolderId, NON_PUBLIC_PHOTOS_FOLDER_NAME);
}

/** Lists a staging folder's member-only photos, preserving entries while Drive creates thumbnails. */
export async function listNonPublicPhotos(drive: DriveClient, stagingFolderId: string): Promise<NonPublicPhoto[]> {
  const folderId = await findNonPublicPhotosFolder(drive, stagingFolderId);
  if (!folderId) return [];
  const images = await drive.listImageFiles(folderId);
  return images.map(image => ({
    id: image.id,
    url: image.thumbnailLink ? resizeThumbnailUrl(image.thumbnailLink, 300) : null,
  }));
}
