/**
 * / (index.html) only - redirects a confirmed signed-in member to /app/. Never loaded by
 * /aktualnosci/ (design.md §2's explicit exception) - that page must always show the feed
 * regardless of auth state, so it must not carry this script.
 */
initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => {
    // Renews the long-lived hint index.html's own inline head script reads next time, so THIS
    // page load reaching here at all (i.e. that script found no/stale hint) doesn't keep
    // happening on every future visit - see auth.js's MEMBER_REDIRECT_HINT_KEY comment.
    setMemberRedirectHint();

    // One-shot hint for the page we're navigating to, NOT a restored-session cache (see auth.js's
    // KRKG-0036 comment) - app.js reads and immediately deletes this on load, and only trusts it
    // for a few seconds. It just lets /app/ skip repainting its own "checking" loader for a whoami
    // round-trip this page already just did; app.js still re-verifies via its own whoami call and
    // corrects course if that comes back signed-out/forbidden.
    try {
      sessionStorage.setItem('kruki_app_redirect_hint', String(Date.now()));
    } catch {
      // sessionStorage can throw in some privacy modes - the redirect still works, /app/ just
      // shows its normal checking loader in that case.
    }
    window.location.replace('/app/');
  },
  // Defense in depth, not load-bearing: index.html's own inline head script is what normally
  // prevents a former member from ever reaching this page with a stale hint still set (it redirects
  // before this script even loads). This just cleans up the rare case where that didn't happen
  // (hint missing/expired already) but the server-verified check still comes back negative.
  onSignedOut: () => clearMemberRedirectHint(),
  onForbidden: () => clearMemberRedirectHint(),
});
