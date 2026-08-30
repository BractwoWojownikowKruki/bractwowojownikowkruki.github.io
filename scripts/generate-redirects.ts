import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface RedirectEntry {
  path: string;
  target: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Meta-refresh fires before the page has a chance to render (instant on every browser, unlike
// the JS redirect below), and the JS redirect covers the rare case where a browser/proxy strips
// the meta tag - both point at the same target, so there is no user-visible difference in which
// one actually fires. GitHub Pages can't serve a real HTTP redirect (no server), so this is the
// closest equivalent it can serve as a static file.
// Generated pages live one level below dist/ (dist/<alias>/index.html), same as every other
// subpage (kontakt/, o-nas/, ...), so asset paths are "../" like theirs.
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
  <link rel="icon" type="image/png" href="../favicon.png" />
  <link rel="apple-touch-icon" href="../favicon.png" />
  <link rel="stylesheet" href="../style.css" />
</head>
<body>
  <header class="site-header site-header--main">
    <a href="../" class="logo-link" aria-label="Bractwo Wojowników Kruki">
      <img src="../kruki-logo.png" alt="Kruki" class="logo" />
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

  <script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>
`;
}

function main(): void {
  const root = new URL('..', import.meta.url).pathname;
  const distDir = join(root, 'dist');
  const redirectsPath = join(root, 'redirects.json');
  const entries: RedirectEntry[] = JSON.parse(readFileSync(redirectsPath, 'utf8'));

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
