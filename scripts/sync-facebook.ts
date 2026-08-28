import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  selectPostsToSync,
  sortIndexByTimestampDesc,
  toStoredPost,
  type IndexEntry,
  type RemotePost,
} from './facebook-sync-utils.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA_DIR = join(ROOT, 'public/facebook/data');
const POSTS_DIR = join(DATA_DIR, 'posts');
const IMAGES_DIR = join(ROOT, 'public/facebook/images');
const INDEX_JSON = join(DATA_DIR, 'index.json');

// The Cloud Run service's public URL - same default facebook-feed.js falls back to. Calling
// this existing public endpoint (rather than the Graph API directly) means this CI job never
// needs its own copy of FACEBOOK_PAGE_ACCESS_TOKEN (see KRKG-0035 design.md).
const BACKEND_URL = process.env.FACEBOOK_SYNC_BACKEND_URL ?? 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';

// Forward-only by design (KRKG-0035): only ever looks at the newest 5 live posts and syncs
// whichever aren't already in the index. No historical backfill.
const SYNC_BATCH_SIZE = 5;

function readIndex(): IndexEntry[] {
  if (!existsSync(INDEX_JSON)) return [];
  return JSON.parse(readFileSync(INDEX_JSON, 'utf8'));
}

async function downloadImage(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buf));
}

// A post is only added to the index once its files are written - a failed image download
// (post.media_url can be a signed URL that expired between the /facebook-posts response and
// this download) skips just that post's image rather than aborting the whole run; it's retried
// automatically on tomorrow's sync since it never made it into the index.
async function syncPost(post: RemotePost): Promise<void> {
  let image: string | null = null;
  if (post.media_url) {
    const imageFile = `${post.id}.jpg`;
    try {
      await downloadImage(post.media_url, join(IMAGES_DIR, imageFile));
      image = `facebook/images/${imageFile}`;
    } catch (e) {
      console.warn(`[warn] Nie udało się pobrać obrazu posta ${post.id}: ${(e as Error).message}`);
    }
  }
  writeFileSync(join(POSTS_DIR, `${post.id}.json`), JSON.stringify(toStoredPost(post, image), null, 2) + '\n');
}

async function main(): Promise<void> {
  mkdirSync(POSTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR, { recursive: true });

  console.log(`[sync-facebook] Pobieranie z ${BACKEND_URL}/facebook-posts`);
  const res = await fetch(`${BACKEND_URL}/facebook-posts`);
  if (!res.ok) throw new Error(`Nie udało się pobrać postów: HTTP ${res.status}`);
  const data = (await res.json()) as { posts?: RemotePost[] };
  const remotePosts = (data.posts ?? []).slice(0, SYNC_BATCH_SIZE);

  const index = readIndex();
  const toSync = selectPostsToSync(index, remotePosts);

  if (toSync.length === 0) {
    console.log('[sync-facebook] Brak nowych postów.');
    return;
  }

  for (const post of toSync) {
    console.log(`[sync-facebook] Zapisywanie posta ${post.id}`);
    await syncPost(post);
  }

  const newEntries: IndexEntry[] = toSync.map(p => ({ id: p.id, timestamp: p.timestamp }));
  const updatedIndex = sortIndexByTimestampDesc([...index, ...newEntries]);
  writeFileSync(INDEX_JSON, JSON.stringify(updatedIndex, null, 2) + '\n');
  console.log(`[sync-facebook] Zsynchronizowano ${toSync.length} nowych postów.`);
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
