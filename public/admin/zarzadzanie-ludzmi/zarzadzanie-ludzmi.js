// Zarządzanie ludźmi (KRKG-0049): the members table (status, live filter, Drive-folder mapping,
// Zawieś/Usuń/Przywróć, and the new Rola column), plus the Sheets backup sync. Split out of the
// original single-page admin.js. showReauth/hideReauth/escapeHtml/escapeAttr/
// sheetSyncStatusMessage/formatDateTime come from ../admin-shared.js, loaded before this file.
// whoamiPath is this page's own /admin/members/whoami (not /admin/whoami like the other 3 admin
// pages) - it also accepts a Firestore 'hovding'/'admin' role, not just the admin allowlist, and
// reports isAdmin so a plain hovding never triggers the role-assignment-only fetches below
// (GET /admin/roles is still admin-only and would 403 for them).
let isAdminCaller = false;
// Wpisowe management needs requireSkladkiAccess (accountant/Firestore-admin role, or the env admin
// allowlist), same as the Lista Wyjazdowa Składki page - a plain hovding with neither must not
// see or use the new Wpisowe column, even though this page's own admin-or-hovding gate lets them
// in. Also requires the live kruki Google Group membership GET /lista-wyjazdowa/my-role itself
// gates on - an admin-allowlist account that isn't a club member gets caught by the try/catch
// below and simply doesn't see the column, same as it can't reach the Składki page either.
let canManageSkladki = false;
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/members/whoami',
  onSignedIn: async payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    isAdminCaller = payload.isAdmin === true;
    document.getElementById('membership-role-header').hidden = !isAdminCaller;
    // Admin-only (KRKG bugfix): a hovding manages member records but must not trigger the
    // Sheets backup sync or the Google Group drift check - both now also 403 server-side
    // (handleAdminMembersSynchronize/handleAdminMembersGroupSync use authenticateAdmin), this
    // just keeps the buttons from being shown at all.
    document.getElementById('membership-sheet-sync-section').hidden = !isAdminCaller;
    document.getElementById('membership-group-sync-section').hidden = !isAdminCaller;
    try {
      ({ canManageSkladki } = await apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth));
    } catch {
      canManageSkladki = false;
    }
    document.getElementById('membership-wpisowe-header').hidden = !canManageSkladki;
    // KRKG-0087: only an administrator may merge an accountless person with an account.
    document.getElementById('accountless-merge-section').hidden = !isAdminCaller;
    loadMembershipMembers();
    loadAccountless();
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

// A transition always removes the member from the visible status group, so patching that one row
// is sufficient and avoids displacing the administrator's current scroll position and focus.
async function postMembershipTransition(row, email, transition) {
  const list = document.getElementById('membership-members-list');
  const result = await window.MutationFeedback.confirmed({
    control: row.querySelector(`[data-transition="${transition}"]`),
    // The row is removed by apply(), so the persistent table is the closest valid anchor for
    // feedback. A span cannot be inserted as a child of the table body.
    anchor: row.closest('table'),
    execute: () => apiFetch(
      '/admin/members/transition',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, transition }) },
      showReauth,
      hideReauth,
    ),
    apply: () => {
      membershipMembersCache.members = membershipMembersCache.members.filter(member => member.email !== email);
      row.remove();
      if (!list.querySelector('.membership-member')) list.innerHTML = '<tr><td colspan="12" class="czl-empty">Brak członków w tym statusie.</td></tr>';
    },
    shouldShowCheck: result => !sheetSyncStatusMessage(result.sheetSyncStatus),
    viewRoot: list,
    refreshFragment: loadMembershipMembers,
  });
  return result.sheetSyncStatus;
}

document.getElementById('membership-synchronize').addEventListener('click', async () => {
  const button = document.getElementById('membership-synchronize');
  const status = document.getElementById('membership-synchronize-status');
  status.textContent = 'Synchronizowanie...';
  let sheetWarning = null;
  try {
    await window.MutationFeedback.confirmed({
      control: button,
      anchor: status,
      execute: () => apiFetch('/admin/members/synchronize', { method: 'POST' }, showReauth, hideReauth).then(result => {
        sheetWarning = sheetSyncStatusMessage(result.sheetSyncStatus);
        if (sheetWarning) throw new Error(sheetWarning);
      }),
      apply: () => { status.textContent = ''; },
      refreshFragment: async () => { status.textContent = ''; },
    });
  } catch (err) {
    status.textContent = sheetWarning ?? `Błąd: ${err.message}`;
  }
});

// KRKG-0065: on-demand only (never on page load) - the Apps Script behind this hit Google's daily
// Groups-read quota in production when KRKG-0046 called it on every ordinary auth check, so this
// stays a manual, rarely-clicked diagnostic rather than anything automatic.
document.getElementById('membership-group-sync-check').addEventListener('click', async () => {
  const result = document.getElementById('membership-group-sync-result');
  result.textContent = 'Sprawdzanie...';
  try {
    const { onlyInFirestore, onlyInGroup } = await apiFetch('/admin/members/group-sync', { method: 'GET' }, showReauth, hideReauth);
    if (onlyInFirestore.length === 0 && onlyInGroup.length === 0) {
      result.textContent = 'Zsynchronizowane - te same osoby w bazie i w grupie.';
      return;
    }
    const renderList = (title, emails) => emails.length === 0 ? '' : `
      <p style="margin-bottom:0.25rem;"><strong>${escapeHtml(title)}</strong></p>
      <ul style="margin:0 0 0.75rem 1.25rem;">${emails.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
    `;
    result.innerHTML =
      renderList('W bazie danych, brak w grupie:', onlyInFirestore) +
      renderList('W grupie, brak w bazie danych:', onlyInGroup);
  } catch (err) {
    result.textContent = `Błąd: ${err.message}`;
  }
});

const MEMBERSHIP_ACTIONS_BY_STATUS = {
  active: [{ transition: 'suspend', label: 'Zawieś' }, { transition: 'remove', label: 'Usuń' }],
  suspended: [{ transition: 'reactivate', label: 'Przywróć' }, { transition: 'remove', label: 'Usuń' }],
  removed: [],
  rejected: [],
};

// Every public About-Us category (about-us.ts's ABOUT_US_CATEGORIES) - deliberately all of them,
// unlike TRANSFER_TARGET_CATEGORIES on the Publiczne wizytówki page (which excludes Emeryci for
// the unrelated photo-transfer feature): a retired member can still be a logged-in Firestore
// member whose account needs linking to their Emeryci folder.
const DRIVE_FOLDER_LINK_CATEGORIES = ['Założyciele', 'Blachowi', 'Niewiasty', 'Emeryci', 'Kandydaci'];

// Cached across loadMembershipMembers calls (status-filter changes, "usuń" actions) so switching
// the status filter repeatedly doesn't re-fetch all 4 categories' folder lists every time - the
// admin panel's own folder structure doesn't change within one open session.
let driveFolderOptionsPromise = null;

function loadDriveFolderOptions() {
  if (!driveFolderOptionsPromise) {
    driveFolderOptionsPromise = Promise.all(
      DRIVE_FOLDER_LINK_CATEGORIES.map(category =>
        apiFetch(`/admin/people?category=${encodeURIComponent(category)}`, { method: 'GET' }, showReauth, hideReauth),
      ),
    ).then(results => {
      const options = [];
      results.forEach((data, i) => {
        for (const p of data.people || []) {
          options.push({ folderId: p.folderId, label: `${DRIVE_FOLDER_LINK_CATEGORIES[i]} / ${p.name}` });
        }
      });
      return options;
    });
  }
  return driveFolderOptionsPromise;
}

// KRKG-0049: every granted role at once (GET /admin/roles), so the Rola column doesn't need one
// fetch per row. Re-fetched on every loadMembershipMembers() call (unlike driveFolderOptions
// above) since role changes happen on this same page and must show up on the next status-filter
// switch or reload - a Map from email to that member's roles array. Admin-only endpoint (role
// assignment is more sensitive than plain people-management) - skipped entirely for a hovding,
// who would just get a 403 that would otherwise fail the whole Promise.all in loadMembershipMembers.
async function loadRolesByEmail() {
  if (!isAdminCaller) return new Map();
  const { roles } = await apiFetch('/admin/roles', { method: 'GET' }, showReauth, hideReauth);
  return new Map(roles.map(r => [r.email, r.roles]));
}

// GET /lista-wyjazdowa/roster is the only endpoint that already carries wpisowePaid for every
// member at once (built for the Składki page) - reused here rather than adding a second one.
async function loadWpisoweByEmail() {
  if (!canManageSkladki) return new Map();
  try {
    const { roster } = await apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth);
    return new Map(roster.map(m => [m.email, m.wpisowePaid]));
  } catch {
    return new Map();
  }
}

// Sections/categories don't change within one open admin session - cached the same way
// driveFolderOptions is above. Uses GET /admin/lookup-lists (admin-allowlist-gated), not
// GET /lista-wyjazdowa/lookup-lists, since an admin-allowlist account isn't guaranteed to also be
// a kruki-group member. One shared fetch backs both loadSections() and loadCategories() below.
let lookupListsPromise = null;
function loadLookupLists() {
  if (!lookupListsPromise) {
    lookupListsPromise = apiFetch('/admin/lookup-lists', { method: 'GET' }, showReauth, hideReauth);
  }
  return lookupListsPromise;
}
function loadSections() {
  return loadLookupLists().then(data => data.sections ?? []);
}
// "Typ członka" (KRKG-0050, shown to the admin/hovding as "Status" - see the Status <th>'s
// comment in index.html; the unrelated account-state filter above is labeled "Konto" precisely so
// it doesn't collide with this) - lookupLists/categories, "Rola" in the original sheet; a different,
// unrelated taxonomy from the public About-Us Drive folder categories (Blachowi/Niewiasty/
// Emeryci/Kandydaci) used on the Publiczne wizytówki page - see design.md's note on this ambiguity.
function loadCategories() {
  return loadLookupLists().then(data => data.categories ?? []);
}
// lookupLists/weapons - same list "Mój profil" (profil.js's populateWeaponCheckboxes) offers a
// member for their own listaWyjazdowaProfile.weaponIds; the Broń column here lets an
// admin/hovding set or correct it on someone else's behalf (see weaponCheckboxesHtml below).
function loadWeapons() {
  return loadLookupLists().then(data => data.weapons ?? []);
}

// 3-letter Sekcja abbreviations (KRKG-0063) for the compact, sticky first column - a display-only
// convenience, not a second source of truth: sections/seed-lookup-lists.ts's fixed 6-id set is
// still where a section's real label (and member-area.css's colors) come from. Falls back to the
// id's own first 3 letters for anything not in this map (e.g. "nieznana"), same
// never-hide-an-unresolved-reference spirit as the raw-id fallback below.
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

// A retired section (design.md §5, mirrors czlonkowie.js/profil.js) is withdrawn from *new*
// selection, but must still resolve for a member who already has it. A sectionId with no
// matching entry at all (e.g. "nieznana", migrate-existing-members.ts's fallback for an unknown
// section) gets a synthesized fallback option instead of vanishing from the dropdown entirely -
// same "never hide an unresolved reference" fix as czlonkowie.js/profil.js. Options show the
// abbreviation, not the full label (KRKG-0063) - the <select> itself is now the compact colored
// cell, so its collapsed and expanded states stay the same width; the full name is still one
// click/tap away as each <option>'s title-less native tooltip via its own text, and via this
// cell's own title attribute set in the change handler below.
function sectionOptions(sections, currentSectionId) {
  const options = sections
    .filter(s => !s.retired || s.id === currentSectionId)
    .map(s => `<option value="${escapeAttr(s.id)}" ${s.id === currentSectionId ? 'selected' : ''}>${escapeHtml(sectionAbbr(s.id))}</option>`);
  if (currentSectionId && !sections.some(s => s.id === currentSectionId)) {
    options.unshift(`<option value="${escapeAttr(currentSectionId)}" selected>${escapeHtml(sectionAbbr(currentSectionId))}</option>`);
  }
  return options.join('');
}

// Same "Brak"-as-null + never-hide-an-unresolved-reference shape as sectionOptions above, but
// categoryId is nullable (unlike sectionId) - "no typ przypisany yet" is a normal, common state
// for anyone who predates KRKG-0050, not an error, so it gets an explicit empty option instead of
// silently falling back to whatever the first real category happens to be.
function categoryOptions(categories, currentCategoryId) {
  const options = categories
    .filter(c => !c.retired || c.id === currentCategoryId)
    .map(c => `<option value="${escapeAttr(c.id)}" ${c.id === currentCategoryId ? 'selected' : ''}>${escapeHtml(c.label)}</option>`);
  if (currentCategoryId && !categories.some(c => c.id === currentCategoryId)) {
    options.unshift(`<option value="${escapeAttr(currentCategoryId)}" selected>${escapeHtml(currentCategoryId)}</option>`);
  }
  options.unshift(`<option value="" ${currentCategoryId ? '' : 'selected'}>Brak</option>`);
  return options.join('');
}

// Typ (categoryId) colors the whole Typ <td> background (KRKG-0052) rather than wrapping the name
// in a pill (KRKG-0057's approach - still used by Spis Ludności/Lista Wyjazdowa, which have no
// dedicated Typ column to color instead). Only emits data-category when a value is actually set -
// an absent attribute means member-area.css's [data-category] rule simply doesn't match, so an
// unassigned Typ stays the table's plain background instead of some in-between fallback shade.
// Has to stay in sync with the select's value on every change (see the change handler's
// categoryId branch below, which updates/clears the Typ <td>'s own data-category/title).
function categoryCellAttrs(categoryId, categories) {
  if (!categoryId) return '';
  const label = categories.find(c => c.id === categoryId)?.label;
  return `data-category="${escapeAttr(categoryId)}" title="${escapeAttr(label || categoryId)}"`;
}

// A member can hold more than one of these at once (e.g. accountant + admin), so the Rola column
// is a checkbox per role rather than a single-choice dropdown - see roleCheckboxesHtml below.
// Only rendered for an admin caller (see roleCheckboxesHtml/isAdminCaller) - a hovding can see
// and edit member profiles/status/Drive-folder on this page, but not grant roles, including
// 'hovding' itself.
const ASSIGNABLE_ROLES = [
  { value: 'accountant', label: 'Księgowy' },
  { value: 'hovding', label: 'Hovding' },
  { value: 'admin', label: 'Admin' },
];
const ROLE_LABELS = Object.fromEntries(ASSIGNABLE_ROLES.map(r => [r.value, r.label]));

// Cached from the last successful load so the free-text filter can re-render instantly without
// re-fetching - cleared/replaced on every status change or data-changing action.
let membershipMembersCache = { members: [], status: 'active', driveFolderOptions: [], rolesByEmail: new Map(), sections: [], categories: [], weapons: [], wpisoweByEmail: new Map() };

async function loadMembershipMembers() {
  const status = document.getElementById('membership-status-filter').value;
  const list = document.getElementById('membership-members-list');
  list.textContent = 'Ładowanie...';
  try {
    const [{ members }, driveFolderOptions, rolesByEmail, sections, categories, weapons, wpisoweByEmail] = await Promise.all([
      apiFetch(`/admin/members?status=${encodeURIComponent(status)}`, { method: 'GET' }, showReauth, hideReauth),
      loadDriveFolderOptions(),
      loadRolesByEmail(),
      loadSections(),
      loadCategories(),
      loadWeapons(),
      loadWpisoweByEmail(),
    ]);
    membershipMembersCache = { members, status, driveFolderOptions, rolesByEmail, sections, categories, weapons, wpisoweByEmail };
    renderMembershipMembers(filterMembershipMembers(members), status, driveFolderOptions, rolesByEmail, sections, categories, weapons, wpisoweByEmail);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function filterMembershipMembers(members) {
  const needle = document.getElementById('membership-members-filter').value.trim().toLocaleLowerCase('pl');
  if (!needle) return members;
  return members.filter(m =>
    [m.lastName, m.firstName, m.nickname, m.email, m.sectionId].some(v => (v ?? '').toString().toLocaleLowerCase('pl').includes(needle)),
  );
}

// Re-renders from the already-cached data (no re-fetch) - shared by both the free-text filter
// input and a sortable-header click (membershipSortState below), so filtering and sorting always
// compose the same way regardless of which one changed last.
function rerenderMembershipMembers() {
  const { members, status, driveFolderOptions, rolesByEmail, sections, categories, weapons, wpisoweByEmail } = membershipMembersCache;
  renderMembershipMembers(filterMembershipMembers(members), status, driveFolderOptions, rolesByEmail, sections, categories, weapons, wpisoweByEmail);
}

document.getElementById('membership-members-filter').addEventListener('input', rerenderMembershipMembers);

// Click-to-sort wiring (shared/sortable-table.js) - the table's thead is static HTML here (unlike
// Składki's), including the Rola/Wpisowe headers that stay in the DOM (just `hidden`) when the
// viewer can't use those columns, so this only ever needs to run once, no .refresh() calls.
const membershipSortState = initSortableTable(document.getElementById('membership-table'), {
  defaultKey: 'section',
  onChange: rerenderMembershipMembers,
});

function memberFocusId(email, control) {
  return `member-${encodeURIComponent(email)}-${control}`;
}

function roleCheckboxesHtml(email, roles) {
  const current = new Set(roles ?? []);
  return ASSIGNABLE_ROLES.map(
    r => `
        <label class="member-role-label">
          <input id="${memberFocusId(email, `role-${r.value}`)}" type="checkbox" class="member-role-checkbox" value="${r.value}" ${current.has(r.value) ? 'checked' : ''} />
          ${r.label}
        </label>`,
  ).join('');
}

// KRKG-0108: the server only honours a Firestore role while its holder is an active member
// (roles.ts getEffectiveRoles), so a grant still stored for a suspended/removed/pending member is
// shown - it's still editable here - but flagged as currently having no effect.
function inactiveRolesHintHtml(status, roles) {
  if (status === 'active' || !roles?.length) return '';
  return '<p class="member-roles-inactive-hint">Nieaktywne — role działają tylko dla aktywnych członków.</p>';
}

// A retired weapon (same "still resolve for someone who already has it" rule as
// sectionOptions/categoryOptions above) stays offered here if this member currently has it
// checked, otherwise drops out of new selection - mirrors profil.js's selectableLookupItems.
function weaponCheckboxesHtml(email, weapons, currentWeaponIds) {
  const current = new Set(currentWeaponIds ?? []);
  return weapons
    .filter(w => !w.retired || current.has(w.id))
    .map(
      w => `
        <label class="member-role-label">
          <input id="${memberFocusId(email, `weapon-${w.id}`)}" type="checkbox" class="member-weapon-checkbox" value="${escapeAttr(w.id)}" ${current.has(w.id) ? 'checked' : ''} />
          ${escapeHtml(w.label)}
        </label>`,
    )
    .join('');
}

function renderMembershipMembers(members, status, driveFolderOptions, rolesByEmail, sections, categories, weapons, wpisoweByEmail) {
  const tbody = document.getElementById('membership-members-list');
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="13" class="czl-empty">Brak członków w tym statusie.</td></tr>';
    return;
  }
  // Defaults to grouped by section, alphabetical within it (KRKG-0051) - now click-to-sort
  // (shared/sortable-table.js, membershipSortState) like every other dense table on the site,
  // rather than an unconditional rule with no header to override it.
  const sectionLabelById = new Map(sections.map(s => [s.id, s.label]));
  const sectionLabel = sectionId => (sectionId ? (sectionLabelById.get(sectionId) ?? sectionId) : '');
  const categoryLabelById = new Map(categories.map(c => [c.id, c.label]));
  const categoryLabel = categoryId => (categoryId ? (categoryLabelById.get(categoryId) ?? categoryId) : '');
  const sortValue = (member) => {
    switch (membershipSortState.key) {
      case 'name': return displayName(member);
      case 'nickname': return member.nickname ?? '';
      case 'status': return categoryLabel(member.categoryId);
      case 'hidden': return member.hidden === true;
      case 'email': return member.email;
      case 'lastLogin': return member.lastLoginAt ?? '';
      case 'wpisowe': return wpisoweByEmail.get(member.email) ?? false;
      default: return sectionLabel(member.sectionId);
    }
  };
  members = [...members].sort((a, b) => {
    const cmp = compareValues(sortValue(a), sortValue(b), membershipSortState.dir);
    if (cmp !== 0) return cmp;
    // Tie-break alphabetically by Nazwisko, not the displayed ksywka/imię.
    return compareValues(a.lastName ?? '', b.lastName ?? '', 'asc');
  });
  const actions = MEMBERSHIP_ACTIONS_BY_STATUS[status] ?? [];
  const labelByFolderId = new Map(driveFolderOptions.map(o => [o.folderId, o.label]));
  document.getElementById('drive-folder-datalist').innerHTML = driveFolderOptions
    .map(o => `<option value="${escapeAttr(o.label)}"></option>`)
    .join('');
  tbody.innerHTML = members
    .map(m => {
      // A driveFolderId pointing at a folder outside the 4 linkable categories (staging
      // "upload"/"deleted", or a folder since removed) has no known label - fall back to the
      // raw id so the field isn't misleadingly blank, matching this codebase's existing
      // convention of showing a raw id rather than hiding an unresolved reference (see
      // KRKG-0037's known-gaps note on raw section-id fallbacks).
      const currentValue = m.driveFolderId ? (labelByFolderId.get(m.driveFolderId) ?? m.driveFolderId) : '';
      // KRKG-0062: flags a member with neither a real Sekcja nor a Typ assigned - "nieznana" is
      // migrate-existing-members.ts's own fallback for "no known section", so it counts as
      // missing here the same as an empty sectionId does.
      const isFlagged = (!m.sectionId || m.sectionId === 'nieznana') && !m.categoryId;
      return `
    <tr class="membership-member${isFlagged ? ' membership-member--flagged' : ''}" data-email="${escapeAttr(m.email)}" data-section="${escapeAttr(m.sectionId ?? '')}">
      <td class="czl-section-cell" title="${escapeAttr(sectionLabel(m.sectionId) || 'Brak sekcji')}"><select id="${memberFocusId(m.email, 'section')}" class="czl-field" data-field="sectionId">${sectionOptions(sections, m.sectionId)}</select></td>
      <td class="czl-name-cell">
        <div class="czl-name-stack">
          <input id="${memberFocusId(m.email, 'last-name')}" type="text" class="czl-field" data-field="lastName" value="${escapeAttr(m.lastName ?? '')}" placeholder="Nazwisko" />
          <input id="${memberFocusId(m.email, 'first-name')}" type="text" class="czl-field" data-field="firstName" value="${escapeAttr(m.firstName ?? '')}" placeholder="Imię" />
        </div>
      </td>
      <td class="czl-nickname-cell">
        <div class="czl-nickname-with-profile">
          <input id="${memberFocusId(m.email, 'nickname')}" type="text" class="czl-field" data-field="nickname" value="${escapeAttr(m.nickname ?? '')}" placeholder="Ksywa" />
          <button type="button" class="profile-trigger profile-trigger--icon" data-profile-trigger data-email="${escapeAttr(m.email)}" aria-label="Pokaż profil" title="Pokaż profil">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
          </button>
        </div>
      </td>
      <td ${categoryCellAttrs(m.categoryId, categories)}><select id="${memberFocusId(m.email, 'category')}" class="czl-field" data-field="categoryId">${categoryOptions(categories, m.categoryId)}</select></td>
      <td><input id="${memberFocusId(m.email, 'hidden')}" type="checkbox" class="member-hidden-checkbox" data-field="hidden" ${m.hidden ? 'checked' : ''} /></td>
      <td>${escapeHtml(m.email)}</td>
      <td>${m.lastLoginAt ? escapeHtml(formatDateTime(m.lastLoginAt)) : 'Nigdy'}</td>
      <td>
        <input id="${memberFocusId(m.email, 'drive-folder')}" type="text" class="czl-field drive-folder-input" list="drive-folder-datalist" placeholder="Folder na stronie..." value="${escapeAttr(currentValue)}" />
        <span class="drive-folder-saved" style="color:var(--gold);" hidden>✓</span>
      </td>
      <td class="member-weapons-cell">${weaponCheckboxesHtml(m.email, weapons, m.weaponIds)}</td>
      <td class="member-roles-cell" ${isAdminCaller ? '' : 'hidden'}>${roleCheckboxesHtml(m.email, rolesByEmail.get(m.email))}${inactiveRolesHintHtml(status, rolesByEmail.get(m.email))}</td>
      <td ${canManageSkladki ? '' : 'hidden'}>
        <label class="member-role-label">
          <input id="${memberFocusId(m.email, 'wpisowe')}" type="checkbox" class="member-wpisowe-checkbox" data-email="${escapeAttr(m.email)}" ${wpisoweByEmail.get(m.email) ? 'checked' : ''} />
          Opłacone
        </label>
      </td>
      <td>
        ${actions.map(a => `<button id="${memberFocusId(m.email, `action-${a.transition}`)}" class="member-action" data-transition="${a.transition}">${a.label}</button>`).join('')}
      </td>
    </tr>`;
    })
    .join('');
}

// Saves lastName/firstName/nickname/sectionId together (one PUT, not per-field) using each
// field's *current* DOM value - mirrors czlonkowie.js's saveMemberField. Doesn't call
// loadMembershipMembers()/renderMembershipMembers() on success: re-rendering would resort/refilter
// the list out from under whichever field the admin is about to edit next, so `members` is
// patched in place instead and the DOM is left exactly as shown.
//
// KRKG-0103: lastName/firstName are both required now, so every save of this row's bundle
// (including a plain Sekcja/Typ change, since they're sent together) fails validation until a
// legacy member's Imię has been split out of Nazwisko - intentional, see design.md.
async function saveMemberProfileField(row, email, control) {
  const lastNameInput = row.querySelector('[data-field="lastName"]');
  const firstNameInput = row.querySelector('[data-field="firstName"]');
  const nicknameInput = row.querySelector('[data-field="nickname"]');
  const sectionSelect = row.querySelector('[data-field="sectionId"]');
  const categorySelect = row.querySelector('[data-field="categoryId"]');
  const lastName = lastNameInput.value.trim();
  const firstName = firstNameInput.value.trim();
  const nickname = nicknameInput.value.trim();
  const sectionId = sectionSelect.value;
  const categoryId = categorySelect.value || null;
  control ??= lastNameInput;
  const previousMember = membershipMembersCache.members.find(member => member.email === email);
  try {
    await window.MutationFeedback.confirmed({
      control,
      execute: () => apiFetch(
        '/admin/members/profile',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, lastName, firstName, nickname: nickname || null, sectionId, categoryId }),
        },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        const member = membershipMembersCache.members.find(candidate => candidate.email === email);
        if (member) {
          member.lastName = lastName;
          member.firstName = firstName;
          member.nickname = nickname || null;
          member.sectionId = sectionId;
          member.categoryId = categoryId;
        }
        row.dataset.section = sectionId;
        const sectionCell = sectionSelect.closest('td');
        const fullLabel = membershipMembersCache.sections.find(section => section.id === sectionId)?.label;
        sectionCell.title = fullLabel || sectionId || 'Brak sekcji';
        const categoryCell = categorySelect.closest('td');
        if (categoryId) {
          categoryCell.dataset.category = categoryId;
          categoryCell.title = categorySelect.selectedOptions[0]?.textContent || categoryId;
        } else {
          delete categoryCell.dataset.category;
          categoryCell.removeAttribute('title');
        }
        const stillFlagged = (!sectionId || sectionId === 'nieznana') && !categoryId;
        row.classList.toggle('membership-member--flagged', stillFlagged);
      },
      viewRoot: row.closest('tbody'),
      refreshFragment: loadMembershipMembers,
      rollback: () => {
        if (!previousMember) return;
        lastNameInput.value = previousMember.lastName ?? '';
        firstNameInput.value = previousMember.firstName ?? '';
        nicknameInput.value = previousMember.nickname ?? '';
        sectionSelect.value = previousMember.sectionId ?? '';
        categorySelect.value = previousMember.categoryId ?? '';
      },
    });
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

// KRKG-0060: hidden is admin/hovding-owned like categoryId, but sent on its own rather than
// through saveMemberProfileField's combined write - toggling it shouldn't require (or risk
// clobbering) the name/section/category fields also present in that same row.
async function saveMemberHidden(email, hidden, control) {
  const previousMember = membershipMembersCache.members.find(member => member.email === email);
  try {
    await window.MutationFeedback.confirmed({
      control,
      execute: () => apiFetch(
        '/admin/members/profile',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, hidden }) },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        const member = membershipMembersCache.members.find(candidate => candidate.email === email);
        if (member) member.hidden = hidden;
      },
      viewRoot: control.closest('tbody'),
      refreshFragment: loadMembershipMembers,
      rollback: () => { control.checked = previousMember?.hidden ?? !hidden; },
    });
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

// Broń (KRKG bugfix): admin/hovding-editable, unlike Rola/Wpisowe above - writes the same
// listaWyjazdowaProfile.weaponIds a member sets themselves on "Mój profil", via
// PUT /admin/members/weapons. Sends the whole checked set on every change, same shape as the role
// checkboxes (a member can hold more than one weapon at once).
async function saveMemberWeapons(email, nextWeaponIds, control) {
  const previousMember = membershipMembersCache.members.find(member => member.email === email);
  try {
    await window.MutationFeedback.confirmed({
      control,
      execute: () => apiFetch(
        '/admin/members/weapons',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, weaponIds: nextWeaponIds }) },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        const member = membershipMembersCache.members.find(candidate => candidate.email === email);
        if (member) member.weaponIds = nextWeaponIds;
      },
      viewRoot: control.closest('tbody'),
      refreshFragment: loadMembershipMembers,
      rollback: () => {
        const cell = control.closest('.member-weapons-cell');
        for (const cb of cell.querySelectorAll('.member-weapon-checkbox')) {
          cb.checked = (previousMember?.weaponIds ?? []).includes(cb.value);
        }
      },
    });
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

// Wpisowe is now hidden entirely from the Składki page's row once paid (KRKG-0047 follow-up) - no
// UI there can undo a mistaken "opłacone" any more, so this checkbox is the only remaining way to
// flip it back. Marking it *paid* is confirmed first (see the change handler below); un-marking it
// is not, the same asymmetry as membership-status-filter's Zawieś/Usuń needing confirmation only
// for the harder-to-undo actions.
async function saveMemberWpisowe(email, nextPaid, control) {
  const previousPaid = membershipMembersCache.wpisoweByEmail.get(email) ?? false;
  try {
    await window.MutationFeedback.confirmed({
      control,
      execute: () => apiFetch(
        `/lista-wyjazdowa/wpisowe?personId=${encodeURIComponent(email)}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        membershipMembersCache.wpisoweByEmail.set(email, nextPaid);
      },
      viewRoot: control.closest('tbody'),
      refreshFragment: loadMembershipMembers,
      rollback: () => { control.checked = previousPaid; },
    });
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

document.getElementById('membership-members-list').addEventListener('change', async e => {
  const wpisoweCheckbox = e.target.closest('.member-wpisowe-checkbox');
  if (wpisoweCheckbox) {
    const nextPaid = wpisoweCheckbox.checked;
    if (nextPaid && !window.confirm('Czy na pewno chcesz zaznaczyć, że wpisowe zostało opłacone?')) {
      wpisoweCheckbox.checked = false;
      return;
    }
    await saveMemberWpisowe(wpisoweCheckbox.dataset.email, nextPaid, wpisoweCheckbox);
    return;
  }

  const weaponCheckbox = e.target.closest('.member-weapon-checkbox');
  if (weaponCheckbox) {
    const cell = weaponCheckbox.closest('.member-weapons-cell');
    const row = weaponCheckbox.closest('tr');
    const nextWeaponIds = Array.from(cell.querySelectorAll('.member-weapon-checkbox'))
      .filter(cb => cb.checked)
      .map(cb => cb.value);
    await saveMemberWeapons(row.dataset.email, nextWeaponIds, weaponCheckbox);
    return;
  }

  const hiddenCheckbox = e.target.closest('.member-hidden-checkbox');
  if (hiddenCheckbox) {
    const row = hiddenCheckbox.closest('tr');
    await saveMemberHidden(row.dataset.email, hiddenCheckbox.checked, hiddenCheckbox);
    return;
  }

  const profileField = e.target.closest('.czl-field');
  if (profileField && profileField.dataset.field) {
    const row = profileField.closest('tr');
    await saveMemberProfileField(row, row.dataset.email, profileField);
    return;
  }

  const roleCheckbox = e.target.closest('.member-role-checkbox');
  if (roleCheckbox) {
    const container = roleCheckbox.closest('.membership-member');
    const email = container.dataset.email;
    // Sends the *whole* checked set, not just the box that changed - a member can hold more than
    // one role at once (e.g. accountant + admin), and PUT /admin/roles replaces the roles array
    // wholesale rather than toggling a single value.
    const nextRoles = Array.from(container.querySelectorAll('.member-role-checkbox'))
      .filter(cb => cb.checked)
      .map(cb => cb.value);
    const label = nextRoles.length ? nextRoles.map(r => ROLE_LABELS[r]).join(', ') : 'Brak';
    if (!window.confirm(`Ustawić role: ${label} dla ${email}?`)) {
      roleCheckbox.checked = !roleCheckbox.checked;
      return;
    }
    try {
      await window.MutationFeedback.confirmed({
        control: roleCheckbox,
        execute: () => apiFetch(
          '/admin/roles',
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, roles: nextRoles }) },
          showReauth,
          hideReauth,
        ),
        apply: () => {
          membershipMembersCache.rolesByEmail.set(email, nextRoles);
        },
        viewRoot: container.closest('tbody'),
        refreshFragment: loadMembershipMembers,
        rollback: () => { roleCheckbox.checked = !roleCheckbox.checked; },
      });
    } catch (err) {
      window.alert(`Błąd: ${err.message}`);
    }
    return;
  }

  const input = e.target.closest('.drive-folder-input');
  if (!input) return;
  const row = e.target.closest('.membership-member');
  const email = row.dataset.email;
  const typedLabel = input.value.trim();
  let folderId = null;
  try {
    const driveFolderOptions = typedLabel ? await loadDriveFolderOptions() : membershipMembersCache.driveFolderOptions;
    if (typedLabel) {
      const match = driveFolderOptions.find(option => option.label === typedLabel);
      if (!match) {
        window.alert(`Nie znaleziono folderu "${typedLabel}" na liście. Wybierz jedną z podpowiedzi.`);
        return;
      }
      folderId = match.folderId;
    }
    const previousFolderId = membershipMembersCache.members.find(member => member.email === email)?.driveFolderId ?? null;
    await window.MutationFeedback.confirmed({
      control: input,
      execute: () => apiFetch(
        '/admin/members/drive-folder',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, folderId }) },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        const cached = membershipMembersCache.members.find(member => member.email === email);
        if (cached) cached.driveFolderId = folderId;
      },
      viewRoot: row.closest('tbody'),
      refreshFragment: loadMembershipMembers,
      rollback: () => {
        input.value = previousFolderId ? (driveFolderOptions.find(option => option.folderId === previousFolderId)?.label ?? previousFolderId) : '';
      },
    });
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});

document.getElementById('membership-status-filter').addEventListener('change', loadMembershipMembers);

document.getElementById('membership-members-list').addEventListener('click', async e => {
  // Tapping a row highlights it gold (KRKG-0052) - touch devices have no hover state, so this is
  // the only way to see which row you're currently editing on mobile. Persists until another row
  // is tapped, unlike :hover/:active which fade the instant you lift your finger. Runs for every
  // click in the list (not just member-action ones below), same as czlonkowie.js's change-driven
  // table.
  const clickedRow = e.target.closest('tr');
  if (clickedRow) {
    document.querySelectorAll('#membership-members-list tr.czl-row-active').forEach(r => r.classList.remove('czl-row-active'));
    clickedRow.classList.add('czl-row-active');
  }

  const actionBtn = e.target.closest('.member-action');
  if (!actionBtn) return;
  const row = e.target.closest('.membership-member');
  const email = row.dataset.email;
  const transition = actionBtn.dataset.transition;
  if (transition === 'remove' && !window.confirm(`Na pewno usunąć członka ${email}?`)) return;
  try {
    const sheetSyncStatus = await postMembershipTransition(row, email, transition);
    const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
    if (sheetWarning) window.alert(sheetWarning);
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});

// ── Osoby bez konta (KRKG-0087 design.md section C) ──────────────────────────────────────────
//
// Accountless people, attached or not, managed by staff. Read from the roster's person rows;
// writes go through the same /lista-wyjazdowa/persons routes Mój profil uses (POST/PUT/DELETE
// /persons, PUT /persons/owner to detach), with the merge being administrator-only
// (PUT /persons/account). The server re-checks the staff role on every write.
const ACCOUNT_NO_WEAPON_CATEGORY_IDS = ['niewiasta', 'bobo'];
let accountlessCache = { persons: [], sections: [], categories: [], weapons: [] };
let editingAccountlessPersonId = null;

function accountlessOptionsHtml(items, selectedId) {
  return items
    .filter((item) => !item.retired || item.id === selectedId)
    .map((item) => `<option value="${escapeAttr(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(item.label)}</option>`)
    .join('');
}

function accountlessWeaponCheckboxesHtml(weapons, currentIds) {
  const current = new Set(currentIds ?? []);
  return weapons
    .filter((w) => !w.retired || current.has(w.id))
    .map((w) => `<label class="member-role-label"><input type="checkbox" class="accountless-weapon-checkbox" value="${escapeAttr(w.id)}"${current.has(w.id) ? ' checked' : ''} />${escapeHtml(w.label)}</label>`)
    .join('');
}

// Niewiasta/Bobo never carry a weapon (server: persons.ts's weaponAllowedForCategory) - clear and
// hide the weapon group so the form can't offer a combination the save would reject.
function updateAccountlessWeaponState() {
  const allowed = !ACCOUNT_NO_WEAPON_CATEGORY_IDS.includes(document.getElementById('accountless-category').value);
  const weapons = document.getElementById('accountless-weapons');
  weapons.hidden = !allowed;
  if (!allowed) {
    for (const cb of weapons.querySelectorAll('.accountless-weapon-checkbox')) cb.checked = false;
  }
}

function resetAccountlessForm() {
  editingAccountlessPersonId = null;
  document.getElementById('accountless-ksywka').value = '';
  document.getElementById('accountless-first-name').value = '';
  document.getElementById('accountless-last-name').value = '';
  document.getElementById('accountless-category').innerHTML = accountlessOptionsHtml(accountlessCache.categories, null);
  document.getElementById('accountless-section-select').innerHTML = accountlessOptionsHtml(accountlessCache.sections, null);
  document.getElementById('accountless-weapons').innerHTML = accountlessWeaponCheckboxesHtml(accountlessCache.weapons, []);
  updateAccountlessWeaponState();
  document.getElementById('accountless-save').textContent = 'Dodaj osobę';
  document.getElementById('accountless-error').hidden = true;
}

function openAccountlessForm(person) {
  resetAccountlessForm();
  if (person) {
    editingAccountlessPersonId = person.personId;
    document.getElementById('accountless-ksywka').value = person.ksywka ?? person.nickname ?? '';
    document.getElementById('accountless-first-name').value = person.firstName ?? '';
    document.getElementById('accountless-last-name').value = person.lastName ?? '';
    if (person.categoryId) document.getElementById('accountless-category').value = person.categoryId;
    if (person.sectionId) document.getElementById('accountless-section-select').value = person.sectionId;
    document.getElementById('accountless-weapons').innerHTML = accountlessWeaponCheckboxesHtml(accountlessCache.weapons, person.weaponIds ?? []);
    updateAccountlessWeaponState();
    document.getElementById('accountless-save').textContent = 'Zapisz zmiany';
  }
  document.getElementById('accountless-form-panel').hidden = false;
}

function accountlessDisplayName(person) {
  return person.ksywka || [person.firstName, person.lastName].filter((part) => (part ?? '').trim()).join(' ') || person.personId;
}

// KRKG-0091: the list is GET /lista-wyjazdowa/persons (staff), which - unlike the roster's current
// read - also returns deactivated (tombstoned) people, so they can be permanently removed.
function renderAccountless(persons) {
  accountlessCache.persons = persons;
  const sectionLabelById = new Map(accountlessCache.sections.map((s) => [s.id, s.label]));
  const categoryLabelById = new Map(accountlessCache.categories.map((c) => [c.id, c.label]));
  const weaponLabelById = new Map(accountlessCache.weapons.map((w) => [w.id, w.label]));
  const tbody = document.getElementById('accountless-list');
  if (persons.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="czl-empty">Brak osób bez konta.</td></tr>';
  } else {
    tbody.innerHTML = persons.map((person) => {
      const categoryLabel = person.categoryId ? (categoryLabelById.get(person.categoryId) ?? person.categoryId) : null;
      const namePill = personPillHtml({ name: accountlessDisplayName(person), categoryId: person.categoryId, categoryLabel, accountless: true, subline: personSubline(person) });
      // A deactivated person's drawer 404s, so their pill is plain text; an active one opens it.
      const nameCell = person.deleted
        ? namePill
        : `<button type="button" class="profile-trigger" data-profile-trigger data-person-id="${escapeAttr(person.personId)}">${namePill}</button>`;
      const weaponLabel = (person.weaponIds ?? []).map((id) => weaponLabelById.get(id) ?? id).join(', ');
      return `
    <tr data-person-id="${escapeAttr(person.personId)}" data-section="${escapeAttr(person.sectionId ?? '')}">
      <td class="czl-section-cell" title="${escapeAttr(sectionLabelById.get(person.sectionId) ?? 'Brak sekcji')}">${person.sectionId ? escapeHtml(sectionAbbr(person.sectionId)) : '—'}</td>
      <td>${nameCell}</td>
      <td>${escapeHtml(categoryLabel ?? '—')}</td>
      <td>${weaponLabel ? escapeHtml(weaponLabel) : '—'}</td>
      <td>${person.ownerPersonId ? escapeHtml(person.ownerName ?? person.ownerPersonId) : '—'}</td>
      <td>${person.deleted ? 'deaktywowana' : 'bez konta'}</td>
      <td>
        ${person.deleted ? '' : '<button type="button" class="member-action accountless-edit">Edytuj</button>'}
        ${!person.deleted && person.ownerPersonId ? '<button type="button" class="member-action accountless-detach">Odepnij</button>' : ''}
        ${person.deleted ? '' : '<button type="button" class="member-action accountless-deactivate">Deaktywuj</button>'}
        <button type="button" class="member-action accountless-purge">Usuń trwale</button>
      </td>
    </tr>`;
    }).join('');
  }
  document.getElementById('accountless-merge-person').innerHTML =
    '<option value="">— wybierz osobę —</option>' +
    persons
      .filter((person) => !person.deleted)
      .map((person) => `<option value="${escapeAttr(person.personId)}">${escapeHtml(accountlessDisplayName(person))}</option>`)
      .join('');
}

async function loadAccountless() {
  const tbody = document.getElementById('accountless-list');
  tbody.innerHTML = '<tr><td colspan="7" class="czl-empty">Ładowanie...</td></tr>';
  try {
    const [{ persons }, sections, categories, weapons] = await Promise.all([
      apiFetch('/lista-wyjazdowa/persons', { method: 'GET' }, showReauth, hideReauth),
      loadSections(),
      loadCategories(),
      loadWeapons(),
    ]);
    accountlessCache = { persons: [], sections, categories, weapons };
    resetAccountlessForm();
    renderAccountless(persons);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="czl-empty">Błąd: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function runAccountlessMutation(control, execute) {
  await window.MutationFeedback.confirmed({
    control,
    anchor: document.getElementById('accountless-section'),
    viewRoot: document.getElementById('accountless-section'),
    refreshFragment: loadAccountless,
    execute,
    apply: () => loadAccountless(),
  });
}

async function submitAccountlessForm() {
  const errorEl = document.getElementById('accountless-error');
  errorEl.hidden = true;
  const categoryId = document.getElementById('accountless-category').value;
  const fields = {
    ksywka: document.getElementById('accountless-ksywka').value.trim(),
    firstName: document.getElementById('accountless-first-name').value.trim(),
    lastName: document.getElementById('accountless-last-name').value.trim(),
    categoryId,
    sectionId: document.getElementById('accountless-section-select').value,
    weaponIds: ACCOUNT_NO_WEAPON_CATEGORY_IDS.includes(categoryId)
      ? []
      : Array.from(document.querySelectorAll('#accountless-weapons .accountless-weapon-checkbox:checked')).map((cb) => cb.value),
  };
  if (!fields.ksywka || !fields.categoryId || !fields.sectionId) {
    errorEl.textContent = 'Ksywka, kategoria i sekcja są wymagane.';
    errorEl.hidden = false;
    return;
  }
  const editing = editingAccountlessPersonId;
  try {
    await runAccountlessMutation(document.getElementById('accountless-save'), () => apiFetch(
      '/lista-wyjazdowa/persons',
      {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { personId: editing, ...fields } : fields),
      },
      showReauth,
      hideReauth,
    ));
    document.getElementById('accountless-form-panel').hidden = true;
    resetAccountlessForm();
  } catch (err) {
    errorEl.textContent = `Nie udało się zapisać osoby: ${err.message}`;
    errorEl.hidden = false;
  }
}

document.getElementById('accountless-add-toggle').addEventListener('click', () => openAccountlessForm(null));
document.getElementById('accountless-cancel').addEventListener('click', () => {
  document.getElementById('accountless-form-panel').hidden = true;
  resetAccountlessForm();
});
document.getElementById('accountless-save').addEventListener('click', submitAccountlessForm);
document.getElementById('accountless-category').addEventListener('change', updateAccountlessWeaponState);

document.getElementById('accountless-list').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-person-id]');
  if (!row) return;
  const personId = row.dataset.personId;
  if (e.target.closest('.accountless-edit')) {
    const person = accountlessCache.persons.find((p) => p.personId === personId);
    if (person) openAccountlessForm(person);
    return;
  }
  if (e.target.closest('.accountless-detach')) {
    if (!window.confirm('Odpiąć tę osobę od opiekuna?')) return;
    try {
      await runAccountlessMutation(e.target, () => apiFetch(
        '/lista-wyjazdowa/persons/owner',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId, ownerPersonId: null }) },
        showReauth,
        hideReauth,
      ));
    } catch (err) {
      window.alert(`Błąd: ${err.message}`);
    }
    return;
  }
  if (e.target.closest('.accountless-deactivate')) {
    if (!window.confirm('Deaktywować tę osobę? Zostanie odpięta od opiekuna i pozostanie w historii jako nieaktywna, ale nie będzie można jej już dodać.')) return;
    try {
      await runAccountlessMutation(e.target, () => apiFetch(
        '/lista-wyjazdowa/persons',
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId }) },
        showReauth,
        hideReauth,
      ));
    } catch (err) {
      window.alert(`Błąd: ${err.message}`);
    }
    return;
  }
  if (e.target.closest('.accountless-purge')) {
    if (!window.confirm('Trwale usunąć tę osobę? Zniknie także z przeszłych wyjazdów i zmieni ich statystyki. Audyt pozostanie.')) return;
    try {
      await runAccountlessMutation(e.target, () => apiFetch(
        '/lista-wyjazdowa/persons/permanent',
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId }) },
        showReauth,
        hideReauth,
      ));
    } catch (err) {
      window.alert(`Błąd: ${err.message}`);
    }
  }
});

document.getElementById('accountless-merge').addEventListener('click', async (e) => {
  const errorEl = document.getElementById('accountless-merge-error');
  errorEl.hidden = true;
  const personId = document.getElementById('accountless-merge-person').value;
  const accountEmail = document.getElementById('accountless-merge-email').value.trim();
  if (!personId || !accountEmail) {
    errorEl.textContent = 'Wybierz osobę i podaj e-mail konta.';
    errorEl.hidden = false;
    return;
  }
  if (!window.confirm(`Scalić tę osobę z kontem ${accountEmail}?`)) return;
  try {
    await runAccountlessMutation(e.target, () => apiFetch(
      '/lista-wyjazdowa/persons/account',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personId, accountEmail }) },
      showReauth,
      hideReauth,
    ));
    document.getElementById('accountless-merge-email').value = '';
  } catch (err) {
    errorEl.textContent = `Nie udało się scalić: ${err.message}`;
    errorEl.hidden = false;
  }
});
