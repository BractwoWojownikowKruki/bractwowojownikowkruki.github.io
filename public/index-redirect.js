/**
 * / (index.html) only - redirects a confirmed signed-in member to /app/. Never loaded by
 * /aktualnosci/ (design.md §2's explicit exception) - that page must always show the feed
 * regardless of auth state, so it must not carry this script.
 */
initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => {
    window.location.replace('/app/');
  },
});
