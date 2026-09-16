/**
 * Panel (/app/) - member dashboard. This page's own initGoogleSignIn call handles ONLY page-level
 * gating (design.md §3a) - it is intentionally independent of nav.js's own auth wiring, which
 * only drives the shared nav/sidebar menu. No shared cross-page auth-state module exists in this
 * repo; every member-gated page wires its own listener, same as lista-wyjazdowa/profil/pliki.
 */

const panels = {
  checking: document.getElementById('app-checking'),
  signedOut: document.getElementById('app-signed-out-panel'),
  forbidden: document.getElementById('app-forbidden-panel'),
  panel: document.getElementById('app-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

showOnly(panels.checking);

function showReauth() {}
function hideReauth() {}

initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => {
    showOnly(panels.panel);
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
