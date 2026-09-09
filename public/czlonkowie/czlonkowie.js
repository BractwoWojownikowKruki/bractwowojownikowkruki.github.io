/**
 * Lista Członków (KRKG-0045) - member directory. Sourced from GET /members/directory, which
 * enumerates the live kruki Google Group allowlist joined with members/{email} profile data, so
 * every member with site access is listed - including someone who's never filled in a profile,
 * shown here with an em dash instead of being missing from the table entirely.
 *
 * KRKG-0047 lets an accountant/admin fix another member's Imię i nazwisko/Ksywa/Sekcja directly
 * from this table - reuses the same PUT /lista-wyjazdowa/member endpoint as the self-service
 * "Mój profil" form, with ?memberEmail= naming the target (see server.ts's
 * handleListaWyjazdowaPutMember). KRKG-0049 replaced the original per-row Edytuj/Zapisz/Anuluj
 * flow with plain inline-editable fields that save on change - no edit mode to enter or leave.
 */

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Section/city color coding (KRKG-0051) - the colors themselves live in exactly one place,
// member-area.css's [data-section="..."] rules; this only ever emits the data-section attribute a
// CSS rule keys off, never a color value, so a section's color changes by editing one line there,
// nowhere else. The row itself (not just this pill) also carries data-section, for member-area.css's
// .czl-table tr[data-section] td:first-child left-accent rule - kept in sync on change for the
// editable case (see the czl-field change handler below).
function sectionPillHtml(sectionId, label) {
  return `<span class="section-pill" data-section="${escapeAttr(sectionId ?? '')}">${escapeHtml(label)}</span>`;
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
// Default/Sekcja-column sort (KRKG-0051): grouped by section, alphabetical within each - see the
// sortKey === 'sectionLabel' special case in renderTable's comparator below.
let sortKey = 'sectionLabel';
let sortDir = 'asc';
let filterText = '';

// Set from GET /lista-wyjazdowa/my-role, same accountant/admin gate as the Składki page's
// toggle/kwota controls - the server re-checks the role on every PUT regardless, this only
// controls whether the "Edytuj" action/column is offered at all.
let canManageSkladki = false;
let sections = [];

function cell(value) {
  return value ? escapeHtml(value) : EMPTY;
}

// A retired section (design.md §5, mirrors profil.js's selectableLookupItems) is withdrawn from
// *new* selection, but must still resolve for a member who already has it - offered only when
// currentSectionId matches, so re-saving that member doesn't silently blank/change their section.
function sectionOptions(currentSectionId) {
  const options = sections
    .filter((s) => !s.retired || s.id === currentSectionId)
    .map((s) => `<option value="${escapeAttr(s.id)}" ${s.id === currentSectionId ? 'selected' : ''}>${escapeHtml(s.label)}</option>`);
  // A sectionId with no matching lookupLists/sections entry at all (e.g. "nieznana", the
  // migration script's fallback for a member with no known section - see
  // migrate-existing-members.ts) would otherwise vanish from the dropdown entirely: the browser
  // then silently selects the first real option instead of "nieznana", and the next inline-field
  // save (KRKG-0049) would overwrite that member's actual sectionId with the wrong one. Shown
  // with the raw id as its own label, same convention as the admin panel's driveFolderId fallback
  // (KRKG-0037's known-gaps note) - never hide an unresolved reference.
  if (currentSectionId && !sections.some((s) => s.id === currentSectionId)) {
    options.unshift(`<option value="${escapeAttr(currentSectionId)}" selected>${escapeHtml(currentSectionId)}</option>`);
  }
  return options.join('');
}

function renderTable() {
  const needle = filterText.trim().toLocaleLowerCase('pl');
  const filtered = !needle
    ? members
    : members.filter((m) =>
        [m.fullName, m.nickname, m.sectionLabel, m.categoryLabel, m.email].some((v) =>
          (v ?? '').toString().toLocaleLowerCase('pl').includes(needle),
        ),
      );
  const sorted = [...filtered].sort((a, b) => {
    const av = (a[sortKey] ?? '').toString().toLocaleLowerCase('pl');
    const bv = (b[sortKey] ?? '').toString().toLocaleLowerCase('pl');
    const cmp = av.localeCompare(bv, 'pl');
    // Sorting by Sekcja ties every member in the same section - break the tie alphabetically by
    // name instead of leaving it at the server's arbitrary order, so "grouped by section, A-Z
    // within it" is what both the default view and an explicit click on the Sekcja header show.
    if (cmp === 0 && sortKey === 'sectionLabel') {
      const an = (a.fullName ?? '').toString().toLocaleLowerCase('pl');
      const bn = (b.fullName ?? '').toString().toLocaleLowerCase('pl');
      const nameCmp = an.localeCompare(bn, 'pl');
      return sortDir === 'asc' ? nameCmp : -nameCmp;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const tbody = document.getElementById('czl-table-body');
  tbody.replaceChildren();
  for (const m of sorted) {
    const row = document.createElement('tr');
    row.dataset.section = m.sectionId ?? '';
    // Imię i nazwisko + Ksywa share one cell, name above nickname below (KRKG-0053) - one fewer
    // column on a table that's already dense.
    const nameCell = canManageSkladki
      ? `<input type="text" class="czl-field" data-email="${escapeAttr(m.email)}" data-field="fullName" value="${escapeAttr(m.fullName ?? '')}" placeholder="Imię i nazwisko" />
         <input type="text" class="czl-field" data-email="${escapeAttr(m.email)}" data-field="nickname" value="${escapeAttr(m.nickname ?? '')}" placeholder="Ksywa" />`
      : `<span class="${m.fullName ? '' : 'czl-empty'}">${cell(m.fullName)}</span>
         <span class="czl-name-secondary ${m.nickname ? '' : 'czl-empty'}">${cell(m.nickname)}</span>`;
    const sectionCell = canManageSkladki
      ? `<select class="czl-field" data-email="${escapeAttr(m.email)}" data-field="sectionId">${sectionOptions(m.sectionId)}</select>`
      : (m.sectionLabel ? sectionPillHtml(m.sectionId, m.sectionLabel) : EMPTY);
    row.innerHTML = `
      <td><div class="czl-name-cell">${nameCell}</div></td>
      <td class="${!canManageSkladki && !m.sectionLabel ? 'czl-empty' : ''}">${sectionCell}</td>
      <td class="${m.categoryLabel ? '' : 'czl-empty'}">${cell(m.categoryLabel)}</td>
      <td>${escapeHtml(m.email)}</td>
    `;
    tbody.append(row);
  }

  document.getElementById('czl-count').textContent =
    filtered.length === members.length
      ? `Liczba członków: ${members.length}`
      : `Liczba członków: ${filtered.length} / ${members.length}`;

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

// Saves all 3 editable fields together (the endpoint takes them as one PUT, not per-field) using
// each field's *current* DOM value, not just the one that just changed - so editing fullName then
// tabbing to nickname sends the already-updated fullName along with it, not a stale copy. Doesn't
// call renderTable() on success: re-rendering would resort the table out from under whichever
// field the admin is about to edit next (e.g. sorted by "Imię i nazwisko" while renaming someone),
// so `members` is patched in place instead and the DOM is left exactly as the admin sees it.
async function saveMemberField(row, email) {
  const fullNameInput = row.querySelector('[data-field="fullName"]');
  const nicknameInput = row.querySelector('[data-field="nickname"]');
  const sectionSelect = row.querySelector('[data-field="sectionId"]');
  const fullName = fullNameInput.value.trim();
  const nickname = nicknameInput.value.trim();
  const sectionId = sectionSelect.value;
  try {
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
    const member = members.find((m) => m.email === email);
    if (member) {
      member.fullName = fullName || null;
      member.nickname = nickname || null;
      member.sectionId = sectionId;
      member.sectionLabel = sections.find((s) => s.id === sectionId)?.label ?? member.sectionLabel;
    }
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

document.getElementById('czl-table-body').addEventListener('change', (e) => {
  const field = e.target.closest('.czl-field');
  if (!field) return;
  const row = field.closest('tr');
  // The row's left accent updates immediately, before the save even resolves - it's a visual
  // echo of what's already selected on screen, not a reflection of saved state (the <select>
  // itself already shows that; a failed save doesn't revert its value either).
  if (field.dataset.field === 'sectionId') {
    row.dataset.section = field.value;
  }
  saveMemberField(row, field.dataset.email);
});

// Tapping a row highlights it gold (KRKG-0052) - touch devices have no hover state, so this is the
// only way to see which row you're currently reading/editing on mobile. Persists until another row
// is tapped, unlike :hover/:active which fade the instant you lift your finger.
document.getElementById('czl-table-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  document.querySelectorAll('#czl-table-body tr.czl-row-active').forEach((r) => r.classList.remove('czl-row-active'));
  row.classList.add('czl-row-active');
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
