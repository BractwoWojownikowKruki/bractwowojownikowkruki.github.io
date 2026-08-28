import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, resetRateLimitForTests } from './rate-limit.ts';

test('isRateLimited allows requests under the threshold', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    assert.equal(isRateLimited('1.2.3.4', 1000), false);
  }
});

test('isRateLimited blocks once a single IP exceeds the threshold within the window', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    isRateLimited('1.2.3.4', 1000);
  }
  assert.equal(isRateLimited('1.2.3.4', 1000), true);
});

test('isRateLimited tracks IPs independently', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    isRateLimited('1.2.3.4', 1000);
  }
  assert.equal(isRateLimited('5.6.7.8', 1000), false);
});

test('isRateLimited resets once the window has elapsed', () => {
  resetRateLimitForTests();
  for (let i = 0; i < 30; i++) {
    isRateLimited('1.2.3.4', 1000);
  }
  assert.equal(isRateLimited('1.2.3.4', 1000 + 60_000), false);
});
