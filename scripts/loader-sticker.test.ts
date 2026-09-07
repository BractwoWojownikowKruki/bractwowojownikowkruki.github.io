import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('defines an accessible, continuously animated Hold the Line loader', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

  assert.match(css, /\.busy-sticker\s*\{[\s\S]*width:\s*116px[\s\S]*height:\s*auto/);
  assert.match(css, /\.busy-sticker--compact\s*\{[\s\S]*width:\s*34px/);
  assert.match(css, /\.busy-sticker-aura\s*\{[\s\S]*overflow:\s*hidden[\s\S]*width:\s*(34|116)px/);
  assert.match(css, /\.busy-sticker\s*\{[\s\S]*animation:\s*busy-sticker-sway/);
  assert.match(css, /\.busy-sticker-aura::before\s*\{[\s\S]*animation:\s*busy-sticker-aura/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.busy-sticker\s*\{[\s\S]*animation:\s*none/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.busy-sticker-aura::before\s*\{[\s\S]*animation:\s*none/);
  assert.match(css, /\.sr-only\s*\{[\s\S]*position:\s*absolute/);
  assert.ok(statSync(new URL('../public/icons/hold-the-line.png', import.meta.url)).size > 0);
});
