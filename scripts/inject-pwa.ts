import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isEligiblePublicDocument } from './pwa-policy.ts';

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
  const distDir = new URL('../dist', import.meta.url).pathname;
  for (const file of visit(distDir)) {
    if (!isEligiblePublicDocument(pathnameFor(distDir, file))) continue;
    const html = readFileSync(file, 'utf8');
    writeFileSync(file, injectPwaMarkup(html));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
