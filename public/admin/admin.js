// The admin panel is one long page (Cache, Facebook, Redirects, membership, people management...)
// and #admin-reauth sits right at the top, above admin-panel - a step-up action triggered from
// deep in the page (e.g. "Usuń" in the membership section) otherwise reveals the prompt entirely
// out of the viewport, so the admin never sees it, never clicks it, and the paused apiFetch retry
// never fires - looking exactly like the action silently did nothing. scrollIntoView matches the
// same pattern this codebase's error banners already use (see wyjazd.js/skladki.js's showError).
function showReauth() {
  const reauth = document.getElementById('admin-reauth');
  reauth.hidden = false;
  reauth.scrollIntoView({ block: 'center' });
}
function hideReauth() {
  document.getElementById('admin-reauth').hidden = true;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadManageList();
    loadFacebookSettings();
    loadRedirects();
    loadMembershipApplications();
    loadMembershipMembers();
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
  const status = document.getElementById('refresh-social-cache-status');
  status.textContent = 'Odświeżanie...';
  try {
    await apiFetch('/admin/social-media/refresh', { method: 'POST' }, showReauth, hideReauth);
    status.textContent =
      'Cache serwera wyczyszczony - kolejne wczytanie strony głównej pobierze świeże posty (przeglądarka, która ma już zapisaną stronę we własnej pamięci podręcznej, może wymagać twardego odświeżenia).';
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
    await apiFetch(
      '/admin/settings',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liveFetchPostCount }) },
      showReauth,
      hideReauth,
    );
    status.textContent = 'Zapisano.';
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
  list.innerHTML = redirects
    .map(
      r => `
    <div style="display:flex; gap:0.5rem; align-items:center; padding:0.4rem 0; border-bottom:1px solid var(--border);">
      <code>/${escapeHtml(r.path)}</code>
      <span>&rarr;</span>
      <span style="flex:1; overflow-wrap:anywhere;">${escapeHtml(r.target)}</span>
      <button class="delete-redirect" data-path="${escapeAttr(r.path)}" style="color:var(--accent);">Usuń</button>
    </div>`,
    )
    .join('');
}

document.getElementById('add-redirect-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('add-redirect-status');
  status.textContent = 'Zapisywanie...';
  const path = document.getElementById('redirect-path').value.trim().toLowerCase();
  const target = document.getElementById('redirect-target').value.trim();
  try {
    await apiFetch(
      '/admin/redirects',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, target }) },
      showReauth,
      hideReauth,
    );
    status.textContent = 'Dodano przekierowanie.';
    document.getElementById('add-redirect-form').reset();
    loadRedirects();
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

document.getElementById('redirects-list').addEventListener('click', async e => {
  const deleteBtn = e.target.closest('.delete-redirect');
  if (!deleteBtn) return;
  if (!window.confirm(`Na pewno usunąć przekierowanie /${deleteBtn.dataset.path}?`)) return;
  await apiFetch(`/admin/redirects?path=${encodeURIComponent(deleteBtn.dataset.path)}`, { method: 'DELETE' }, showReauth, hideReauth);
  loadRedirects();
});

function sheetSyncStatusMessage(status) {
  if (status === 'failed') return 'Zapisano, ale nie udało się zaktualizować kopii w arkuszu - użyj przycisku Synchronizuj.';
  if (status === 'not_configured') return 'Backup arkusza nie jest skonfigurowany.';
  return null;
}

// KRKG-0046: sends one status-transition request, then reloads both membership lists - a single
// transition (e.g. approve) always moves a record out of one list and into the other. Returns
// the response's sheetSyncStatus so callers can surface a non-blocking warning if it failed -
// the transition itself has already succeeded (Firestore is authoritative) regardless.
async function postMembershipTransition(email, transition) {
  const { sheetSyncStatus } = await apiFetch(
    '/admin/members/transition',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, transition }) },
    showReauth,
    hideReauth,
  );
  loadMembershipApplications();
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

async function loadMembershipApplications() {
  const list = document.getElementById('membership-applications-list');
  list.textContent = 'Ładowanie...';
  try {
    const { members } = await apiFetch('/admin/members?status=pending', { method: 'GET' }, showReauth, hideReauth);
    renderMembershipApplications(members);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function renderMembershipApplications(members) {
  const list = document.getElementById('membership-applications-list');
  if (!members.length) {
    list.innerHTML = '<p>Brak oczekujących zgłoszeń.</p>';
    return;
  }
  list.innerHTML = members
    .map(
      m => `
    <div class="membership-application" data-email="${escapeAttr(m.email)}" style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; padding:0.5rem 0; border-bottom:1px solid var(--border);">
      <div style="flex:1; min-width:200px;">
        <strong>${escapeHtml(m.fullName)}</strong>${m.nickname ? ` (${escapeHtml(m.nickname)})` : ''}
        <br><span style="color:var(--text-muted);">${escapeHtml(m.email)} - ${escapeHtml(m.sectionId)}</span>
      </div>
      <button class="approve-application" style="color:var(--gold);">Zatwierdź</button>
      <button class="reject-application" style="color:var(--accent);">Odrzuć</button>
    </div>`,
    )
    .join('');
}

// try/catch here (missing before this fix) matters beyond the step-up 401 case fixed above in
// showReauth: without it, any other failure (network blip, 403 from a role change, 500) rejected
// silently - the confirm dialog closes and the click just looks like it did nothing, the same
// symptom reported for "Usuń", just from a different cause.
document.getElementById('membership-applications-list').addEventListener('click', async e => {
  const row = e.target.closest('.membership-application');
  if (!row) return;
  const email = row.dataset.email;
  try {
    if (e.target.closest('.approve-application')) {
      const sheetSyncStatus = await postMembershipTransition(email, 'approve');
      const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
      window.alert(
        `Zatwierdzono ${email}. Pamiętaj, aby dodać tę osobę ręcznie do grupy Google (Docs/Sheets/Drive).` +
          (sheetWarning ? `\n\n${sheetWarning}` : ''),
      );
    } else if (e.target.closest('.reject-application')) {
      if (!window.confirm(`Na pewno odrzucić zgłoszenie ${email}?`)) return;
      const sheetSyncStatus = await postMembershipTransition(email, 'reject');
      const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
      if (sheetWarning) window.alert(sheetWarning);
    }
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});

const MEMBERSHIP_ACTIONS_BY_STATUS = {
  active: [{ transition: 'suspend', label: 'Zawieś' }, { transition: 'remove', label: 'Usuń' }],
  suspended: [{ transition: 'reactivate', label: 'Przywróć' }, { transition: 'remove', label: 'Usuń' }],
  removed: [],
  rejected: [],
};

async function loadMembershipMembers() {
  const status = document.getElementById('membership-status-filter').value;
  const list = document.getElementById('membership-members-list');
  list.textContent = 'Ładowanie...';
  try {
    const { members } = await apiFetch(`/admin/members?status=${encodeURIComponent(status)}`, { method: 'GET' }, showReauth, hideReauth);
    renderMembershipMembers(members, status);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function renderMembershipMembers(members, status) {
  const list = document.getElementById('membership-members-list');
  if (!members.length) {
    list.innerHTML = '<p>Brak członków w tym statusie.</p>';
    return;
  }
  const actions = MEMBERSHIP_ACTIONS_BY_STATUS[status] ?? [];
  list.innerHTML = members
    .map(
      m => `
    <div class="membership-member" data-email="${escapeAttr(m.email)}" style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; padding:0.5rem 0; border-bottom:1px solid var(--border);">
      <div style="flex:1; min-width:200px;">
        <strong>${escapeHtml(m.fullName)}</strong>${m.nickname ? ` (${escapeHtml(m.nickname)})` : ''}
        <br><span style="color:var(--text-muted);">${escapeHtml(m.email)} - ${escapeHtml(m.sectionId)}</span>
      </div>
      ${actions.map(a => `<button class="member-action" data-transition="${a.transition}" style="color:var(--gold);">${a.label}</button>`).join('')}
    </div>`,
    )
    .join('');
}

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

// Uploads every file in fileList to folderId, sequentially (simplicity over throughput - this
// codebase's other upload flow, dodaj-galerie.js, uses bounded concurrency for large albums,
// but a person's photo set here is small enough that sequential is fine). onProgress(n), if
// given, is called after each file with the count uploaded so far.
async function uploadPhotos(folderId, fileList, onProgress) {
  let uploaded = 0;
  for (const file of fileList) {
    await apiFetch(
      `/admin/people/photo?folderId=${encodeURIComponent(folderId)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
      { method: 'POST', body: file },
      showReauth,
      hideReauth,
    );
    uploaded++;
    onProgress?.(uploaded);
  }
}

document.getElementById('add-person-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('add-person-status');
  status.textContent = 'Zapisywanie...';
  const category = document.getElementById('person-category').value;
  const name = document.getElementById('person-name').value.trim();
  const orderRaw = document.getElementById('person-order').value;
  const order = orderRaw === '' ? null : Number(orderRaw);
  const description = document.getElementById('person-description').value.trim();
  const photoFiles = document.getElementById('person-photos').files;

  try {
    const { folderId } = await apiFetch(
      '/admin/people',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, name, order, description }),
      },
      showReauth,
      hideReauth,
    );
    if (photoFiles.length) {
      status.textContent = `Dodano osobę, przesyłanie zdjęć (0/${photoFiles.length})...`;
      await uploadPhotos(folderId, photoFiles, uploaded => {
        status.textContent = `Dodano osobę, przesyłanie zdjęć (${uploaded}/${photoFiles.length})...`;
      });
    }
    status.textContent = 'Dodano osobę.';
    document.getElementById('add-person-form').reset();
    loadManageList();
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

document.getElementById('manage-category').addEventListener('change', loadManageList);

// Valid "transfer this photo to" targets: existing people in the 3 categories a photo could
// reasonably belong to (Emeryci excluded per spec - retired warriors aren't where a fresh
// upload-staging photo should ever land; upload/deleted excluded since those aren't existing
// published profiles). Fetched fresh on every loadManageList() call rather than cached across
// them, so a person added/moved/renamed a moment ago always shows up correctly.
const TRANSFER_TARGET_CATEGORIES = ['Blachowi', 'Niewiasty', 'Kandydaci'];

async function loadTransferTargets() {
  const results = await Promise.all(
    TRANSFER_TARGET_CATEGORIES.map(category =>
      apiFetch(`/admin/people?category=${encodeURIComponent(category)}`, { method: 'GET' }, showReauth, hideReauth),
    ),
  );
  const targets = [];
  results.forEach((data, i) => {
    for (const p of data.people || []) {
      targets.push({ folderId: p.folderId, path: `${TRANSFER_TARGET_CATEGORIES[i]} / ${p.name}` });
    }
  });
  return targets;
}

async function loadManageList() {
  const category = document.getElementById('manage-category').value;
  const list = document.getElementById('manage-people-list');
  list.textContent = 'Ładowanie...';
  try {
    const [data, transferTargets] = await Promise.all([
      apiFetch(`/admin/people?category=${encodeURIComponent(category)}`, { method: 'GET' }, showReauth, hideReauth),
      loadTransferTargets(),
    ]);
    renderManageList(data.people || [], transferTargets);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

const DEPARTMENT_OPTIONS = [
  ['Blachowi', 'Blachowi'],
  ['Niewiasty', 'Niewiasty'],
  ['Emeryci', 'Emeryci'],
  ['Kandydaci', 'Kandydaci'],
  ['upload', 'Upload (zgłoszenia)'],
  ['deleted', 'Usunięci'],
];

function departmentOptionsHtml(selected) {
  return DEPARTMENT_OPTIONS.map(
    ([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`,
  ).join('');
}

function transferTargetOptionsHtml(transferTargets, excludeFolderId) {
  return transferTargets
    .filter(t => t.folderId !== excludeFolderId)
    .map(t => `<option value="${escapeAttr(t.folderId)}">${escapeHtml(t.path)}</option>`)
    .join('');
}

function photoItemHtml(folderId, photo, isMain, transferTargets) {
  return `
    <div class="manage-photo-item" style="display:inline-block; text-align:center; margin:0 0.5rem 0.5rem 0; vertical-align:top; width:100px;">
      <img src="${photo.url}" alt="" style="width:100px; height:100px; object-fit:cover; border-radius:4px; display:block; border:1px solid var(--border);" />
      <div style="font-size:11px; margin-top:2px;">
        ${
          isMain
            ? '<strong>Główne</strong>'
            : `<button class="set-main-photo" data-folder-id="${folderId}" data-file-id="${photo.id}">Ustaw główne</button>`
        }
      </div>
      <button class="delete-photo" data-file-id="${photo.id}" style="color:var(--accent); font-size:11px; margin-top:2px;">Usuń zdjęcie</button>
      <div style="margin-top:4px;">
        <select class="transfer-target" data-file-id="${photo.id}" style="width:100%; font-size:11px;">
          <option value="">Transferuj do...</option>
          ${transferTargetOptionsHtml(transferTargets, folderId)}
        </select>
        <button class="transfer-photo" data-file-id="${photo.id}" style="font-size:11px; margin-top:2px;">Transferuj</button>
      </div>
    </div>`;
}

function renderManageList(people, transferTargets) {
  const list = document.getElementById('manage-people-list');
  const currentCategory = document.getElementById('manage-category').value;
  if (!people.length) {
    list.innerHTML = '<p>Brak osób w tej kategorii.</p>';
    return;
  }
  list.innerHTML = people
    .map(p => {
      const allPhotos = [
        ...(p.mainPhoto ? [{ ...p.mainPhoto, isMain: true }] : []),
        ...p.photos.map(photo => ({ ...photo, isMain: false })),
      ];
      const photosHtml = allPhotos.length
        ? allPhotos.map(photo => photoItemHtml(p.folderId, photo, photo.isMain, transferTargets)).join('')
        : '<p style="color:var(--text-muted); font-size:13px;">Brak zdjęć.</p>';
      return `
    <div style="border:1px solid var(--border); border-radius:6px; padding:1rem;">
      <strong>${escapeHtml(p.name)}</strong>
      <div style="margin:0.5rem 0;">${photosHtml}</div>
      <textarea class="edit-description" data-folder-id="${p.folderId}" rows="6" style="width:100%; margin:0.5rem 0;">${escapeHtml(p.description)}</textarea>
      <button class="save-description" data-folder-id="${p.folderId}">Zapisz opis</button>

      <div style="display:flex; gap:0.5rem; align-items:flex-end; flex-wrap:wrap; margin:0.75rem 0;">
        <label>Imię
          <input type="text" class="edit-name" data-folder-id="${p.folderId}" value="${escapeAttr(p.name)}" style="display:block; margin-top:4px;" />
        </label>
        <label>Kolejność
          <input type="number" min="0" class="edit-order" data-folder-id="${p.folderId}" value="${p.order ?? ''}" style="display:block; width:90px; margin-top:4px;" />
        </label>
        <button class="save-order" data-folder-id="${p.folderId}">Zapisz</button>
      </div>

      <div style="display:flex; gap:0.5rem; align-items:flex-end; margin:0.75rem 0;">
        <label>Przenieś do
          <select class="move-category" data-folder-id="${p.folderId}" style="display:block; margin-top:4px;">
            ${departmentOptionsHtml(currentCategory)}
          </select>
        </label>
        <button class="move-person" data-folder-id="${p.folderId}">Przenieś</button>
      </div>

      <label style="display:block; margin:0.75rem 0;">
        <input type="checkbox" class="toggle-in-memoriam" data-folder-id="${p.folderId}" ${p.inMemoriam ? 'checked' : ''} />
        Oznacz jako in memoriam (zdjęcia czarno-białe z czarną wstęgą)
      </label>

      <input type="file" class="upload-photo" data-folder-id="${p.folderId}" accept="image/*" multiple style="display:block; margin:0.5rem 0;" />
      <button class="delete-person" data-folder-id="${p.folderId}" style="color:var(--accent);">Usuń osobę</button>
    </div>`;
    })
    .join('');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

document.getElementById('manage-people-list').addEventListener('click', async e => {
  const saveBtn = e.target.closest('.save-description');
  if (saveBtn) {
    const folderId = saveBtn.dataset.folderId;
    const textarea = document.querySelector(`.edit-description[data-folder-id="${folderId}"]`);
    await apiFetch(
      `/admin/people/description?folderId=${encodeURIComponent(folderId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: textarea.value }) },
      showReauth,
      hideReauth,
    );
    loadManageList();
    return;
  }
  const deleteBtn = e.target.closest('.delete-person');
  if (deleteBtn) {
    if (!window.confirm('Na pewno usunąć tę osobę?')) return;
    const folderId = deleteBtn.dataset.folderId;
    await apiFetch(`/admin/people?folderId=${encodeURIComponent(folderId)}`, { method: 'DELETE' }, showReauth, hideReauth);
    loadManageList();
    return;
  }
  const saveOrderBtn = e.target.closest('.save-order');
  if (saveOrderBtn) {
    const folderId = saveOrderBtn.dataset.folderId;
    const nameInput = document.querySelector(`.edit-name[data-folder-id="${folderId}"]`);
    const orderInput = document.querySelector(`.edit-order[data-folder-id="${folderId}"]`);
    const order = orderInput.value === '' ? null : Number(orderInput.value);
    await apiFetch(
      '/admin/people/order',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, name: nameInput.value, order }),
      },
      showReauth,
      hideReauth,
    );
    loadManageList();
    return;
  }
  const moveBtn = e.target.closest('.move-person');
  if (moveBtn) {
    const folderId = moveBtn.dataset.folderId;
    const select = document.querySelector(`.move-category[data-folder-id="${folderId}"]`);
    await apiFetch(
      '/admin/people/category',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, category: select.value }),
      },
      showReauth,
      hideReauth,
    );
    loadManageList();
    return;
  }
  const deletePhotoBtn = e.target.closest('.delete-photo');
  if (deletePhotoBtn) {
    if (!window.confirm('Na pewno usunąć to zdjęcie?')) return;
    await apiFetch(`/admin/people/photo?fileId=${encodeURIComponent(deletePhotoBtn.dataset.fileId)}`, { method: 'DELETE' }, showReauth, hideReauth);
    loadManageList();
    return;
  }
  const setMainBtn = e.target.closest('.set-main-photo');
  if (setMainBtn) {
    await apiFetch(
      '/admin/people/photo/main',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: setMainBtn.dataset.folderId, fileId: setMainBtn.dataset.fileId }),
      },
      showReauth,
      hideReauth,
    );
    loadManageList();
    return;
  }
  const transferBtn = e.target.closest('.transfer-photo');
  if (transferBtn) {
    const fileId = transferBtn.dataset.fileId;
    const select = document.querySelector(`.transfer-target[data-file-id="${fileId}"]`);
    if (!select.value) {
      window.alert('Wybierz osobę, do której chcesz przenieść zdjęcie.');
      return;
    }
    await apiFetch(
      '/admin/people/photo/transfer',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, targetFolderId: select.value }),
      },
      showReauth,
      hideReauth,
    );
    loadManageList();
  }
});

document.getElementById('manage-people-list').addEventListener('change', async e => {
  const uploadInput = e.target.closest('.upload-photo');
  if (uploadInput) {
    if (!uploadInput.files.length) return;
    await uploadPhotos(uploadInput.dataset.folderId, uploadInput.files);
    uploadInput.value = '';
    loadManageList();
    return;
  }
  const inMemoriamCheckbox = e.target.closest('.toggle-in-memoriam');
  if (inMemoriamCheckbox) {
    const nowChecked = inMemoriamCheckbox.checked;
    const confirmed = window.confirm(
      nowChecked
        ? 'Na pewno oznaczyć tę osobę jako in memoriam? Jej zdjęcia będą pokazywane czarno-białe z czarną wstęgą.'
        : 'Na pewno cofnąć oznaczenie in memoriam dla tej osoby?',
    );
    if (!confirmed) {
      inMemoriamCheckbox.checked = !nowChecked;
      return;
    }
    await apiFetch(
      '/admin/people/in-memoriam',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: inMemoriamCheckbox.dataset.folderId, inMemoriam: nowChecked }),
      },
      showReauth,
      hideReauth,
    );
    loadManageList();
  }
});
