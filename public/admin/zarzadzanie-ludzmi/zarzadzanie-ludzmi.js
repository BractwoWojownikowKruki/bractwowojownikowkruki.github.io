// Zarządzanie ludźmi (KRKG-0049): the members table (status, live filter, Drive-folder mapping,
// Zawieś/Usuń/Przywróć, and the new Rola column), plus the Sheets backup sync. Split out of the
// original single-page admin.js. showReauth/hideReauth/escapeHtml/escapeAttr/
// sheetSyncStatusMessage/formatDateTime come from ../admin-shared.js, loaded before this file.
// whoamiPath is this page's own /admin/members/whoami (not /admin/whoami like the other 3 admin
// pages) - it also accepts a Firestore 'moderator'/'admin' role, not just the admin allowlist, and
// reports isAdmin so a plain moderator never triggers the role-assignment-only fetches below
// (GET /admin/roles(+/audit-log) are still admin-only and would 403 for them).
let isAdminCaller = false;
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/members/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    isAdminCaller = payload.isAdmin === true;
    document.getElementById('roles-audit-log-panel').hidden = !isAdminCaller;
    document.getElementById('membership-role-header').hidden = !isAdminCaller;
    loadMembershipMembers();
    if (isAdminCaller) renderRolesAuditLog();
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

// KRKG-0046: sends one status-transition request, then reloads the members list - a single
// transition (suspend/reactivate/remove) always changes this list. Returns the response's
// sheetSyncStatus so callers can surface a non-blocking warning if it failed - the transition
// itself has already succeeded (Firestore is authoritative) regardless.
async function postMembershipTransition(email, transition) {
  const { sheetSyncStatus } = await apiFetch(
    '/admin/members/transition',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, transition }) },
    showReauth,
    hideReauth,
  );
  loadMembershipMembers();
  return sheetSyncStatus;
}

document.getElementById('membership-synchronize').addEventListener('click', async () => {
  const status = document.getElementById('membership-synchronize-status');
  status.textContent = 'Synchronizowanie...';
  try {
    const { sheetSyncStatus } = await apiFetch('/admin/members/synchronize', { method: 'POST' }, showReauth, hideReauth);
    status.textContent = sheetSyncStatusMessage(sheetSyncStatus) ?? 'Zsynchronizowano.';
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

const MEMBERSHIP_ACTIONS_BY_STATUS = {
  active: [{ transition: 'suspend', label: 'Zawieś' }, { transition: 'remove', label: 'Usuń' }],
  suspended: [{ transition: 'reactivate', label: 'Przywróć' }, { transition: 'remove', label: 'Usuń' }],
  removed: [],
  rejected: [],
};

// The 4 public About-Us categories (about-us.ts's ABOUT_US_CATEGORIES) - deliberately all 4,
// unlike TRANSFER_TARGET_CATEGORIES on the Publiczne wizytówki page (which excludes Emeryci for
// the unrelated photo-transfer feature): a retired member can still be a logged-in Firestore
// member whose account needs linking to their Emeryci folder.
const DRIVE_FOLDER_LINK_CATEGORIES = ['Blachowi', 'Niewiasty', 'Emeryci', 'Kandydaci'];

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
// assignment is more sensitive than plain people-management) - skipped entirely for a moderator,
// who would just get a 403 that would otherwise fail the whole Promise.all in loadMembershipMembers.
async function loadRolesByEmail() {
  if (!isAdminCaller) return new Map();
  const { roles } = await apiFetch('/admin/roles', { method: 'GET' }, showReauth, hideReauth);
  return new Map(roles.map(r => [r.email, r.roles]));
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
// "Typ członka" (KRKG-0050) - lookupLists/categories, "Rola" in the original sheet; a different,
// unrelated taxonomy from the public About-Us Drive folder categories (Blachowi/Niewiasty/
// Emeryci/Kandydaci) used on the Publiczne wizytówki page - see design.md's note on this ambiguity.
function loadCategories() {
  return loadLookupLists().then(data => data.categories ?? []);
}

// A retired section (design.md §5, mirrors czlonkowie.js/profil.js) is withdrawn from *new*
// selection, but must still resolve for a member who already has it. A sectionId with no
// matching entry at all (e.g. "nieznana", migrate-existing-members.ts's fallback for an unknown
// section) gets a synthesized fallback option instead of vanishing from the dropdown entirely -
// same "never hide an unresolved reference" fix as czlonkowie.js/profil.js.
function sectionOptions(sections, currentSectionId) {
  const options = sections
    .filter(s => !s.retired || s.id === currentSectionId)
    .map(s => `<option value="${escapeAttr(s.id)}" ${s.id === currentSectionId ? 'selected' : ''}>${escapeHtml(s.label)}</option>`);
  if (currentSectionId && !sections.some(s => s.id === currentSectionId)) {
    options.unshift(`<option value="${escapeAttr(currentSectionId)}" selected>${escapeHtml(currentSectionId)}</option>`);
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
// Only rendered for an admin caller (see roleCheckboxesHtml/isAdminCaller) - a moderator can see
// and edit member profiles/status/Drive-folder on this page, but not grant roles, including
// 'moderator' itself.
const ASSIGNABLE_ROLES = [
  { value: 'accountant', label: 'Księgowy' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'admin', label: 'Admin' },
];
const ROLE_LABELS = Object.fromEntries(ASSIGNABLE_ROLES.map(r => [r.value, r.label]));

// KRKG-0049: every role change, admin-only same as the page itself - not gated any further since
// reaching this page at all already requires the admin allowlist.
async function renderRolesAuditLog() {
  const { entries } = await apiFetch('/admin/roles/audit-log', { method: 'GET' }, showReauth, hideReauth);
  document.getElementById('roles-audit-log-content').innerHTML = entries
    .slice()
    .reverse()
    .map(e => `<li>${escapeHtml(formatDateTime(e.changedAt))} — ${escapeHtml(e.changedBy)} → ${escapeHtml(e.targetEmail)}: ${escapeHtml(e.changeSummary)}</li>`)
    .join('');
}

// Cached from the last successful load so the free-text filter can re-render instantly without
// re-fetching - cleared/replaced on every status change or data-changing action.
let membershipMembersCache = { members: [], status: 'active', driveFolderOptions: [], rolesByEmail: new Map(), sections: [], categories: [] };

async function loadMembershipMembers() {
  const status = document.getElementById('membership-status-filter').value;
  const list = document.getElementById('membership-members-list');
  list.textContent = 'Ładowanie...';
  try {
    const [{ members }, driveFolderOptions, rolesByEmail, sections, categories] = await Promise.all([
      apiFetch(`/admin/members?status=${encodeURIComponent(status)}`, { method: 'GET' }, showReauth, hideReauth),
      loadDriveFolderOptions(),
      loadRolesByEmail(),
      loadSections(),
      loadCategories(),
    ]);
    membershipMembersCache = { members, status, driveFolderOptions, rolesByEmail, sections, categories };
    renderMembershipMembers(filterMembershipMembers(members), status, driveFolderOptions, rolesByEmail, sections, categories);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function filterMembershipMembers(members) {
  const needle = document.getElementById('membership-members-filter').value.trim().toLocaleLowerCase('pl');
  if (!needle) return members;
  return members.filter(m =>
    [m.fullName, m.nickname, m.email, m.sectionId].some(v => (v ?? '').toString().toLocaleLowerCase('pl').includes(needle)),
  );
}

document.getElementById('membership-members-filter').addEventListener('input', () => {
  const { members, status, driveFolderOptions, rolesByEmail, sections, categories } = membershipMembersCache;
  renderMembershipMembers(filterMembershipMembers(members), status, driveFolderOptions, rolesByEmail, sections, categories);
});

function roleCheckboxesHtml(roles) {
  const current = new Set(roles ?? []);
  return ASSIGNABLE_ROLES.map(
    r => `
        <label class="member-role-label">
          <input type="checkbox" class="member-role-checkbox" value="${r.value}" ${current.has(r.value) ? 'checked' : ''} />
          ${r.label}
        </label>`,
  ).join('');
}

function renderMembershipMembers(members, status, driveFolderOptions, rolesByEmail, sections, categories) {
  const tbody = document.getElementById('membership-members-list');
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="czl-empty">Brak członków w tym statusie.</td></tr>';
    return;
  }
  // Grouped by section, alphabetical within it (KRKG-0051) - same rule as czlonkowie.js's Sekcja
  // sort, just unconditional here since this list has no clickable column headers to override it.
  const sectionLabelById = new Map(sections.map(s => [s.id, s.label]));
  const sectionLabel = sectionId => (sectionId ? (sectionLabelById.get(sectionId) ?? sectionId) : '');
  members = [...members].sort((a, b) => {
    const sectionCmp = sectionLabel(a.sectionId).toLocaleLowerCase('pl').localeCompare(sectionLabel(b.sectionId).toLocaleLowerCase('pl'), 'pl');
    if (sectionCmp !== 0) return sectionCmp;
    return (a.fullName ?? '').toLocaleLowerCase('pl').localeCompare((b.fullName ?? '').toLocaleLowerCase('pl'), 'pl');
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
      <td class="czl-section-bar"></td>
      <td><input type="text" class="czl-field" data-field="fullName" value="${escapeAttr(m.fullName ?? '')}" placeholder="Imię i nazwisko" /></td>
      <td><input type="text" class="czl-field" data-field="nickname" value="${escapeAttr(m.nickname ?? '')}" placeholder="Ksywa" /></td>
      <td><select class="czl-field" data-field="sectionId">${sectionOptions(sections, m.sectionId)}</select></td>
      <td ${categoryCellAttrs(m.categoryId, categories)}><select class="czl-field" data-field="categoryId">${categoryOptions(categories, m.categoryId)}</select></td>
      <td><input type="checkbox" class="member-hidden-checkbox" data-field="hidden" ${m.hidden ? 'checked' : ''} /></td>
      <td>${escapeHtml(m.email)}</td>
      <td>${m.lastLoginAt ? escapeHtml(formatDateTime(m.lastLoginAt)) : 'Nigdy'}</td>
      <td>
        <input type="text" class="czl-field drive-folder-input" list="drive-folder-datalist" placeholder="Folder na stronie..." value="${escapeAttr(currentValue)}" />
        <span class="drive-folder-saved" style="color:var(--gold);" hidden>✓</span>
      </td>
      <td class="member-roles-cell" ${isAdminCaller ? '' : 'hidden'}>${roleCheckboxesHtml(rolesByEmail.get(m.email))}</td>
      <td>
        ${actions.map(a => `<button class="member-action" data-transition="${a.transition}">${a.label}</button>`).join('')}
      </td>
    </tr>`;
    })
    .join('');
}

// Saves fullName/nickname/sectionId together (one PUT, not per-field) using each field's
// *current* DOM value - mirrors czlonkowie.js's saveMemberField. Doesn't call
// loadMembershipMembers()/renderMembershipMembers() on success: re-rendering would resort/refilter
// the list out from under whichever field the admin is about to edit next, so `members` is
// patched in place instead and the DOM is left exactly as shown.
async function saveMemberProfileField(row, email) {
  const fullNameInput = row.querySelector('[data-field="fullName"]');
  const nicknameInput = row.querySelector('[data-field="nickname"]');
  const sectionSelect = row.querySelector('[data-field="sectionId"]');
  const categorySelect = row.querySelector('[data-field="categoryId"]');
  const fullName = fullNameInput.value.trim();
  const nickname = nicknameInput.value.trim();
  const sectionId = sectionSelect.value;
  const categoryId = categorySelect.value || null;
  try {
    await apiFetch(
      '/admin/members/profile',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, fullName: fullName || null, nickname: nickname || null, sectionId, categoryId }),
      },
      showReauth,
      hideReauth,
    );
    const member = membershipMembersCache.members.find(m => m.email === email);
    if (member) {
      member.fullName = fullName || null;
      member.nickname = nickname || null;
      member.sectionId = sectionId;
      member.categoryId = categoryId;
    }
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

// KRKG-0060: hidden is admin/moderator-owned like categoryId, but sent on its own rather than
// through saveMemberProfileField's combined write - toggling it shouldn't require (or risk
// clobbering) the name/section/category fields also present in that same row.
async function saveMemberHidden(email, hidden) {
  try {
    await apiFetch(
      '/admin/members/profile',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, hidden }) },
      showReauth,
      hideReauth,
    );
    const member = membershipMembersCache.members.find(m => m.email === email);
    if (member) member.hidden = hidden;
  } catch (err) {
    window.alert(`Błąd zapisu: ${err.message}`);
  }
}

document.getElementById('membership-members-list').addEventListener('change', async e => {
  const hiddenCheckbox = e.target.closest('.member-hidden-checkbox');
  if (hiddenCheckbox) {
    const row = hiddenCheckbox.closest('tr');
    saveMemberHidden(row.dataset.email, hiddenCheckbox.checked);
    return;
  }

  const profileField = e.target.closest('.czl-field');
  if (profileField && profileField.dataset.field) {
    const row = profileField.closest('tr');
    // Same instant-echo update as czlonkowie.js's Sekcja <select> - not a reflection of saved
    // state, just what's already visibly selected.
    if (profileField.dataset.field === 'sectionId') {
      row.dataset.section = profileField.value;
    }
    if (profileField.dataset.field === 'categoryId') {
      const typCell = profileField.closest('td');
      if (profileField.value) {
        typCell.dataset.category = profileField.value;
        typCell.title = profileField.selectedOptions[0]?.textContent || profileField.value;
      } else {
        delete typCell.dataset.category;
        typCell.removeAttribute('title');
      }
    }
    if (profileField.dataset.field === 'sectionId' || profileField.dataset.field === 'categoryId') {
      const sectionValue = row.querySelector('select[data-field="sectionId"]').value;
      const categoryValue = row.querySelector('select[data-field="categoryId"]').value;
      const stillFlagged = (!sectionValue || sectionValue === 'nieznana') && !categoryValue;
      row.classList.toggle('membership-member--flagged', stillFlagged);
    }
    saveMemberProfileField(row, row.dataset.email);
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
      await apiFetch(
        '/admin/roles',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, roles: nextRoles }) },
        showReauth,
        hideReauth,
      );
      membershipMembersCache.rolesByEmail.set(email, nextRoles);
      renderRolesAuditLog();
    } catch (err) {
      window.alert(`Błąd: ${err.message}`);
      roleCheckbox.checked = !roleCheckbox.checked;
    }
    return;
  }

  const input = e.target.closest('.drive-folder-input');
  if (!input) return;
  const row = e.target.closest('.membership-member');
  const email = row.dataset.email;
  const savedIndicator = row.querySelector('.drive-folder-saved');
  savedIndicator.hidden = true;

  const typedLabel = input.value.trim();
  let folderId = null;
  if (typedLabel) {
    const driveFolderOptions = await loadDriveFolderOptions();
    const match = driveFolderOptions.find(o => o.label === typedLabel);
    if (!match) {
      window.alert(`Nie znaleziono folderu "${typedLabel}" na liście. Wybierz jedną z podpowiedzi.`);
      return;
    }
    folderId = match.folderId;
  }

  try {
    await apiFetch(
      '/admin/members/drive-folder',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, folderId }) },
      showReauth,
      hideReauth,
    );
    savedIndicator.hidden = false;
    const cached = membershipMembersCache.members.find(m => m.email === email);
    if (cached) cached.driveFolderId = folderId;
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
    const sheetSyncStatus = await postMembershipTransition(email, transition);
    const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
    if (sheetWarning) window.alert(sheetWarning);
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});
