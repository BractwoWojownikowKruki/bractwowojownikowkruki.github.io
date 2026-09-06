export const DRIVE_API_KEY_PUBLIC = 'AIzaSyCNnBUsUnpNyfyCeJqPghBraIRjg-YHyPQ';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink)';

export function formatFileSize(size) {
  if (size == null || size === '') return '';
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const value = bytes < 1024 * 1024 ? bytes / 1024 : bytes / (1024 * 1024);
  return `${Number(value.toFixed(1))} ${bytes < 1024 * 1024 ? 'KB' : 'MB'}`;
}

export function driveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

export function isAllowedThumbnailUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'lh3.googleusercontent.com'; } catch { return false; }
}

export function isAllowedViewUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'drive.google.com'; } catch { return false; }
}

export function createDriveListRequest(folderId, pageToken) {
  const params = new URLSearchParams({ q: `'${folderId}' in parents`, fields: LIST_FIELDS, orderBy: 'folder,name_natural', pageSize: '1000' });
  if (pageToken) params.set('pageToken', pageToken);
  return { url: `https://www.googleapis.com/drive/v3/files?${params}`, options: { headers: { 'X-Goog-Api-Key': DRIVE_API_KEY_PUBLIC } } };
}

export function createDriveFolderMetadataRequest(folderId) {
  return { url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id%2Cname`, options: { headers: { 'X-Goog-Api-Key': DRIVE_API_KEY_PUBLIC } } };
}

export function nextBreadcrumbs(stack, folderId, pending) {
  const existing = stack.findIndex(entry => entry.id === folderId);
  if (existing >= 0) return stack.slice(0, existing + 1);
  if (pending?.id === folderId && stack.at(-1)?.id === pending.parentId) return [...stack, { id: pending.id, name: pending.name }];
  return stack;
}

export async function fetchDriveFolderFiles(folderId, fetchFn = fetch) {
  const files = []; let token;
  do { const request = createDriveListRequest(folderId, token); const response = await fetchFn(request.url, request.options); if (!response.ok) throw new Error(String(response.status)); const page = await response.json(); files.push(...(page.files ?? [])); token = page.nextPageToken; } while (token);
  return files;
}

async function fetchFolderName(folderId) {
  const request = createDriveFolderMetadataRequest(folderId);
  const response = await fetch(request.url, request.options);
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()).name;
}

export function fileAction(file) {
  if (file.mimeType === FOLDER_MIME_TYPE) return null;
  if (file.mimeType.startsWith('application/vnd.google-apps.')) return isAllowedViewUrl(file.webViewLink) ? { label: 'Otwórz', href: file.webViewLink } : null;
  return { label: 'Pobierz', href: driveDownloadUrl(file.id) };
}

function makeTile(file, onFolder) {
  const tile = document.createElement(file.mimeType === FOLDER_MIME_TYPE ? 'button' : 'article'); tile.className = `file-tile${file.mimeType === FOLDER_MIME_TYPE ? ' file-tile-folder' : ''}`;
  if (file.mimeType === FOLDER_MIME_TYPE) { tile.type = 'button'; tile.addEventListener('click', () => onFolder(file)); }
  const visual = document.createElement('div'); visual.className = 'file-tile-thumb';
  if (file.mimeType.startsWith('image/') && isAllowedThumbnailUrl(file.thumbnailLink)) { const image = document.createElement('img'); image.src = file.thumbnailLink; image.alt = ''; image.loading = 'lazy'; image.addEventListener('error', () => { image.remove(); visual.textContent = '📄'; }); visual.append(image); } else visual.textContent = file.mimeType === FOLDER_MIME_TYPE ? '📁' : '📄';
  const name = document.createElement('div'); name.className = 'file-tile-name'; name.textContent = file.name;
  tile.append(visual, name); const size = formatFileSize(file.size); if (size) { const el = document.createElement('div'); el.className = 'file-tile-size'; el.textContent = size; tile.append(el); }
  const action = fileAction(file); if (action) { const link = document.createElement('a'); link.className = 'file-tile-download'; link.href = action.href; link.textContent = action.label; link.target = '_blank'; link.rel = 'noopener noreferrer'; tile.append(link); }
  return tile;
}

export function initializeDriveFileBrowser(root) {
  const rootId = root.dataset.driveRootId; const rootName = root.dataset.driveRootName; if (!rootId || !rootName) return;
  let stack = [{ id: rootId, name: rootName }], pending, requestId = 0;
  const render = async () => { const folderId = location.hash.slice(1) || rootId; const current = ++requestId; const external = folderId !== rootId && !stack.some(entry => entry.id === folderId) && pending?.id !== folderId; stack = nextBreadcrumbs(stack, folderId, pending); pending = undefined; root.replaceChildren(); const status = document.createElement('p'); status.className = 'file-browser-status'; status.textContent = 'Ładowanie…'; root.append(status);
    try { if (external) { const name = await fetchFolderName(folderId); if (current !== requestId) return; stack = [{ id: rootId, name: rootName }, { id: folderId, name }]; } const files = await fetchDriveFolderFiles(folderId); if (current !== requestId) return; const crumbs = document.createElement('nav'); crumbs.className = 'file-browser-breadcrumbs'; stack.forEach((entry, index) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.name; button.addEventListener('click', () => { location.hash = entry.id === rootId ? '' : entry.id; }); crumbs.append(button); if (index < stack.length - 1) crumbs.append(' › '); }); const grid = document.createElement('div'); grid.className = 'file-browser-grid'; for (const file of files) grid.append(makeTile(file, child => { pending = { id: child.id, name: child.name, parentId: folderId }; location.hash = child.id; })); root.replaceChildren(crumbs, files.length ? grid : Object.assign(status, { textContent: 'Ten folder jest pusty.' }));
    } catch { if (current === requestId) { status.textContent = 'Nie udało się załadować zawartości folderu.'; } }
  };
  addEventListener('hashchange', render); render();
}

if (typeof document !== 'undefined') document.querySelectorAll('[data-drive-root-id]').forEach(initializeDriveFileBrowser);
