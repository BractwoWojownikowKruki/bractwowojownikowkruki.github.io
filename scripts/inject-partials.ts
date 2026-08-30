import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export function injectPartials(html: string, partials: Record<string, string>): string {
  return html.replace(/^[ \t]*<!--\s*PARTIAL:(\w+)\s*-->/gm, (match, name: string) => {
    const partial = partials[name];
    if (partial === undefined) {
      console.warn(`[inject-partials] Brak partiala "${name}", zostawiam placeholder`);
      return match;
    }
    return partial.trimEnd();
  });
}

function findHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findHtmlFiles(full));
    } else if (entry.endsWith('.html')) {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  const root = new URL('..', import.meta.url).pathname;
  const templatesDir = join(root, 'templates');
  const distDir = join(root, 'dist');

  const partials: Record<string, string> = {};
  for (const file of readdirSync(templatesDir)) {
    if (!file.endsWith('.html')) continue;
    const name = file.replace(/\.html$/, '');
    partials[name] = readFileSync(join(templatesDir, file), 'utf8');
  }

  let count = 0;
  for (const file of findHtmlFiles(distDir)) {
    const html = readFileSync(file, 'utf8');
    const injected = injectPartials(html, partials);
    if (injected !== html) {
      writeFileSync(file, injected);
      count++;
    }
  }
  console.log(`[inject-partials] Wstrzyknięto partiale w ${count} plik(ach) HTML`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
