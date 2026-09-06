/**
 * The login page begins in an explicitly unknown state: a HttpOnly session cookie cannot be
 * inspected in the browser, so only the member whoami endpoint decides whether to show a member
 * as signed in or offer the Google button. This avoids a misleading sign-in flash for a returning
 * member while keeping registration available to everyone not currently authorized.
 */
function showSignedIn(identity) {
  document.getElementById('login-checking').hidden = true;
  document.getElementById('login-signin').hidden = true;
  document.getElementById('login-signed-in-email').textContent = identity.email;
  document.getElementById('login-signed-in').hidden = false;
  document.getElementById('register-section').hidden = true;
}

function showSignIn() {
  document.getElementById('login-checking').hidden = true;
  document.getElementById('login-signin').hidden = false;
  document.getElementById('login-signed-in').hidden = true;
  document.getElementById('register-section').hidden = false;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: showSignedIn,
  onSignedOut: showSignIn,
  onForbidden: showSignIn,
});
