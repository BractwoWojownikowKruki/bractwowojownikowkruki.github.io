/**
 * Lista wyjazdowa - placeholder landing page (Plan A, KRKG-0037 follow-up).
 *
 * The real content (event browsing/sign-up, design.md §8) is a later plan, not built yet. This
 * page exists now purely so "Lista wyjazdowa" has its own member-gated nav entry and URL,
 * distinct from "Mój profil" (/profil/, the actual profile form) - same panel-switch gating
 * pattern as that page, minus the form.
 */

const panels = {
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
  comingSoon: document.getElementById('coming-soon-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

showOnly(panels.signedOut);

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => showOnly(panels.comingSoon),
  onForbidden: () => showOnly(panels.forbidden),
});
