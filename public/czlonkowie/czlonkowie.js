/**
 * Lista Członków (KRKG-0045) - member directory. Sourced from GET /members/directory, which
 * enumerates the live kruki Google Group allowlist joined with members/{email} profile data, so
 * every member with site access is listed - including someone who's never filled in a profile,
 * shown here with an em dash instead of being missing from the table entirely.
 *
 * Read-only (KRKG-0063) - inline editing (KRKG-0047/0049's Imię i nazwisko/Ksywa/Sekcja fields,
 * saved via PUT /lista-wyjazdowa/member) was dropped in favor of Zarządzanie ludźmi as the one
 * place to actually edit a member's profile; this page is now purely a lookup/directory view.
 */

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// 3-letter Sekcja abbreviations (KRKG-0063) for the compact, sticky first column - a display-only
// convenience, not a second source of truth: sections/seed-lookup-lists.ts's fixed 6-id set is
// still where a section's real label (and member-area.css's colors, via --section-c) come from.
// Falls back to the id's own first 3 letters for anything not in this map (e.g. "nieznana"), same
// never-hide-an-unresolved-reference spirit as sectionId's own fallback further down.
const SECTION_ABBR = {
  bydgoszcz: 'BDG',
  czukcze: 'CZU',
  krakow: 'KRK',
  poznan: 'POZ',
  warszawa: 'WAW',
  wroclaw: 'WRO',
};
function sectionAbbr(sectionId) {
  return SECTION_ABBR[sectionId] ?? (sectionId ?? '').slice(0, 3).toUpperCase();
}

// Typ (categoryId) shown by wrapping the name itself in a colored outline pill, instead of its
// own column or a second pill next to the name (KRKG-0057) - never-a-color-value-in-JS
// convention, same as the section abbreviation above; the actual colors live in member-area.css's
// [data-category="..."] rules. extraClass carries czl-empty for an empty fullName, nothing
// otherwise. Spis Ludności is read-only (KRKG-0063), so this has no sync-on-change counterpart.
function categoryNamePillAttrs(categoryId, label, extraClass) {
  return `class="${extraClass} category-name-pill" data-category="${escapeAttr(categoryId ?? '')}" title="${escapeAttr(label || 'Brak typu')}"`;
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

function cell(value) {
  return value ? escapeHtml(value) : EMPTY;
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
    // Imię i nazwisko gets its own colored outline pill for Typ (KRKG-0057); Ksywa is its own
    // column (KRKG-0064) rather than sharing a cell (KRKG-0053's original stacked layout, dropped
    // now that this table has the room - it matches Zarządzanie ludźmi's own separate column).
    row.innerHTML = `
      <td class="czl-section-cell" title="${escapeAttr(m.sectionLabel || 'Brak sekcji')}">${m.sectionId ? escapeHtml(sectionAbbr(m.sectionId)) : EMPTY}</td>
      <td>
        <button type="button" class="profile-trigger" data-profile-trigger data-email="${escapeAttr(m.email)}">
          <span ${categoryNamePillAttrs(m.categoryId, m.categoryLabel, m.fullName ? '' : 'czl-empty')}>${cell(m.fullName)}</span>
        </button>
        <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${escapeAttr(m.email)}" aria-label="Pokaż profil" title="Pokaż profil">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        </button>
      </td>
      <td class="${m.nickname ? '' : 'czl-empty'}">${cell(m.nickname)}</td>
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
