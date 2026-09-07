/**
 * Lista Członków (KRKG-0045) - member directory. Sourced from GET /members/directory, which
 * enumerates the live kruki Google Group allowlist joined with members/{email} profile data, so
 * every member with site access is listed - including someone who's never filled in a profile,
 * shown here with an em dash instead of being missing from the table entirely.
 */

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const panels = {
  checking: document.getElementById('czl-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
  directory: document.getElementById('directory-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

showOnly(panels.checking);

function showReauth() {} // no reauth banner on this page yet - matches other read-only member pages
function hideReauth() {}

const EMPTY = '—';
let members = [];
let sortKey = 'email';
let sortDir = 'asc';

function cell(value) {
  return value ? escapeHtml(value) : EMPTY;
}

function renderTable() {
  const sorted = [...members].sort((a, b) => {
    const av = (a[sortKey] ?? '').toString().toLocaleLowerCase('pl');
    const bv = (b[sortKey] ?? '').toString().toLocaleLowerCase('pl');
    const cmp = av.localeCompare(bv, 'pl');
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const tbody = document.getElementById('czl-table-body');
  tbody.replaceChildren();
  for (const m of sorted) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="${m.fullName ? '' : 'czl-empty'}">${cell(m.fullName)}</td>
      <td class="${m.nickname ? '' : 'czl-empty'}">${cell(m.nickname)}</td>
      <td class="${m.sectionLabel ? '' : 'czl-empty'}">${cell(m.sectionLabel)}</td>
      <td>${escapeHtml(m.email)}</td>
    `;
    tbody.append(row);
  }

  document.getElementById('czl-count').textContent = `Liczba członków: ${members.length}`;

  document.querySelectorAll('#czl-table thead th').forEach((th) => {
    const isActive = th.dataset.sortKey === sortKey;
    th.setAttribute('aria-sort', isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

document.querySelectorAll('#czl-table thead th').forEach((th) => {
  th.querySelector('button').addEventListener('click', () => {
    const key = th.dataset.sortKey;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
    renderTable();
  });
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    try {
      const { members: fetched } = await apiFetch('/members/directory', { method: 'GET' }, showReauth, hideReauth);
      members = fetched;
      showOnly(panels.directory);
      renderTable();
    } catch (err) {
      showOnly(panels.directory);
      const errorEl = document.getElementById('directory-error');
      errorEl.textContent = `Nie udało się wczytać listy członków: ${err.message}`;
      errorEl.hidden = false;
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
