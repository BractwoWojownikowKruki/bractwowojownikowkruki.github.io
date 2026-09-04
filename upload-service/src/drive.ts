const DRIVE_API = 'https://www.googleapis.com';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload';

// Keyed by refreshToken, not a single shared slot: exportDocHtml uses a second, more broadly
// scoped credential (drive.readonly, for reading pre-existing Docs) alongside the main
// drive.file-scoped one used everywhere else - a single-slot cache would have the two stomp on
// each other's access token, silently reusing the wrong scope's token for the wrong call.
const cachedAccessTokens = new Map<string, { token: string; expiresAt: number }>();

export async function getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const cached = cachedAccessTokens.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
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
  cachedAccessTokens.set(refreshToken, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
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

// Looks up an existing folder by exact name under a parent, or null if none exists. Used by
// ensureFolder below to make folder creation idempotent - bootstrapping the "O Nas" tree must
// be safe to call on every cold start without creating duplicate folders each time.
export async function findFolderByName(deps: DriveDeps, parentFolderId: string, name: string): Promise<string | null> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const escapedName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and trashed = false`,
  );
  const res = await fetch(`${DRIVE_API}/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się wyszukać folderu w Drive: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { files: { id: string }[] };
  return data.files[0]?.id ?? null;
}

// Idempotent find-or-create. parentFolderId may be the literal string 'root' for a top-level
// folder in My Drive - the Drive API accepts 'root' as an alias both in query filters and in
// a create call's `parents` array.
export async function ensureFolder(deps: DriveDeps, parentFolderId: string, name: string): Promise<string> {
  const existing = await findFolderByName(deps, parentFolderId, name);
  if (existing) return existing;
  return createAlbumFolder(deps, parentFolderId, name);
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

// Trashes rather than permanently deletes - a reversible safety net via Drive's own trash if a
// deletion turns out to be a mistake, while still disappearing from every listing this service
// makes (listGalleryFolders/listFiles both filter trashed = false).
export async function deleteFolder(deps: DriveDeps, folderId: string): Promise<void> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${folderId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się usunąć folderu w Drive: HTTP ${res.status}`);
  }
}

// Renames a folder in place - used by the admin panel to change a person's "N. Imię" folder
// name (and so their display order/name) without touching its contents or parent.
export async function renameFolder(deps: DriveDeps, folderId: string, newName: string): Promise<void> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${folderId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sanitizeFolderName(newName) }),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się zmienić nazwy folderu w Drive: HTTP ${res.status}`);
  }
}

// Shared by moveFolder and moveFile below - addParents/removeParents are query params on
// files.update, not body fields, per the Drive API. Reads the item's current parents (and
// name) first rather than trusting a caller-supplied "old parent", since the admin panel
// doesn't reliably know which department/person an item currently belongs to when the target
// is chosen from a plain dropdown.
async function moveDriveItem(deps: DriveDeps, itemId: string, newParentId: string): Promise<{ name: string }> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const getRes = await fetch(`${DRIVE_API}/drive/v3/files/${itemId}?fields=parents,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!getRes.ok) {
    throw new Error(`Nie udało się odczytać elementu w Drive: HTTP ${getRes.status}`);
  }
  const { parents, name } = (await getRes.json()) as { parents?: string[]; name: string };
  const removeParents = (parents ?? []).join(',');

  const updateUrl = new URL(`${DRIVE_API}/drive/v3/files/${itemId}`);
  updateUrl.searchParams.set('addParents', newParentId);
  if (removeParents) updateUrl.searchParams.set('removeParents', removeParents);

  const res = await fetch(updateUrl.toString(), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się przenieść elementu w Drive: HTTP ${res.status}`);
  }
  return { name };
}

// Moves a folder to a new parent (e.g. from the "upload" staging folder into a real category,
// or between categories). Returns the folder's name (unchanged by the move itself) so callers
// that also need to reassign the person's display order on a department move (see
// computeOrderForDepartmentMove in about-us.ts) don't need a second round trip just to read it
// back.
export async function moveFolder(deps: DriveDeps, folderId: string, newParentId: string): Promise<{ name: string }> {
  return moveDriveItem(deps, folderId, newParentId);
}

// Moves a single photo to a different person's folder (the admin panel's "transfer photo to
// another user" action - e.g. new photos landed in the upload staging folder for someone who
// already has an existing profile elsewhere, and belong in that person's folder instead of
// becoming a whole new entry).
export async function moveFile(deps: DriveDeps, fileId: string, newParentFolderId: string): Promise<void> {
  await moveDriveItem(deps, fileId, newParentFolderId);
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
// a whole file twice. Returns the created file's id (the request already asked Drive for
// `fields=id`) so callers can attribute the upload to whoever made it - see the
// gallery-photos upload-attribution log in server.ts.
//
// originalModifiedMs, when given, is the source file's own last-modified time (the browser's
// File.lastModified, in epoch ms - not "when this request was made"), stored as Drive's native
// modifiedTime instead of a custom `properties` entry. It exists purely as a second, still
// cheap-to-check signal for upload-duplicate detection (see fileKeyFor in server.ts) - reading
// it back later needs no more than the same metadata-only Drive listing already done for the
// name+size check.
export async function uploadFileStream(
  deps: DriveDeps,
  folderId: string,
  fileName: string,
  mimeType: string,
  bodyStream: AsyncIterable<Buffer>,
  originalModifiedMs?: number,
): Promise<{ id: string }> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const metadata: Record<string, unknown> = { name: fileName, parents: [folderId] };
  if (originalModifiedMs !== undefined) {
    metadata.modifiedTime = new Date(originalModifiedMs).toISOString();
  }
  const { prefix, suffix, boundary } = buildMultipartParts(metadata, mimeType);

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
  return (await res.json()) as { id: string };
}

export interface DriveFileInfo {
  name: string;
  size: number;
  // ISO 8601 - Drive's own modifiedTime, which uploadFileStream may have set from the source
  // file's original File.lastModified rather than left as "upload time". Undefined for files
  // uploaded before that existed, or without a modifiedTime override.
  modifiedTime?: string;
}

export async function listFiles(deps: DriveDeps, folderId: string): Promise<DriveFileInfo[]> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const files: DriveFileInfo[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    let path = `${DRIVE_API}/drive/v3/files?q=${q}&fields=nextPageToken,files(name,size,modifiedTime)&pageSize=1000`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(path, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Nie udało się pobrać listy plików z Drive: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { files: { name: string; size?: string; modifiedTime?: string }[]; nextPageToken?: string };
    files.push(...data.files.map(f => ({ name: f.name, size: Number(f.size ?? 0), modifiedTime: f.modifiedTime })));
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

async function findFileIdByName(deps: DriveDeps, folderId: string, name: string): Promise<string | null> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const escapedName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`'${folderId}' in parents and name='${escapedName}' and trashed = false`);
  const res = await fetch(`${DRIVE_API}/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się wyszukać pliku w Drive: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { files: { id: string }[] };
  return data.files[0]?.id ?? null;
}

// Exports a Google Doc as HTML via Drive's export endpoint (not the Docs API's structured JSON
// model - the export endpoint gives back ready-to-render markup close to what Docs itself shows,
// which is all the Wojownicy-only doc pages need). Only works for native Google Docs, not an
// uploaded .docx/.pdf/etc - Drive can only "export" its own formats. Called with a drive.file
// -scoped credential (config.ts's docsClientId, a separate OAuth client from the main
// DriveDeps - see its comment); drive.file normally only sees files the app itself created, but
// Google Picker lets a human grant it access to specific pre-existing files instead, without
// broadening to drive.readonly (see scripts/grant-docs-file-access.ts). A file missing from
// that grant makes Drive return 403/404, surfaced to the caller as a thrown error rather than
// silently returning empty content.
// Docs' export <style> block is mostly plain, unnested `.class{...}` rules (no @media/nesting)
// - critically including the CSS-counter machinery numbered lists rely on (list-style:none on
// the <ol>/<ul> plus a ::before with content:counter(...) doing the actual visible numbering).
// Dropping that block entirely (as an earlier version of this function did) left the browser's
// own default <li> markers showing instead, with no numbering text of their own - broken/blank
// bullets rather than "1. 2. 3.". Prefixing every selector with the scope keeps that machinery
// working without leaking into the rest of the page.
function scopeCss(css: string, scope: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (_match, selectors: string, body: string) =>
    `${selectors
      .split(',')
      .map(selector => `${scope} ${selector.trim()}`)
      .join(', ')}{${body}}`,
  );
}

export async function exportDocHtml(deps: DriveDeps, fileId: string): Promise<string> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${fileId}/export?mimeType=text/html`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się wyeksportować dokumentu z Drive: HTTP ${res.status}`);
  }
  const fullHtml = await res.text();
  // Docs' HTML export is a full page (<html><head><style>...), sized and styled for a standalone
  // document - the <head>'s page-level CSS (fixed widths, its own font stack) would fight the
  // site's own typography if inlined as-is. Scoping just the <style> block's rules to
  // #doc-content (rather than dropping it) keeps Docs' list-numbering/spacing working without
  // that leak; the site's own #doc-content !important rules (style.css) still win for color/font
  // regardless, since those beat any non-!important rule this scoped block might also set.
  const style = fullHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1];
  const body = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? fullHtml;
  return style ? `<style>${scopeCss(style, '#doc-content')}</style>${body}` : body;
}

// Returns null if the file doesn't exist - callers treat a missing Opis.txt as "no
// description yet" rather than an error, since an admin may create a person before writing one.
export async function readTextFile(deps: DriveDeps, folderId: string, fileName: string): Promise<string | null> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const fileId = await findFileIdByName(deps, folderId, fileName);
  if (!fileId) return null;
  const res = await fetch(`${DRIVE_API}/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Nie udało się odczytać pliku z Drive: HTTP ${res.status}`);
  }
  return res.text();
}

// Idempotent like writeManifest: updates the file in place if it already exists, otherwise
// creates it - so re-saving a person's description from /admin never leaves duplicate
// Opis.txt files behind.
export async function writeTextFile(deps: DriveDeps, folderId: string, fileName: string, content: string): Promise<void> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const existingId = await findFileIdByName(deps, folderId, fileName);
  if (existingId) {
    const res = await fetch(`${DRIVE_UPLOAD_API}/drive/v3/files/${existingId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain; charset=UTF-8' },
      body: content,
    });
    if (!res.ok) {
      throw new Error(`Nie udało się zaktualizować pliku w Drive: HTTP ${res.status}`);
    }
    return;
  }
  const { prefix, suffix, boundary } = buildMultipartParts({ name: fileName, parents: [folderId] }, 'text/plain');
  const res = await fetch(`${DRIVE_UPLOAD_API}/drive/v3/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([prefix, Buffer.from(content, 'utf8'), suffix]),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się utworzyć pliku w Drive: HTTP ${res.status}`);
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

export interface DriveImageInfo {
  id: string;
  name: string;
  thumbnailLink: string | null;
}

// Every image file directly inside folderId, sorted by name - the first result is treated as
// a person's "main photo" by every caller (about-us.ts's fetchCategoryPeople), so admins
// control which photo is the main one purely by naming it to sort first (e.g. "1-main.jpg").
export async function listImageFiles(deps: DriveDeps, folderId: string): Promise<DriveImageInfo[]> {
  const accessToken = await getAccessToken(deps.clientId, deps.clientSecret, deps.refreshToken);
  const images: DriveImageInfo[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
    let path = `${DRIVE_API}/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,thumbnailLink)&pageSize=1000&orderBy=name`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(path, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Nie udało się pobrać listy zdjęć z Drive: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { files: { id: string; name: string; thumbnailLink?: string }[]; nextPageToken?: string };
    images.push(...data.files.map(f => ({ id: f.id, name: f.name, thumbnailLink: f.thumbnailLink ?? null })));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return images;
}

// Same `=s<size>` query-param substitution the frontend already does client-side in
// galerie/app.js's driveThumbUrl - kept server-side here too so about-us.ts can hand the
// frontend a ready-to-use URL at the right size without duplicating this regex in a third place.
export function resizeThumbnailUrl(thumbnailLink: string, size: number): string {
  return thumbnailLink.replace(/=s\d+$/, `=s${size}`);
}

export interface DriveClient {
  createAlbumFolder(parentFolderId: string, folderName: string): Promise<string>;
  uploadFileStream(
    folderId: string,
    fileName: string,
    mimeType: string,
    bodyStream: AsyncIterable<Buffer>,
    originalModifiedMs?: number,
  ): Promise<{ id: string }>;
  listFiles(folderId: string): Promise<DriveFileInfo[]>;
  setFolderPublic(folderId: string): Promise<void>;
  deleteFolder(folderId: string): Promise<void>;
  renameFolder(folderId: string, newName: string): Promise<void>;
  moveFolder(folderId: string, newParentId: string): Promise<{ name: string }>;
  moveFile(fileId: string, newParentFolderId: string): Promise<void>;
  writeManifest(folderId: string, manifest: GalleryManifest): Promise<void>;
  readManifest(folderId: string): Promise<GalleryManifest | null>;
  listGalleryFolders(rootFolderId: string): Promise<DriveFolderInfo[]>;
  getCoverThumbnail(folderId: string): Promise<string | null>;
  findFolderByName(parentFolderId: string, name: string): Promise<string | null>;
  ensureFolder(parentFolderId: string, name: string): Promise<string>;
  readTextFile(folderId: string, fileName: string): Promise<string | null>;
  writeTextFile(folderId: string, fileName: string, content: string): Promise<void>;
  listImageFiles(folderId: string): Promise<DriveImageInfo[]>;
  exportDocHtml(fileId: string): Promise<string>;
}

// Binds the module's functions to one set of Drive credentials, giving server.ts a small
// interface it can depend on - and server.test.ts a seam to substitute a fake implementation.
// `docsDeps` is a separate, dedicated OAuth client used only for exportDocHtml - see
// config.ts's docsClientId comment for why it must stay distinct from `deps`.
export function createDriveClient(deps: DriveDeps, docsDeps: DriveDeps = deps): DriveClient {
  return {
    createAlbumFolder: (parentFolderId, folderName) => createAlbumFolder(deps, parentFolderId, folderName),
    uploadFileStream: (folderId, fileName, mimeType, bodyStream, originalModifiedMs) =>
      uploadFileStream(deps, folderId, fileName, mimeType, bodyStream, originalModifiedMs),
    listFiles: folderId => listFiles(deps, folderId),
    setFolderPublic: folderId => setFolderPublic(deps, folderId),
    deleteFolder: folderId => deleteFolder(deps, folderId),
    renameFolder: (folderId, newName) => renameFolder(deps, folderId, newName),
    moveFolder: (folderId, newParentId) => moveFolder(deps, folderId, newParentId),
    moveFile: (fileId, newParentFolderId) => moveFile(deps, fileId, newParentFolderId),
    writeManifest: (folderId, manifest) => writeManifest(deps, folderId, manifest),
    readManifest: folderId => readManifest(deps, folderId),
    listGalleryFolders: rootFolderId => listGalleryFolders(deps, rootFolderId),
    getCoverThumbnail: folderId => getCoverThumbnail(deps, folderId),
    findFolderByName: (parentFolderId, name) => findFolderByName(deps, parentFolderId, name),
    ensureFolder: (parentFolderId, name) => ensureFolder(deps, parentFolderId, name),
    readTextFile: (folderId, fileName) => readTextFile(deps, folderId, fileName),
    writeTextFile: (folderId, fileName, content) => writeTextFile(deps, folderId, fileName, content),
    listImageFiles: folderId => listImageFiles(deps, folderId),
    exportDocHtml: fileId => exportDocHtml(docsDeps, fileId),
  };
}
