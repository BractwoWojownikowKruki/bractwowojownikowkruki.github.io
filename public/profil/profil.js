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

  const publicHtml = hasPublic
    ? `
    <p class="lw-hint">Zaakceptowane - widoczne publicznie w „Wojownicy”.</p>
    ${[publicSection.mainPhoto, ...publicSection.photos]
      .filter(Boolean)
      .map(
        (photo, index) => `
      <div class="lw-photo-thumb">
        <img src="${escapeAttr(photo.url)}" alt="${index === 0 ? 'Główne zdjęcie' : 'Dodatkowe zdjęcie'}" />
      </div>`,
      )
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

document.getElementById('lw-current-submission').addEventListener('click', (e) => {
  const btn = e.target.closest('.lw-delete-pending-btn');
  if (!btn) return;
  btn.disabled = true;
  deletePendingPhoto(btn).catch((err) => {
    btn.disabled = false;
    window.alert(`Nie udało się usunąć zdjęcia: ${err.message}`);
  });
});

// Same escapeHtml/escapeAttr pair as person-tile.js - the established pattern in this codebase
// for interpolating user-controlled strings into an innerHTML template. Needed here because
// equipment/companion name+description are member-entered free text, round-tripped straight back
// into value="..." attributes on page load (initForm's prefill calls these same functions with
// the member's own saved profile data) - unescaped, a stored `"><...` value becomes live markup.
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

// Same icon set as the roster's Broń column (see wyjazd.js's WEAPON_ICONS) - shown next to the
// label here rather than instead of it, since a checkbox list is where someone actually picks
// their weapon and needs the text to be sure what they're choosing (KRKG-0054).
const WEAPON_ICONS = {
  tarczownik: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 L19 6 V12 C19 17 15.5 20 12 21 C8.5 20 5 17 5 12 V6 Z"/></svg>',
  wlocznik: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 L16 8"/><path d="M14 4 L20 4 L20 10 Z" fill="currentColor" stroke="none"/></svg>',
  dunczyk: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 3 V21"/><path d="M12 4 C12 4 5.5 5.5 5 9.5 C4.7 11.8 7 13 9 13 C10.8 13 12 11.5 12 9.5 Z" fill="currentColor" stroke="none"/></svg>',
};

function populateWeaponCheckboxes(container, weapons, currentWeaponIds) {
  container.innerHTML = selectableLookupItems(weapons, currentWeaponIds)
    .map(
      (w) =>
        `<label><input type="checkbox" name="weaponIds" value="${escapeAttr(w.id)}" /><span class="lw-weapon-icon" aria-hidden="true">${WEAPON_ICONS[w.id] ?? ''}</span><span>${escapeHtml(w.label)}</span></label>`,
    )
    .join('');
}

function addEquipmentRow(container, item = { id: '', name: '', description: '' }) {
  const row = document.createElement('div');
  row.className = 'equipment-row';
  row.innerHTML = `
    <input type="hidden" class="equipment-id" value="${escapeAttr(item.id)}" />
    <input type="text" class="equipment-name" placeholder="Nazwa" value="${escapeAttr(item.name)}" />
    <input type="text" class="equipment-description" placeholder="Opis" value="${escapeAttr(item.description)}" />
    <button type="button" class="remove-row">Usuń</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function addCompanionRow(container, companion = { id: '', name: '' }) {
  const row = document.createElement('div');
  row.className = 'companion-row';
  row.innerHTML = `
    <input type="hidden" class="companion-id" value="${escapeAttr(companion.id)}" />
    <input type="text" class="companion-name" placeholder="Imię" value="${escapeAttr(companion.name)}" />
    <button type="button" class="remove-row">Usuń</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// Rows left completely blank (added with "Dodaj sprzęt"/"Dodaj osobę" and then abandoned) are
// dropped rather than submitted: the server rejects a nameless entry with a 400, and failing the
// whole save over an empty leftover row would be a poor trade for a form this long.
function readEquipmentRows(container) {
  return Array.from(container.querySelectorAll('.equipment-row'))
    .map((row) => ({
      id: row.querySelector('.equipment-id').value,
      name: row.querySelector('.equipment-name').value,
      description: row.querySelector('.equipment-description').value,
    }))
    .filter((item) => item.name.trim());
}

function readCompanionRows(container) {
  return Array.from(container.querySelectorAll('.companion-row'))
    .map((row) => ({
      id: row.querySelector('.companion-id').value,
      name: row.querySelector('.companion-name').value,
    }))
    .filter((companion) => companion.name.trim());
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

function fillRows(container, items, addRow) {
  container.innerHTML = '';
  for (const item of items) addRow(container, item);
}

async function initForm(lookupLists) {
  const form = document.getElementById('profile-form');
  const equipmentContainer = document.getElementById('equipment-rows');
  const companionContainer = document.getElementById('companion-rows');
  document.getElementById('add-equipment-row').addEventListener('click', () => addEquipmentRow(equipmentContainer));
  document.getElementById('add-companion-row').addEventListener('click', () => addCompanionRow(companionContainer));

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

    const applySavedProfile = ({ savedMember, savedProfile }) => {
      // Re-seed the rows from the server's response so the ids it just generated for brand-new
      // equipment/companions are carried by the form: without this, editing and re-saving would
      // send blank ids again and mint a duplicate id for the same item on every save.
      fillRows(equipmentContainer, savedProfile.equipment, addEquipmentRow);
      fillRows(companionContainer, savedProfile.companions, addCompanionRow);
      // Reflect the server's fullName back into the field it may have just backfilled, so a
      // member who only typed Ksywa sees where their name came from, not a blank field.
      form.fullName.value = savedMember.fullName;
      form.nickname.value = savedMember.nickname ?? '';
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
      // Imię i nazwisko and Ksywa are both optional (server enforces "at least one of the
      // two"): sending '' rather than omitting the key lets the server tell an intentionally
      // blank field apart from a field that was never touched, and it backfills fullName from
      // nickname itself when fullName is blank - so `savedMember.fullName` below may differ
      // from what was actually typed here.
      const { member: savedMember } = await apiFetch(
        '/lista-wyjazdowa/member',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: form.fullName.value || null,
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
            equipment: readEquipmentRows(equipmentContainer),
            companions: readCompanionRows(companionContainer),
          }),
        },
        showReauth,
        hideReauth,
      );

      // Photo/Drive submission is a direct reuse of wrzuc.js's existing submit -> per-photo
      // upload sequence (unchanged server endpoints, see design.md §6) - only run it if a main
      // photo was actually picked, so re-saving profile fields alone doesn't spam a new Drive
      // folder every time.
      const mainEntry = photoEntries[0];
      if (mainEntry) {
        const extraEntries = photoEntries.slice(1).filter(Boolean);
        // savedMember.fullName, not form.fullName.value: if only Ksywa was given, the server
        // already backfilled fullName from it, and that's the name the Drive folder should use.
        const { folderId, submissionToken } = await apiFetch(
          '/wojownicy-upload/submit',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: savedMember.fullName }),
          },
          showReauth,
          hideReauth,
        );

        const total = 1 + extraEntries.length;
        progressEl.textContent = `Przesyłanie zdjęć (0/${total})...`;
        await uploadPhoto(folderId, submissionToken, mainEntry, true);
        progressEl.textContent = `Przesyłanie zdjęć (1/${total})...`;
        for (let i = 0; i < extraEntries.length; i++) {
          await uploadPhoto(folderId, submissionToken, extraEntries[i], false);
          progressEl.textContent = `Przesyłanie zdjęć (${i + 2}/${total})...`;
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
  let loadError = null;
  try {
    const [memberResponse, profileResponse] = await Promise.all([
      apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
    ]);
    member = memberResponse.member;
    profile = profileResponse.profile;
  } catch (err) {
    loadError = err;
  }

  populateSectionSelect(form.sectionId, lookupLists.sections, member?.sectionId ?? null);
  populateWeaponCheckboxes(document.getElementById('weapons-checkboxes'), lookupLists.weapons, profile?.weaponIds ?? []);

  // An existing member/profile prefills the same form rather than locking it: a member must
  // always be able to come back and fix a typo, change section/weapons, or add equipment
  // (design.md §8 point 4) - this page replaced the always-editable /wojownicy/wrzuc/.
  if (member) {
    form.fullName.value = member.fullName;
    form.nickname.value = member.nickname ?? '';
    form.sectionId.value = member.sectionId;
    document.getElementById('category-readout').textContent =
      lookupLists.categories.find((c) => c.id === member.categoryId)?.label ?? '—';
  }
  if (profile) {
    for (const cb of form.querySelectorAll('input[name="weaponIds"]')) {
      cb.checked = profile.weaponIds.includes(cb.value);
    }
    fillRows(equipmentContainer, profile.equipment, addEquipmentRow);
    fillRows(companionContainer, profile.companions, addCompanionRow);
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
