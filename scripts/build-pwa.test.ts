import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPwa } from './build-pwa.ts';
import { PRECACHE_PATHS } from './pwa-policy.ts';

test('generates a deployment-versioned worker from approved built assets', () => {
  const distDir = mkdtempSync(join(tmpdir(), 'kruki-pwa-'));
  for (const pathname of PRECACHE_PATHS) {
    const target = join(distDir, pathname);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'small shell asset');
  }

  buildPwa(distDir, 'deployment-sha');
  const worker = readFileSync(join(distDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /kruki-pwa-deployment-sha/);
  assert.doesNotMatch(worker, /galerie\/thumbs/);
});
