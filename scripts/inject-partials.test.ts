import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  assertInstallControl(nav, 'members-zone-nav', '<div class="nav-account-area">');
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
