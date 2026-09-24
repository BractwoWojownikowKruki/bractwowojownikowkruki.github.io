import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipartParts, escapeDriveQueryValue, resizeThumbnailUrl, sanitizeFolderName } from './drive.ts';

test('sanitizeFolderName strips characters Drive folder names can carry but that read oddly', () => {
  assert.equal(sanitizeFolderName('2026-08-09 Wolin/Kruki'), '2026-08-09 WolinKruki');
});

test('sanitizeFolderName trims surrounding whitespace', () => {
  assert.equal(sanitizeFolderName('  2026-08-09 Wolin  '), '2026-08-09 Wolin');
});

test('sanitizeFolderName falls back to a plain label when the name is empty after sanitizing', () => {
  assert.equal(sanitizeFolderName('///'), 'Album');
});

test('buildMultipartParts produces a prefix/suffix pair Drive accepts around arbitrary streamed content', () => {
  const { prefix, suffix, boundary } = buildMultipartParts({ name: 'foo.jpg', parents: ['abc'] }, 'image/jpeg');
  const prefixText = prefix.toString('latin1');
  assert.ok(prefixText.startsWith(`--${boundary}\r\n`));
  assert.ok(prefixText.includes('Content-Type: application/json'));
  assert.ok(prefixText.includes('"name":"foo.jpg"'));
  assert.ok(prefixText.includes('Content-Type: image/jpeg'));
  assert.equal(suffix.toString('latin1'), `\r\n--${boundary}--`);
});

test('resizeThumbnailUrl swaps the =s<size> suffix Drive thumbnail links carry', () => {
  assert.equal(
    resizeThumbnailUrl('https://lh3.googleusercontent.com/abc=s220', 800),
    'https://lh3.googleusercontent.com/abc=s800',
  );
});

// KRKG-0108: ids and names are interpolated into Drive `q` literals quoted with single quotes.
test('escapeDriveQueryValue escapes single quotes and backslashes (backslash first), leaving plain ids alone', () => {
  assert.equal(escapeDriveQueryValue('1AbC_d-EfG'), '1AbC_d-EfG');
  assert.equal(escapeDriveQueryValue("x' or name contains '"), "x\\' or name contains \\'");
  assert.equal(escapeDriveQueryValue('a\\b'), 'a\\\\b');
  assert.equal(escapeDriveQueryValue("\\'"), "\\\\\\'");
});
