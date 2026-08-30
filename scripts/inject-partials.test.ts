import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectPartials } from './inject-partials.ts';

test('injectPartials replaces a placeholder with the matching partial', () => {
  const html = '<body>\n  <!-- PARTIAL:footer -->\n</body>';
  const result = injectPartials(html, { footer: '  <footer>hi</footer>' });
  assert.equal(result, '<body>\n  <footer>hi</footer>\n</body>');
});

test('injectPartials replaces multiple placeholders in the same document', () => {
  const html = '<!-- PARTIAL:header -->\n<!-- PARTIAL:footer -->';
  const result = injectPartials(html, { header: '<h>h</h>', footer: '<f>f</f>' });
  assert.equal(result, '<h>h</h>\n<f>f</f>');
});

test('injectPartials leaves the placeholder untouched when no matching partial exists', () => {
  const html = '<!-- PARTIAL:missing -->';
  const result = injectPartials(html, { footer: '<f>f</f>' });
  assert.equal(result, '<!-- PARTIAL:missing -->');
});

test('injectPartials leaves html without placeholders unchanged', () => {
  const html = '<body><p>no placeholders here</p></body>';
  assert.equal(injectPartials(html, { footer: '<f>f</f>' }), html);
});
