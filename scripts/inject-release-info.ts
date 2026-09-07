import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatReleaseMetadata, renderReleaseInfo } from './release-info.ts';

function findHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...findHtmlFiles(fullPath));
    } else if (entry.endsWith('.html')) {
      results.push(fullPath);
    }
  }
  return results;
}

function readLocalCommitSha(repositoryRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '0000000';
  }
}

function releaseInput(name: string, localFallback: () => string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(`Missing required GitHub Actions release input: ${name}`);
  }
  return localFallback();
}

function main(): void {
  const repositoryRoot = new URL('..', import.meta.url).pathname;
  const outputDir = process.env.BUILD_OUTPUT_DIR
    ? resolve(process.env.BUILD_OUTPUT_DIR)
    : join(repositoryRoot, 'dist');
  const releaseBuiltAt = releaseInput('RELEASE_BUILT_AT', () => new Date().toISOString());
  const metadata = formatReleaseMetadata({
    buildTimestamp: new Date(releaseBuiltAt),
    runNumber: releaseInput('GITHUB_RUN_NUMBER', () => '0'),
    commitSha: releaseInput('RELEASE_COMMIT_SHA', () => readLocalCommitSha(repositoryRoot)),
  });

  let count = 0;
  for (const file of findHtmlFiles(outputDir)) {
    const html = readFileSync(file, 'utf8');
    const rendered = renderReleaseInfo(html, metadata);
    if (rendered !== html) {
      writeFileSync(file, rendered);
      count++;
    }
  }

  console.log(`[inject-release-info] Wstrzyknięto dane wydania w ${count} plik(ach) HTML`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
