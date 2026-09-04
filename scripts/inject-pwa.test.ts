import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { injectPwaMarkup, classifyPwaPage } from './inject-pwa.ts';
import { PUBLIC_PWA_PATHS } from './pwa-policy.ts';

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

test('build emits PWA markup and a bounded worker into an isolated output directory', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'kruki-pwa-output-'));
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, BUILD_OUTPUT_DIR: outputDir, GITHUB_SHA: 'pwa-output-test' },
      stdio: 'pipe',
    });

    for (const pathname of PUBLIC_PWA_PATHS) {
      const outputFile = pathname === '/' ? join(outputDir, 'index.html') : join(outputDir, pathname, 'index.html');
      const html = readFileSync(outputFile, 'utf8');
      assert.equal([...html.matchAll(/rel="manifest"/g)].length, 1, pathname);
      assert.equal([...html.matchAll(/name="theme-color"/g)].length, 1, pathname);
      assert.equal([...html.matchAll(/src="\/pwa-register\.js"/g)].length, 1, pathname);
    }

    const home = readFileSync(join(outputDir, 'index.html'), 'utf8');
    assert.equal([...home.matchAll(/\bdata-pwa-install(?:\s|=|>)/g)].length, 2);
    assertInstallControlInZone(home, 'members-zone-mobile');
    assertInstallControlInZone(home, 'members-zone-sidebar');
    assert.equal(readFileSync(join(outputDir, 'pwa-install.js'), 'utf8').length > 0, true);
    assert.equal([...home.matchAll(/src="\/pwa-install\.js"/g)].length, 1);

    for (const pathname of ['/admin/', '/galerie/', '/logowanie/', '/wojownicy/wrzuc/']) {
      const html = readFileSync(join(outputDir, pathname, 'index.html'), 'utf8');
      assert.doesNotMatch(html, /rel="manifest"/, pathname);
      assert.doesNotMatch(html, /name="theme-color"/, pathname);
      assert.doesNotMatch(html, /src="\/pwa-register\.js"/, pathname);
    }

    const worker = readFileSync(join(outputDir, 'service-worker.js'), 'utf8');
    assert.match(worker, /kruki-pwa-pwa-output-test/);
    assert.doesNotMatch(worker, /galerie\/(?:covers|thumbs)|facebook\/images|api\.kruki\.org/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

function assertInstallControlInZone(html: string, zoneId: string): void {
  assert.match(
    html,
    new RegExp(`<div[^>]*\\bid="${zoneId}"[^>]*>[\\s\\S]*?<button\\b[^>]*\\bdata-pwa-install(?:\\s|=|>)[^>]*>`),
    `${zoneId} must contain an install control`,
  );
}
