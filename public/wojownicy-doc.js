/**
 * Shared behavior for the Wojownicy-only "live from a Google Doc" pages (Zasady Bractwa,
 * Poradnik Walki) - each page sets `const DOC_KEY` before loading this script, matching one of
 * the keys in upload-service's config.ts wojownicyDocs map. Gated by the same kruki Google
 * Group membership as "Wrzucam swoje zdjęcie" (GET /wojownicy-upload/whoami); content itself
 * comes from GET /wojownicy-docs?key=... once signed in - never checked into the repo, always
 * fetched live. Sign-in happens on /logowanie/, not here - this page only reacts to whatever
 * state auth.js/nav.js already established (or restored from an earlier page).
 */
function showSignedOut() {
  document.getElementById('doc-signin').hidden = false;
  document.getElementById('doc-forbidden').hidden = true;
  document.getElementById('doc-content').hidden = true;
}

function showForbidden() {
  document.getElementById('doc-signin').hidden = true;
  document.getElementById('doc-forbidden').hidden = false;
  document.getElementById('doc-content').hidden = true;
}

function showReauth() {
  document.getElementById('doc-reauth').hidden = false;
}

function hideReauth() {
  document.getElementById('doc-reauth').hidden = true;
}

async function showContent() {
  document.getElementById('doc-signin').hidden = true;
  document.getElementById('doc-forbidden').hidden = true;
  try {
    const { html } = await apiFetch(`/wojownicy-docs?key=${encodeURIComponent(DOC_KEY)}`, { method: 'GET' }, showReauth, hideReauth);
    const contentEl = document.getElementById('doc-content');
    contentEl.innerHTML = html;
    contentEl.hidden = false;
  } catch (err) {
    const errorEl = document.getElementById('doc-error');
    errorEl.textContent = `Błąd: ${err.message}`;
    errorEl.hidden = false;
  }
}

if (!isIdTokenValid()) {
  showSignedOut();
}

initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => showContent(),
  onForbidden: () => showForbidden(),
});
