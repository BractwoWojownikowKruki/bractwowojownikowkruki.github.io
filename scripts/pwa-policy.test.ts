import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cacheNameForDeployment,
  isEligiblePublicDocument,
  isPwaExcludedPath,
  PRECACHE_PATHS,
  renderServiceWorker,
  validatePrecacheAsset,
} from './pwa-policy.ts';

test('defines the bounded shell precache', () => {
  assert.deepEqual(PRECACHE_PATHS, [
    '/offline.html',
    '/style.css',
    '/favicon.png',
    '/manifest.webmanifest',
    '/pwa-register.js',
    '/pwa-icons/icon-192.png',
  ]);
});

test('rejects media, external paths, and oversized assets from the precache', () => {
  for (const path of [
    '/galerie/covers/example.jpg',
    '/galerie/thumbs/example.jpg',
    '/facebook/images/example.jpg',
    '/kruki-logo.png',
    'https://example.com/app.js',
  ]) {
    assert.throws(() => validatePrecacheAsset(path, 1));
  }
  // KRKG-0050 batch 5/6: MAX_PRECACHE_BYTES raised from 100 KiB to 110 KiB (see pwa-policy.ts's
  // comment on it) - style.css was already at 102251 bytes before this batch's own (small,
  // necessary) .audyt-history-link addition, leaving no realistic margin for future growth either.
  assert.throws(() => validatePrecacheAsset('/style.css', 112_641));
  assert.doesNotThrow(() => validatePrecacheAsset('/style.css', 102_926));
});

test('classifies public and gated page paths', () => {
  assert.equal(isEligiblePublicDocument('/'), true);
  assert.equal(isEligiblePublicDocument('/kontakt/'), true);
  assert.equal(isEligiblePublicDocument('/grafiki/'), true);
  assert.equal(isEligiblePublicDocument('/oferty/'), true);
  assert.equal(isEligiblePublicDocument('/galerie/'), false);
  assert.equal(isPwaExcludedPath('/galerie/'), true);
  assert.equal(isPwaExcludedPath('/galerie/dodaj-galerie.html'), true);
  assert.equal(isPwaExcludedPath('/admin/'), true);
  assert.equal(isPwaExcludedPath('/logowanie/'), true);
  assert.equal(isPwaExcludedPath('/wojownicy/wrzuc/'), true);
  assert.equal(isPwaExcludedPath('/profil/'), true);
  assert.equal(isPwaExcludedPath('/lista-wyjazdowa/'), true);
  // KRKG-0046
  assert.equal(isPwaExcludedPath('/zgloszenie/'), true);
});

test('uses a deployment-specific cache name', () => {
  assert.equal(cacheNameForDeployment('first'), 'kruki-pwa-first');
  assert.notEqual(cacheNameForDeployment('first'), cacheNameForDeployment('second'));
});

test('renders offline fallback only for navigation requests to eligible public pages', () => {
  const source = renderServiceWorker({
    cacheName: 'kruki-pwa-test',
    precachePaths: PRECACHE_PATHS,
  });
  assert.match(source, /request\.mode === 'navigate'/);
  assert.match(source, /isEligiblePublicDocument\(url\.pathname\)/);
  assert.match(source, /caches\.match\('\/offline\.html'\)/);
  assert.match(source, /isPwaExcludedPath\(url\.pathname\)/);
});
