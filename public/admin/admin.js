// Ogólne (KRKG-0049): cache refresh, live-Facebook post count, and redirects - everything in the
// admin panel that isn't membership or people management, which each moved to their own page/JS
// file (zgloszenia.js, zarzadzanie-ludzmi.js, publiczne-wizytowki.js). showReauth/hideReauth/
// escapeHtml/escapeAttr/sheetSyncStatusMessage come from admin-shared.js, loaded before this file.
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadFacebookSettings();
    loadRedirects();
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

document.getElementById('refresh-social-cache').addEventListener('click', async () => {
  const status = document.getElementById('refresh-social-cache-status');
  status.textContent = 'Odświeżanie...';
  try {
    await apiFetch('/admin/social-media/refresh', { method: 'POST' }, showReauth, hideReauth);
    status.textContent =
      'Cache serwera wyczyszczony - kolejne wczytanie strony głównej pobierze świeże posty (przeglądarka, która ma już zapisaną stronę we własnej pamięci podręcznej, może wymagać twardego odświeżenia).';
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

async function loadFacebookSettings() {
  try {
    const settings = await apiFetch('/admin/settings', { method: 'GET' }, showReauth, hideReauth);
    document.getElementById('facebook-live-count').value = settings.liveFetchPostCount;
  } catch (err) {
    document.getElementById('facebook-settings-status').textContent = `Błąd: ${err.message}`;
  }
}

document.getElementById('facebook-settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('facebook-settings-status');
  status.textContent = 'Zapisywanie...';
  try {
    const liveFetchPostCount = parseInt(document.getElementById('facebook-live-count').value, 10);
    await apiFetch(
      '/admin/settings',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liveFetchPostCount }) },
      showReauth,
      hideReauth,
    );
    status.textContent = 'Zapisano.';
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

async function loadRedirects() {
  const list = document.getElementById('redirects-list');
  list.textContent = 'Ładowanie...';
  try {
    const { redirects } = await apiFetch('/admin/redirects', { method: 'GET' }, showReauth, hideReauth);
    renderRedirectsList(redirects);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function renderRedirectsList(redirects) {
  const list = document.getElementById('redirects-list');
  if (!redirects.length) {
    list.innerHTML = '<p>Brak przekierowań.</p>';
    return;
  }
  list.innerHTML = redirects
    .map(
      r => `
    <div style="display:flex; gap:0.5rem; align-items:center; padding:0.4rem 0; border-bottom:1px solid var(--border);">
      <code>/${escapeHtml(r.path)}</code>
      <span>&rarr;</span>
      <span style="flex:1; overflow-wrap:anywhere;">${escapeHtml(r.target)}</span>
      <a class="audyt-history-link" href="/admin/audyt/?resourceKey=${encodeURIComponent(`redirect:${r.path}`)}">◷ Historia</a>
      <button class="delete-redirect" data-path="${escapeAttr(r.path)}" style="color:var(--accent);">Usuń</button>
    </div>`,
    )
    .join('');
}

document.getElementById('add-redirect-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('add-redirect-status');
  status.textContent = 'Zapisywanie...';
  const path = document.getElementById('redirect-path').value.trim().toLowerCase();
  const target = document.getElementById('redirect-target').value.trim();
  try {
    await apiFetch(
      '/admin/redirects',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, target }) },
      showReauth,
      hideReauth,
    );
    status.textContent = 'Dodano przekierowanie.';
    document.getElementById('add-redirect-form').reset();
    loadRedirects();
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

document.getElementById('redirects-list').addEventListener('click', async e => {
  const deleteBtn = e.target.closest('.delete-redirect');
  if (!deleteBtn) return;
  if (!window.confirm(`Na pewno usunąć przekierowanie /${deleteBtn.dataset.path}?`)) return;
  await apiFetch(`/admin/redirects?path=${encodeURIComponent(deleteBtn.dataset.path)}`, { method: 'DELETE' }, showReauth, hideReauth);
  loadRedirects();
});
