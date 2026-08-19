/**
 * Gates the "Wrzucam swoje zdjęcie" link behind sign-in: it stays hidden until the visitor
 * signs in AND turns out to be a kruki Google Group member (GET /wojownicy-upload/whoami).
 * Deliberately silent either way once resolved - signed in but not a member just means the
 * link never appears, no explanation of which group is required.
 */
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
