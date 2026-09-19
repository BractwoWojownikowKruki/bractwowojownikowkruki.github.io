import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const page = readFileSync(new URL('../public/pliki/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/pliki/pliki.js', import.meta.url), 'utf8');

test('Pliki renders an announced Brokuł person pill through the shared renderer', () => {
  assert.match(page, /shared\/person-pill\.js[\s\S]*pliki\.js/);
  assert.match(script, /personPillHtml\(\{[\s\S]*?mode:\s*'person'/);
});
