/**
 * Gates the "Wrzucam swoje zdjęcie" nav link behind sign-in: it stays hidden until the visitor
 * signs in (via the nav's own Google button - this page has no sign-in button of its own) AND
 * turns out to be a kruki Google Group member (GET /wojownicy-upload/whoami). Deliberately
 * silent either way once resolved - signed in but not a member just means the link never
 * appears, no explanation of which group is required.
 *
 * Remembers the last confirmed membership result per email, so a returning member sees the
// upload link immediately (onRestoredIdentity, below) instead of waiting out the Apps Script
// check again on every single page load. Purely a perceived-speed optimization: the real
// upload endpoints still re-verify group membership server-side regardless of what this cache
// says, so a stale "true" here can't grant anything - onSignedIn/onForbidden always correct it
// once the real check resolves, a moment later.
const MEMBER_CACHE_KEY = 'kruki_wojownicy_member';

function loadCachedMembership(email) {
  try {
    const cached = JSON.parse(localStorage.getItem(MEMBER_CACHE_KEY));
    return cached?.email === email ? cached.isMember : null;
  } catch {
    return null;
  }
}

function saveCachedMembership(email, isMember) {
  try {
    localStorage.setItem(MEMBER_CACHE_KEY, JSON.stringify({ email, isMember }));
  } catch {
    // Storage can be unavailable (private browsing) - just means no optimistic guess next time.
  }
}

initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onRestoredIdentity: payload => {
    if (loadCachedMembership(payload.email) === true) {
      document.getElementById('wrzuc-link').hidden = false;
    }
  },
  onSignedIn: payload => {
    saveCachedMembership(payload.email, true);
    document.getElementById('wrzuc-link').hidden = false;
  },
  onForbidden: payload => {
    if (payload?.email) saveCachedMembership(payload.email, false);
    document.getElementById('wrzuc-link').hidden = true;
  },
});
