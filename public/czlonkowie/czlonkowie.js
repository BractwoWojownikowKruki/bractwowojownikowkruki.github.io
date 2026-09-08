/**
 * Lista Członków (KRKG-0045) - member directory. Sourced from GET /members/directory, which
 * enumerates the live kruki Google Group allowlist joined with members/{email} profile data, so
 * every member with site access is listed - including someone who's never filled in a profile,
 * shown here with an em dash instead of being missing from the table entirely.
 *
 * KRKG-0047 adds an accountant/admin-only "Edytuj" action per row, letting them fix another
 * member's Imię i nazwisko/Ksywa/Sekcja - reuses the same PUT /lista-wyjazdowa/member endpoint as
 * the self-service "Mój profil" form, with ?memberEmail= naming the target (see server.ts's
 * handleListaWyjazdowaPutMember).
 */

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
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
let filterText = '';

// Set from GET /lista-wyjazdowa/my-role, same accountant/admin gate as the Składki page's
// toggle/kwota controls - the server re-checks the role on every PUT regardless, this only
// controls whether the "Edytuj" action/column is offered at all.
let canManageSkladki = false;
let sections = [];
// Email of the row currently expanded into an edit form, or null - only one row edits at a time.
let editingEmail = null;

function cell(value) {
  return value ? escapeHtml(value) : EMPTY;
}

// A retired section (design.md §5, mirrors profil.js's selectableLookupItems) is withdrawn from
// *new* selection, but must still resolve for a member who already has it - offered only when
// currentSectionId matches, so re-saving that member doesn't silently blank/change their section.
function sectionOptions(currentSectionId) {
  return sections
    .filter((s) => !s.retired || s.id === currentSectionId)
    .map((s) => `<option value="${escapeAttr(s.id)}" ${s.id === currentSectionId ? 'selected' : ''}>${escapeHtml(s.label)}</option>`)
    .join('');
}

function renderEditRow(member) {
  const row = document.createElement('tr');
  row.className = 'czl-edit-row';
  row.innerHTML = `
    <td><input type="text" class="czl-edit-fullname" value="${escapeAttr(member.fullName ?? '')}" placeholder="Imię i nazwisko" /></td>
    <td><input type="text" class="czl-edit-nickname" value="${escapeAttr(member.nickname ?? '')}" placeholder="Ksywa" /></td>
    <td><select class="czl-edit-section">${sectionOptions(member.sectionId)}</select></td>
    <td>${escapeHtml(member.email)}</td>
    <td>
      <button type="button" class="czl-edit-save" data-email="${escapeAttr(member.email)}">Zapisz</button>
      <button type="button" class="czl-edit-cancel">Anuluj</button>
      <p class="czl-edit-error" hidden></p>
    </td>
  `;
  return row;
}

function renderTable() {
  const needle = filterText.trim().toLocaleLowerCase('pl');
  const filtered = !needle
    ? members
    : members.filter((m) =>
        [m.fullName, m.nickname, m.sectionLabel, m.email].some((v) =>
          (v ?? '').toString().toLocaleLowerCase('pl').includes(needle),
        ),
      );
  const sorted = [...filtered].sort((a, b) => {
    const av = (a[sortKey] ?? '').toString().toLocaleLowerCase('pl');
    const bv = (b[sortKey] ?? '').toString().toLocaleLowerCase('pl');
    const cmp = av.localeCompare(bv, 'pl');
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const tbody = document.getElementById('czl-table-body');
  tbody.replaceChildren();
  for (const m of sorted) {
    if (m.email === editingEmail) {
      tbody.append(renderEditRow(m));
      continue;
    }
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="${m.fullName ? '' : 'czl-empty'}">${cell(m.fullName)}</td>
      <td class="${m.nickname ? '' : 'czl-empty'}">${cell(m.nickname)}</td>
      <td class="${m.sectionLabel ? '' : 'czl-empty'}">${cell(m.sectionLabel)}</td>
      <td>${escapeHtml(m.email)}</td>
      ${canManageSkladki ? `<td><button type="button" class="czl-edit-start" data-email="${escapeAttr(m.email)}">Edytuj</button></td>` : ''}
    `;
    tbody.append(row);
  }

  document.getElementById('czl-count').textContent =
    filtered.length === members.length
      ? `Liczba członków: ${members.length}`
      : `Liczba członków: ${filtered.length} / ${members.length}`;
  document.getElementById('czl-actions-header').hidden = !canManageSkladki;

  document.querySelectorAll('#czl-table thead th[data-sort-key]').forEach((th) => {
    const isActive = th.dataset.sortKey === sortKey;
    th.setAttribute('aria-sort', isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

document.getElementById('czl-filter').addEventListener('input', (e) => {
  filterText = e.target.value;
  renderTable();
});

document.querySelectorAll('#czl-table thead th[data-sort-key]').forEach((th) => {
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

async function saveMemberEdit(email, row) {
  const errorEl = row.querySelector('.czl-edit-error');
  errorEl.hidden = true;
  try {
    const fullName = row.querySelector('.czl-edit-fullname').value.trim();
    const nickname = row.querySelector('.czl-edit-nickname').value.trim();
    const sectionId = row.querySelector('.czl-edit-section').value;
    await apiFetch(
      `/lista-wyjazdowa/member?memberEmail=${encodeURIComponent(email)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: fullName || null, nickname: nickname || null, sectionId }),
      },
      showReauth,
      hideReauth,
    );
    editingEmail = null;
    const { members: fetched } = await apiFetch('/members/directory', { method: 'GET' }, showReauth, hideReauth);
    members = fetched;
    renderTable();
  } catch (err) {
    errorEl.textContent = `Błąd: ${err.message}`;
    errorEl.hidden = false;
  }
}

document.getElementById('czl-table-body').addEventListener('click', (e) => {
  const startBtn = e.target.closest('.czl-edit-start');
  if (startBtn) {
    editingEmail = startBtn.dataset.email;
    renderTable();
    return;
  }
  const cancelBtn = e.target.closest('.czl-edit-cancel');
  if (cancelBtn) {
    editingEmail = null;
    renderTable();
    return;
  }
  const saveBtn = e.target.closest('.czl-edit-save');
  if (saveBtn) {
    saveMemberEdit(saveBtn.dataset.email, saveBtn.closest('tr'));
  }
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    try {
      const [{ members: fetched }, { canManageSkladki: role }, lookupLists] = await Promise.all([
        apiFetch('/members/directory', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
      ]);
      members = fetched;
      canManageSkladki = role;
      sections = lookupLists.sections ?? [];
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
