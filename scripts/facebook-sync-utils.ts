// Pure helpers for scripts/sync-facebook.ts, split out (like utils.ts is for sync-albums.ts) so
// they're testable without mocking fetch/fs. Deliberately its own module, not shared with
// utils.ts - the Facebook sync is an independent feature (KRKG-0035), not a variant of album
// syncing, even though both scripts follow the same general "diff against what's already
// stored, fetch what's missing" shape.

export interface RemotePost {
  id: string;
  caption: string;
  media_url: string;
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

export interface IndexEntry {
  id: string;
  timestamp: string;
}

export interface StoredPost {
  id: string;
  caption: string;
  permalink: string;
  timestamp: string;
  image: string | null;
  likeCount: number;
  commentsCount: number;
}

// Given the already-synced index and the newest posts fetched live (newest-first, already
// truncated to the sync batch size by the caller), returns which of those posts still need to
// be synced - i.e. not already present in the index.
export function selectPostsToSync(indexEntries: IndexEntry[], remotePosts: RemotePost[]): RemotePost[] {
  const known = new Set(indexEntries.map(e => e.id));
  return remotePosts.filter(p => !known.has(p.id));
}

// The index is kept newest-first by timestamp regardless of the order posts were synced in -
// callers append new entries in any order and then re-sort with this.
export function sortIndexByTimestampDesc(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function toStoredPost(post: RemotePost, image: string | null): StoredPost {
  return {
    id: post.id,
    caption: post.caption ?? '',
    permalink: post.permalink,
    timestamp: post.timestamp,
    image,
    likeCount: post.like_count ?? 0,
    commentsCount: post.comments_count ?? 0,
  };
}
