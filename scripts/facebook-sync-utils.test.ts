import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPostsToSync, sortIndexByTimestampDesc, toStoredPost, type RemotePost } from './facebook-sync-utils.ts';

function post(id: string, timestamp: string): RemotePost {
  return { id, caption: `caption-${id}`, media_url: `https://fb.example/${id}.jpg`, permalink: `https://facebook.com/${id}`, timestamp };
}

test('selectPostsToSync returns posts not already in the index', () => {
  const index = [{ id: '1', timestamp: '2026-01-01T00:00:00Z' }];
  const remote = [post('1', '2026-01-01T00:00:00Z'), post('2', '2026-01-08T00:00:00Z')];
  const result = selectPostsToSync(index, remote);
  assert.deepEqual(result.map(p => p.id), ['2']);
});

test('selectPostsToSync returns nothing new when every remote post is already synced', () => {
  const index = [{ id: '1', timestamp: '2026-01-01T00:00:00Z' }];
  const remote = [post('1', '2026-01-01T00:00:00Z')];
  assert.deepEqual(selectPostsToSync(index, remote), []);
});

test('selectPostsToSync returns everything when the index is empty', () => {
  const remote = [post('1', '2026-01-01T00:00:00Z'), post('2', '2026-01-08T00:00:00Z')];
  assert.deepEqual(selectPostsToSync([], remote).map(p => p.id), ['1', '2']);
});

test('sortIndexByTimestampDesc orders newest first regardless of input order', () => {
  const entries = [
    { id: 'a', timestamp: '2026-01-01T00:00:00Z' },
    { id: 'b', timestamp: '2026-01-15T00:00:00Z' },
    { id: 'c', timestamp: '2026-01-08T00:00:00Z' },
  ];
  assert.deepEqual(sortIndexByTimestampDesc(entries).map(e => e.id), ['b', 'c', 'a']);
});

test('toStoredPost maps Graph API field names to the static storage shape, defaulting missing counts to 0', () => {
  const remote = post('1', '2026-01-01T00:00:00Z');
  assert.deepEqual(toStoredPost(remote, 'facebook/images/1.jpg'), {
    id: '1',
    caption: 'caption-1',
    permalink: 'https://facebook.com/1',
    timestamp: '2026-01-01T00:00:00Z',
    image: 'facebook/images/1.jpg',
    likeCount: 0,
    commentsCount: 0,
  });
});

test('toStoredPost carries through like/comment counts when present', () => {
  const remote = { ...post('1', '2026-01-01T00:00:00Z'), like_count: 3, comments_count: 2 };
  const stored = toStoredPost(remote, null);
  assert.equal(stored.likeCount, 3);
  assert.equal(stored.commentsCount, 2);
  assert.equal(stored.image, null);
});
