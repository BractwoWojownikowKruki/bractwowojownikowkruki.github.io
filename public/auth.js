// Shared Google Sign-In + upload-service auth helpers, used by both the "Dodaj galerię" page
// (upload/register) and the main gallery page (gallery deletion). The two pages present
// sign-in state very differently - a persistent panel vs. an on-demand modal shown only when
// deleting a gallery - so each page supplies its own UI hooks rather than this module owning
// any DOM beyond the sign-in buttons themselves.
//
// KRKG-0036: session state now lives entirely in a first-party, HttpOnly __Host-session cookie
// on api.kruki.org - the browser sends/receives it automatically on every fetch below via
// credentials: "include". There is nothing here for this script to read, store, or restore:
// no localStorage token, no client-side expiry tracking. That's deliberate - it's exactly what
// closes the localStorage-token-is-XSS-extractable risk this story exists to fix. The one
// consequence worth naming: since this module can no longer answer "am I signed in?" locally,
// every page asks the server once on load (see initGoogleSignIn below) rather than painting an
// instant guess from a decoded token.
const UPLOAD_SERVICE_URL = 'https://api.kruki.org';
const GOOGLE_OAUTH_CLIENT_ID = '895090213384-cqac9v2tvmjhkkertjjj5q4h8qf41g3d.apps.googleusercontent.com';

let pendingReauth = null;
let pendingReauthHide = null;
// Google Identity Services only keeps ONE active initialize() config per page - calling it
// twice would silently replace the first caller's callback. So initialize() runs at most once
// (guarded by this flag) with a single shared callback that fans out to every registered
// listener below, each checking its own whoamiPath independently (e.g. the nav's "is this user
// an admin" check coexisting with a page's own "is this user an uploader" check).
let gisInitialized = false;
const signedInListeners = [];

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
}

// Exchanges a Google ID token for the first-party session cookie (POST /session/login). The raw
// token only ever lives in a local variable for the duration of this call and the one that calls
// it - never assigned to a module-level variable, stored, logged, or placed in a URL/error
// report (see design-v2.md Phase 1 point 1's hygiene requirement).
async function exchangeForSession(googleIdToken) {
  const res = await fetch(`${UPLOAD_SERVICE_URL}/session/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: googleIdToken }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function promptReauth(showReauthUI, hideReauthUI) {
  return new Promise(resolve => {
    pendingReauth = resolve;
    pendingReauthHide = hideReauthUI;
    showReauthUI();
  });
}

// credentials: "include" sends the session cookie automatically - no Authorization header, the
// browser manages the credential entirely, this code never sees it. A 401 means either no
// session at all, or (for a destructive action) a session past the step-up freshness window -
// either way the fix is the same from here: prompt a fresh Google sign-in and retry exactly
// once. This replaces the old proactive "is my locally-tracked token about to expire" check
// with a reactive one driven by what the server actually says, which is the only option once
// there's no local token to inspect - and is simpler besides.
async function apiFetch(path, options = {}, showReauthUI, hideReauthUI) {
  const doFetch = () => fetch(`${UPLOAD_SERVICE_URL}${path}`, { ...options, credentials: 'include' });
  let res = await doFetch();
  if (res.status === 401 && showReauthUI && hideReauthUI) {
    await promptReauth(showReauthUI, hideReauthUI);
    res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Ends the session on this device (design-v2.md Phase 1 point 10 - stateless by design, so this
// is not server-side revocation, just clearing the cookie here; a member being removed from the
// club is enforced separately, live, by the allowlist check on every privileged call). Reloads
// afterwards so every piece of signed-in UI across the page - nav avatar, member-only links,
// page-specific panels - resets through its own normal signed-out path instead of each needing
// a bespoke logout handler.
async function logout() {
  try {
    await fetch(`${UPLOAD_SERVICE_URL}/session/logout`, { method: 'POST', credentials: 'include' });
  } finally {
    window.location.reload();
  }
}

async function handleCredentialResponse(response) {
  const googleIdToken = response.credential;
  const payload = decodeJwtPayload(googleIdToken);

  if (pendingReauth) {
    // A step-up/reauth prompt needs the exchange to actually succeed before resolving the
    // paused caller - failing here should leave the prompt up, not resolve as if it worked.
    try {
      await exchangeForSession(googleIdToken);
    } catch {
      return;
    }
    const resolve = pendingReauth;
    pendingReauth = null;
    if (pendingReauthHide) {
      pendingReauthHide();
      pendingReauthHide = null;
    }
    resolve();
    return;
  }

  // Fresh, unprompted sign-in (a page's own button, not a reauth prompt). onIdentity fires here,
  // synchronously from the locally-decoded payload, independent of whether the exchange below
  // succeeds - for cosmetic UI with no allowlist of its own to wait on (e.g. /logowanie/, which
  // greets any Google account, member or not). Safe: nothing privileged ever depends on this,
  // only onSignedIn/onForbidden below (driven by the real server-verified exchange/whoami) does.
  for (const listener of signedInListeners) {
    listener.onIdentity?.(payload);
  }

  try {
    await exchangeForSession(googleIdToken);
  } catch {
    for (const listener of signedInListeners) {
      listener.onForbidden?.();
    }
    return;
  }

  for (const listener of signedInListeners) {
    if (!listener.onSignedIn && !listener.onForbidden) continue;
    try {
      const identity = await apiFetch(listener.whoamiPath, { method: 'GET' });
      listener.onSignedIn?.(identity);
    } catch {
      listener.onForbidden?.();
    }
  }
}

// Wires up Google Identity Services for the current page. `buttonIds` are the DOM ids of every
// container GIS should render a sign-in button into (a page may need more than one, e.g. an
// initial sign-in button and a separate reauth-prompt button). `onSignedIn(identity)` and
// `onForbidden()` are optional, called with the server-verified result of `whoamiPath` -
// `identity` is whatever that endpoint returns (at least `{email}`, plus `name`/`picture` where
// available). Safe to call more than once per page (see signedInListeners above) - each call
// independently verifies its own whoamiPath against the one shared session cookie.
//
// `onIdentity(payload)` is different: it fires on every *fresh* sign-in (not a reauth prompt),
// synchronously from the locally-decoded Google JWT, before/regardless of whether the session
// exchange behind it succeeds. For a page with no privilege gate of its own (e.g. /logowanie/,
// which just wants to greet "Zalogowano jako ..." for any Google account, member or not) this is
// the only callback needed - it never waits on or depends on any allowlist. A forged payload
// here can't grant anything, since every actual privileged action still goes through
// onSignedIn/onForbidden's server-verified check.
//
// There is no "restored session" fast path anymore (see this file's top comment) - every
// onSignedIn/onForbidden call asks the server once, on load, via `whoamiPath`. That's a real
// trade-off: this can take a real 1-3s+ (a cold Cloud Run instance, or a slow allowlist check -
// see the Apps Script allowlist comment in upload-service/src/allowlist.ts), so purely cosmetic
// UI (the nav avatar) pays that same latency now instead of painting instantly from a locally-
// decoded token. What's gone in exchange is the hourly Google reauth popup this whole redesign
// exists to remove - sessions now last up to 14 days sliding, so this one-time-per-page-load
// check is a fair trade.
function initGoogleSignIn({ buttonIds, onSignedIn, onForbidden, onIdentity, whoamiPath = '/whoami', buttonConfig = {} }) {
  signedInListeners.push({ whoamiPath, onSignedIn, onForbidden, onIdentity });

  if (onSignedIn || onForbidden) {
    apiFetch(whoamiPath, { method: 'GET' })
      .then(identity => onSignedIn?.(identity))
      .catch(() => onForbidden?.());
  }

  function render() {
    if (!window.google?.accounts?.id) return;
    if (!gisInitialized) {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        callback: handleCredentialResponse,
      });
      gisInitialized = true;
    }
    const config = { type: 'standard', text: 'signin_with', locale: 'pl', ...buttonConfig };
    for (const id of buttonIds) {
      const el = document.getElementById(id);
      if (el) {
        window.google.accounts.id.renderButton(el, config);
      }
    }
  }

  // The GSI <script> tag loads with `async`, so it can finish (and even fire its own onload)
  // either before or after this script has run - there's no reliable single event to hang this
  // on in either direction. Polling briefly from here works regardless of which one wins the
  // race: it doesn't depend on GSI calling back into us, and it doesn't require GSI's own load
  // event to fire after this file has already been parsed.
  (function waitForGoogleIdentityServices(attemptsRemaining) {
    if (window.google?.accounts?.id) {
      render();
      return;
    }
    if (attemptsRemaining <= 0) return;
    setTimeout(() => waitForGoogleIdentityServices(attemptsRemaining - 1), 50);
  })(100);
}
