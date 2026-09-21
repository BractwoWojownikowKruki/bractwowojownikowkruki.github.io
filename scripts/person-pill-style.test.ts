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

test('KRKG-0101: categories control bg/fg/accent independently', () => {
  // The pill reads its fill/text from optional per-category vars, falling back to the old mix.
  assert.match(css, /\.category-name-pill\s*\{[^}]*background:\s*var\(--category-bg,/);
  assert.match(css, /\.category-name-pill\s*\{[^}]*color:\s*var\(--category-fg,/);
  assert.match(css, /\.category-name-pill\s*\{[^}]*var\(--category-c, var\(--category-color-default\)\) 27%, var\(--surface-deep\)/);
  // thing/bobo/emeryt set all three flat colors in their own [data-category] blocks.
  assert.match(css, /\[data-category="thing"\]\s*\{[^}]*--category-c:\s*#ffcc00;[^}]*--category-bg:\s*#ffbb00;[^}]*--category-fg:\s*#000000;/);
  assert.match(css, /\[data-category="bobo"\]\s*\{[^}]*--category-c:\s*#f06bb0;[^}]*--category-bg:\s*#fb98cb;[^}]*--category-fg:\s*#3a0e24;/);
  assert.match(css, /\[data-category="emeryt"\]\s*\{[^}]*--category-c:\s*#94a3b8;[^}]*--category-bg:\s*#999999;[^}]*--category-fg:\s*#212121;/);
});
