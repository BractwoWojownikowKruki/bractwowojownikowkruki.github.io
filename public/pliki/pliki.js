/**
 * Protected member-zone Pliki page (KRKG-0076). Thin wiring only - same panel-swap pattern as
 * audyt.js/skladki.js. Lists member-added file links as tiles, lets a signed-in member add or
 * delete their own via the /files HTTP contract (Batch 2), and confirms every mutation through
 * the shared MutationFeedback.confirmed() UX used site-wide.
 */
const panels = {
  checking: document.getElementById('pliki-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
  document.getElementById('main-content').hidden = panel !== null;
}

showOnly(panels.checking);

const DOC_TYPE_ICONS = {
  googleDoc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  googleSheet: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line><line x1="12" y1="13" x2="12" y2="21"></line></svg>',
  googleDrive: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  office: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path></svg>',
  generic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('pl-PL', { year: 'numeric', month: 'long', day: 'numeric' });
}

const OPEN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

// Populated once per sign-in from GET /members/directory (email -> {nickname, fullName, email}),
// the same roster endpoint czlonkowie.js uses - GET /files only returns addedByEmail, not a
// display name, so the badge needs this to show a real name (nickname/imię i nazwisko) instead of
// a raw email fragment, matching every other member badge on the site (display-name.js's
// displayName()). A member briefly missing from the roster (e.g. hidden) falls back to a bare
// { email } stub, which displayName() itself reduces to the email's local part.
let memberByEmail = new Map();

function fileTileHtml(file) {
  const emailAttr = escapeHtml(file.addedByEmail);
  const member = memberByEmail.get(file.addedByEmail) || { email: file.addedByEmail };
  const deleteButton = file.canDelete
    ? `<button type="button" class="pliki-tile-delete" data-delete-id="${escapeHtml(file.id)}" aria-label="Usuń plik">✕</button>`
    : '';
  return `
    <article class="pliki-tile" data-file-id="${escapeHtml(file.id)}">
      ${deleteButton}
      <div class="pliki-tile-icon">${DOC_TYPE_ICONS[file.docType] || DOC_TYPE_ICONS.generic}</div>
      <h3 class="pliki-tile-name">${escapeHtml(file.name)}</h3>
      ${file.description ? `<p class="pliki-tile-description">${escapeHtml(file.description)}</p>` : ''}
      <div class="pliki-tile-meta">
        <span>${formatDate(file.addedAt)}</span>
        <button type="button" class="profile-trigger" data-profile-trigger data-email="${emailAttr}">
          <span class="category-name-pill" data-category="${escapeHtml(member.categoryId ?? '')}" title="${escapeHtml(member.categoryLabel ?? '')}">${escapeHtml(displayName(member))}</span>
        </button>
      </div>
      <a class="btn-drive-action pliki-tile-open" href="${escapeHtml(file.url)}" target="_blank" rel="noopener">${OPEN_ICON}Otwórz</a>
    </article>
  `;
}

async function loadFiles() {
  const listEl = document.getElementById('pliki-list');
  const { files } = await apiFetch('/files', { method: 'GET' });
  listEl.innerHTML = files.length
    ? files.map(fileTileHtml).join('')
    : '<p class="pliki-empty">Nikt jeszcze nie dodał żadnego pliku.</p>';
}

function wireAddForm() {
  const toggle = document.getElementById('pliki-add-toggle');
  const cancel = document.getElementById('pliki-add-cancel');
  const form = document.getElementById('pliki-add-form');
  const submitButton = document.getElementById('pliki-add-submit');
  const errorEl = document.getElementById('pliki-add-error');

  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) document.getElementById('pliki-add-url').focus();
  });
  cancel.addEventListener('click', () => {
    form.reset();
    form.hidden = true;
    errorEl.hidden = true;
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorEl.hidden = true;
    const url = document.getElementById('pliki-add-url').value.trim();
    const description = document.getElementById('pliki-add-description').value.trim();
    try {
      await window.MutationFeedback.confirmed({
        execute: () => apiFetch('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, description }) }),
        apply: async () => {
          form.reset();
          form.hidden = true;
          await loadFiles();
        },
        refreshFragment: () => loadFiles(),
        // Anchor on the always-visible header toggle, not submitButton: apply() hides #pliki-add-form
        // (and submitButton with it), which would bury the checkmark in a hidden subtree.
        control: document.getElementById('pliki-add-toggle'),
        viewRoot: document.getElementById('pliki-list'),
      });
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

function wireDeleteButtons() {
  document.getElementById('pliki-list').addEventListener('click', async e => {
    const button = e.target.closest('[data-delete-id]');
    if (!button) return;
    if (!window.confirm('Czy na pewno chcesz usunąć ten plik?')) return;
    try {
      await window.MutationFeedback.confirmed({
        execute: () => apiFetch(`/files?id=${encodeURIComponent(button.dataset.deleteId)}`, { method: 'DELETE' }),
        apply: async () => { await loadFiles(); },
        refreshFragment: () => loadFiles(),
        // Anchor on the always-visible header toggle, not the clicked button: apply() calls
        // loadFiles(), which replaces #pliki-list's innerHTML and detaches the clicked button,
        // which made MutationFeedback throw "anchor is no longer connected" on every successful delete.
        control: document.getElementById('pliki-add-toggle'),
        viewRoot: document.getElementById('pliki-list'),
      });
    } catch (err) {
      window.alert(`Nie udało się usunąć pliku: ${err.message}`);
      // Refresh the list even on failure: if the delete failed because someone else already
      // removed the file (404), the stale tile would otherwise linger with a dead delete button.
      await loadFiles();
    }
  });
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    showOnly(null);
    wireAddForm();
    wireDeleteButtons();
    try {
      const { members } = await apiFetch('/members/directory', { method: 'GET' });
      memberByEmail = new Map(members.map(m => [m.email, m]));
    } catch (err) {
      // Non-fatal: fileTileHtml() falls back to a bare { email } stub per file, which still
      // renders a usable (if less friendly) badge - a roster hiccup shouldn't block the page.
    }
    try {
      await loadFiles();
    } catch (err) {
      document.getElementById('pliki-list').innerHTML = '<p class="pliki-empty">Nie udało się wczytać plików.</p>';
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
