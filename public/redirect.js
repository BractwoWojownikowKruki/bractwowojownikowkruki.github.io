/**
 * Shared by every generated short-link redirect page (generate-redirects.ts) - the JS fallback
 * for the meta-refresh redirect those pages already carry, covering the rare case where a
 * browser/proxy strips the meta tag. Extracted from a per-page inline <script> (KRKG-0108, so
 * every page can carry a script-src Content-Security-Policy); the target comes from the loading
 * script tag's own data-target attribute instead of being written inline.
 */
location.replace(document.currentScript.dataset.target);
