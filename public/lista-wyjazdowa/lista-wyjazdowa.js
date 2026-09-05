/**
 * Lista Wyjazdowa - member profile form (Plan A, KRKG-0037).
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
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
  form: document.getElementById('profile-form-panel'),
  saved: document.getElementById('profile-saved-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

// Default state until the server-verified whoami check (inside initGoogleSignIn, below) resolves
// one way or the other.
showOnly(panels.signedOut);

function loadLookupLists() {
  return apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth);
}

function populateSectionSelect(select, sections) {
  select.innerHTML = sections.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
}

function populateWeaponCheckboxes(container, weapons) {
  container.innerHTML = weapons
    .map((w) => `<label><input type="checkbox" name="weaponIds" value="${w.id}" /> ${w.label}</label>`)
    .join('');
}

function addEquipmentRow(container, item = { id: '', name: '', description: '' }) {
  const row = document.createElement('div');
  row.className = 'equipment-row';
  row.innerHTML = `
    <input type="hidden" class="equipment-id" value="${item.id}" />
    <input type="text" class="equipment-name" placeholder="Nazwa" value="${item.name}" />
    <input type="text" class="equipment-description" placeholder="Opis" value="${item.description}" />
    <button type="button" class="remove-row">Usuń</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function addCompanionRow(container, companion = { id: '', name: '' }) {
  const row = document.createElement('div');
  row.className = 'companion-row';
  row.innerHTML = `
    <input type="hidden" class="companion-id" value="${companion.id}" />
    <input type="text" class="companion-name" placeholder="Imię" value="${companion.name}" />
    <button type="button" class="remove-row">Usuń</button>
  `;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function readEquipmentRows(container) {
  return Array.from(container.querySelectorAll('.equipment-row')).map((row) => ({
    id: row.querySelector('.equipment-id').value,
    name: row.querySelector('.equipment-name').value,
    description: row.querySelector('.equipment-description').value,
  }));
}

function readCompanionRows(container) {
  return Array.from(container.querySelectorAll('.companion-row')).map((row) => ({
    id: row.querySelector('.companion-id').value,
    name: row.querySelector('.companion-name').value,
  }));
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

async function initForm(lookupLists) {
  const form = document.getElementById('profile-form');
  populateSectionSelect(form.sectionId, lookupLists.sections);
  populateWeaponCheckboxes(document.getElementById('weapons-checkboxes'), lookupLists.weapons);

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

    try {
      await apiFetch(
        '/lista-wyjazdowa/member',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: form.fullName.value,
            nickname: form.nickname.value || null,
            sectionId: form.sectionId.value,
          }),
        },
        showReauth,
        hideReauth,
      );

      await apiFetch(
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
        const { folderId, submissionToken } = await apiFetch(
          '/wojownicy-upload/submit',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: form.fullName.value }),
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
      }

      showOnly(panels.saved);
    } catch (err) {
      errorEl.textContent = `Błąd: ${err.message}`;
      errorEl.hidden = false;
      progressEl.hidden = true;
      submitBtn.disabled = false;
    }
  });

  try {
    const [{ member }, { profile }] = await Promise.all([
      apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
    ]);

    // A member+profile pair already exists: this is Plan A's deliberate onboarding-once flow
    // (see #profile-saved-panel's note in index.html) - Plan B replaces this end state with the
    // real events list. Returning here re-shows the placeholder rather than an editable form.
    if (member && profile) {
      showOnly(panels.saved);
      return;
    }

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
      for (const item of profile.equipment) addEquipmentRow(equipmentContainer, item);
      for (const c of profile.companions) addCompanionRow(companionContainer, c);
    }
  } catch (err) {
    // The form itself is already fully wired at this point (dropdown/checkboxes populated,
    // submit handler attached above) - a failure here just means we couldn't confirm/prefill
    // existing data, not that the form is unusable, so keep it visible rather than block on it.
    const errorEl = document.getElementById('profile-form-error');
    errorEl.textContent = `Nie udało się wczytać zapisanych danych: ${err.message}`;
    errorEl.hidden = false;
  }

  showOnly(panels.form);
}

initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    try {
      const lookupLists = await loadLookupLists();
      await initForm(lookupLists);
    } catch (err) {
      const errorEl = document.getElementById('profile-form-error');
      showOnly(panels.form);
      errorEl.textContent = `Błąd wczytywania danych: ${err.message}`;
      errorEl.hidden = false;
    }
  },
  onForbidden: () => showOnly(panels.forbidden),
});
