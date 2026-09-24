import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONTENT_SECURITY_POLICY, injectCspMarkup } from './inject-csp.ts';

test('injectCspMarkup adds the CSP meta tag as the first element of <head>, once', () => {
  const input = '<html><head><title>x</title></head><body>ok</body></html>';
  const output = injectCspMarkup(input);
  assert.match(output, /<head>\s*<meta http-equiv="Content-Security-Policy"/);
  assert.equal([...output.matchAll(/http-equiv="Content-Security-Policy"/g)].length, 1);
  assert.equal(injectCspMarkup(output), output);
});

test('injectCspMarkup carries a script-src restricted to self and Google Identity Services, plus object-src/base-uri/form-action', () => {
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /base-uri 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /form-action 'self'/);
});

test('injectCspMarkup preserves attributes already on <head>', () => {
  const input = '<html><head lang="pl"><title>x</title></head><body>ok</body></html>';
  const output = injectCspMarkup(input);
  assert.match(output, /<head lang="pl">\s*<meta http-equiv="Content-Security-Policy"/);
});

function visitHtml(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const file = join(dir, entry);
    return statSync(file).isDirectory() ? visitHtml(file) : file.endsWith('.html') ? [file] : [];
  });
}

test('build gives every published HTML page exactly one CSP meta and no inline <script> without a src', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'kruki-csp-output-'));
  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        BUILD_OUTPUT_DIR: outputDir,
        GITHUB_SHA: 'csp-output-test',
        GITHUB_RUN_NUMBER: '123',
        RELEASE_BUILT_AT: '2026-09-24T00:00:00.000Z',
        RELEASE_COMMIT_SHA: '0123456789abcdef',
      },
      stdio: 'pipe',
    });

    const files = visitHtml(outputDir);
    assert.ok(files.length > 30, 'sanity check: the build output should contain many pages');
    for (const file of files) {
      const html = readFileSync(file, 'utf8');
      assert.equal(
        [...html.matchAll(/http-equiv="Content-Security-Policy"/g)].length,
        1,
        `${file} must carry exactly one CSP meta tag`,
      );
      // An inline <script> with no src attribute would execute regardless of script-src - the
      // policy this batch adds only blocks scripts loaded from disallowed hosts/inline text that
      // ISN'T already trusted by 'self', which is moot if the page still has a literal inline
      // <script> block. Every executable one was moved to an external file in this same batch;
      // a script tag with a non-JavaScript type (e.g. application/ld+json structured data) is
      // never executed by the browser regardless of script-src, so it is excluded here too.
      const inlineScripts = [...html.matchAll(/<script((?![^>]*\ssrc=)[^>]*)>([\s\S]*?)<\/script>/g)]
        .filter(m => !/\btype="application\/ld\+json"/.test(m[1]))
        .map(m => m[0])
        .filter(tag => tag.replace(/<script[^>]*>|<\/script>/g, '').trim() !== '');
      assert.deepEqual(inlineScripts, [], `${file} must not have an inline <script> with executable content`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
