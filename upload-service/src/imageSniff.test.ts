import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimeTypesEquivalent, sniffImageMimeType } from './imageSniff.ts';

test('sniffImageMimeType recognizes a JPEG signature', () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(sniffImageMimeType(buf), 'image/jpeg');
});

test('sniffImageMimeType recognizes a PNG signature', () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  assert.equal(sniffImageMimeType(buf), 'image/png');
});

test('sniffImageMimeType recognizes a WEBP signature', () => {
  const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
  assert.equal(sniffImageMimeType(buf), 'image/webp');
});

test('sniffImageMimeType recognizes an HEIC ftyp brand', () => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp', 'ascii'), Buffer.from('heic', 'ascii')]);
  assert.equal(sniffImageMimeType(buf), 'image/heic');
});

test('sniffImageMimeType recognizes an HEIF (mif1) ftyp brand', () => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp', 'ascii'), Buffer.from('mif1', 'ascii')]);
  assert.equal(sniffImageMimeType(buf), 'image/heif');
});

test('sniffImageMimeType returns null for plain text masquerading as an image', () => {
  const buf = Buffer.from('this is not an image, just text pretending to be one', 'utf8');
  assert.equal(sniffImageMimeType(buf), null);
});

test('sniffImageMimeType returns null for a too-short buffer', () => {
  assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8])), null);
});

test('mimeTypesEquivalent treats image/heic and image/heif as the same family', () => {
  assert.equal(mimeTypesEquivalent('image/heic', 'image/heif'), true);
  assert.equal(mimeTypesEquivalent('image/heif', 'image/heic'), true);
});

test('mimeTypesEquivalent requires an exact match outside the heic/heif family', () => {
  assert.equal(mimeTypesEquivalent('image/jpeg', 'image/png'), false);
  assert.equal(mimeTypesEquivalent('image/jpeg', 'image/jpeg'), true);
});
