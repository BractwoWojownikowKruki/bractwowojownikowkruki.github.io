import { Storage } from '@google-cloud/storage';

/**
 * Public photo storage for equipment photos (Google Cloud Storage). Unlike the Drive-backed
 * person photos, an uploaded object gets a stable public URL that is saved straight onto the
 * Firestore record - the list endpoints never have to ask Drive for a fresh (expiring)
 * thumbnailLink, and the browser may cache the image indefinitely. Object names carry a random
 * UUID and are never overwritten, which is what makes the long immutable Cache-Control safe.
 */
export interface PhotoStorage {
  /** Stores the object and returns its public URL. */
  upload(objectName: string, contentType: string, data: AsyncIterable<Buffer>): Promise<string>;
  /** Removes the object; an object that is already gone is not an error. */
  delete(objectName: string): Promise<void>;
}

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function publicObjectUrl(bucketName: string, objectName: string): string {
  return `https://storage.googleapis.com/${bucketName}/${objectName.split('/').map(encodeURIComponent).join('/')}`;
}

// Authenticates through Application Default Credentials - on Cloud Run that is the service's own
// runtime service account, which needs roles/storage.objectAdmin on this one bucket only.
export function createGcsPhotoStorage(bucketName: string): PhotoStorage {
  const bucket = new Storage().bucket(bucketName);
  return {
    async upload(objectName, contentType, data) {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(chunk);
      await bucket.file(objectName).save(Buffer.concat(chunks), {
        resumable: false,
        contentType,
        metadata: { cacheControl: IMMUTABLE_CACHE_CONTROL },
      });
      return publicObjectUrl(bucketName, objectName);
    },
    async delete(objectName) {
      await bucket.file(objectName).delete({ ignoreNotFound: true });
    },
  };
}
