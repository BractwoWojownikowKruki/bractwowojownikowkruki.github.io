import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheNameForDeployment, PRECACHE_PATHS, renderServiceWorker, validatePrecacheAsset } from './pwa-policy.ts';

/** Generates the deployment-specific browser worker from the final static output. */
export function buildPwa(distDir: string, deploymentId = process.env.GITHUB_SHA): void {
  const hasher = createHash('sha256');
  for (const pathname of PRECACHE_PATHS) {
    const content = readFileSync(join(distDir, pathname));
    validatePrecacheAsset(pathname, content.byteLength);
    hasher.update(pathname);
    hasher.update(content);
  }
  const identifier = deploymentId || hasher.digest('hex');
  writeFileSync(join(distDir, 'service-worker.js'), renderServiceWorker({ cacheName: cacheNameForDeployment(identifier), precachePaths: PRECACHE_PATHS }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildPwa(new URL('../dist', import.meta.url).pathname);
}
