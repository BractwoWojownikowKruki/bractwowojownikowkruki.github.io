import assert from 'node:assert/strict';
import { test } from 'node:test';
import { injectPwaMarkup, classifyPwaPage } from './inject-pwa.ts';

test('adds PWA markup once to an eligible HTML document', () => {
  const input = '<html><head><title>x</title></head><body>ok</body></html>';
  const output = injectPwaMarkup(input);
  assert.match(output, /manifest\.webmanifest/);
  assert.match(output, /pwa-register\.js/);
  assert.equal(injectPwaMarkup(output), output);
});

test('classifies every built HTML route or rejects it', () => {
  assert.equal(classifyPwaPage('/'), 'eligible');
  assert.equal(classifyPwaPage('/admin/'), 'excluded');
  assert.equal(classifyPwaPage('/404.html'), 'non-entry');
  assert.throws(() => classifyPwaPage('/future-page/'));
});
