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
  document.getElementById('login-forbidden').hidden = true;
  document.getElementById('register-section').hidden = false;
}

// A signed-in Google account that isn't a Bractwo member (403 from whoamiPath) has nothing to
// do on this page - /zgloszenie/ already handles that identity correctly via its own
// allowlist-free /membership/whoami check, so send them straight there rather than leaving them
// stuck on a page offering to sign in again with the same account.
const FORBIDDEN_REDIRECT_DELAY_MS = 1500;

function showForbidden() {
  document.getElementById('login-checking').hidden = true;
  document.getElementById('login-signin').hidden = true;
  document.getElementById('login-signed-in').hidden = true;
  document.getElementById('register-section').hidden = true;
  document.getElementById('login-forbidden').hidden = false;
  setTimeout(() => {
    window.location.href = '/zgloszenie/';
  }, FORBIDDEN_REDIRECT_DELAY_MS);
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: showSignedIn,
  onSignedOut: showSignIn,
  onForbidden: showForbidden,
});
