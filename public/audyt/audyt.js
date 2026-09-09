/**
 * Protected member-zone Historia page (KRKG-0050 batch 5/6). Thin wiring only - every Historia
 * link across the site (◷ Historia on a Wyjazd, gallery, Składki row, ...) lands here with its
 * resourceKey pre-set as a query param; the shared module (../shared/audit-view.js) does the
 * actual filtering/table/drawer work against `/audyt` (member scope - never `/admin/audyt`).
 * Same panel-swap pattern as wyjazd.js/skladki.js.
 */
const panels = {
  checking: document.getElementById('lw-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
  document.getElementById('main-content').hidden = panel !== null;
}

showOnly(panels.checking);

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: () => {
    showOnly(null);
    const resourceKey = new URLSearchParams(window.location.search).get('resourceKey') || undefined;
    AuditView.mount(document.getElementById('audyt-container'), {
      apiBase: '/audyt',
      scope: 'member',
      initialFilters: resourceKey ? { resourceKey } : undefined,
    });
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
