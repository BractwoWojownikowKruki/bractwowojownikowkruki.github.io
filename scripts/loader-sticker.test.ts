import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const staticLoaderSources = [
  'templates/nav.html',
  'public/admin/index.html',
  'public/galerie/dodaj-galerie.html',
  'public/galerie/dodaj-zdjecia.html',
  'public/galerie/index.html',
  'public/lista-wyjazdowa/index.html',
  'public/lista-wyjazdowa/skladki/index.html',
  'public/lista-wyjazdowa/wyjazd/index.html',
  'public/logowanie/index.html',
  'public/o-nas/nasze-osiagniecia/index.html',
  'public/poradnik-walki/index.html',
  'public/profil/index.html',
  'public/wojownicy/blachowi/index.html',
  'public/wojownicy/emeryci/index.html',
  'public/wojownicy/kandydaci/index.html',
  'public/wojownicy/niewiasty/index.html',
  'public/wojownicy/wrzuc/index.html',
  'public/zasady-bractwa/index.html',
  'public/index.html',
  'templates/social_sidebar.html',
];

const loaderContext = /<(p|div)\b[^>]*class="[^"]*\b(?:auth-checking|page-spinner|loading-spinner)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g;
const stickerImage = /<img\b(?=[^>]*\bsrc="\/icons\/hold-the-line\.png")(?=[^>]*\bclass="[^"]*\bbusy-sticker\b)(?=[^>]*\balt="")[^>]*>/;

test('defines an accessible, continuously animated Hold the Line loader', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');

  assert.match(css, /\.busy-sticker\s*\{[\s\S]*width:\s*116px[\s\S]*height:\s*auto/);
  assert.match(css, /\.busy-sticker--compact\s*\{[\s\S]*width:\s*40px/);
  assert.match(css, /\.busy-sticker-aura\s*\{[\s\S]*overflow:\s*hidden[\s\S]*width:\s*(40|116)px/);
  assert.match(css, /\.busy-sticker\s*\{[\s\S]*animation:\s*busy-sticker-sway/);
  assert.match(css, /\.busy-sticker-aura::before\s*\{[\s\S]*animation:\s*busy-sticker-aura/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.busy-sticker\s*\{[\s\S]*animation:\s*none/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.busy-sticker-aura::before\s*\{[\s\S]*animation:\s*none/);
  assert.match(css, /\.auth-checking:not\(\.nav-auth-checking\)\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.drive-gallery-status\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.busy-sticker-aura--compact\s*\{[\s\S]*width:\s*28px/);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.busy-sticker--compact\s*\{[\s\S]*width:\s*28px/);
  assert.match(css, /\.sr-only\s*\{[\s\S]*position:\s*absolute/);
  assert.ok(statSync(new URL('../public/icons/hold-the-line.png', import.meta.url)).size > 0);
});

test('keeps an initial session check visible for at least one second without delaying other loading states', async () => {
  const auth = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');

  assert.match(auth, /const MINIMUM_SESSION_CHECKING_MS = 1000;/);
  assert.match(auth, /const sessionCheckStartedAt = Date\.now\(\);/);
  assert.match(auth, /Math\.max\(0, MINIMUM_SESSION_CHECKING_MS - \(Date\.now\(\) - sessionCheckStartedAt\)\)/);
  assert.match(auth, /identity => afterMinimumSessionChecking\(\(\) => onSignedIn\?\.\(identity\)\)/);
  assert.match(auth, /err => afterMinimumSessionChecking\(\(\) => notifyAuthFailure\(\{ onSignedOut, onForbidden \}, err\)\)/);
});

test('uses the Hold the Line sticker in every static loading context', async () => {
  for (const source of staticLoaderSources) {
    const html = await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
    const loaders = html.match(loaderContext) ?? [];

    assert.ok(loaders.length > 0, `${source} should contain a static loading context`);
    for (const loader of loaders) {
      assert.match(loader, stickerImage, `${source} should use the decorative Hold the Line sticker`);
      assert.doesNotMatch(loader, /<(?:span|div)\b[^>]*\bclass="(?:[^"\s]+\s+)*spinner(?:\s+[^"\s]+)*"/, `${source} should not retain a legacy spinner`);
    }

    const legacySpinners = html.match(/<span\b[^>]*\bclass="(?:[^"\s]+\s+)*spinner(?:\s+[^"\s]+)*"[^>]*><\/span>/g) ?? [];
    if (source === 'public/o-nas/nasze-osiagniecia/index.html') {
      assert.equal(legacySpinners.length, 1, 'only the achievement lightbox overlay spinner may remain');
      assert.match(html, /<div class="lightbox-image-wrap">[\s\S]*?<span class="spinner"><\/span>[\s\S]*?<\/div>/);
    } else {
      assert.equal(legacySpinners.length, 0, `${source} should not retain a legacy spinner outside image overlays`);
    }
  }
});

test('uses a compact, screen-reader-labelled Hold the Line sticker in the shared navigation partial', async () => {
  for (const source of ['templates/nav.html']) {
    const html = await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
    const navStatus = html.match(/<p class="auth-checking nav-auth-checking" id="nav-auth-checking" role="status">([\s\S]*?)<\/p>/)?.[1];

    assert.ok(navStatus, `${source} should preserve the navigation status hook`);
    assert.match(navStatus, /<span class="busy-sticker-aura busy-sticker-aura--compact" aria-hidden="true">\s*<img src="\/icons\/hold-the-line\.png" class="busy-sticker busy-sticker--compact" alt="">\s*<\/span>/);
    assert.equal((navStatus.match(/<span class="sr-only">Please hold the line\.\.\.<\/span>/g) ?? []).length, 1);
    assert.equal((navStatus.match(/Please hold the line\.\.\./g) ?? []).length, 1, `${source} should not expose duplicate navigation text`);
  }
});

test('uses the shared Hold the Line sticker in gallery list and page loading states', async () => {
  const app = await readFile(new URL('../public/galerie/app.js', import.meta.url), 'utf8');
  const legacySpinnersOutsideImageOverlays = app
    .replace(/<div class="(?:drive-hero-image-wrap|lightbox-image-wrap)">[\s\S]*?<\/div>/g, '')
    .match(/<span class="spinner"><\/span>/g) ?? [];

  assert.match(app, /const BUSY_STICKER = '<span class="busy-sticker-aura" aria-hidden="true"><img src="\/icons\/hold-the-line\.png" class="busy-sticker" alt=""><\/span>';/);
  assert.match(app, /id="drive-gallery-status">\$\{BUSY_STICKER\} Ładowanie…<\/p>/);
  assert.equal(legacySpinnersOutsideImageOverlays.length, 0, 'gallery app should retain legacy spinners only inside image overlays');
  assert.equal((app.match(/<span class="spinner"><\/span>/g) ?? []).length, 3, 'gallery image overlays should retain their image-load spinners');
  assert.match(app, /<div class="drive-hero-image-wrap">[\s\S]*?<span class="spinner"><\/span>[\s\S]*?<\/div>/);
  assert.match(app, /<div class="lightbox-image-wrap">[\s\S]*?<span class="spinner"><\/span>[\s\S]*?<\/div>/);
});

test('temporary site build preserves sticker markup in both navigation variants without static legacy spinners', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'kruki-loader-build-'));
  const repositoryRoot = new URL('..', import.meta.url).pathname;

  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: repositoryRoot,
      // scripts/inject-release-info.ts requires RELEASE_BUILT_AT/RELEASE_COMMIT_SHA/
      // GITHUB_RUN_NUMBER whenever GITHUB_ACTIONS=true, which this "Run tests" CI step already
      // is - the real values are only exported later, in pages.yml's separate "Build site" step.
      // This is a one-off sanity build, not the real release, so it supplies its own dummy
      // values rather than inheriting env that's incomplete at this point in the pipeline.
      env: {
        ...process.env,
        BUILD_OUTPUT_DIR: outputDir,
        RELEASE_BUILT_AT: new Date().toISOString(),
        RELEASE_COMMIT_SHA: '0000000',
        GITHUB_RUN_NUMBER: '0',
      },
      stdio: 'pipe',
    });

    for (const source of ['index.html', 'galerie/index.html']) {
      const html = readFileSync(join(outputDir, source), 'utf8');
      assert.match(html, /src="\/icons\/hold-the-line\.png"/, `${source} should contain the shared sticker asset`);
      assert.doesNotMatch(html, /<span class="spinner"><\/span>/, `${source} should not contain a legacy static spinner`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
