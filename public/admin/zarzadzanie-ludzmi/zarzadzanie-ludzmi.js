// Zarządzanie ludźmi (KRKG-0049): the members table (status, live filter, Drive-folder mapping,
// Zawieś/Usuń/Przywróć, and the new Rola column), plus the Sheets backup sync. Split out of the
// original single-page admin.js. showReauth/hideReauth/escapeHtml/escapeAttr/
// sheetSyncStatusMessage/formatDateTime come from ../admin-shared.js, loaded before this file.
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadMembershipMembers();
    renderRolesAuditLog();
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
// switch or reload - a Map from email to that member's roles array.
async function loadRolesByEmail() {
  const { roles } = await apiFetch('/admin/roles', { method: 'GET' }, showReauth, hideReauth);
  return new Map(roles.map(r => [r.email, r.roles]));
}

// Collapses a roles array down to the single tier this column offers - 'admin' wins over
// 'accountant' if a doc somehow has both, empty/unknown roles show as no assigned role ('').
function roleTier(roles) {
  if (roles && roles.includes('admin')) return 'admin';
  if (roles && roles.includes('accountant')) return 'accountant';
  return '';
}

const ROLE_TIER_LABELS = { '': 'Brak', accountant: 'Księgowy', admin: 'Admin' };

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
let membershipMembersCache = { members: [], status: 'active', driveFolderOptions: [], rolesByEmail: new Map() };

async function loadMembershipMembers() {
  const status = document.getElementById('membership-status-filter').value;
  const list = document.getElementById('membership-members-list');
  list.textContent = 'Ładowanie...';
  try {
    const [{ members }, driveFolderOptions, rolesByEmail] = await Promise.all([
      apiFetch(`/admin/members?status=${encodeURIComponent(status)}`, { method: 'GET' }, showReauth, hideReauth),
      loadDriveFolderOptions(),
      loadRolesByEmail(),
    ]);
    membershipMembersCache = { members, status, driveFolderOptions, rolesByEmail };
    renderMembershipMembers(filterMembershipMembers(members), status, driveFolderOptions, rolesByEmail);
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
  const { members, status, driveFolderOptions, rolesByEmail } = membershipMembersCache;
  renderMembershipMembers(filterMembershipMembers(members), status, driveFolderOptions, rolesByEmail);
});

function roleSelectHtml(email, roles) {
  const tier = roleTier(roles);
  return `
    <select class="member-role" data-email="${escapeAttr(email)}" style="font-size:12px;">
      ${Object.entries(ROLE_TIER_LABELS)
        .map(([value, label]) => `<option value="${value}"${value === tier ? ' selected' : ''}>${label}</option>`)
        .join('')}
    </select>`;
}

function renderMembershipMembers(members, status, driveFolderOptions, rolesByEmail) {
  const list = document.getElementById('membership-members-list');
  if (!members.length) {
    list.innerHTML = '<p>Brak członków w tym statusie.</p>';
    return;
  }
  const actions = MEMBERSHIP_ACTIONS_BY_STATUS[status] ?? [];
  const labelByFolderId = new Map(driveFolderOptions.map(o => [o.folderId, o.label]));
  const datalistHtml = `
    <datalist id="drive-folder-datalist">
      ${driveFolderOptions.map(o => `<option value="${escapeAttr(o.label)}"></option>`).join('')}
    </datalist>`;
  list.innerHTML =
    datalistHtml +
    members
      .map(m => {
        // A driveFolderId pointing at a folder outside the 4 linkable categories (staging
        // "upload"/"deleted", or a folder since removed) has no known label - fall back to the
        // raw id so the field isn't misleadingly blank, matching this codebase's existing
        // convention of showing a raw id rather than hiding an unresolved reference (see
        // KRKG-0037's known-gaps note on raw section-id fallbacks).
        const currentValue = m.driveFolderId ? (labelByFolderId.get(m.driveFolderId) ?? m.driveFolderId) : '';
        return `
    <div class="membership-member" data-email="${escapeAttr(m.email)}" style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; padding:0.3rem 0; border-bottom:1px solid var(--border);">
      <div style="flex:1; min-width:200px;">
        <strong>${escapeHtml(m.fullName)}</strong>${m.nickname ? ` (${escapeHtml(m.nickname)})` : ''}
        <br><span style="color:var(--text-muted);">${escapeHtml(m.email)} - ${escapeHtml(m.sectionId)}</span>
      </div>
      <div style="display:flex; align-items:center; gap:0.4rem;">
        <input
          type="text"
          class="drive-folder-input"
          list="drive-folder-datalist"
          placeholder="Folder na stronie..."
          value="${escapeAttr(currentValue)}"
          style="width:220px; font-size:12px;"
        />
        <span class="drive-folder-saved" style="color:var(--gold);" hidden>✓</span>
      </div>
      ${roleSelectHtml(m.email, rolesByEmail.get(m.email))}
      ${actions.map(a => `<button class="member-action" data-transition="${a.transition}" style="color:var(--gold);">${a.label}</button>`).join('')}
    </div>`;
      })
      .join('');
}

document.getElementById('membership-members-list').addEventListener('change', async e => {
  const roleSelect = e.target.closest('.member-role');
  if (roleSelect) {
    const email = roleSelect.dataset.email;
    const previousTier = roleTier(membershipMembersCache.rolesByEmail.get(email));
    const nextTier = roleSelect.value;
    if (!window.confirm(`Ustawić rolę „${ROLE_TIER_LABELS[nextTier]}” dla ${email}?`)) {
      roleSelect.value = previousTier;
      return;
    }
    try {
      const roles = nextTier ? [nextTier] : [];
      await apiFetch(
        '/admin/roles',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, roles }) },
        showReauth,
        hideReauth,
      );
      membershipMembersCache.rolesByEmail.set(email, roles);
      renderRolesAuditLog();
    } catch (err) {
      window.alert(`Błąd: ${err.message}`);
      roleSelect.value = previousTier;
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
