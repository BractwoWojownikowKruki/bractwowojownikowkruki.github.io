import type { MemberDoc } from './members.ts';

export type SheetSyncStatus = 'ok' | 'failed' | 'not_configured';

export interface SheetsClient {
  // Deliberately the only write method (per review finding #2 on the implementation plan):
  // every membership transition triggers a full, atomic rebuild rather than an incremental
  // per-row append/update, so there is exactly one code path to keep correct and no risk of one
  // status change silently dropping every other member from the backup.
  syncAllMembers(members: Array<MemberDoc & { email: string }>): Promise<SheetSyncStatus>;
}

// No-op used when SHEETS_* env vars are unset (design.md's fail-safe-startup requirement) -
// approve/reject/etc. still succeed via Firestore; the caller surfaces "not_configured" to the
// admin rather than crashing or silently pretending to have synced.
export function createDisabledSheetsClient(): SheetsClient {
  return { syncAllMembers: async () => 'not_configured' };
}

export interface SheetsClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sheetId: string;
  fetchImpl?: typeof fetch;
}

const ROW_HEADER = ['Email', 'Imię i nazwisko', 'Ksywa', 'Sekcja', 'Status'];
// Fixed generous upper bound so a shrinking member list still blanks out stale trailing rows in
// the same request (a single spreadsheets.batchUpdate call, never a separate clear + write).
const SYNC_ROW_COUNT = 500;
const SYNC_COLUMN_COUNT = 5;

function memberRow(m: MemberDoc & { email: string }): string[] {
  return [m.email, m.fullName, m.nickname ?? '', m.sectionId, m.status];
}

// Mirrors drive.ts's getAccessToken pattern exactly: manual refresh-token exchange, cached
// in-memory per refresh token with a 60s expiry buffer - no google-auth-library, no googleapis
// package (design.md's explicit no-new-dependency decision).
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getSheetsAccessToken(opts: SheetsClientOptions, now: () => number = Date.now): Promise<string> {
  const cached = tokenCache.get(opts.refreshToken);
  if (cached && cached.expiresAt > now() + 60_000) return cached.accessToken;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) throw new Error(`Odświeżenie tokenu Sheets nie powiodło się: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(opts.refreshToken, { accessToken: body.access_token, expiresAt: now() + body.expires_in * 1000 });
  return body.access_token;
}

export function createSheetsClient(opts: SheetsClientOptions): SheetsClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    // Single atomic spreadsheets.batchUpdate call - applied together or not at all (documented
    // Sheets API guarantee), chosen specifically over separate clear+update calls to avoid a
    // half-cleared sheet on a mid-request failure.
    async syncAllMembers(members): Promise<SheetSyncStatus> {
      const rows = [ROW_HEADER, ...members.map(memberRow)];
      const paddedRows: string[][] = [];
      for (let i = 0; i < SYNC_ROW_COUNT; i++) {
        const row = rows[i] ?? [];
        const padded = [...row];
        while (padded.length < SYNC_COLUMN_COUNT) padded.push('');
        paddedRows.push(padded);
      }
      try {
        const token = await getSheetsAccessToken(opts);
        const res = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${opts.sheetId}:batchUpdate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            requests: [
              {
                updateCells: {
                  range: { sheetId: 0, startRowIndex: 0, endRowIndex: SYNC_ROW_COUNT, startColumnIndex: 0, endColumnIndex: SYNC_COLUMN_COUNT },
                  rows: paddedRows.map(row => ({ values: row.map(v => ({ userEnteredValue: { stringValue: v } })) })),
                  fields: 'userEnteredValue',
                },
              },
            ],
          }),
        });
        if (!res.ok) {
          console.error('Sheets batchUpdate nie powiodło się:', res.status);
          return 'failed';
        }
        return 'ok';
      } catch (err) {
        console.error('Sheets batchUpdate rzuciło wyjątkiem:', err);
        return 'failed';
      }
    },
  };
}
