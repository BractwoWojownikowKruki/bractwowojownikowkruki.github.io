import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

export interface RedirectEntry {
  path: string;
  target: string;
}

function escapeAttr(value: string): string {
  // Every use here is a double-quoted attribute, so only & and " are strictly load-bearing -
  // but escaping ' too (KRKG-0108 review) means this stays correct if a future double-quoted
  // OR single-quoted attribute value ever reuses it, not just the two current call sites.
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Meta-refresh fires before the page has a chance to render (instant on every browser, unlike
// the JS redirect below), and the JS redirect covers the rare case where a browser/proxy strips
// the meta tag - both point at the same target, so there is no user-visible difference in which
// one actually fires. GitHub Pages can't serve a real HTTP redirect (no server), so this is the
// closest equivalent it can serve as a static file.
// Generated pages live at dist/<alias>/index.html and aliases can be nested (ngg_tag/x), so
// asset paths are root-absolute rather than "../"-relative.
export function renderRedirectPage(target: string): string {
  const escapedTarget = escapeAttr(target);
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="0;url=${escapedTarget}" />
  <link rel="canonical" href="${escapedTarget}" />
  <meta name="robots" content="noindex, follow" />
  <title>Poczekaj... - Bractwo Wojowników Kruki</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;900&display=swap" rel="stylesheet" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header class="site-header site-header--main">
    <a href="/" class="logo-link" aria-label="Bractwo Wojowników Kruki">
      <img src="/kruki-logo.png" alt="Kruki" class="logo" />
    </a>
  </header>

  <main class="main-content main-content--single">
    <div class="content-left">
      <section class="content-section" style="text-align:center; padding: 3rem 1rem;">
        <h1>Poczekaj...</h1>
        <p>Przekierowywanie na <a href="${escapedTarget}">${escapedTarget}</a>...</p>
      </section>
    </div>
  </main>

  <script src="/redirect.js" data-target="${escapedTarget}"></script>
</body>
</html>
`;
}

function main(): void {
  const root = new URL('..', import.meta.url).pathname;
  const distDir = process.env.BUILD_OUTPUT_DIR ? resolve(process.env.BUILD_OUTPUT_DIR) : join(root, 'dist');
  // redirects.json holds the short links admins create on purpose (edited through the upload
  // service); legacy-redirects.json holds the old WordPress URLs kept alive for search engines
  // and is build-time only, so the admin panel never lists or touches it.
  const entries: RedirectEntry[] = ['redirects.json', 'legacy-redirects.json'].flatMap(
    (file) => JSON.parse(readFileSync(join(root, file), 'utf8')) as RedirectEntry[],
  );

  for (const { path, target } of entries) {
    const dir = join(distDir, path);
    if (existsSync(dir)) {
      throw new Error(`generate-redirects: dist/${path} już istnieje - alias "${path}" koliduje z istniejącą stroną.`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), renderRedirectPage(target));
  }
  console.log(`[generate-redirects] Wygenerowano ${entries.length} przekierowań.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
