/**
 * Plain Google sign-in, no privilege gate of its own - this page just confirms "you're signed
 * in as X"; every actual privileged action elsewhere on the site (admin panel, Wrzucam swoje
 * zdjęcie, gallery uploads) independently re-verifies the resulting session server-side against
 * its own allowlist regardless of what happens here. Uses onIdentity (not onSignedIn/onForbidden)
 * precisely because there's no allowlist to wait on - it should greet any Google account, member
 * or not, the moment a credential comes back, regardless of whether the session exchange behind
 * it (which does require kruki-group membership) succeeds.
 */
function showSignedIn(payload) {
  document.getElementById('login-signin').hidden = true;
  document.getElementById('login-signed-in-email').textContent = payload.email;
  document.getElementById('login-signed-in').hidden = false;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  onIdentity: showSignedIn,
});

/**
 * "Zarejestruj się" only makes sense for someone who isn't a member yet - hide it once the
 * kruki Google Group membership check (same one gating Wrzucam swoje zdjęcie/Zasady Bractwa/
 * Poradnik Walki) actually confirms membership, not just "signed in with some Google account"
 * (onIdentity above fires for any account, member or not - that's the wrong signal here, since
 * a non-member signing in with their own Google account still needs these instructions).
 */
initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => {
    document.getElementById('register-section').hidden = true;
  },
  onForbidden: () => {
    document.getElementById('register-section').hidden = false;
  },
});
