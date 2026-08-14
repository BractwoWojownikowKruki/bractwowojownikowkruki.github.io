// Shared Google Sign-In + upload-service auth helpers, used by both the "Dodaj galerię" page
// (upload/register) and the main gallery page (gallery deletion). The two pages present
// sign-in state very differently - a persistent panel vs. an on-demand modal shown only when
// deleting a gallery - so each page supplies its own UI hooks rather than this module owning
// any DOM beyond the sign-in buttons themselves.
const UPLOAD_SERVICE_URL = 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';
const GOOGLE_OAUTH_CLIENT_ID = '895090213384-cqac9v2tvmjhkkertjjj5q4h8qf41g3d.apps.googleusercontent.com';
// Refresh a little before the token's real expiry, not exactly at it, so an in-flight
// request never straddles the boundary between "was valid" and "just expired".
const ID_TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS = 30;

let idToken = null;
let idTokenExp = 0;
let pendingReauth = null;
let pendingReauthHide = null;

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
}

function isIdTokenValid() {
  return Boolean(idToken) && idTokenExp - ID_TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS > Date.now() / 1000;
}

// Pauses the caller and invokes showReauthUI() if the current Google ID token has expired, is
// about to, or was never obtained. Resolves (after calling hideReauthUI()) once a sign-in
// completes. Deliberately explicit/visible rather than a silent background refresh - Identity
// Services doesn't offer a reliable silent-refresh path across third-party-cookie-restricted
// browsers.
async function ensureFreshIdToken(showReauthUI, hideReauthUI) {
  if (isIdTokenValid()) return;
  pendingReauthHide = hideReauthUI;
  showReauthUI();
  await new Promise(resolve => { pendingReauth = resolve; });
}

async function apiFetch(path, options, showReauthUI, hideReauthUI) {
  await ensureFreshIdToken(showReauthUI, hideReauthUI);
  const res = await fetch(`${UPLOAD_SERVICE_URL}${path}`, {
    ...options,
    headers: { ...(options?.headers ?? {}), Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Wires up Google Identity Services for the current page. `buttonIds` are the DOM ids of every
// container GIS should render a sign-in button into (a page may need more than one, e.g. an
// initial sign-in button and a separate reauth-prompt button). `onSignedIn(payload)` and
// `onForbidden()` are optional and fire only after a genuine first sign-in - not one triggered
// by ensureFreshIdToken's reauth prompt, which just resolves the paused caller instead. Pages
// that only ever need reauth (nothing to proactively show on initial sign-in) can omit both.
function initGoogleSignIn({ buttonIds, onSignedIn, onForbidden }) {
  async function handleCredentialResponse(response) {
    idToken = response.credential;
    const payload = decodeJwtPayload(idToken);
    idTokenExp = payload.exp;

    if (pendingReauth) {
      const resolve = pendingReauth;
      pendingReauth = null;
      if (pendingReauthHide) {
        pendingReauthHide();
        pendingReauthHide = null;
      }
      resolve();
      return;
    }

    if (!onSignedIn && !onForbidden) return;
    try {
      await apiFetch('/whoami', { method: 'GET' }, () => {}, () => {});
      onSignedIn?.(payload);
    } catch {
      onForbidden?.();
    }
  }

  function render() {
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      callback: handleCredentialResponse,
    });
    for (const id of buttonIds) {
      const el = document.getElementById(id);
      if (el) {
        window.google.accounts.id.renderButton(el, { type: 'standard', text: 'signin_with', locale: 'pl' });
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
