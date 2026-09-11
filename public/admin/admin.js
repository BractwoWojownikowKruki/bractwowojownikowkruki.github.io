// Ogólne (KRKG-0049): cache refresh, live-Facebook post count, and redirects - everything in the
// admin panel that isn't membership or people management, which each moved to their own page/JS
// file (zgloszenia.js, zarzadzanie-ludzmi.js, publiczne-wizytowki.js). showReauth/hideReauth/
// escapeHtml/escapeAttr/sheetSyncStatusMessage come from admin-shared.js, loaded before this file.

// Icon-only Historia button (.audyt-history-btn, style.css) - same path everywhere it appears
// site-wide (nav.js's 'history' icon, zarzadzanie-ludzmi/index.html, galerie/app.js, ...).
const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';
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
  const button = document.getElementById('refresh-social-cache');
  const status = document.getElementById('refresh-social-cache-status');
  status.textContent = 'Odświeżanie...';
  try {
    await window.MutationFeedback.confirmed({
      control: button,
      anchor: status,
      execute: () => apiFetch('/admin/social-media/refresh', { method: 'POST' }, showReauth, hideReauth),
      apply: () => { status.textContent = ''; },
      refreshFragment: async () => { status.textContent = ''; },
    });
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
    await window.MutationFeedback.confirmed({
      control: document.getElementById('facebook-live-count'),
      anchor: status,
      execute: () => apiFetch(
        '/admin/settings',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liveFetchPostCount }) },
        showReauth,
        hideReauth,
      ),
      apply: () => { status.textContent = ''; },
      refreshFragment: loadFacebookSettings,
    });
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
  list.innerHTML = redirects.map(redirectItemHtml).join('');
}

function redirectItemHtml(r) {
  return `
    <div style="display:flex; gap:0.5rem; align-items:center; padding:0.4rem 0; border-bottom:1px solid var(--border);">
      <code>/${escapeHtml(r.path)}</code>
      <span>&rarr;</span>
      <span style="flex:1; overflow-wrap:anywhere;">${escapeHtml(r.target)}</span>
      <a class="audyt-history-btn" href="/admin/audyt/?resourceKey=${encodeURIComponent(`redirect:${r.path}`)}" title="Historia" aria-label="Historia">${HISTORY_ICON}</a>
      <button id="${redirectFocusId(r.path)}" class="delete-redirect" data-path="${escapeAttr(r.path)}" style="color:var(--accent);">Usuń</button>
    </div>`;
}

function redirectFocusId(path) {
  return `redirect-${encodeURIComponent(path)}-delete`;
}

document.getElementById('add-redirect-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('add-redirect-status');
  status.textContent = 'Zapisywanie...';
  const path = document.getElementById('redirect-path').value.trim().toLowerCase();
  const target = document.getElementById('redirect-target').value.trim();
  try {
    await window.MutationFeedback.confirmed({
      control: document.getElementById('redirect-target'),
      anchor: status,
      execute: () => apiFetch(
        '/admin/redirects',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, target }) },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        document.getElementById('add-redirect-form').reset();
        const list = document.getElementById('redirects-list');
        list.querySelector('p')?.remove();
        list.insertAdjacentHTML('beforeend', redirectItemHtml({ path, target }));
        status.textContent = '';
      },
      viewRoot: list,
      refreshFragment: loadRedirects,
    });
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

document.getElementById('redirects-list').addEventListener('click', async e => {
  const deleteBtn = e.target.closest('.delete-redirect');
  if (!deleteBtn) return;
  if (!window.confirm(`Na pewno usunąć przekierowanie /${deleteBtn.dataset.path}?`)) return;
  try {
    const list = document.getElementById('redirects-list');
    await window.MutationFeedback.confirmed({
      control: deleteBtn,
      anchor: list,
      execute: () => apiFetch(`/admin/redirects?path=${encodeURIComponent(deleteBtn.dataset.path)}`, { method: 'DELETE' }, showReauth, hideReauth),
      apply: () => {
        deleteBtn.closest('div').remove();
        if (!list.querySelector('.delete-redirect')) list.innerHTML = '<p>Brak przekierowań.</p>';
      },
      viewRoot: list,
      refreshFragment: loadRedirects,
    });
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});
