/**
 * Plain Google sign-in, no privilege gate of its own - this page just confirms "you're signed
 * in as X"; every actual privileged action elsewhere on the site (admin panel, Wrzucam swoje
 * zdjęcie, gallery uploads) independently re-verifies the resulting token server-side against
 * its own allowlist regardless of what happens here. Uses onIdentity/onRestoredIdentity (not
 * onSignedIn/onForbidden) precisely because there's no allowlist to wait on - it should greet
 * any Google account, member or not, the moment a credential comes back.
 */
function showSignedIn(payload) {
  document.getElementById('login-signin').hidden = true;
  document.getElementById('login-signed-in-email').textContent = payload.email;
  document.getElementById('login-signed-in').hidden = false;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  onRestoredIdentity: showSignedIn,
  onIdentity: showSignedIn,
});
