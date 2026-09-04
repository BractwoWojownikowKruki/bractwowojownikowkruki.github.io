import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isEligiblePublicDocument, isPwaExcludedPath } from './pwa-policy.ts';

/** Categorizes a known static document so new pages cannot silently skip PWA policy review. */
export function classifyPwaPage(pathname: string): 'eligible' | 'excluded' | 'non-entry' {
  if (isEligiblePublicDocument(pathname)) return 'eligible';
  if (isPwaExcludedPath(pathname)) return 'excluded';
  if (pathname === '/404.html' || pathname === '/offline.html') return 'non-entry';
  throw new Error(`Unclassified PWA document: ${pathname}`);
}

/** Adds install metadata only to the explicitly approved public document set. */
export function injectPwaMarkup(html: string): string {
  if (html.includes('rel="manifest"')) return html;
  return html
    .replace('</head>', '  <link rel="manifest" href="/manifest.webmanifest" />\n  <meta name="theme-color" content="#16120e" />\n</head>')
    .replace('</body>', '  <script src="/pwa-register.js"></script>\n</body>');
}

function visit(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const file = join(dir, entry);
    return statSync(file).isDirectory() ? visit(file) : file.endsWith('.html') ? [file] : [];
  });
}

function pathnameFor(distDir: string, file: string): string {
  const path = relative(distDir, file).replaceAll('index.html', '').replaceAll('\\', '/');
  return path ? `/${path}` : '/';
}

function main(): void {
  const distDir = process.env.BUILD_OUTPUT_DIR
    ? resolve(process.env.BUILD_OUTPUT_DIR)
    : new URL('../dist', import.meta.url).pathname;
  for (const file of visit(distDir)) {
    if (classifyPwaPage(pathnameFor(distDir, file)) !== 'eligible') continue;
    const html = readFileSync(file, 'utf8');
    writeFileSync(file, injectPwaMarkup(html));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
