export interface AllowlistFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type AllowlistFetch = (url: string) => Promise<AllowlistFetchResponse>;

export function parseAllowlistCsv(csv: string): string[] {
  return csv
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().toLowerCase())
    .filter(Boolean);
}

export interface SheetAllowlist {
  // forceRefresh bypasses the cache even if it's still warm - for step-up-gated destructive/
  // admin routes (KRKG-0036 Phase 1), which need the actual current allowlist rather than up to
  // ttlMs-stale data. A forced fetch that fails still fails closed (empty list), same as an
  // ordinary one - see createCachedAllowlist below.
  getEmails(options?: { forceRefresh?: boolean }): Promise<string[]>;
}

export interface SheetAllowlistOptions {
  url: string;
  ttlMs?: number;
  fetchImpl?: AllowlistFetch;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Shared by every allowlist source below: fetch, parse, cache for ttlMs, and fail closed
// (empty list, never a thrown error) on any fetch/parse problem - including when a refetch
// fails after a previous fetch had succeeded - so a transient outage denies uploads rather
// than risk stale/unverifiable data. See KRKG-0024 design.md for the rationale; the same
// posture applies regardless of what's on the other end of `url` (a Sheet export or an Apps
// Script endpoint).
function createCachedAllowlist(
  url: string,
  parse: (body: string) => string[],
  errorLabel: string,
  options: Pick<SheetAllowlistOptions, 'ttlMs' | 'fetchImpl' | 'now'> = {},
): SheetAllowlist {
  const { ttlMs = DEFAULT_TTL_MS, fetchImpl = fetch as unknown as AllowlistFetch, now = Date.now } = options;
  let cache: { emails: string[]; fetchedAt: number } | null = null;

  return {
    async getEmails(options: { forceRefresh?: boolean } = {}): Promise<string[]> {
      if (!options.forceRefresh && cache && now() - cache.fetchedAt < ttlMs) {
        return cache.emails;
      }
      try {
        const res = await fetchImpl(url);
        if (!res.ok) {
          throw new Error(`Nieoczekiwany status odpowiedzi (${errorLabel}): ${res.status}`);
        }
        const emails = parse(await res.text());
        cache = { emails, fetchedAt: now() };
        return emails;
      } catch (err) {
        console.error(`Nie udało się pobrać listy dostępu (${errorLabel}):`, err);
        return [];
      }
    },
  };
}

// Fetches the allowlist from a published Google Sheet CSV export.
export function createSheetAllowlist(options: SheetAllowlistOptions): SheetAllowlist {
  return createCachedAllowlist(options.url, parseAllowlistCsv, 'arkusz Google', options);
}

function parseGroupMembersJson(body: string): string[] {
  const data = JSON.parse(body) as { emails?: unknown };
  if (!Array.isArray(data.emails)) {
    throw new Error('Odpowiedź nie zawiera pola "emails" jako tablicy.');
  }
  return data.emails.map(e => String(e).trim().toLowerCase()).filter(Boolean);
}

// Fetches the allowlist from a Google Apps Script Web App deployment (doGet) that returns
// {"emails": [...]}, reading live membership of a Google Group via GroupsApp - see
// upload-service/README or the Wojownicy-upload feature notes for the script itself. Deployed
// under the club's own Google account (not a personal one), "Execute as: Me" / "Who has
// access: Anyone" - the "Anyone" is required because the caller here is this server, not a
// signed-in browser, and can't complete an interactive Google OAuth prompt.
export function createAppsScriptAllowlist(options: SheetAllowlistOptions): SheetAllowlist {
  return createCachedAllowlist(options.url, parseGroupMembersJson, 'Apps Script grupy', options);
}

// Always-empty, no-network allowlist - the fail-closed default for a gate whose real source
// (a Google Group URL) hasn't been configured/created yet (see KRKG-0027's moderator group:
// the group doesn't exist yet, so every caller is denied until MODERATOR_GROUP_URL is set,
// rather than either blocking deploys on a not-yet-real secret or silently falling open).
export function createEmptyAllowlist(): SheetAllowlist {
  return { async getEmails() { return []; } };
}
