const DRIVE_API = 'https://www.googleapis.com';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się odświeżyć tokenu Drive: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

export function sanitizeFolderName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '').trim();
  return cleaned || 'Album';
}

export interface DriveDeps {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function createAlbumFolder(deps: DriveDeps, parentFolderId: string, folderName: string): Promise<string> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const res = await fetch(`${DRIVE_API}/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: sanitizeFolderName(folderName),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    }),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się utworzyć folderu w Drive: HTTP ${res.status}`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}

async function findPublicPermissionId(deps: DriveDeps, accessToken: string, folderId: string): Promise<string | null> {
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${folderId}/permissions?fields=permissions(id,type,role)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się odczytać uprawnień folderu w Drive: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { permissions: { id: string; type: string; role: string }[] };
  return data.permissions.find(p => p.type === 'anyone' && p.role === 'reader')?.id ?? null;
}

// Idempotent: checks for an existing "anyone can read" permission before creating one, so a
// retried /finalize call never errors on a duplicate grant.
export async function setFolderPublic(deps: DriveDeps, folderId: string): Promise<void> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const existing = await findPublicPermissionId(deps, accessToken, folderId);
  if (existing) return;
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${folderId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się ustawić uprawnień folderu w Drive: HTTP ${res.status}`);
  }
}

export function buildMultipartParts(
  metadata: Record<string, unknown>,
  mimeType: string,
): { prefix: Buffer; suffix: Buffer; boundary: string } {
  const boundary = `kruczegalery${Math.random().toString(36).slice(2)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--`);
  return { prefix, suffix, boundary };
}

// Streams the multipart body straight through to Drive - the caller's bodyStream (Task 8's
// validated stream) enforces the size cap and MIME sniff chunk-by-chunk, so this never buffers
// a whole file twice.
export async function uploadFileStream(
  deps: DriveDeps,
  folderId: string,
  fileName: string,
  mimeType: string,
  bodyStream: AsyncIterable<Buffer>,
): Promise<void> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const { prefix, suffix, boundary } = buildMultipartParts({ name: fileName, parents: [folderId] }, mimeType);

  async function* multipartBody(): AsyncGenerator<Buffer> {
    yield prefix;
    yield* bodyStream;
    yield suffix;
  }

  const res = await fetch(`${DRIVE_UPLOAD_API}/drive/v3/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    // Node's fetch (undici) accepts an async-iterable request body when duplex is set.
    // @ts-expect-error - duplex is valid at runtime but missing from the DOM RequestInit type Node reuses.
    body: multipartBody(),
    duplex: 'half',
  });
  if (!res.ok) {
    throw new Error(`Nie udało się przesłać pliku "${fileName}" do Drive: HTTP ${res.status}`);
  }
}

export interface DriveFileInfo {
  name: string;
  size: number;
}

export async function listFiles(deps: DriveDeps, folderId: string): Promise<DriveFileInfo[]> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const files: DriveFileInfo[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    let path = `${DRIVE_API}/drive/v3/files?q=${q}&fields=nextPageToken,files(name,size)&pageSize=1000`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(path, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Nie udało się pobrać listy plików z Drive: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { files: { name: string; size?: string }[]; nextPageToken?: string };
    files.push(...data.files.map(f => ({ name: f.name, size: Number(f.size ?? 0) })));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

export const MANIFEST_FILE_NAME = '.gallery.json';

export interface GalleryManifest {
  name?: string;
  date: string;
  contributors: string[];
}

async function findManifestFileId(accessToken: string, folderId: string): Promise<string | null> {
  const q = encodeURIComponent(`'${folderId}' in parents and name='${MANIFEST_FILE_NAME}' and trashed = false`);
  const res = await fetch(`${DRIVE_API}/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się wyszukać pliku manifestu galerii w Drive: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { files: { id: string }[] };
  return data.files[0]?.id ?? null;
}

// Idempotent: updates the folder's existing manifest file if one is already present (e.g. a
// retried /finalize call, or a future "add more photos" flow revising contributors/date),
// otherwise creates it - so a gallery folder always has at most one manifest for the discovery
// endpoint to read.
export async function writeManifest(deps: DriveDeps, folderId: string, manifest: GalleryManifest): Promise<void> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const content = JSON.stringify(manifest, null, 2);
  const existingId = await findManifestFileId(accessToken, folderId);
  if (existingId) {
    const res = await fetch(`${DRIVE_UPLOAD_API}/drive/v3/files/${existingId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: content,
    });
    if (!res.ok) {
      throw new Error(`Nie udało się zaktualizować manifestu galerii w Drive: HTTP ${res.status}`);
    }
    return;
  }
  const { prefix, suffix, boundary } = buildMultipartParts({ name: MANIFEST_FILE_NAME, parents: [folderId] }, 'application/json');
  const res = await fetch(`${DRIVE_UPLOAD_API}/drive/v3/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([prefix, Buffer.from(content), suffix]),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się utworzyć manifestu galerii w Drive: HTTP ${res.status}`);
  }
}

export async function readManifest(deps: DriveDeps, folderId: string): Promise<GalleryManifest | null> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const fileId = await findManifestFileId(accessToken, folderId);
  if (!fileId) return null;
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się odczytać manifestu galerii z Drive: HTTP ${res.status}`);
  }
  try {
    return JSON.parse(await res.text()) as GalleryManifest;
  } catch {
    // A manifest that fails to parse is treated the same as a missing one - the discovery
    // endpoint falls back to the folder's own name/modified time rather than erroring out.
    return null;
  }
}

export interface DriveFolderInfo {
  id: string;
  name: string;
  modifiedTime: string;
}

// Lists the immediate subfolders of a root folder - each one is a gallery for discovery
// purposes, regardless of whether it has a manifest yet (see readManifest's fallback).
export async function listGalleryFolders(deps: DriveDeps, rootFolderId: string): Promise<DriveFolderInfo[]> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const folders: DriveFolderInfo[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed = false`);
    let path = `${DRIVE_API}/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=1000`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(path, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Nie udało się pobrać listy galerii z Drive: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { files: DriveFolderInfo[]; nextPageToken?: string };
    folders.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return folders;
}

// First image in the folder (by name) used as the gallery's cover, mirroring how the frontend
// already renders Drive-gallery covers from a live thumbnailLink rather than a cached file.
export async function getCoverThumbnail(deps: DriveDeps, folderId: string): Promise<string | null> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
  const res = await fetch(`${DRIVE_API}/drive/v3/files?q=${q}&fields=files(thumbnailLink)&pageSize=1&orderBy=name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się pobrać miniatury okładki galerii z Drive: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { files: { thumbnailLink?: string }[] };
  return data.files[0]?.thumbnailLink ?? null;
}

export interface DriveClient {
  createAlbumFolder(parentFolderId: string, folderName: string): Promise<string>;
  uploadFileStream(folderId: string, fileName: string, mimeType: string, bodyStream: AsyncIterable<Buffer>): Promise<void>;
  listFiles(folderId: string): Promise<DriveFileInfo[]>;
  setFolderPublic(folderId: string): Promise<void>;
  writeManifest(folderId: string, manifest: GalleryManifest): Promise<void>;
  readManifest(folderId: string): Promise<GalleryManifest | null>;
  listGalleryFolders(rootFolderId: string): Promise<DriveFolderInfo[]>;
  getCoverThumbnail(folderId: string): Promise<string | null>;
}

// Binds the module's functions to one set of Drive credentials, giving server.ts a small
// interface it can depend on - and server.test.ts a seam to substitute a fake implementation.
export function createDriveClient(deps: DriveDeps): DriveClient {
  return {
    createAlbumFolder: (parentFolderId, folderName) => createAlbumFolder(deps, parentFolderId, folderName),
    uploadFileStream: (folderId, fileName, mimeType, bodyStream) =>
      uploadFileStream(deps, folderId, fileName, mimeType, bodyStream),
    listFiles: folderId => listFiles(deps, folderId),
    setFolderPublic: folderId => setFolderPublic(deps, folderId),
    writeManifest: (folderId, manifest) => writeManifest(deps, folderId, manifest),
    readManifest: folderId => readManifest(deps, folderId),
    listGalleryFolders: rootFolderId => listGalleryFolders(deps, rootFolderId),
    getCoverThumbnail: folderId => getCoverThumbnail(deps, folderId),
  };
}
