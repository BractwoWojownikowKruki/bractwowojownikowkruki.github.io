// Zgłoszenia (KRKG-0049): pending membership applications - approve/reject. Split out of the
// original single-page admin.js. showReauth/hideReauth/escapeHtml/escapeAttr/sheetSyncStatusMessage
// come from ../admin-shared.js, loaded before this file.
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadMembershipApplications();
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

// A pending application always leaves this list after either server-confirmed transition. Keeping
// that small DOM update local preserves the administrator's scroll position and nearby focus.
async function postMembershipTransition(row, email, transition) {
  const list = document.getElementById('membership-applications-list');
  let sheetSyncStatus;
  await window.MutationFeedback.confirmed({
    control: row.querySelector(`.${transition}-application`),
    anchor: list,
    execute: () => apiFetch(
      '/admin/members/transition',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, transition }) },
      showReauth,
      hideReauth,
    ).then(result => { sheetSyncStatus = result.sheetSyncStatus; }),
    apply: () => {
      row.remove();
      if (!list.querySelector('.membership-application')) list.innerHTML = '<p>Brak oczekujących zgłoszeń.</p>';
    },
    refreshFragment: loadMembershipApplications,
  });
  return sheetSyncStatus;
}

async function loadMembershipApplications() {
  const list = document.getElementById('membership-applications-list');
  list.textContent = 'Ładowanie...';
  try {
    const { members } = await apiFetch('/admin/members?status=pending', { method: 'GET' }, showReauth, hideReauth);
    renderMembershipApplications(members);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function renderMembershipApplications(members) {
  const list = document.getElementById('membership-applications-list');
  if (!members.length) {
    list.innerHTML = '<p>Brak oczekujących zgłoszeń.</p>';
    return;
  }
  list.innerHTML = members
    .map(
      m => `
    <div class="membership-application" data-email="${escapeAttr(m.email)}" style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; padding:0.5rem 0; border-bottom:1px solid var(--border);">
      <div style="flex:1; min-width:200px;">
        <strong>${escapeHtml(m.fullName)}</strong>${m.nickname ? ` (${escapeHtml(m.nickname)})` : ''}
        <br><span style="color:var(--text-muted);">${escapeHtml(m.email)} - ${escapeHtml(m.sectionId)}</span>
      </div>
      <button class="approve-application" style="color:var(--gold);">Zatwierdź</button>
      <button class="reject-application" style="color:var(--accent);">Odrzuć</button>
    </div>`,
    )
    .join('');
}

// try/catch here matters beyond the step-up 401 case handled by showReauth: without it, any
// other failure (network blip, 403 from a role change, 500) rejected silently - the confirm
// dialog closes and the click just looks like it did nothing.
document.getElementById('membership-applications-list').addEventListener('click', async e => {
  const row = e.target.closest('.membership-application');
  if (!row) return;
  const email = row.dataset.email;
  try {
    if (e.target.closest('.approve-application')) {
      const sheetSyncStatus = await postMembershipTransition(row, email, 'approve');
      const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
      if (sheetWarning) window.alert(sheetWarning);
    } else if (e.target.closest('.reject-application')) {
      if (!window.confirm(`Na pewno odrzucić zgłoszenie ${email}?`)) return;
      const sheetSyncStatus = await postMembershipTransition(row, email, 'reject');
      const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
      if (sheetWarning) window.alert(sheetWarning);
    }
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});
