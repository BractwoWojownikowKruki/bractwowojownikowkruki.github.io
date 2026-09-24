// Thin wiring only (plan.md "two shells, one shared module") - the complete administrator
// shell mounts AuditView against /admin/audyt with scope: admin, plus the diagnostics section
// above (administrator-only, never contextual member history - implementation-contract.md).
// showReauth/hideReauth/escapeHtml/formatDateTime come from ../admin-shared.js.
//
// /admin/audyt/whoami gates this shell - its own endpoint, not /admin/members/whoami (which
// is admin-or-hovding only and gates the very different, broader Zarządzanie ludźmi page):
// an accountant-only viewer must pass this gate to reach the page at all, restricted server-
// side to the 'dues' category once they're in (resolveAdminAuditAuth, server.ts).
//
// Extracted from an inline <script> (KRKG-0108, so the page can carry a script-src Content-
// Security-Policy) - unchanged otherwise.
function resourceHref(resource) {
  // Best-effort deep link back to the resource's own page (plan-addendum.md's "Diagnostics
  // remediation path" - link each row to its original resource page where feasible). Only
  // wired for kinds with an obvious canonical URL; anything else (settings, pending Drive
  // folders with no final id yet) has no working link and is shown as plain text.
  if (resource.kind === 'event') return `/lista-wyjazdowa/wyjazd/?eventId=${encodeURIComponent(resource.key.slice('event:'.length))}`;
  if (resource.kind === 'redirect') return `/admin/`;
  return null;
}

async function loadDiagnostics() {
  const panel = document.getElementById('diagnostics-panel');
  try {
    const { rows } = await apiFetch('/admin/audyt/diagnostics', { method: 'GET' }, showReauth, hideReauth);
    panel.hidden = false;
    const STATE_LABELS = { pending: 'Oczekuje', failed: 'Nieudana', requires_review: 'Wymaga przeglądu' };
    document.getElementById('diagnostics-content').innerHTML = rows.length
      ? rows
          .map(r => {
            const href = resourceHref(r.resource);
            const resourceCell = href
              ? `<a href="${escapeAttr(href)}">${escapeHtml(r.resource.display)}</a>`
              : escapeHtml(r.resource.display);
            return `
    <tr data-state="${escapeAttr(r.state)}" class="audyt-diagnostics-row">
      <td><code>${escapeHtml(r.correlationId)}</code></td>
      <td><span class="audyt-diagnostics-state audyt-diagnostics-state--${escapeAttr(r.state)}">${escapeHtml(STATE_LABELS[r.state] ?? r.state)}</span></td>
      <td>${escapeHtml(AuditView.actionLabel(r.action))}</td>
      <td>${resourceCell}</td>
      <td>${escapeHtml(r.actor.name || r.actor.email)}</td>
      <td>${escapeHtml(formatDateTime(r.startedAt))}</td>
      <td>${r.completedAt ? escapeHtml(formatDateTime(r.completedAt)) : '—'}</td>
    </tr>`;
          })
          .join('')
      : '<tr><td colspan="7" class="czl-empty">Brak operacji do przejrzenia.</td></tr>';
  } catch (err) {
    // The audit shell admits administrators and hovdings, while diagnostics are
    // administrator-only. Hide this panel when a hovding receives its expected 403.
    panel.hidden = true;
  }
}

initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/audyt/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    const resourceKey = new URLSearchParams(window.location.search).get('resourceKey') || undefined;
    const eventId = new URLSearchParams(window.location.search).get('eventId') || undefined;
    AuditView.mount(document.getElementById('audyt-container'), {
      apiBase: '/admin/audyt',
      scope: 'admin',
      initialFilters: resourceKey ? { resourceKey } : eventId ? { eventId } : undefined,
      showReauth,
      hideReauth,
    });
    loadDiagnostics();
  },
  onSignedOut: () => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = false;
  },
  onForbidden: () => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-forbidden').hidden = false;
  },
});
