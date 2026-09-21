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

test('KRKG-0101: Bobo is a light-pink inverse of Niewiasta\'s dark-pink pill', () => {
  assert.match(css, /--category-color-bobo:\s*#f06bb0;/);
  assert.match(css, /\.category-name-pill\[data-category="bobo"\]\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--category-color-bobo\)\s*32%,\s*white\)/);
  assert.match(css, /\.category-name-pill\[data-category="bobo"\]\s*\{[^}]*color:\s*color-mix\(in srgb, var\(--category-color-bobo\)\s*68%,\s*black\)/);
});
