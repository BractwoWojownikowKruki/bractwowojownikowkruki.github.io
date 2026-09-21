/**
 * Mój profil - member profile form (Plan A, KRKG-0037). Lives at /profil/, separate from the
 * /lista-wyjazdowa/ page (member roster/event sign-up, not yet built - see design.md §8). The
 * backend API routes stay under the /lista-wyjazdowa/* prefix regardless, since that's the
 * feature area's name on the server side, not a statement about which page consumes them.
 *
 * auth.js is a plain (non-module) script that puts initGoogleSignIn/apiFetch/logout in global
 * scope - see how nav.js and wojownicy/wrzuc/wrzuc.js already consume it the same way. There is
 * no ES module export here to `import`, and apiFetch already resolves to the *parsed JSON body*
 * (or throws on a non-2xx response) rather than a raw Response, so callers never call .json()
 * themselves - see auth.js's apiFetch for both of these.
 *
 * initGoogleSignIn has no onSignedOut callback (checked against the real auth.js, not assumed):
 * onForbidden fires both for "never signed in" (401, no session cookie) and "signed in but not
 * an allowlisted kruki member" (403) - see verifySessionRequest/checkAllowlist in
 * upload-service/src/{server,auth}.ts. wrzuc.js's own page relies on exactly this: its
 * "please sign in" panel is the default *visible* HTML state, overwritten by onSignedIn or
 * onForbidden once the server-verified whoami check resolves. This page follows the identical
 * pattern via showOnly(), just funnelled through the same panel-switch helper as every other
 * state instead of manual hidden-toggling.
 */

function showReauth() {
  document.getElementById('lw-reauth').hidden = false;
}
function hideReauth() {
  document.getElementById('lw-reauth').hidden = true;
}

const panels = {
  checking: document.getElementById('profile-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
  form: document.getElementById('profile-form-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

// Default state until the server-verified whoami check (inside initGoogleSignIn, below) resolves
// one way or the other.
showOnly(panels.checking);

function loadLookupLists() {
  return apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth);
}

function loadCurrentSubmission() {
  return apiFetch('/lista-wyjazdowa/profile/photo', { method: 'GET' }, showReauth, hideReauth);
}

// Shows whatever the member has already uploaded (if anything) above the picker, so "did my
// photo actually make it" has a real answer instead of the picker just going blank after save
// (KRKG: driveFolderId/photo-display gap, design.md §6). Nothing here is editable - replacing the
// public photo is still done by picking new files below and saving again.
//
// KRKG-0070: `response` is GET /lista-wyjazdowa/profile/photo's `{ public, pending }` shape - the
// two folders are now permanent and independent, so a member can have a live public photo AND a
// newer pending upload at the same time (design.md). The public section is read-only (same as
// before); the pending section additionally gets a delete button per photo, since deleting from
// one's own staging folder before approval is this batch's whole point.
function renderCurrentSubmission(response) {
  const container = document.getElementById('lw-current-submission');
  const publicSection = response?.public;
  const pendingSection = response?.pending;
  const hasPublic = !!publicSection && (publicSection.mainPhoto || publicSection.photos.length > 0);
  const hasPending = !!pendingSection && pendingSection.photos.length > 0;
  if (!hasPublic && !hasPending) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;

  // KRKG-0083: approved photos are no longer read-only - a member can delete any of their own
  // published photos and pick which one is main. "Is this the main photo" is decided by id
  // (publicSection.mainPhoto?.id), never by array position - after a delete the concatenated
  // list's indices shift, and mainPhoto can be null while photos still exist (about-us.ts's
  // mapDriveImagesToPhotos drops an imageless-thumbnail main entirely).
  const publicHtml = hasPublic
    ? `
    <p class="lw-hint">Zaakceptowane - widoczne publicznie w „Wojownicy”.</p>
    ${[publicSection.mainPhoto, ...publicSection.photos]
      .filter(Boolean)
      .map((photo) => {
        const isMain = photo.id === publicSection.mainPhoto?.id;
        return `
      <div class="lw-photo-thumb">
        <img src="${escapeAttr(photo.url)}" alt="${isMain ? 'Główne zdjęcie' : 'Dodatkowe zdjęcie'}" />
        ${isMain ? '<p class="lw-main-badge">Główne</p>' : `<button type="button" class="lw-crop-btn lw-set-main-btn" data-file-id="${escapeAttr(photo.id)}">Ustaw jako główne</button>`}
        <button type="button" class="lw-crop-btn lw-delete-public-btn" data-file-id="${escapeAttr(photo.id)}">Usuń</button>
      </div>`;
      })
      .join('')}
  `
    : '';

  const pendingHtml = hasPending
    ? `
    <p class="lw-hint">Oczekuje na akceptację administratora - niewidoczne jeszcze w „Wojownicy”.</p>
    ${pendingSection.photos
      .map(
        (photo) => `
      <div class="lw-photo-thumb">
        <img src="${escapeAttr(photo.url)}" alt="Zgłoszone zdjęcie" />
        <button type="button" class="lw-crop-btn lw-delete-pending-btn" data-file-id="${escapeAttr(photo.id)}">Usuń</button>
      </div>`,
      )
      .join('')}
  `
    : '';

  container.innerHTML = publicHtml + pendingHtml;
}

// Deletes one of the caller's own still-pending (staging-folder) photos, then re-renders the
// section from the server's response - mirrors the pattern already used right after a fresh
// upload (loadCurrentSubmission + renderCurrentSubmission back to back).
async function deletePendingPhoto(control) {
  const container = document.getElementById('lw-current-submission');
  await window.MutationFeedback.confirmed({
    control,
    anchor: container,
    viewRoot: document.getElementById('profile-form'),
    refreshFragment: async () => renderCurrentSubmission(await loadCurrentSubmission()),
    execute: () => apiFetch(
      `/lista-wyjazdowa/profile/photo?fileId=${encodeURIComponent(control.dataset.fileId)}`,
      { method: 'DELETE' },
      showReauth,
      hideReauth,
    ),
    apply: async () => renderCurrentSubmission(await loadCurrentSubmission()),
  });
}

// KRKG-0083: deletes one of the caller's own already-approved (public) photos. Unlike a pending
// upload, this removes something already live on the public site - the click handler below
// confirms before calling this at all (MutationFeedback.confirmed only shows a post-success
// checkmark, it is not itself a confirmation dialog), so by the time this runs the user has
// already agreed.
async function deletePublicPhoto(control) {
  const container = document.getElementById('lw-current-submission');
  await window.MutationFeedback.confirmed({
    control,
    anchor: container,
    viewRoot: document.getElementById('profile-form'),
    refreshFragment: async () => renderCurrentSubmission(await loadCurrentSubmission()),
    execute: () => apiFetch(
      `/lista-wyjazdowa/profile/photo?source=public&fileId=${encodeURIComponent(control.dataset.fileId)}`,
      { method: 'DELETE' },
      showReauth,
      hideReauth,
    ),
    apply: async () => renderCurrentSubmission(await loadCurrentSubmission()),
  });
}

// KRKG-0083: promotes one of the caller's own already-approved photos to "main" (the cover shown
// in the public "Wojownicy" grid). Non-destructive and reversible (pick a different one any time),
// so unlike delete this has no confirm prompt.
async function setMainPhoto(control) {
  const container = document.getElementById('lw-current-submission');
  await window.MutationFeedback.confirmed({
    control,
    anchor: container,
    viewRoot: document.getElementById('profile-form'),
    refreshFragment: async () => renderCurrentSubmission(await loadCurrentSubmission()),
    execute: () => apiFetch(
      '/lista-wyjazdowa/profile/photo/main',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: control.dataset.fileId }) },
      showReauth,
      hideReauth,
    ),
    apply: async () => renderCurrentSubmission(await loadCurrentSubmission()),
  });
}

document.getElementById('lw-current-submission').addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('.lw-delete-pending-btn, .lw-delete-public-btn');
  if (deleteBtn) {
    // Confirm (public delete only) BEFORE disabling the button, not inside the async action -
    // cancelling resolves rather than rejects, so a confirm gate placed after disabling would
    // never reach the .catch below that re-enables it, leaving the button stuck disabled forever.
    const isPublic = deleteBtn.classList.contains('lw-delete-public-btn');
    if (isPublic && !window.confirm('Usunąć to zdjęcie? Zniknie z publicznej strony „Wojownicy”.')) return;
    deleteBtn.disabled = true;
    const action = isPublic ? deletePublicPhoto : deletePendingPhoto;
    action(deleteBtn).catch((err) => {
      deleteBtn.disabled = false;
      window.alert(`Nie udało się usunąć zdjęcia: ${err.message}`);
    });
    return;
  }

  const mainBtn = e.target.closest('.lw-set-main-btn');
  if (mainBtn) {
    mainBtn.disabled = true;
    setMainPhoto(mainBtn).catch((err) => {
      mainBtn.disabled = false;
      window.alert(`Nie udało się ustawić głównego zdjęcia: ${err.message}`);
    });
  }
});

const CURRENT_YEAR = new Date().getFullYear();

// Read-only wpisowe/składka roczna status shown right under the photo (KRKG-0047 follow-up) -
// paid/unpaid is accountant/admin-only to change (see the Lista Wyjazdowa Składki page); this
// just lets a member see their own current state without asking. Same .lw-skladka-icon
// badge/glyph convention as lista-wyjazdowa/skladki/skladki.js's paidIconHtml (wpisowe as a
// check/cross, roczna as a coin, both colored red/green via member-area.css's data-paid rule),
// but always a plain, unclickable <span> here - nothing on this page can toggle it.
function renderDuesStatus(wpisowePaid, rocznaPaid) {
  const container = document.getElementById('lw-dues-status');
  const rocznaLabel = `Składka ${CURRENT_YEAR}: ${rocznaPaid ? 'opłacona' : 'nieopłacona'}`;
  // Wpisowe shows nothing at all once paid (KRKG-0047 follow-up, same as skladki.js's row) - this
  // page is read-only anyway, so there's no control being hidden, just a settled fact with nothing
  // left to say about it.
  const wpisoweHtml = wpisowePaid ? '' : `
    <span class="lw-dues-status-item">
      <span class="lw-skladka-icon" data-paid="false" aria-hidden="true">✕</span>
      ${escapeHtml('Wpisowe: nieopłacone')}
    </span>
  `;
  container.innerHTML = `
    ${wpisoweHtml}
    <span class="lw-dues-status-item">
      <span class="lw-skladka-icon" data-paid="${rocznaPaid}" aria-hidden="true">💰</span>
      ${escapeHtml(rocznaLabel)}
    </span>
  `;
  container.hidden = false;
}

// Same escapeHtml/escapeAttr pair as person-tile.js - the established pattern in this codebase
// for interpolating user-controlled strings into an innerHTML template. Needed here because
// companion identity fields (and equipment descriptions) are member-entered free text, round-
// tripped straight back into value="..." attributes on page load (initForm's prefill calls these
// same functions with the member's own saved profile data) - unescaped, a stored `"><...` value
// becomes live markup.
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// A retired lookup item (design.md §5) is withdrawn from *new* use, but must keep resolving for
// profiles that already reference it - so it is offered only to the member who already has it
// selected. Filtering blindly would silently blank out their saved Sekcja/Broń on the next save
// (and, for Sekcja, produce a value the server now rejects as unknown), which is exactly the
// breakage "retired instead of deleted" exists to avoid.
function selectableLookupItems(items, selectedIds) {
  return items.filter((item) => !item.retired || selectedIds.includes(item.id));
}

function populateSectionSelect(select, sections, currentSectionId) {
  const options = selectableLookupItems(sections, currentSectionId ? [currentSectionId] : [])
    .map((s) => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.label)}</option>`);
  // currentSectionId with no matching lookup-list entry at all (e.g. "nieznana", the migration
  // script's fallback for a member with no known section) would otherwise have no <option> to
  // select - the caller's `form.sectionId.value = member.sectionId` a few lines down then
  // silently no-ops, leaving whichever option happens to render first selected instead, and the
  // next profile save would overwrite the member's actual sectionId with that wrong one. Shown
  // with the raw id as its own label, same convention as czlonkowie.js's fallback.
  if (currentSectionId && !sections.some((s) => s.id === currentSectionId)) {
    options.unshift(`<option value="${escapeAttr(currentSectionId)}">${escapeHtml(currentSectionId)}</option>`);
  }
  select.innerHTML = options.join('');
}

// Same icon set as the roster's Broń column (see wyjazd.js's WEAPON_ICON_KEYS) - shown next to the
// label here rather than instead of it, since a checkbox list is where someone actually picks
// their weapon and needs the text to be sure what they're choosing (KRKG-0054).
const WEAPON_ICON_FILES = {
  tarczownik: '/icons/bron-tarcza.png',
  wlocznik: '/icons/bron-wlocznia.png',
  dunczyk: '/icons/bron-topor.png',
};

function populateWeaponCheckboxes(container, weapons, currentWeaponIds) {
  container.innerHTML = selectableLookupItems(weapons, currentWeaponIds)
    .map((w) => {
      const iconFile = WEAPON_ICON_FILES[w.id];
      const icon = iconFile ? `<img class="lw-weapon-icon" src="${iconFile}" alt="" width="20" height="20">` : '';
      return `<label><input type="checkbox" name="weaponIds" value="${escapeAttr(w.id)}" />${icon}<span>${escapeHtml(w.label)}</span></label>`;
    })
    .join('');
}

// ── Photo selection + crop modal (ported from wojownicy/wrzuc/wrzuc.js) ─────────────────────
//
// Same {file, croppedBlob} entry shape and index scheme (0 = main, 1..N = extras) as wrzuc.js.
// wrzuc.js also builds a personTileHtml() preview matching the public About Us grid - not
// needed here (this form isn't producing a public profile-tile preview), so the preview below
// is a plain thumbnail grid instead, but the crop modal / Cropper wiring / upload sequence are
// carried over unchanged.

let photoEntries = [];

function entrySourceBlob(entry) {
  return entry.croppedBlob || entry.file;
}

function renderPhotoPreview() {
  const container = document.getElementById('lw-photo-preview');
  const hasAny = photoEntries.some(Boolean);
  if (!hasAny) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = photoEntries
    .map((entry, index) => {
      if (!entry) return '';
      const url = URL.createObjectURL(entrySourceBlob(entry));
      const label = index === 0 ? 'Główne zdjęcie' : `Dodatkowe zdjęcie ${index}`;
      return `
        <div class="lw-photo-thumb">
          <img src="${url}" alt="${label}" />
          <p>${label}</p>
          <button type="button" class="lw-crop-btn" data-photo-index="${index}">Kadruj</button>
        </div>
      `;
    })
    .join('');
}

document.getElementById('lw-main-photo').addEventListener('change', () => {
  const file = document.getElementById('lw-main-photo').files[0] || null;
  photoEntries[0] = file ? { file, croppedBlob: null } : undefined;
  renderPhotoPreview();
});

document.getElementById('lw-extra-photos').addEventListener('change', () => {
  const extraFiles = Array.from(document.getElementById('lw-extra-photos').files);
  photoEntries.length = 1; // keep index 0 (main photo) untouched, drop everything after it
  extraFiles.forEach((file, i) => {
    photoEntries[i + 1] = { file, croppedBlob: null };
  });
  renderPhotoPreview();
});

document.getElementById('lw-photo-preview').addEventListener('click', (e) => {
  const btn = e.target.closest('.lw-crop-btn');
  if (btn) openCropModal(Number(btn.dataset.photoIndex));
});

let activeCropper = null;
let activeCropIndex = -1;

function closeCropModal() {
  if (activeCropper) {
    activeCropper.destroy();
    activeCropper = null;
  }
  document.getElementById('crop-modal').hidden = true;
  document.body.style.overflow = '';
  activeCropIndex = -1;
}

function openCropModal(photoIndex) {
  const entry = photoEntries[photoIndex];
  if (!entry) return;
  activeCropIndex = photoIndex;

  const img = document.getElementById('crop-target');
  const errorEl = document.getElementById('crop-modal-error');
  const saveBtn = document.getElementById('crop-save');
  errorEl.hidden = true;
  saveBtn.hidden = false;
  img.hidden = false;

  document.getElementById('crop-modal').hidden = false;
  document.body.style.overflow = 'hidden';

  img.onload = () => {
    activeCropper = new Cropper(img, { viewMode: 1, autoCropArea: 1, background: false });
  };
  // Most browsers (everything but Safari) can't decode HEIC/HEIF into an <img> at all - fail
  // gracefully and keep the original file uploadable as-is; cropping is optional here too.
  img.onerror = () => {
    errorEl.hidden = false;
    saveBtn.hidden = true;
    img.hidden = true;
  };
  img.src = URL.createObjectURL(entrySourceBlob(entry));
}

document.getElementById('crop-cancel').addEventListener('click', closeCropModal);

document.getElementById('crop-save').addEventListener('click', () => {
  if (!activeCropper) return;
  const canvas = activeCropper.getCroppedCanvas({ maxWidth: 2000, maxHeight: 2000 });
  const entry = photoEntries[activeCropIndex];
  if (!canvas || !entry) {
    closeCropModal();
    return;
  }
  canvas.toBlob(
    (blob) => {
      if (blob) {
        entry.croppedBlob = blob;
        renderPhotoPreview();
      }
      closeCropModal();
    },
    'image/jpeg',
    0.9,
  );
});

async function uploadPhoto(folderId, submissionToken, entry, isMain) {
  const body = entrySourceBlob(entry);
  const query = new URLSearchParams({
    folderId,
    fileName: entry.file.name,
    mimeType: body.type || entry.file.type || 'application/octet-stream',
    isMain: String(isMain),
  });
  await apiFetch(
    `/wojownicy-upload/photo?${query.toString()}`,
    { method: 'POST', headers: { 'X-Submission-Token': submissionToken }, body },
    showReauth,
    hideReauth,
  );
}

// ── Form ────────────────────────────────────────────────────────────────────────────────────

// Clears the photo picker after a successful upload so a follow-up edit (see the "Edytuj profil"
// button below) doesn't re-submit the same photos into a second Drive folder.
function resetPhotoSelection() {
  photoEntries = [];
  document.getElementById('lw-main-photo').value = '';
  document.getElementById('lw-extra-photos').value = '';
  renderPhotoPreview();
}

// ── Namioty i wiaty (KRKG-0096 batch 3) ──────────────────────────────────────────────────────
//
// Replaces the old free-text "Sprzęt obozowy" list (name+description rows only submitted with the
// rest of the form) with a small per-person mini-list wired directly to the structured /equipment
// API (Batch 1) - both the member's own section and each companion in addPersonRow get one. Unlike
// the old system, every add/delete here is its own immediate POST/DELETE /equipment call via
// MutationFeedback.confirmed (matching how /sprzet-obozowy/'s own add form already works), not
// staged and submitted together with "Zapisz profil" - a deliberate UX difference, confirmed in
// the plan (see task-3-brief.md Step 3).
let equipmentItems = [];
let equipmentCategories = [];
let equipmentCategoryLabelById = new Map();

// Pure filter (no DOM) so it can be unit-tested directly - same convention as
// sprzet-obozowy.js's splitEquipmentByOwnership. belongsToPersonId is the canonical id space
// shared across the app (member = lowercased e-mail, accountless person = personId/UUID).
function equipmentForOwner(equipment, ownerId) {
  return equipment.filter((item) => item.belongsToPersonId === ownerId);
}

function equipmentCategoryOptionsHtml() {
  return selectableLookupItems(equipmentCategories, [])
    .map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.label)}</option>`)
    .join('');
}

function equipmentItemHtml(item) {
  const categoryLabel = equipmentCategoryLabelById.get(item.categoryId) ?? item.categoryId;
  const description = item.description ? ` – ${escapeHtml(item.description)}` : '';
  const deleteButton = item.canDelete
    ? `<button type="button" class="person-equipment-delete" data-equipment-id="${escapeAttr(item.id)}">Usuń</button>`
    : '';
  return `
    <li class="person-equipment-item" data-equipment-id="${escapeAttr(item.id)}">
      <span class="person-equipment-label">${escapeHtml(categoryLabel)}${description}</span>
      ${deleteButton}
    </li>
  `;
}

function personEquipmentInnerHtml(items) {
  const list = items.length
    ? `<ul class="person-equipment-list">${items.map(equipmentItemHtml).join('')}</ul>`
    : '<p class="lw-hint">Brak.</p>';
  return `
    ${list}
    <div class="equipment-row person-equipment-add">
      <select class="person-equipment-category" aria-label="Kategoria sprzętu">${equipmentCategoryOptionsHtml()}</select>
      <input type="text" class="person-equipment-description" placeholder="Opis (opcjonalnie)" aria-label="Opis" />
      <button type="button" class="person-equipment-add-btn">Dodaj</button>
    </div>
  `;
}

// `container` is the persistent `.person-equipment` element itself (only its innerHTML is
// replaced, never the element), so a MutationFeedback.confirmed anchored/viewRoot'd on it stays
// connected across re-renders - unlike anchoring on the clicked add/delete button, which this
// re-render detaches (same reasoning as sprzet-obozowy.js's wireAddForm/wireTableActions comments).
function renderPersonEquipment(container, ownerId) {
  container.innerHTML = personEquipmentInnerHtml(equipmentForOwner(equipmentItems, ownerId));
}

async function addPersonEquipmentItem(container, ownerId, getSectionId, control) {
  const categoryId = container.querySelector('.person-equipment-category').value;
  const description = container.querySelector('.person-equipment-description').value.trim();
  if (!categoryId) return;
  await window.MutationFeedback.confirmed({
    control,
    anchor: container,
    viewRoot: container,
    execute: () => apiFetch(
      '/equipment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId, description, belongsToPersonId: ownerId, sectionId: getSectionId() }),
      },
      showReauth,
      hideReauth,
    ),
    apply: ({ equipment: saved }) => {
      // POST /equipment's response doesn't carry canEdit/canDelete (only the GET /equipment list
      // handler synthesizes them, server.ts's handleListEquipment - always true on every item, see
      // its own comment). Without this, a freshly-added item would render with no delete button
      // until the page reloads, since equipmentItemHtml gates the button on item.canDelete.
      equipmentItems.push({ ...saved, canEdit: true, canDelete: true });
      renderPersonEquipment(container, ownerId);
    },
    refreshFragment: async () => renderPersonEquipment(container, ownerId),
  });
}

async function deletePersonEquipmentItem(container, ownerId, itemId, control) {
  await window.MutationFeedback.confirmed({
    control,
    anchor: container,
    viewRoot: container,
    execute: () => apiFetch(`/equipment?id=${encodeURIComponent(itemId)}`, { method: 'DELETE' }, showReauth, hideReauth),
    apply: () => {
      equipmentItems = equipmentItems.filter((item) => item.id !== itemId);
      renderPersonEquipment(container, ownerId);
    },
    refreshFragment: async () => renderPersonEquipment(container, ownerId),
  });
}

// `getSectionId` is a callback, not a captured value, so each call reads the owner's *current*
// sectionId at the moment "Dodaj" is clicked (member.sectionId may change if the profile form is
// re-saved; a companion row is entirely re-created by renderPersons/addPersonRow after every
// person save, so its own closure is always fresh - see task-3-brief.md Step 3).
function wireEquipmentMiniList(container, ownerId, getSectionId) {
  container.addEventListener('click', (event) => {
    const addBtn = event.target.closest('.person-equipment-add-btn');
    if (addBtn) {
      addPersonEquipmentItem(container, ownerId, getSectionId, addBtn).catch((err) => {
        window.alert(`Nie udało się dodać sprzętu: ${err.message}`);
      });
      return;
    }
    const deleteBtn = event.target.closest('.person-equipment-delete');
    if (deleteBtn) {
      deletePersonEquipmentItem(container, ownerId, deleteBtn.dataset.equipmentId, deleteBtn).catch((err) => {
        window.alert(`Nie udało się usunąć sprzętu: ${err.message}`);
      });
    }
  });
  renderPersonEquipment(container, ownerId);
}

// ── Osoby towarzyszące (KRKG-0087 design.md section B) ───────────────────────────────────────
//
// Accountless people attached to this member, edited in place. Kept in its own panel outside
// #profile-form: these controls must not take part in the main profile submit, and their weapon
// checkboxes deliberately use a different input name so the form's own input[name="weaponIds"]
// query never picks them up. The server re-checks ownership on every write regardless.
const NO_WEAPON_CATEGORY_IDS = ['niewiasta', 'bobo'];
let viewerEmail = null;
let ownerSectionId = null;
let personLookupLists = { sections: [], categories: [], weapons: [] };

function personOptionsHtml(items, selectedId) {
  return selectableLookupItems(items, selectedId ? [selectedId] : [])
    .map((item) => `<option value="${escapeAttr(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(item.label)}</option>`)
    .join('');
}

function personWeaponCheckboxesHtml(weapons, currentIds) {
  return selectableLookupItems(weapons, currentIds)
    .map((w) => `<label><input type="checkbox" name="personWeaponIds" value="${escapeAttr(w.id)}"${currentIds.includes(w.id) ? ' checked' : ''} /><span>${escapeHtml(w.label)}</span></label>`)
    .join('');
}

// Niewiasta/Bobo never carry a weapon (server: persons.ts's weaponAllowedForCategory) - clearing
// and hiding the row's weapon checkboxes mirrors that rule, so the UI can't offer a combination
// the save would reject. Changing back to a weapon-bearing category just re-shows the checkboxes.
function updatePersonWeaponState(row) {
  const weapons = row.querySelector('.person-weapons');
  if (!weapons) return;
  const allowed = !NO_WEAPON_CATEGORY_IDS.includes(row.querySelector('.person-category').value);
  weapons.hidden = !allowed;
  if (!allowed) {
    for (const cb of weapons.querySelectorAll('input[name="personWeaponIds"]')) cb.checked = false;
  }
}

function readPersonRow(row) {
  const categoryId = row.querySelector('.person-category').value;
  return {
    ksywka: row.querySelector('.person-ksywka').value.trim(),
    firstName: row.querySelector('.person-first-name').value.trim(),
    lastName: row.querySelector('.person-last-name').value.trim(),
    categoryId,
    sectionId: row.querySelector('.person-section').value,
    weaponIds: NO_WEAPON_CATEGORY_IDS.includes(categoryId)
      ? []
      : Array.from(row.querySelectorAll('input[name="personWeaponIds"]:checked')).map((cb) => cb.value),
  };
}

function showPersonsError(message) {
  const errorEl = document.getElementById('persons-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearPersonsError() {
  document.getElementById('persons-error').hidden = true;
}

// `person` null renders a blank "new person" row; the caller's owner section is the default so a
// member only has to pick a ksywka and category (design.md section B). The category's no-weapon
// rule is applied on render too, for a person already saved as Niewiasta/Bobo.
function addPersonRow(container, person = null) {
  const row = document.createElement('div');
  row.className = 'person-row';
  if (person) row.dataset.personId = person.personId;
  row.innerHTML = `
    <div class="person-row-fields">
      <input type="text" class="person-ksywka" placeholder="Ksywka" value="${escapeAttr(person?.nickname ?? '')}" aria-label="Ksywka" />
      <input type="text" class="person-first-name" placeholder="Imię" value="${escapeAttr(person?.firstName ?? '')}" aria-label="Imię" />
      <input type="text" class="person-last-name" placeholder="Nazwisko" value="${escapeAttr(person?.lastName ?? '')}" aria-label="Nazwisko" />
      <select class="person-category" aria-label="Kategoria">${personOptionsHtml(personLookupLists.categories, person?.categoryId ?? null)}</select>
      <select class="person-section" aria-label="Sekcja">${personOptionsHtml(personLookupLists.sections, person?.sectionId ?? ownerSectionId)}</select>
    </div>
    <div class="person-weapons lw-checkbox-grid">${personWeaponCheckboxesHtml(personLookupLists.weapons, person?.weaponIds ?? [])}</div>
    <div class="person-row-actions">
      <button type="button" class="person-save add-album-submit">${person ? 'Zapisz' : 'Dodaj'}</button>
      ${person
        ? '<button type="button" class="person-delete btn-cancel">Deaktywuj</button>'
        : '<button type="button" class="person-cancel btn-cancel">Anuluj</button>'}
    </div>
  `;
  row.querySelector('.person-category').addEventListener('change', () => updatePersonWeaponState(row));
  updatePersonWeaponState(row);
  row.querySelector('.person-save').addEventListener('click', (event) => {
    clearPersonsError();
    const fields = readPersonRow(row);
    if (!fields.ksywka || !fields.categoryId || !fields.sectionId) {
      showPersonsError('Ksywka, kategoria i sekcja są wymagane.');
      return;
    }
    if (person) savePerson(row.dataset.personId, fields, event.target);
    else createPerson(fields, event.target);
  });
  if (person) {
    row.querySelector('.person-delete').addEventListener('click', (event) => {
      clearPersonsError();
      if (!window.confirm('Deaktywować tę osobę? Zostanie odpięta i zniknie z listy, ale pozostanie w historii.')) return;
      deletePerson(row.dataset.personId, event.target);
    });
  } else {
    row.querySelector('.person-cancel').addEventListener('click', () => row.remove());
  }
  container.appendChild(row);
}

function renderPersons(roster) {
  const owner = (viewerEmail ?? '').toLowerCase();
  const attached = roster.filter((person) => person.accountless && (person.ownerPersonId ?? '').toLowerCase() === owner);
  const container = document.getElementById('persons-rows');
  container.innerHTML = '';
  if (attached.length === 0) {
    container.innerHTML = '<p class="lw-hint">Nie masz jeszcze osób towarzyszących.</p>';
    return;
  }
  for (const person of attached) addPersonRow(container, person);
}

async function loadPersons() {
  const { roster } = await apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth);
  renderPersons(roster);
}

// Every person write goes through the shared confirmed-mutation helper: the list is only re-read
// after the server confirms the write, and a failure leaves the form untouched and reports it.
async function runPersonMutation(control, execute) {
  const panel = document.getElementById('persons-panel');
  await window.MutationFeedback.confirmed({
    control,
    anchor: panel,
    viewRoot: panel,
    refreshFragment: loadPersons,
    execute,
    apply: () => loadPersons(),
  });
}

async function createPerson(fields, control) {
  try {
    await runPersonMutation(control, () => apiFetch('/lista-wyjazdowa/persons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, ownerPersonId: viewerEmail.toLowerCase() }),
    }, showReauth, hideReauth));
  } catch (err) {
    showPersonsError(`Nie udało się dodać osoby: ${err.message}`);
  }
}

async function savePerson(personId, fields, control) {
  try {
    await runPersonMutation(control, () => apiFetch('/lista-wyjazdowa/persons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId, ...fields }),
    }, showReauth, hideReauth));
  } catch (err) {
    showPersonsError(`Nie udało się zapisać osoby: ${err.message}`);
  }
}

async function deletePerson(personId, control) {
  try {
    await runPersonMutation(control, () => apiFetch('/lista-wyjazdowa/persons', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId }),
    }, showReauth, hideReauth));
  } catch (err) {
    showPersonsError(`Nie udało się usunąć osoby: ${err.message}`);
  }
}

async function initForm(lookupLists) {
  const form = document.getElementById('profile-form');
  personLookupLists = lookupLists;
  equipmentCategories = lookupLists.equipmentCategories ?? [];
  equipmentCategoryLabelById = new Map(equipmentCategories.map((c) => [c.id, c.label]));
  document.getElementById('add-person-row').addEventListener('click', () => addPersonRow(document.getElementById('persons-rows')));

  // Submit handling is wired unconditionally, before the member/profile prefetch below - so a
  // transient failure fetching existing data (network blip, cold Cloud Run instance) leaves a
  // still-usable blank form instead of a form panel with no submit handler attached at all.
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const weaponIds = Array.from(form.querySelectorAll('input[name="weaponIds"]:checked')).map((cb) => cb.value);
    const errorEl = document.getElementById('profile-form-error');
    const progressEl = document.getElementById('profile-form-progress');
    const submitBtn = document.getElementById('profile-form-submit');

    errorEl.hidden = true;
    submitBtn.disabled = true;
    progressEl.hidden = false;
    progressEl.textContent = 'Zapisywanie profilu...';

    const applySavedProfile = ({ savedMember }) => {
      form.lastName.value = savedMember.lastName;
      form.firstName.value = savedMember.firstName;
      form.nickname.value = savedMember.nickname ?? '';
      // Keep the equipment mini-list's "current sectionId" in sync with a Sekcja change just
      // saved here - the mini-list itself is unaffected by this submit (it saves independently,
      // see wireEquipmentMiniList), but a fresh add right after this save must use the new value.
      ownerSectionId = savedMember.sectionId;
      resetPhotoSelection();

      progressEl.hidden = true;
      submitBtn.disabled = false;
    };
    const refreshProfileFragment = async () => {
      const [{ member: savedMember }, { profile: savedProfile }, { submission }] = await Promise.all([
        apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
        loadCurrentSubmission(),
      ]);
      renderCurrentSubmission(submission);
      applySavedProfile({ savedMember, savedProfile });
    };

    try {
      await window.MutationFeedback.confirmed({
        control: submitBtn,
        anchor: progressEl,
        viewRoot: form,
        refreshFragment: refreshProfileFragment,
        execute: async () => {
      // KRKG-0103: Nazwisko and Imię are both required (the form's own `required` attribute
      // catches an empty submit before this ever runs); Ksywa stays optional, sent as '' rather
      // than omitted so the server can tell an intentionally blank Ksywa apart from one that was
      // never touched.
      const { member: savedMember } = await apiFetch(
        '/lista-wyjazdowa/member',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lastName: form.lastName.value,
            firstName: form.firstName.value,
            nickname: form.nickname.value || null,
            sectionId: form.sectionId.value,
          }),
        },
        showReauth,
        hideReauth,
      );

      const { profile: savedProfile } = await apiFetch(
        '/lista-wyjazdowa/profile',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            weaponIds,
          }),
        },
        showReauth,
        hideReauth,
      );

      // Photo/Drive submission is a direct reuse of wrzuc.js's existing submit -> per-photo
      // upload sequence (unchanged server endpoints, see design.md §6) - only run it if a photo
      // was actually picked (main or extra), so re-saving profile fields alone doesn't spam a new
      // Drive folder every time.
      //
      // Bug fix: this used to gate the ENTIRE block on `mainEntry` alone, so a member who only
      // picked an extra/secondary photo (never touching the main-photo picker - a common case for
      // someone who already has a public main photo and just wants to add another) had that photo
      // silently dropped - no upload call was ever made, no error shown, and the rest of the form
      // still saved fine, masking the failure entirely.
      const mainEntry = photoEntries[0];
      const extraEntries = photoEntries.slice(1).filter(Boolean);
      if (mainEntry || extraEntries.length) {
        // KRKG-0103: name has no bearing on identity/folder-reuse (that's keyed by e-mail alone,
        // see server.ts's findReusableSubmissionFolder) - it's purely cosmetic folder-title text,
        // always both fields now, both required.
        const { folderId, submissionToken } = await apiFetch(
          '/wojownicy-upload/submit',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `${savedMember.lastName} ${savedMember.firstName}`.trim() }),
          },
          showReauth,
          hideReauth,
        );

        const total = (mainEntry ? 1 : 0) + extraEntries.length;
        let uploaded = 0;
        progressEl.textContent = `Przesyłanie zdjęć (0/${total})...`;
        if (mainEntry) {
          await uploadPhoto(folderId, submissionToken, mainEntry, true);
          uploaded++;
          progressEl.textContent = `Przesyłanie zdjęć (${uploaded}/${total})...`;
        }
        for (const entry of extraEntries) {
          await uploadPhoto(folderId, submissionToken, entry, false);
          uploaded++;
          progressEl.textContent = `Przesyłanie zdjęć (${uploaded}/${total})...`;
        }
        // Reflects the photo(s) that just landed - without this the "already uploaded" panel
        // above the picker would keep showing the previous submission (or nothing) until the
        // member reloads the page.
        renderCurrentSubmission(await loadCurrentSubmission());
      }

      return { savedMember, savedProfile };
        },
        apply: applySavedProfile,
      });
    } catch (err) {
      errorEl.textContent = `Błąd: ${err.message}`;
      errorEl.hidden = false;
      progressEl.hidden = true;
      submitBtn.disabled = false;
    }
  });

  // The lookup dropdown/checkboxes are populated *after* this fetch, not before it, because
  // whether a retired Sekcja/Broń may be offered depends on what this member already has saved
  // (see selectableLookupItems). A failed fetch falls through with null member/profile, which
  // still renders every non-retired option - a usable blank form.
  let member = null;
  let profile = null;
  let dues = null;
  let roster = [];
  let loadError = null;
  try {
    const [memberResponse, profileResponse, duesResponse, rosterResponse, equipmentResponse] = await Promise.all([
      apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
      apiFetch(`/lista-wyjazdowa/dues/mine?year=${CURRENT_YEAR}`, { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/equipment', { method: 'GET' }, showReauth, hideReauth),
    ]);
    member = memberResponse.member;
    profile = profileResponse.profile;
    dues = duesResponse.dues;
    roster = rosterResponse.roster;
    equipmentItems = equipmentResponse.equipment;
  } catch (err) {
    loadError = err;
  }

  // The owner's section is the default for a new person (design.md section B) - captured before
  // renderPersons so a "Dodaj osobę" row preselects it.
  ownerSectionId = member?.sectionId ?? null;

  populateSectionSelect(form.sectionId, lookupLists.sections, member?.sectionId ?? null);
  populateWeaponCheckboxes(document.getElementById('weapons-checkboxes'), lookupLists.weapons, profile?.weaponIds ?? []);

  // An existing member/profile prefills the same form rather than locking it: a member must
  // always be able to come back and fix a typo, change section/weapons, or add equipment
  // (design.md §8 point 4) - this page replaced the always-editable /wojownicy/wrzuc/.
  if (member) {
    form.lastName.value = member.lastName;
    form.firstName.value = member.firstName;
    form.nickname.value = member.nickname ?? '';
    form.sectionId.value = member.sectionId;
    document.getElementById('category-readout').textContent =
      lookupLists.categories.find((c) => c.id === member.categoryId)?.label ?? '—';
  }
  if (profile) {
    for (const cb of form.querySelectorAll('input[name="weaponIds"]')) {
      cb.checked = profile.weaponIds.includes(cb.value);
    }
  }
  if (!loadError) {
    renderDuesStatus(profile?.wpisowePaid ?? false, dues?.paid ?? false);
    renderPersons(roster);
    wireEquipmentMiniList(document.getElementById('own-equipment'), viewerEmail.toLowerCase(), () => ownerSectionId);
  }

  if (loadError) {
    // The form is fully usable at this point (options rendered, submit handler attached) - the
    // failure only means we couldn't confirm/prefill existing data, so show it as a warning on
    // the form instead of blocking on it.
    const errorEl = document.getElementById('profile-form-error');
    errorEl.textContent = `Nie udało się wczytać zapisanych danych: ${loadError.message}`;
    errorEl.hidden = false;
  }

  showOnly(panels.form);
}

initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async identity => {
    try {
      viewerEmail = identity.email;
      // Historia deep link (KRKG-0050 batch 5/6) - member:{email}, the same resource key
      // profile.member.updated (and every role/membership event) is stored under (see
      // implementation-contract.md's "Action registry" intro paragraph).
      const historyLink = document.getElementById('profile-history-link');
      historyLink.href = `/audyt/?resourceKey=${encodeURIComponent(`member:${identity.email}`)}`;
      historyLink.hidden = false;
      const [lookupLists, currentSubmission] = await Promise.all([loadLookupLists(), loadCurrentSubmission()]);
      renderCurrentSubmission(currentSubmission);
      await initForm(lookupLists);
    } catch (err) {
      const errorEl = document.getElementById('profile-form-error');
      showOnly(panels.form);
      errorEl.textContent = `Błąd wczytywania danych: ${err.message}`;
      errorEl.hidden = false;
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
