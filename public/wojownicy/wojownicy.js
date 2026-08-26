/**
 * Gates the "Wrzucam swoje zdjęcie" link behind sign-in: it stays hidden until the visitor
 * signs in AND turns out to be a kruki Google Group member (GET /wojownicy-upload/whoami).
 * Deliberately silent either way once resolved - signed in but not a member just means the
 * link never appears, no explanation of which group is required.
 *
 * #upload-signin starts hidden (not shown by default) so a visitor who's already signed in
 * from an earlier page - auth.js restores that session, but re-checking it here is still an
 * async round trip, and this particular check can be slow (whoamiPath is backed by an Apps
 * Script Web App reading live Google Group membership, which has a real cold-start delay) -
 * never sees a misleading "Zaloguj się" while the check is still pending. Only shown if we
 * can tell, synchronously, that there's no restorable session to check in the first place.
 */
if (!isIdTokenValid()) {
  document.getElementById('upload-signin').hidden = false;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => {
    document.getElementById('upload-signin').hidden = true;
    document.getElementById('wrzuc-link').hidden = false;
  },
  onForbidden: () => {
    document.getElementById('upload-signin').hidden = true;
  },
});
