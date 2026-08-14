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

// Shared read-transform-write-with-conflict-retry loop behind both appendAlbumToMain and
// removeAlbumFromMain - a 409 means the sha we read is stale (someone else committed to
// albums.json in between), so it re-reads the current content and sha and retries the write.
async function updateAlbumsJson(
  deps: GithubDeps,
  fetchImpl: typeof fetch,
  commitMessage: string,
  transform: (currentContent: string) => string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${deps.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const getRes = await fetchImpl(`https://api.github.com/repos/${deps.repo}/contents/albums.json?ref=main`, { headers });
    if (!getRes.ok) {
      throw new Error(`Nie udało się odczytać albums.json z GitHub: HTTP ${getRes.status}`);
    }
    const file = (await getRes.json()) as { content: string; sha: string };
    const currentContent = Buffer.from(file.content, 'base64').toString('utf8');
    const updatedContent = transform(currentContent);
    if (updatedContent === currentContent) {
      return;
    }
    const putRes = await fetchImpl(`https://api.github.com/repos/${deps.repo}/contents/albums.json`, {
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
      throw new Error(`Nie udało się zapisać albums.json na GitHub: HTTP ${putRes.status}`);
    }
  }
}

export async function appendAlbumToMain(
  deps: GithubDeps,
  entry: NewAlbumEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const label = entry.nameOverride ?? entry.dateOverride;
  return updateAlbumsJson(
    deps,
    fetchImpl,
    `Dodaj album (przesłany przez formularz): ${label}`,
    current => buildUpdatedAlbumsJson(current, entry),
  );
}

export async function removeAlbumFromMain(
  deps: GithubDeps,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return updateAlbumsJson(
    deps,
    fetchImpl,
    `Usuń album (przesłany przez formularz): ${url}`,
    current => buildAlbumsJsonWithout(current, url),
  );
}

export interface GithubClient {
  appendAlbumToMain(entry: NewAlbumEntry): Promise<void>;
  removeAlbumFromMain(url: string): Promise<void>;
}

// Binds appendAlbumToMain/removeAlbumFromMain to one set of GitHub credentials - server.ts
// depends on this small interface, and server.test.ts substitutes a fake for route-level testing.
export function createGithubClient(deps: GithubDeps): GithubClient {
  return {
    appendAlbumToMain: entry => appendAlbumToMain(deps, entry),
    removeAlbumFromMain: url => removeAlbumFromMain(deps, url),
  };
}
