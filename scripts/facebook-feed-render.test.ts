import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/facebook-feed.js', import.meta.url), 'utf8');

function renderPost(post: Record<string, unknown>): { html: string; likeIcon: string } {
  const window: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    Date,
    document: { addEventListener() {}, getElementById: () => null },
    window,
  };
  vm.runInNewContext(`${source}\n;globalThis.__Feed = FacebookFeed;`, context, { filename: 'facebook-feed.js' });
  const FacebookFeed = context.__Feed as new (containerId: string) => {
    escapeHtml(text: string): string;
    renderPost(value: Record<string, unknown>): string;
    likeIconSvg(): string;
  };
  const feed = new FacebookFeed('missing');
  feed.escapeHtml = (text) => text;
  return { html: feed.renderPost(post), likeIcon: feed.likeIconSvg() };
}

test('Facebook post engagement shows the like icon without stale counts or comment icon', () => {
  const { html, likeIcon } = renderPost({
    caption: 'A post',
    mediaUrl: '',
    permalink: 'https://facebook.com/post/1',
    timestamp: '2026-11-20T12:00:00Z',
    likeCount: 731,
    commentsCount: 84,
  });

  assert.match(html, /class="fb-post-engagement"/);
  assert.ok(html.includes(likeIcon));
  assert.doesNotMatch(html, /731|84/);
  assert.doesNotMatch(html, /M7\.9 20/);
  assert.equal((html.match(/class="fb-post-stat"/g) ?? []).length, 1);
});
