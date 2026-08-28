import { AuthError } from './auth.ts';
import type { DriveClient } from './drive.ts';

const SETTINGS_FILE_NAME = 'facebook.json';
const DEFAULT_LIVE_FETCH_POST_COUNT = 5;
const MIN_LIVE_FETCH_POST_COUNT = 1;
// fetchFacebookPosts itself never returns more than this (limit=25 in social-media.ts), so a
// higher setting could never have any effect.
const MAX_LIVE_FETCH_POST_COUNT = 25;

export interface FacebookSettings {
  liveFetchPostCount: number;
}

let bootstrapPromise: Promise<string> | null = null;

// "Strona" > "Ustawienia" - a small dedicated settings folder. Deliberately not stored inside
// the "O Nas" structure in about-us.ts even though both sit under the same "Strona" parent:
// this holds unrelated admin-configurable knobs (currently just the Facebook feed's live-fetch
// count), and the two features shouldn't share storage just because they're both Drive-backed.
export function bootstrapSettingsFolder(drive: DriveClient): Promise<string> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const stronaId = await drive.ensureFolder('root', 'Strona');
      return drive.ensureFolder(stronaId, 'Ustawienia');
    })();
  }
  return bootstrapPromise;
}

export function resetSettingsBootstrapForTests(): void {
  bootstrapPromise = null;
}

function isValidLiveFetchPostCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_LIVE_FETCH_POST_COUNT &&
    value <= MAX_LIVE_FETCH_POST_COUNT
  );
}

// A missing or corrupt settings file falls back to the default rather than throwing - this is
// read on every public GET /facebook-posts, so it must never break the landing page's feed.
export async function getFacebookSettings(drive: DriveClient): Promise<FacebookSettings> {
  const folderId = await bootstrapSettingsFolder(drive);
  const raw = await drive.readTextFile(folderId, SETTINGS_FILE_NAME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isValidLiveFetchPostCount(parsed.liveFetchPostCount)) {
        return { liveFetchPostCount: parsed.liveFetchPostCount };
      }
    } catch {
      // fall through to the default below
    }
  }
  return { liveFetchPostCount: DEFAULT_LIVE_FETCH_POST_COUNT };
}

export async function setFacebookSettings(drive: DriveClient, settings: FacebookSettings): Promise<void> {
  if (!isValidLiveFetchPostCount(settings.liveFetchPostCount)) {
    throw new AuthError(
      `liveFetchPostCount musi być liczbą całkowitą od ${MIN_LIVE_FETCH_POST_COUNT} do ${MAX_LIVE_FETCH_POST_COUNT}.`,
      400,
    );
  }
  const folderId = await bootstrapSettingsFolder(drive);
  await drive.writeTextFile(folderId, SETTINGS_FILE_NAME, JSON.stringify(settings));
}
