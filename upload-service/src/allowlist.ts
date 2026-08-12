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
  getEmails(): Promise<string[]>;
}

export interface SheetAllowlistOptions {
  url: string;
  ttlMs?: number;
  fetchImpl?: AllowlistFetch;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

// Fetches the allowlist from a published Google Sheet CSV export, caching it for ttlMs.
// Fails closed on any fetch/parse error - including when a refetch fails after a previous
// successful fetch - so a transient outage denies uploads rather than risk stale/unverifiable
// data. See KRKG-0024 design.md for the rationale.
export function createSheetAllowlist(options: SheetAllowlistOptions): SheetAllowlist {
  const { url, ttlMs = DEFAULT_TTL_MS, fetchImpl = fetch as unknown as AllowlistFetch, now = Date.now } = options;
  let cache: { emails: string[]; fetchedAt: number } | null = null;

  return {
    async getEmails(): Promise<string[]> {
      if (cache && now() - cache.fetchedAt < ttlMs) {
        return cache.emails;
      }
      try {
        const res = await fetchImpl(url);
        if (!res.ok) {
          throw new Error(`Nieoczekiwany status odpowiedzi arkusza dostępu: ${res.status}`);
        }
        const emails = parseAllowlistCsv(await res.text());
        cache = { emails, fetchedAt: now() };
        return emails;
      } catch (err) {
        console.error('Nie udało się pobrać listy dostępu z arkusza Google:', err);
        return [];
      }
    },
  };
}
