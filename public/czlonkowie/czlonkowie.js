/**
 * Lista Członków (KRKG-0045) - member directory. Sourced from GET /members/directory, which
 * enumerates the live kruki Google Group allowlist joined with members/{email} profile data, so
 * every member with site access is listed - including someone who's never filled in a profile,
 * shown here with an em dash instead of being missing from the table entirely. KRKG-0087: accountless
 * people (who have no account and are not on the allowlist) are unioned in from GET
 * /lista-wyjazdowa/roster's person rows, so this page lists every person, not just members.
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

// Status (categoryId) shown two ways with the same pill: wrapping the display name itself (KRKG-0057) and,
// as its own dedicated Status column (KRKG bugfix), a standalone badge. KRKG-0087: both are rendered
// by shared/person-pill.js's personPillHtml, which also carries the "osoba bez konta" marker for
// accountless people - the Status column passes no accountless flag, since the marker belongs on the
// person's name pill only, not on a bare category badge. Spis Ludności is read-only (KRKG-0063), so
// this has no sync-on-change counterpart.

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
let filterText = '';

function cell(value) {
  return value ? escapeHtml(value) : EMPTY;
}

function sortValue(member) {
  // KRKG-0087: an accountless person has no e-mail, so every non-name column is coalesced to ''
  // rather than leaving a null to stringify as "null" in a sort comparison.
  return sortState.key === 'displayName' ? displayName(member) : (member[sortState.key] ?? '');
}

// Default/Sekcja-column sort (KRKG-0051): grouped by section, alphabetical within each - see the
// sortState.key === 'sectionLabel' special case in renderTable's comparator below. Click-to-sort
// wiring itself (aria-sort, toggling asc/desc, which header is active) lives in
// shared/sortable-table.js - every dense table on the site uses the same one now.
const sortState = initSortableTable(document.getElementById('czl-table'), {
  defaultKey: 'sectionLabel',
  onChange: renderTable,
});

function renderTable() {
  const needle = filterText.trim().toLocaleLowerCase('pl');
  const filtered = !needle
    ? members
    : members.filter((m) =>
        [m.lastName, m.firstName, m.nickname, m.sectionLabel, m.categoryLabel, m.email].some((v) =>
          (v ?? '').toString().toLocaleLowerCase('pl').includes(needle),
        ),
      );
  const sorted = [...filtered].sort((a, b) => {
    const cmp = compareValues(sortValue(a), sortValue(b), sortState.dir);
    // Sorting by Sekcja ties every member in the same section - break the tie alphabetically by
    // Nazwisko (not the displayed ksywka/imię) instead of leaving it at the server's arbitrary
    // order, so "grouped by section, A-Z by surname within it" is what both the default view and
    // an explicit click on the Sekcja header show.
    if (cmp === 0 && sortState.key === 'sectionLabel') {
      return compareValues(a.lastName ?? '', b.lastName ?? '', sortState.dir);
    }
    return cmp;
  });

  const tbody = document.getElementById('czl-table-body');
  tbody.replaceChildren();
  for (const m of sorted) {
    const row = document.createElement('tr');
    row.dataset.section = m.sectionId ?? '';
    // Display name gets its own colored pill for Typ (KRKG-0057), rendered by shared/person-pill.js
    // so an accountless person also carries the "osoba bez konta" marker; the full name remains
    // available in the profile drawer instead of taking space in this compact directory table.
    const namePill = personPillHtml({
      name: displayName(m) || EMPTY,
      categoryId: m.categoryId,
      categoryLabel: m.categoryLabel,
      accountless: m.accountless === true,
      extraClass: displayName(m) ? undefined : 'czl-empty',
      subline: personSubline(m),
    });
    // KRKG-0087: an accountless person has no e-mail, so their pill opens the shared drawer
    // through the person-keyed endpoint (data-person-id); a member's opens it by e-mail.
    const nameCell = m.accountless
      ? `<button type="button" class="profile-trigger" data-profile-trigger data-person-id="${escapeAttr(m.personId)}">
          ${namePill}
        </button>`
      : `<button type="button" class="profile-trigger" data-profile-trigger data-email="${escapeAttr(m.personId)}">
          ${namePill}
        </button>
        <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${escapeAttr(m.personId)}" aria-label="Pokaż profil" title="Pokaż profil">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        </button>`;
    const statusPill = personPillHtml({
      name: m.categoryLabel || 'Brak statusu',
      categoryId: m.categoryId,
      categoryLabel: m.categoryLabel,
      accountless: false,
      extraClass: m.categoryLabel ? undefined : 'czl-empty',
      mode: 'category-label',
    });
    row.innerHTML = `
      <td class="czl-section-cell" title="${escapeAttr(m.sectionLabel || 'Brak sekcji')}">${m.sectionId ? escapeHtml(sectionAbbr(m.sectionId)) : EMPTY}</td>
      <td>
        ${nameCell}
      </td>
      <td>${statusPill}</td>
      <td>${cell(m.email)}</td>
    `;
    tbody.append(row);
  }

  document.getElementById('czl-count').textContent =
    filtered.length === members.length
      ? `Liczba członków: ${members.length}`
      : `Liczba członków: ${filtered.length} / ${members.length}`;
}

document.getElementById('czl-filter').addEventListener('input', (e) => {
  filterText = e.target.value;
  renderTable();
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
      // KRKG-0087: the directory is allowlist members only, so accountless people (who have no
      // account and are not on the allowlist) come from the roster's person rows. Lookup lists
      // resolve their section/category labels the same way /members/directory already does for
      // members, so both sources render through one identical row template.
      const [{ members: directoryMembers }, { roster }, lookupLists] = await Promise.all([
        apiFetch('/members/directory', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
      ]);
      const sectionLabelById = new Map((lookupLists.sections ?? []).map((s) => [s.id, s.label]));
      const categoryLabelById = new Map((lookupLists.categories ?? []).map((c) => [c.id, c.label]));
      const memberRows = directoryMembers.map((m) => ({ ...m, personId: m.email, accountless: false }));
      const personRows = roster
        .filter((person) => person.accountless)
        .map((person) => ({
          personId: person.personId,
          email: null,
          accountless: true,
          lastName: person.lastName,
          firstName: person.firstName,
          nickname: person.nickname,
          sectionId: person.sectionId,
          sectionLabel: person.sectionId ? (sectionLabelById.get(person.sectionId) ?? person.sectionId) : null,
          categoryId: person.categoryId,
          categoryLabel: person.categoryId ? (categoryLabelById.get(person.categoryId) ?? person.categoryId) : null,
        }));
      members = [...memberRows, ...personRows];
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
