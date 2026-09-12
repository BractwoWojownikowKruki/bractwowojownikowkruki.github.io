// Publiczne wizytówki (KRKG-0049): the public About-Us people (photos/description/order/category)
// shown on the "My, Wojownicy" pages. Split out of the original single-page admin.js.
// showReauth/hideReauth/escapeHtml/escapeAttr come from ../admin-shared.js, loaded before this file.

// Icon-only Historia button (.audyt-history-btn, style.css) - same path everywhere it appears
// site-wide (nav.js's 'history' icon, zarzadzanie-ludzmi/index.html, galerie/app.js, ...).
const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadManageList();
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

// Uploads every file in fileList to folderId, sequentially (simplicity over throughput - this
// codebase's other upload flow, dodaj-galerie.js, uses bounded concurrency for large albums,
// but a person's photo set here is small enough that sequential is fine). onProgress(n), if
// given, is called after each file with the count uploaded so far.
async function uploadPhotos(folderId, fileList, onProgress) {
  const photos = [];
  let uploaded = 0;
  for (const file of fileList) {
    const result = await apiFetch(
      `/admin/people/photo?folderId=${encodeURIComponent(folderId)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
      { method: 'POST', body: file },
      showReauth,
      hideReauth,
    );
    photos.push({ ...result.photo, localUrl: result.photo.url === null ? URL.createObjectURL(file) : null });
    uploaded++;
    onProgress?.(uploaded);
  }
  return photos;
}

document.getElementById('manage-category').addEventListener('change', loadManageList);

// Valid "transfer this photo to" targets: existing people in the 3 categories a photo could
// reasonably belong to (Emeryci excluded per spec - retired warriors aren't where a fresh
// upload-staging photo should ever land; upload/deleted excluded since those aren't existing
// published profiles). Fetched fresh on every loadManageList() call rather than cached across
// them, so a person added/moved/renamed a moment ago always shows up correctly.
const TRANSFER_TARGET_CATEGORIES = ['Blachowi', 'Niewiasty', 'Kandydaci'];
let transferTargetsCache = [];

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
    transferTargetsCache = transferTargets;
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

// Apply Review (KRKG-0070, gpt-5 v5.0 round): all 4 public categories are valid approve targets
// (unlike TRANSFER_TARGET_CATEGORIES above, which deliberately excludes Emeryci for a different
// reason - transferring into an existing retired-warrior profile isn't where a *fresh* upload
// should default). Approving into Emeryci as someone's first-ever public profile is a normal,
// legitimate admin choice the UI must not block.
const APPROVE_TARGET_CATEGORIES = ['Blachowi', 'Niewiasty', 'Emeryci', 'Kandydaci'];

function approveTargetCategoryOptionsHtml() {
  return APPROVE_TARGET_CATEGORIES.map(category => `<option value="${category}">${category}</option>`).join('');
}

function photoItemHtml(folderId, photo, isMain, transferTargets) {
  const imageUrl = photo.url ?? photo.localUrl;
  return `
    <div class="manage-photo-item" data-file-id="${escapeAttr(photo.id)}" style="display:inline-block; text-align:center; margin:0 0.5rem 0.5rem 0; vertical-align:top; width:100px;">
      <img src="${escapeAttr(imageUrl)}" alt="${photo.url === null ? 'Miniatura zdjęcia będzie dostępna później' : ''}" style="width:100px; height:100px; object-fit:cover; border-radius:4px; display:block; border:1px solid var(--border);" />
      <div class="main-photo-control" style="font-size:11px; margin-top:2px;">
        ${
          isMain
            ? '<strong>Główne</strong>'
            : `<button class="set-main-photo" data-folder-id="${folderId}" data-file-id="${photo.id}">Ustaw główne</button>`
        }
      </div>
      <button class="delete-photo" data-folder-id="${folderId}" data-file-id="${photo.id}" style="color:var(--accent); font-size:11px; margin-top:2px;">Usuń zdjęcie</button>
      <div style="margin-top:4px;">
        <select class="transfer-target" data-file-id="${photo.id}" style="width:100%; font-size:11px;">
          <option value="">Transferuj do...</option>
          ${transferTargetOptionsHtml(transferTargets, folderId)}
        </select>
        <button class="transfer-photo" data-file-id="${photo.id}" style="font-size:11px; margin-top:2px;">Transferuj</button>
      </div>
    </div>`;
}

function personCardId(folderId) {
  return `manage-person-${encodeURIComponent(folderId)}`;
}

function personCardHtml(p) {
  const currentCategory = document.getElementById('manage-category').value;
      const allPhotos = [
        ...(p.mainPhoto ? [{ ...p.mainPhoto, isMain: true }] : []),
        ...p.photos.map(photo => ({ ...photo, isMain: false })),
      ];
      const photosHtml = allPhotos.length
        ? allPhotos.map(photo => photoItemHtml(p.folderId, photo, photo.isMain, transferTargetsCache)).join('')
        : '<p style="color:var(--text-muted); font-size:13px;">Brak zdjęć.</p>';
      return `
    <div id="${personCardId(p.folderId)}" class="manage-person-card" data-folder-id="${escapeAttr(p.folderId)}" style="border:1px solid var(--border); border-radius:6px; padding:1rem;">
      <strong class="person-name">${escapeHtml(p.name)}</strong>
      <a class="audyt-history-btn" style="margin-left:0.5rem; vertical-align:middle;" href="/admin/audyt/?resourceKey=${encodeURIComponent(`person:${p.folderId}`)}" title="Historia" aria-label="Historia">${HISTORY_ICON}</a>
      <div class="person-photos" style="margin:0.5rem 0;">${photosHtml}</div>
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
}

// KRKG-0070 (addendum): the "Upload (zgłoszenia)" category gets its own per-person card, entirely
// different from personCardHtml above - one submission is reviewed as a whole (pick photos, set
// name/category once), not photo-by-photo. Photos render at the same size they'd have on the
// public page (.person-main-photo/.person-gallery, same classes profile-panel.js/o-nas.js use).
// `p.publicName`/`p.publicDescription`/`p.publicFolderId` come from the enriched
// GET /admin/people?category=upload response (server.ts's enrichUploadEntryWithPublicStatus):
// publicFolderId === null means this member has no public folder yet - name/category are
// required and typed in here; otherwise they're already fixed and shown read-only (edit them via
// the person's own card in their actual category instead), and only photo selection is
// meaningful. Review (batch 3/3): a checkbox alone gave the admin no way to remove a bad pending
// photo before approving anything, so each photo also gets its own "Usuń" button, reusing the
// existing admin DELETE /admin/people/photo (same endpoint personCardHtml's .delete-photo uses).
function uploadPhotoPickHtml(folderId, photo, isMain) {
  return `
    <div class="upload-photo-item${isMain ? ' person-main-photo' : ''}" data-file-id="${escapeAttr(photo.id)}" style="position:relative; display:inline-block;">
      <input type="checkbox" class="upload-photo-select" data-file-id="${escapeAttr(photo.id)}" style="position:absolute; top:6px; left:6px; width:18px; height:18px; z-index:1;" />
      <img src="${escapeAttr(photo.url)}" alt="" />
      <button type="button" class="delete-pending-photo" data-folder-id="${escapeAttr(folderId)}" data-file-id="${escapeAttr(photo.id)}" style="position:absolute; bottom:4px; right:4px; z-index:1; font-size:10px; color:var(--accent); background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:2px 4px; cursor:pointer;">Usuń</button>
    </div>`;
}

// Review (batch 3/3): extracted so a successful first-time approve can flip a card from the
// editable variant to this read-only one in place, without a full list reload - see the
// approve-batch click handler below.
function uploadReadOnlyFieldsHtml(name, description) {
  return `
    <div class="upload-fields">
      <p style="margin:0.5rem 0;"><strong>Nazwa publiczna:</strong> ${escapeHtml(name ?? '')}</p>
      ${description ? `<p style="margin:0.5rem 0; white-space:pre-wrap;"><strong>Opis:</strong> ${escapeHtml(description)}</p>` : ''}
      <p style="margin:0.5rem 0; color:var(--text-muted); font-size:12px;">Osoba ma już publiczny profil - nazwę i opis edytuje się z jej karty we właściwej kategorii.</p>
    </div>`;
}

function uploadEditableFieldsHtml() {
  return `
    <div class="upload-fields">
      <label style="display:block; margin:0.5rem 0;">Nazwa publiczna
        <input type="text" class="upload-public-name" required style="display:block; width:100%; margin-top:4px;" />
      </label>
      <label style="display:block; margin:0.5rem 0;">Opis (opcjonalnie)
        <textarea class="upload-public-description" rows="4" style="display:block; width:100%; margin-top:4px;"></textarea>
      </label>
      <label style="display:block; margin:0.5rem 0;">Kategoria
        <select class="upload-target-category" style="display:block; width:100%; margin-top:4px;">
          ${approveTargetCategoryOptionsHtml()}
        </select>
      </label>
    </div>`;
}

function uploadPersonCardHtml(p) {
  const galleryHtml = p.photos.length
    ? `<div class="person-gallery">${p.photos.map(photo => uploadPhotoPickHtml(p.folderId, photo, false)).join('')}</div>`
    : '';
  const isPublished = !!p.publicFolderId;
  const nameDescHtml = isPublished ? uploadReadOnlyFieldsHtml(p.publicName, p.publicDescription) : uploadEditableFieldsHtml();
  return `
    <div id="${personCardId(p.folderId)}" class="manage-person-card" data-folder-id="${escapeAttr(p.folderId)}" data-public-folder-id="${escapeAttr(p.publicFolderId ?? '')}" style="border:1px solid var(--border); border-radius:6px; padding:1rem;">
      <strong class="person-name">${escapeHtml(p.name)}</strong>
      <a class="audyt-history-btn" style="margin-left:0.5rem; vertical-align:middle;" href="/admin/audyt/?resourceKey=${encodeURIComponent(`person:${p.folderId}`)}" title="Historia" aria-label="Historia">${HISTORY_ICON}</a>
      <div class="person-photos" style="margin:0.5rem 0;">
        ${p.mainPhoto ? uploadPhotoPickHtml(p.folderId, p.mainPhoto, true) : ''}
        ${galleryHtml}
      </div>
      ${nameDescHtml}
      <button class="approve-batch" data-folder-id="${p.folderId}" data-public-folder-id="${escapeAttr(p.publicFolderId ?? '')}">Przenieś</button>
    </div>`;
}

function renderManageList(people, transferTargets) {
  const list = document.getElementById('manage-people-list');
  transferTargetsCache = transferTargets;
  const currentCategory = document.getElementById('manage-category').value;
  const renderCard = currentCategory === 'upload' ? uploadPersonCardHtml : personCardHtml;
  list.innerHTML = people.length ? people.map(renderCard).join('') : '<p>Brak osób w tej kategorii.</p>';
}

function personCard(folderId) {
  return document.getElementById(personCardId(folderId));
}

async function confirmedPersonWrite(control, card, execute, apply, anchor = card) {
  return window.MutationFeedback.confirmed({
    control, anchor, execute, apply, viewRoot: document.getElementById('manage-people-list'), refreshFragment: loadManageList,
  });
}

document.getElementById('manage-people-list').addEventListener('click', async e => {
  try {
  const saveBtn = e.target.closest('.save-description');
  if (saveBtn) {
    const folderId = saveBtn.dataset.folderId;
    const textarea = document.querySelector(`.edit-description[data-folder-id="${folderId}"]`);
    await confirmedPersonWrite(saveBtn, personCard(folderId), () => apiFetch(
      `/admin/people/description?folderId=${encodeURIComponent(folderId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: textarea.value }) },
      showReauth, hideReauth,
    ), () => {});
    return;
  }
  const deleteBtn = e.target.closest('.delete-person');
  if (deleteBtn) {
    if (!window.confirm('Na pewno usunąć tę osobę?')) return;
    const folderId = deleteBtn.dataset.folderId;
    const card = personCard(folderId);
    await confirmedPersonWrite(deleteBtn, card, () => apiFetch(`/admin/people?folderId=${encodeURIComponent(folderId)}`, { method: 'DELETE' }, showReauth, hideReauth), () => {
      card.remove();
      const list = document.getElementById('manage-people-list');
      if (!list.querySelector('.manage-person-card')) list.innerHTML = '<p>Brak osób w tej kategorii.</p>';
    }, document.getElementById('manage-people-list'));
    return;
  }
  const saveOrderBtn = e.target.closest('.save-order');
  if (saveOrderBtn) {
    const folderId = saveOrderBtn.dataset.folderId;
    const nameInput = document.querySelector(`.edit-name[data-folder-id="${folderId}"]`);
    const orderInput = document.querySelector(`.edit-order[data-folder-id="${folderId}"]`);
    const order = orderInput.value === '' ? null : Number(orderInput.value);
    await confirmedPersonWrite(saveOrderBtn, personCard(folderId), () => apiFetch(
      '/admin/people/order',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, name: nameInput.value, order }),
      },
      showReauth, hideReauth,
    ), () => { personCard(folderId).querySelector('.person-name').textContent = nameInput.value.trim(); });
    return;
  }
  const moveBtn = e.target.closest('.move-person');
  if (moveBtn) {
    const folderId = moveBtn.dataset.folderId;
    const select = document.querySelector(`.move-category[data-folder-id="${folderId}"]`);
    const card = personCard(folderId);
    await confirmedPersonWrite(moveBtn, card, () => apiFetch(
      '/admin/people/category',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, category: select.value }),
      },
      showReauth, hideReauth,
    ), () => { if (select.value !== document.getElementById('manage-category').value) card.remove(); }, document.getElementById('manage-people-list'));
    return;
  }
  const deletePhotoBtn = e.target.closest('.delete-photo');
  if (deletePhotoBtn) {
    if (!window.confirm('Na pewno usunąć to zdjęcie?')) return;
    const item = deletePhotoBtn.closest('.manage-photo-item');
    await confirmedPersonWrite(deletePhotoBtn, personCard(deletePhotoBtn.dataset.folderId), () => apiFetch(
      `/admin/people/photo?fileId=${encodeURIComponent(deletePhotoBtn.dataset.fileId)}&folderId=${encodeURIComponent(deletePhotoBtn.dataset.folderId)}`,
      { method: 'DELETE' },
      showReauth, hideReauth,
    ), () => item.remove());
    return;
  }
  const setMainBtn = e.target.closest('.set-main-photo');
  if (setMainBtn) {
    const card = personCard(setMainBtn.dataset.folderId);
    await confirmedPersonWrite(setMainBtn, card, () => apiFetch(
      '/admin/people/photo/main',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: setMainBtn.dataset.folderId, fileId: setMainBtn.dataset.fileId }),
      },
      showReauth, hideReauth,
    ), () => {
      const prior = card.querySelector('.main-photo-control strong')?.closest('.main-photo-control');
      if (prior) prior.innerHTML = `<button class="set-main-photo" data-folder-id="${setMainBtn.dataset.folderId}" data-file-id="${prior.closest('.manage-photo-item').dataset.fileId}">Ustaw główne</button>`;
      setMainBtn.closest('.main-photo-control').innerHTML = '<strong>Główne</strong>';
    });
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
    const item = transferBtn.closest('.manage-photo-item');
    await confirmedPersonWrite(transferBtn, personCard(item.closest('.manage-person-card').dataset.folderId), () => apiFetch(
      '/admin/people/photo/transfer',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, targetFolderId: select.value }),
      },
      showReauth, hideReauth,
    ), () => item.remove());
    return;
  }
  const deletePendingBtn = e.target.closest('.delete-pending-photo');
  if (deletePendingBtn) {
    if (!window.confirm('Na pewno usunąć to zdjęcie ze zgłoszenia?')) return;
    const folderId = deletePendingBtn.dataset.folderId;
    const fileId = deletePendingBtn.dataset.fileId;
    const card = personCard(folderId);
    const item = deletePendingBtn.closest('.upload-photo-item');
    const list = document.getElementById('manage-people-list');
    await confirmedPersonWrite(deletePendingBtn, card, () => apiFetch(
      `/admin/people/photo?fileId=${encodeURIComponent(fileId)}&folderId=${encodeURIComponent(folderId)}`,
      { method: 'DELETE' },
      showReauth, hideReauth,
    ), () => {
      item.remove();
      if (!card.querySelector('.upload-photo-item')) {
        card.remove();
        if (!list.querySelector('.manage-person-card')) list.innerHTML = '<p>Brak osób w tej kategorii.</p>';
      }
    }, list);
    return;
  }
  const approveBatchBtn = e.target.closest('.approve-batch');
  if (approveBatchBtn) {
    const folderId = approveBatchBtn.dataset.folderId;
    const card = personCard(folderId);
    const list = document.getElementById('manage-people-list');
    const checked = Array.from(card.querySelectorAll('.upload-photo-select:checked'));
    if (!checked.length) {
      window.alert('Zaznacz co najmniej jedno zdjęcie do przeniesienia.');
      return;
    }
    const fileIds = checked.map(cb => cb.dataset.fileId);
    const wasPublished = !!approveBatchBtn.dataset.publicFolderId;
    const body = { fileIds, stagingFolderId: folderId };
    let enteredName = '';
    let enteredDescription = '';
    if (!wasPublished) {
      const nameInput = card.querySelector('.upload-public-name');
      // KRKG-0070 addendum: the public name is never pre-filled from the staging folder's own
      // name, MemberDoc, or anything else - it is only ever what the admin explicitly typed here,
      // and is required for a first-time publish (the field only exists in the DOM at all when
      // wasPublished is false, so there is nothing to accidentally send once a folder exists).
      enteredName = nameInput.value.trim();
      if (!enteredName) {
        window.alert('Podaj nazwę publiczną.');
        return;
      }
      enteredDescription = card.querySelector('.upload-public-description').value.trim();
      body.name = enteredName;
      body.description = enteredDescription || undefined;
      body.targetCategory = card.querySelector('.upload-target-category').value;
    }
    await confirmedPersonWrite(approveBatchBtn, card, () => apiFetch(
      '/admin/people/photo/approve',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      showReauth,
      hideReauth,
    ), ({ folderId: newPublicFolderId }) => {
      fileIds.forEach(fileId => card.querySelector(`.upload-photo-item[data-file-id="${fileId}"]`)?.remove());
      if (!wasPublished) {
        // Review (batch 3/3): the public folder now exists after this first successful batch -
        // flip the card to the read-only variant in place, so approving a second, partial batch
        // of the remaining photos doesn't keep sending (and the backend keep silently ignoring) a
        // name/description/category the admin already committed on the first click.
        card.dataset.publicFolderId = newPublicFolderId;
        approveBatchBtn.dataset.publicFolderId = newPublicFolderId;
        card.querySelector('.upload-fields').outerHTML = uploadReadOnlyFieldsHtml(enteredName, enteredDescription || null);
      }
      if (!card.querySelector('.upload-photo-item')) {
        card.remove();
        if (!list.querySelector('.manage-person-card')) list.innerHTML = '<p>Brak osób w tej kategorii.</p>';
      }
    }, list);
    return;
  }
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});

document.getElementById('manage-people-list').addEventListener('change', async e => {
  try {
  const uploadInput = e.target.closest('.upload-photo');
  if (uploadInput) {
    if (!uploadInput.files.length) return;
    const card = personCard(uploadInput.dataset.folderId);
    await confirmedPersonWrite(uploadInput, card, () => uploadPhotos(uploadInput.dataset.folderId, uploadInput.files), photos => {
      const photosRoot = card.querySelector('.person-photos');
      photos.forEach(photo => photosRoot.insertAdjacentHTML('beforeend', photoItemHtml(uploadInput.dataset.folderId, photo, false, transferTargetsCache)));
      uploadInput.value = '';
    });
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
    await confirmedPersonWrite(inMemoriamCheckbox, personCard(inMemoriamCheckbox.dataset.folderId), () => apiFetch(
      '/admin/people/in-memoriam',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: inMemoriamCheckbox.dataset.folderId, inMemoriam: nowChecked }),
      },
      showReauth, hideReauth,
    ), () => {});
  }
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});
