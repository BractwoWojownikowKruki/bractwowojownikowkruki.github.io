import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { injectPartials } from './inject-partials.ts';

test('injectPartials replaces a placeholder with the matching partial', () => {
  const html = '<body>\n  <!-- PARTIAL:footer -->\n</body>';
  const result = injectPartials(html, { footer: '  <footer>hi</footer>' });
  assert.equal(result, '<body>\n  <footer>hi</footer>\n</body>');
});

test('injectPartials replaces multiple placeholders in the same document', () => {
  const html = '<!-- PARTIAL:header -->\n<!-- PARTIAL:footer -->';
  const result = injectPartials(html, { header: '<h>h</h>', footer: '<f>f</f>' });
  assert.equal(result, '<h>h</h>\n<f>f</f>');
});

test('injectPartials leaves the placeholder untouched when no matching partial exists', () => {
  const html = '<!-- PARTIAL:missing -->';
  const result = injectPartials(html, { footer: '<f>f</f>' });
  assert.equal(result, '<!-- PARTIAL:missing -->');
});

test('injectPartials leaves html without placeholders unchanged', () => {
  const html = '<body><p>no placeholders here</p></body>';
  assert.equal(injectPartials(html, { footer: '<f>f</f>' }), html);
});

test('build renders the same release identity into root and nested final HTML', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'kruki-release-build-'));
  const repositoryRoot = new URL('..', import.meta.url).pathname;
  const expected = 'wersja 2026.09.06.123 · commit 0123456 · opublikowano 06.09.2026, 14:23 UTC';

  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        BUILD_OUTPUT_DIR: outputDir,
        RELEASE_BUILT_AT: '2026-09-06T14:23:00.000Z',
        GITHUB_RUN_NUMBER: '123',
        RELEASE_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_SHA: 'fedcba9876543210fedcba9876543210fedcba98',
      },
      stdio: 'pipe',
    });

    for (const relativePath of ['index.html', 'o-nas/index.html']) {
      const html = await readFile(join(outputDir, relativePath), 'utf8');
      assert.ok(html.includes(`<span data-release-info>${expected}</span>`));
      assert.doesNotMatch(html, /\{\{RELEASE_INFO\}\}/);
    }

    const worker = await readFile(join(outputDir, 'service-worker.js'), 'utf8');
    assert.match(worker, /const CACHE_NAME = "kruki-pwa-0123456789abcdef0123456789abcdef01234567";/);
    assert.doesNotMatch(worker, /kruki-pwa-fedcba9876543210fedcba9876543210fedcba98/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('Pages build exports one final commit and UTC build timestamp immediately before building', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');

  assert.match(
    workflow,
    /- name: Build site\s+run: \|\s+RELEASE_COMMIT_SHA="\$\(git rev-parse HEAD\)"\s+RELEASE_BUILT_AT="\$\(date -u \+'%Y-%m-%dT%H:%M:%SZ'\)"\s+export RELEASE_COMMIT_SHA RELEASE_BUILT_AT\s+npm run build/,
  );
});

test('release injector uses readable local metadata when CI inputs are absent', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'kruki-release-local-'));
  const repositoryRoot = new URL('..', import.meta.url).pathname;
  const localSha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();

  try {
    await writeFile(join(outputDir, 'index.html'), '<span data-release-info>{{RELEASE_INFO}}</span>');
    execFileSync(join(repositoryRoot, 'node_modules/.bin/tsx'), ['scripts/inject-release-info.ts'], {
      cwd: repositoryRoot,
      env: releaseEnvironment({ BUILD_OUTPUT_DIR: outputDir }),
      stdio: 'pipe',
    });

    const html = await readFile(join(outputDir, 'index.html'), 'utf8');
    assert.match(
      html,
      new RegExp(`wersja \\d{4}\\.\\d{2}\\.\\d{2}\\.0 · commit ${localSha} · opublikowano \\d{2}\\.\\d{2}\\.\\d{4}, \\d{2}:\\d{2} UTC`),
    );
    assert.doesNotMatch(html, /\{\{RELEASE_INFO\}\}/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('release injector rejects every missing required GitHub Actions input', async () => {
  const repositoryRoot = new URL('..', import.meta.url).pathname;
  const requiredInputs = ['RELEASE_BUILT_AT', 'RELEASE_COMMIT_SHA', 'GITHUB_RUN_NUMBER'] as const;

  for (const missingInput of requiredInputs) {
    const outputDir = mkdtempSync(join(tmpdir(), 'kruki-release-ci-'));

    try {
      await writeFile(join(outputDir, 'index.html'), '<span data-release-info>{{RELEASE_INFO}}</span>');
      const env = releaseEnvironment({
        BUILD_OUTPUT_DIR: outputDir,
        GITHUB_ACTIONS: 'true',
        RELEASE_BUILT_AT: '2026-09-06T14:23:00.000Z',
        RELEASE_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_RUN_NUMBER: '123',
      });
      delete env[missingInput];

      const result = spawnSync(
        join(repositoryRoot, 'node_modules/.bin/tsx'),
        ['scripts/inject-release-info.ts'],
        { cwd: repositoryRoot, env, encoding: 'utf8' },
      );

      assert.notEqual(result.status, 0, `${missingInput} must be required in GitHub Actions`);
      assert.match(result.stderr, new RegExp(`Missing required GitHub Actions release input: ${missingInput}`));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('member-zone partials provide initially hidden accessible PWA install controls', async () => {
  const [nav, sidebar, footer] = await Promise.all([
    readFile(new URL('../templates/nav.html', import.meta.url), 'utf8'),
    readFile(new URL('../templates/social_sidebar.html', import.meta.url), 'utf8'),
    readFile(new URL('../templates/footer.html', import.meta.url), 'utf8'),
  ]);

  const mobilePanel = nav.match(/<div class="members-zone-panel" id="members-zone-panel" hidden>([\s\S]*?)\n\s*<\/div>\n\s*<\/div>/)?.[1];
  assert.ok(mobilePanel, 'members-zone-mobile panel must exist');
  assertInstallControl(mobilePanel, 'members-zone-panel', '');
  assertInstallControl(sidebar, 'members-zone-sidebar', '</aside>');
  assertInstallControl(nav, 'members-zone-nav', 'id="nav-login-link"');
  assert.match(footer, /<script\s+src="\/pwa-install\.js"><\/script>/);
});

test('protected entry points begin with the shared session-checking message, not a login control', async () => {
  const protectedPages = [
    '../public/logowanie/index.html',
    '../public/wojownicy/wrzuc/index.html',
    '../public/galerie/dodaj-galerie.html',
    '../public/galerie/dodaj-zdjecia.html',
    '../public/galerie/index.html',
    '../public/zasady-bractwa/index.html',
    '../public/poradnik-walki/index.html',
    '../public/profil/index.html',
    '../public/lista-wyjazdowa/index.html',
    '../public/lista-wyjazdowa/wyjazd/index.html',
    '../public/lista-wyjazdowa/skladki/index.html',
    '../public/admin/index.html',
  ];

  for (const page of protectedPages) {
    const html = await readFile(new URL(page, import.meta.url), 'utf8');
    assert.match(html, /class="auth-checking"[^>]*role="status"/);
    assert.match(html, /Please hold the line\.\.\./);
  }
});

test('both shared navigation partials start with an account-status indicator', async () => {
  for (const partial of ['../templates/nav.html', '../templates/nav_galerie.html']) {
    const html = await readFile(new URL(partial, import.meta.url), 'utf8');
    assert.match(html, /id="nav-auth-checking"/);
    assert.match(html, /Please hold the line\.\.\./);
  }
});

test('the Strefa Członków top-nav dropdown lives inside .nav-account-area in both nav partials', async () => {
  // Regression check for a bug where templates/nav_galerie.html placed #members-zone-nav as a
  // sibling BEFORE .nav-account-area instead of nested inside it. .nav-account-area is what
  // pushes its contents to the row's right edge (margin-left:auto, see .nav-account-area in
  // style.css) - outside it, the dropdown drifted to the middle of the row on Galerie pages
  // while every other page still showed it flush right, since only nav.html's copy was ever
  // fixed. The two templates are otherwise near-identical by design (see the diff between them),
  // so this asserts the one structural relationship that must not silently drift apart again.
  for (const partial of ['../templates/nav.html', '../templates/nav_galerie.html']) {
    const html = await readFile(new URL(partial, import.meta.url), 'utf8');
    const accountArea = html.match(/<div class="nav-account-area">([\s\S]*?)\n\s*<\/div>\s*\n\s*<\/nav>/)?.[1];

    assert.ok(accountArea, `${partial} must have a .nav-account-area block ending just before </nav>`);
    assert.match(accountArea, /id="members-zone-nav"/, `${partial}: #members-zone-nav must be nested inside .nav-account-area`);
  }
});

test('session-checking indicators honor hidden after authentication resolves', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.auth-checking\[hidden\]\s*\{\s*display:\s*none;/);
});

test('shared sign-in routing distinguishes a missing session from denied membership', async () => {
  const auth = await readFile(new URL('../public/auth.js', import.meta.url), 'utf8');
  assert.match(auth, /onSignedOut/);
  assert.match(auth, /err\.status === 401/);
  assert.match(auth, /err\.status === 403/);
  assert.match(auth, /function notifyAuthFailure/);
});

function assertInstallControl(source: string, zoneId: string, zoneEnd: string) {
  const zoneStart = zoneEnd ? source.indexOf(`id="${zoneId}"`) : 0;
  const zoneEndIndex = zoneEnd ? source.indexOf(zoneEnd, zoneStart) : source.length;
  const zone = zoneStart >= 0 && zoneEndIndex >= 0 ? source.slice(zoneStart, zoneEndIndex) : undefined;
  assert.ok(zone, `${zoneId} must exist`);

  const controls = zone.match(/<button\b[^>]*data-pwa-install[^>]*>\s*Zainstaluj\s*<\/button>/g) ?? [];
  const messages = zone.match(/<[^>]+data-pwa-install-message[^>]*><\/[^>]+>/g) ?? [];
  assert.equal(controls.length, 1, `${zoneId} must have one install control`);
  assert.equal(messages.length, 1, `${zoneId} must have one install message`);
  assert.match(controls[0], /\bhidden\b/);
  assert.match(messages[0], /\bhidden\b/);
  assert.match(messages[0], /\brole="status"/);
  assert.match(messages[0], /\baria-live="polite"/);

  const messageId = messages[0].match(/\bid="([^"]+)"/)?.[1];
  assert.ok(messageId, `${zoneId} install message needs a unique ID`);
  assert.match(controls[0], new RegExp(`\\baria-describedby="${messageId}"`));
}

function releaseEnvironment(overrides: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...overrides } as Record<string, string>;
  delete env.GITHUB_ACTIONS;
  delete env.RELEASE_BUILT_AT;
  delete env.RELEASE_COMMIT_SHA;
  delete env.GITHUB_RUN_NUMBER;
  return { ...env, ...overrides };
}
