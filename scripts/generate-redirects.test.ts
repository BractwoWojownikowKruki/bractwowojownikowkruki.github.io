import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRedirectPage } from './generate-redirects.ts';

test('renderRedirectPage embeds the target in a meta-refresh redirect', () => {
  const html = renderRedirectPage('https://discord.gg/abc123');
  assert.match(html, /<meta http-equiv="refresh" content="0;url=https:\/\/discord\.gg\/abc123" \/>/);
});

test('renderRedirectPage embeds the target in a JS fallback redirect', () => {
  const html = renderRedirectPage('https://discord.gg/abc123');
  assert.match(html, /location\.replace\("https:\/\/discord\.gg\/abc123"\)/);
});

test('renderRedirectPage escapes double quotes in the target for the meta/link attributes', () => {
  const html = renderRedirectPage('https://example.com/?a="x"');
  assert.doesNotMatch(html, /url=https:\/\/example\.com\/\?a="x"/);
  assert.match(html, /&quot;/);
});

test('renderRedirectPage shows the site logo linking home, styled like the rest of the site', () => {
  const html = renderRedirectPage('https://discord.gg/abc123');
  assert.match(html, /<link rel="stylesheet" href="\.\.\/style\.css" \/>/);
  assert.match(html, /<img src="\.\.\/kruki-logo\.png" alt="Kruki" class="logo" \/>/);
});

test('renderRedirectPage shows a "Poczekaj..." message', () => {
  const html = renderRedirectPage('https://discord.gg/abc123');
  assert.match(html, /Poczekaj\.\.\./);
});
