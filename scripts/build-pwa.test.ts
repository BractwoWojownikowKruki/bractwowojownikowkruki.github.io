import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPwa } from './build-pwa.ts';
import { PRECACHE_PATHS } from './pwa-policy.ts';

test('removes a temporary directory when the action throws', () => {
  let distDir: string | undefined;

  assert.throws(() => {
    withTemporaryDirectory('kruki-pwa-cleanup-', (directory) => {
      distDir = directory;
      throw new Error('expected test failure');
    });
  }, /expected test failure/);

  assert.ok(distDir);
  assert.equal(existsSync(distDir), false);
});

test('generates a deployment-versioned worker from approved built assets', () => {
  withTemporaryDirectory('kruki-pwa-', (distDir) => {
    for (const pathname of PRECACHE_PATHS) {
      const target = join(distDir, pathname);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'small shell asset');
    }

    buildPwa(distDir, 'deployment-sha');
    const worker = readFileSync(join(distDir, 'service-worker.js'), 'utf8');
    assert.match(worker, /kruki-pwa-deployment-sha/);
    assert.doesNotMatch(worker, /galerie\/(?:covers|thumbs)|facebook\/images|api\.kruki\.org/);
  });
});

test('prefers the final release commit over the workflow event commit', () => {
  withTemporaryDirectory('kruki-pwa-final-sha-', (distDir) => {
    const previousReleaseSha = process.env.RELEASE_COMMIT_SHA;
    const previousGithubSha = process.env.GITHUB_SHA;

    try {
      for (const pathname of PRECACHE_PATHS) {
        const target = join(distDir, pathname);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, 'small shell asset');
      }

      process.env.RELEASE_COMMIT_SHA = 'final-release-sha';
      process.env.GITHUB_SHA = 'workflow-event-sha';

      buildPwa(distDir);

      const worker = readFileSync(join(distDir, 'service-worker.js'), 'utf8');
      assert.match(worker, /kruki-pwa-final-release-sha/);
      assert.doesNotMatch(worker, /workflow-event-sha/);
    } finally {
      restoreEnvironmentVariable('RELEASE_COMMIT_SHA', previousReleaseSha);
      restoreEnvironmentVariable('GITHUB_SHA', previousGithubSha);
    }
  });
});

function withTemporaryDirectory<T>(prefix: string, action: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
