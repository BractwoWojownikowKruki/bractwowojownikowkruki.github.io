/**
 * / (index.html) only - redirects a confirmed signed-in member to /app/. Never loaded by
 * /aktualnosci/ (design.md §2's explicit exception) - that page must always show the feed
 * regardless of auth state, so it must not carry this script.
 */
initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: redirectToApp,
  // Defense in depth, not load-bearing: index.html's own inline head script is what normally
  // prevents a former member from ever reaching this page with a stale hint still set (it redirects
  // before this script even loads). This just cleans up the rare case where that didn't happen
  // (hint missing/expired already) but the server-verified check still comes back negative.
  onSignedOut: () => clearMemberRedirectHint(),
  onForbidden: () => clearMemberRedirectHint(),
});
