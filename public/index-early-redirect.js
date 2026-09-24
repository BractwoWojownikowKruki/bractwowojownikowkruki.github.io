/**
 * / (index.html) only. Extracted from an inline <head> script (KRKG-0108, so the page can carry a
 * script-src Content-Security-Policy) - a plain <script src> with no async/defer still runs
 * synchronously, in document order, blocking parsing exactly like the inline script it replaces,
 * so the timing this depends on (send a returning member to /app/ before "Aktualności" ever
 * paints) is unchanged.
 *
 * Duplicates auth.js's MEMBER_REDIRECT_HINT_KEY/MAX_AGE_MS constants because it must run before
 * auth.js is even fetched (see auth.js's own comment on that constant for the full rationale -
 * this hint is a plain timestamp, not a credential, and grants nothing by itself). index-
 * redirect.js further down the page is the authoritative, server-verified fallback for when this
 * finds no/a stale hint (first-ever visit on this browser, or one older than MAX_AGE_MS).
 */
(function () {
  try {
    var hint = localStorage.getItem('kruki_last_member_hint');
    if (hint && Date.now() - Number(hint) >= 0 && Date.now() - Number(hint) < 14 * 24 * 60 * 60 * 1000) {
      window.location.replace('/app/');
    }
  } catch (e) {
    // localStorage can throw in some privacy modes - falls through to the normal,
    // network-verified redirect in index-redirect.js further down the page.
  }
})();
