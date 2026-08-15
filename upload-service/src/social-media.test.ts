import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIso8601Duration } from './social-media.ts';

test('parseIso8601Duration formats minutes and seconds without a leading hour', () => {
  assert.equal(parseIso8601Duration('PT4M13S'), '4:13');
});

test('parseIso8601Duration pads seconds under 10', () => {
  assert.equal(parseIso8601Duration('PT45S'), '0:45');
});

test('parseIso8601Duration includes hours and pads minutes/seconds', () => {
  assert.equal(parseIso8601Duration('PT1H2M3S'), '1:02:03');
});

test('parseIso8601Duration handles a bare seconds-only duration under a minute', () => {
  assert.equal(parseIso8601Duration('PT9S'), '0:09');
});

test('parseIso8601Duration falls back to 0:00 for an unparseable string', () => {
  assert.equal(parseIso8601Duration('not-a-duration'), '0:00');
});
