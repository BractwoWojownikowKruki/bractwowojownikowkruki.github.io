import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// KRKG-0108: a second layer against stored/reflected XSS - even if an escaping bug like the
// gallery-date one this story's Batch 1 fixed slips through again, an injected inline script (or
// one loaded from an attacker-controlled host) must not execute. GitHub Pages serves this static
// site with no way to set response headers, so a <meta http-equiv> tag is the only delivery
// mechanism available - it has no report-only mode, so this is enforcing from the first deploy.
//
// Deliberately narrow, not a full lockdown: only script-src is restricted (this app has no
// inline event handlers or inline <script> left to break - every one was moved to an external
// file as part of this same batch), plus three low-risk, broadly-safe directives with no
// legitimate use here (object-src, base-uri, form-action). img-src/connect-src/style-src are left
// open on purpose - this page loads from a wide, hard-to-enumerate set of Google/Meta CDN hosts
// for thumbnails, avatars, and social embeds, and locking those down is a separate, higher-
// effort piece of work with its own breakage risk, not a mechanical addition to this one.
//
// 'self' covers every same-origin script this site loads (all of them, except Google Identity
// Services below) - GitHub Pages serves this whole site from one origin, so no other host is
// needed for that. https://accounts.google.com/gsi/client is Google Identity Services (the
// "Sign in with Google" button/One Tap), loaded on every page that has sign-in - granting it here
// once, for every page, is simpler and no less safe than auditing which pages have it.
export const CONTENT_SECURITY_POLICY =
  "script-src 'self' https://accounts.google.com/gsi/client; object-src 'none'; base-uri 'self'; form-action 'self'";

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;

/** Inserts the CSP meta tag as the first element of <head>, once. Idempotent, like injectPwaMarkup. */
export function injectCspMarkup(html: string): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  return html.replace(/<head(\s[^>]*)?>/, match => `${match}\n  ${CSP_META_TAG}`);
}

function visit(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const file = join(dir, entry);
    return statSync(file).isDirectory() ? visit(file) : file.endsWith('.html') ? [file] : [];
  });
}

function main(): void {
  const distDir = process.env.BUILD_OUTPUT_DIR
    ? resolve(process.env.BUILD_OUTPUT_DIR)
    : new URL('../dist', import.meta.url).pathname;
  for (const file of visit(distDir)) {
    const html = readFileSync(file, 'utf8');
    writeFileSync(file, injectCspMarkup(html));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
