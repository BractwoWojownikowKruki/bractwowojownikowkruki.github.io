import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const css = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');

test('Brokuł emoji has its own compact text geometry and Candidates share the green', () => {
  assert.match(css, /--category-color-kandydat:\s*#639f09;/);
  assert.match(css, /\.brokul-pill-icon\s*\{[\s\S]*?font-size:\s*1em;/);
  assert.match(css, /\.brokul-pill-icon\s*\{[\s\S]*?margin-right:\s*0\.28rem;/);
  assert.match(css, /\.brokul-pill-icon\s*\{[\s\S]*?vertical-align:\s*-0\.02em;/);
});

test('KRKG-0101: categories control bg/fg/accent independently, with Bobo as the example', () => {
  // The pill reads its fill/text from optional per-category vars, falling back to the old mix.
  assert.match(css, /\.category-name-pill\s*\{[^}]*background:\s*var\(--category-bg,/);
  assert.match(css, /\.category-name-pill\s*\{[^}]*color:\s*var\(--category-fg,/);
  assert.match(css, /\.category-name-pill\s*\{[^}]*var\(--category-c, var\(--category-color-default\)\) 27%, var\(--surface-deep\)/);
  // Bobo sets all three on its own [data-category] block - light pink fill, dark pink text.
  assert.match(css, /\[data-category="bobo"\]\s*\{[^}]*--category-c:\s*var\(--category-color-bobo\)/);
  assert.match(css, /\[data-category="bobo"\]\s*\{[^}]*--category-bg:\s*color-mix\(in srgb, #f90081 50%, white\)/);
  assert.match(css, /\[data-category="bobo"\]\s*\{[^}]*--category-fg:\s*color-mix\(in srgb, var\(--category-color-bobo\) 48%, #000000\)/);
});
