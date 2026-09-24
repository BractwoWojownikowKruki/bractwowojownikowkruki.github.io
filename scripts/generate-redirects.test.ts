import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRedirectPage } from './generate-redirects.ts';

test('renderRedirectPage embeds the target in a meta-refresh redirect', () => {
  const html = renderRedirectPage('https://discord.gg/abc123');
  assert.match(html, /<meta http-equiv="refresh" content="0;url=https:\/\/discord\.gg\/abc123" \/>/);
});

// KRKG-0108: the JS fallback redirect is an external script (so the page can carry a script-src
// Content-Security-Policy) reading its target from a data attribute, not an inline literal.
test('renderRedirectPage embeds the target as a data attribute for the external JS fallback redirect', () => {
  const html = renderRedirectPage('https://discord.gg/abc123');
  assert.match(html, /<script src="\.\.\/redirect\.js" data-target="https:\/\/discord\.gg\/abc123"><\/script>/);
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
