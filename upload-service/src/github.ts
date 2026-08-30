export interface NewAlbumEntry {
  url: string;
  nameOverride?: string;
  dateOverride: string;
}

export function buildUpdatedAlbumsJson(currentContent: string, entry: NewAlbumEntry): string {
  const entries: NewAlbumEntry[] = JSON.parse(currentContent);
  if (entries.some(e => e.url === entry.url)) {
    return currentContent;
  }
  entries.push({
    url: entry.url,
    ...(entry.nameOverride ? { nameOverride: entry.nameOverride } : {}),
    dateOverride: entry.dateOverride,
  });
  return JSON.stringify(entries, null, 2) + '\n';
}

export function buildAlbumsJsonWithout(currentContent: string, url: string): string {
  const entries: NewAlbumEntry[] = JSON.parse(currentContent);
  const filtered = entries.filter(e => e.url !== url);
  if (filtered.length === entries.length) {
    return currentContent;
  }
  return JSON.stringify(filtered, null, 2) + '\n';
}

export interface GithubDeps {
  token: string;
  repo: string;
}

const MAX_CONFLICT_RETRIES = 5;

// Shared read-transform-write-with-conflict-retry loop behind the album and redirect
// read/write functions below - a 409 means the sha we read is stale (someone else committed
// to the file in between), so it re-reads the current content and sha and retries the write.
async function updateJsonFile(
  deps: GithubDeps,
  fetchImpl: typeof fetch,
  fileName: string,
  commitMessage: string,
  transform: (currentContent: string) => string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${deps.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const getRes = await fetchImpl(`https://api.github.com/repos/${deps.repo}/contents/${fileName}?ref=main`, { headers });
    if (!getRes.ok) {
      throw new Error(`Nie udało się odczytać ${fileName} z GitHub: HTTP ${getRes.status}`);
    }
    const file = (await getRes.json()) as { content: string; sha: string };
    const currentContent = Buffer.from(file.content, 'base64').toString('utf8');
    const updatedContent = transform(currentContent);
    if (updatedContent === currentContent) {
      return;
    }
    const putRes = await fetchImpl(`https://api.github.com/repos/${deps.repo}/contents/${fileName}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(updatedContent, 'utf8').toString('base64'),
        sha: file.sha,
        branch: 'main',
      }),
    });
    if (putRes.ok) {
      return;
    }
    if (putRes.status !== 409 || attempt === MAX_CONFLICT_RETRIES) {
      throw new Error(`Nie udało się zapisać ${fileName} na GitHub: HTTP ${putRes.status}`);
    }
  }
}

export async function appendAlbumToMain(
  deps: GithubDeps,
  entry: NewAlbumEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const label = entry.nameOverride ?? entry.dateOverride;
  return updateJsonFile(
    deps,
    fetchImpl,
    'albums.json',
    `Dodaj album (przesłany przez formularz): ${label}`,
    current => buildUpdatedAlbumsJson(current, entry),
  );
}

export async function removeAlbumFromMain(
  deps: GithubDeps,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return updateJsonFile(
    deps,
    fetchImpl,
    'albums.json',
    `Usuń album (przesłany przez formularz): ${url}`,
    current => buildAlbumsJsonWithout(current, url),
  );
}

export interface RedirectEntry {
  path: string;
  target: string;
}

// Mirrors the top-level directories public/ (and therefore dist/) already reserves - an alias
// colliding with one of these would otherwise only surface as a build-time failure in
// generate-redirects.ts, long after the admin already believes the redirect was saved.
const RESERVED_REDIRECT_PATHS = new Set([
  'admin',
  'banner-photos',
  'facebook',
  'galerie',
  'kontakt',
  'nabor',
  'o-nas',
  'turniej',
  'vendor',
  'wojownicy',
]);

const REDIRECT_PATH_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidRedirectPath(path: string): boolean {
  return REDIRECT_PATH_PATTERN.test(path) && !RESERVED_REDIRECT_PATHS.has(path);
}

export function isValidRedirectTarget(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Unlike albums (deduped by URL, appending is a no-op on a repeat), a redirect alias is a
// unique key an admin may legitimately want to repoint - so adding an already-used alias
// replaces its target instead of silently doing nothing.
export function buildUpdatedRedirectsJson(currentContent: string, entry: RedirectEntry): string {
  const entries: RedirectEntry[] = JSON.parse(currentContent);
  const filtered = entries.filter(e => e.path !== entry.path);
  filtered.push(entry);
  return JSON.stringify(filtered, null, 2) + '\n';
}

export function buildRedirectsJsonWithout(currentContent: string, path: string): string {
  const entries: RedirectEntry[] = JSON.parse(currentContent);
  const filtered = entries.filter(e => e.path !== path);
  if (filtered.length === entries.length) {
    return currentContent;
  }
  return JSON.stringify(filtered, null, 2) + '\n';
}

export async function fetchRedirectsJson(deps: GithubDeps, fetchImpl: typeof fetch = fetch): Promise<RedirectEntry[]> {
  const getRes = await fetchImpl(`https://api.github.com/repos/${deps.repo}/contents/redirects.json?ref=main`, {
    headers: { Authorization: `Bearer ${deps.token}`, Accept: 'application/vnd.github+json' },
  });
  if (!getRes.ok) {
    throw new Error(`Nie udało się odczytać redirects.json z GitHub: HTTP ${getRes.status}`);
  }
  const file = (await getRes.json()) as { content: string };
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
}

export async function appendRedirectToMain(
  deps: GithubDeps,
  entry: RedirectEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return updateJsonFile(
    deps,
    fetchImpl,
    'redirects.json',
    `Dodaj przekierowanie (panel admina): /${entry.path} -> ${entry.target}`,
    current => buildUpdatedRedirectsJson(current, entry),
  );
}

export async function removeRedirectFromMain(
  deps: GithubDeps,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return updateJsonFile(
    deps,
    fetchImpl,
    'redirects.json',
    `Usuń przekierowanie (panel admina): /${path}`,
    current => buildRedirectsJsonWithout(current, path),
  );
}

export interface GithubClient {
  appendAlbumToMain(entry: NewAlbumEntry): Promise<void>;
  removeAlbumFromMain(url: string): Promise<void>;
  listRedirects(): Promise<RedirectEntry[]>;
  appendRedirectToMain(entry: RedirectEntry): Promise<void>;
  removeRedirectFromMain(path: string): Promise<void>;
}

// Binds the functions above to one set of GitHub credentials - server.ts depends on this small
// interface, and server.test.ts substitutes a fake for route-level testing.
export function createGithubClient(deps: GithubDeps): GithubClient {
  return {
    appendAlbumToMain: entry => appendAlbumToMain(deps, entry),
    removeAlbumFromMain: url => removeAlbumFromMain(deps, url),
    listRedirects: () => fetchRedirectsJson(deps),
    appendRedirectToMain: entry => appendRedirectToMain(deps, entry),
    removeRedirectFromMain: path => removeRedirectFromMain(deps, path),
  };
}
