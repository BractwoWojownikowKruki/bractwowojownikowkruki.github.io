/**
 * "Zarejestruj się" self-service membership application (KRKG-0046). Reuses the site's existing
 * Google Sign-In (auth.js) exactly like every other member-area page - see profil.js's header
 * comment for the general apiFetch/initGoogleSignIn contract this follows.
 *
 * The one thing this page does differently: it's gated by GET /membership/whoami, not the usual
 * member whoamiPath (e.g. /wojownicy-upload/whoami) - that endpoint succeeds for *any* signed-in
 * Google account, member or not, returning {email, status} where status is null/pending/active/
 * suspended/rejected/removed. onForbidden never fires here (the endpoint has no allowlist to
 * reject against) - only onSignedOut (no session at all) and onSignedIn (any session, whatever
 * its status) are used.
 */

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

const panels = {
  checking: document.getElementById('zg-checking'),
  signedOut: document.getElementById('zg-signin'),
  active: document.getElementById('zg-active'),
  pending: document.getElementById('zg-pending'),
  suspended: document.getElementById('zg-suspended'),
  form: document.getElementById('zg-form-panel'),
};

showOnly(panels.checking);

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function populateSectionSelect(select, sections) {
  select.innerHTML = sections
    .filter(s => !s.retired)
    .map(s => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.label)}</option>`)
    .join('');
}

// ── Photos (same pick + crop flow as /profil/, index 0 = main, 1..N = extras) ────────────────
//
// Mirrors the server's limits for this flow (server.ts's APPLICANT_MAX_PHOTOS /
// APPLICANT_MAX_PHOTO_BYTES) so the applicant hears about them before anything is sent; the
// server enforces them regardless.
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let photoEntries = [];

function entrySourceBlob(entry) {
  return entry.croppedBlob || entry.file;
}

function selectedPhotoEntries() {
  return photoEntries.map((entry, index) => ({ entry, isMain: index === 0 })).filter(p => p.entry);
}

function renderPhotoPreview() {
  const container = document.getElementById('zg-photo-preview');
  if (!photoEntries.some(Boolean)) {
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
        <div class="zg-photo-thumb">
          <img src="${url}" alt="${label}" />
          <p>${label}</p>
          <button type="button" class="zg-crop-btn" data-photo-index="${index}">Kadruj</button>
        </div>
      `;
    })
    .join('');
}

document.getElementById('zg-main-photo').addEventListener('change', () => {
  const file = document.getElementById('zg-main-photo').files[0] || null;
  photoEntries[0] = file ? { file, croppedBlob: null } : undefined;
  renderPhotoPreview();
});

document.getElementById('zg-extra-photos').addEventListener('change', () => {
  const extraFiles = Array.from(document.getElementById('zg-extra-photos').files);
  photoEntries.length = 1; // keep index 0 (main photo) untouched, drop everything after it
  extraFiles.forEach((file, i) => {
    photoEntries[i + 1] = { file, croppedBlob: null };
  });
  renderPhotoPreview();
});

document.getElementById('zg-photo-preview').addEventListener('click', e => {
  const btn = e.target.closest('.zg-crop-btn');
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
  // Most browsers (everything but Safari) can't decode HEIC/HEIF into an <img> - keep the
  // original file uploadable as-is; cropping is optional.
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
    blob => {
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

// Returns an error message, or null when the selection fits the limits.
function photoSelectionError(selected) {
  if (selected.length > MAX_PHOTOS) return `Możesz dodać najwyżej ${MAX_PHOTOS} zdjęcia.`;
  const tooBig = selected.find(p => entrySourceBlob(p.entry).size > MAX_PHOTO_BYTES);
  if (tooBig) return `Zdjęcie "${tooBig.entry.file.name}" jest większe niż ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`;
  return null;
}

async function uploadApplicationPhotos(selected, progressEl) {
  const { folderId, submissionToken, remainingPhotos } = await apiFetch('/membership/photos/start', { method: 'POST' });
  if (selected.length > remainingPhotos) {
    throw new Error(`Zgłoszenie ma już zdjęcia - możesz dodać jeszcze ${remainingPhotos}.`);
  }
  let uploaded = 0;
  progressEl.textContent = `Przesyłanie zdjęć (0/${selected.length})...`;
  progressEl.hidden = false;
  for (const { entry, isMain } of selected) {
    const body = entrySourceBlob(entry);
    const query = new URLSearchParams({
      folderId,
      fileName: entry.file.name,
      mimeType: body.type || entry.file.type || 'application/octet-stream',
      isMain: String(isMain),
    });
    await apiFetch(`/membership/photo?${query.toString()}`, {
      method: 'POST', headers: { 'X-Submission-Token': submissionToken }, body,
    });
    uploaded++;
    progressEl.textContent = `Przesyłanie zdjęć (${uploaded}/${selected.length})...`;
  }
}

// ── Form ────────────────────────────────────────────────────────────────────────────────────

let submitHandlerAttached = false;

async function showForm(previousStatus, email) {
  const form = document.getElementById('zg-form');
  const noteEl = document.getElementById('zg-form-note');
  if (previousStatus === 'rejected' || previousStatus === 'removed') {
    noteEl.textContent =
      previousStatus === 'rejected'
        ? 'Twoje poprzednie zgłoszenie zostało odrzucone. Możesz zgłosić się ponownie.'
        : 'Twoje członkostwo zostało zakończone. Możesz zgłosić się ponownie.';
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }
  form.email.value = email ?? '';

  try {
    const { sections } = await apiFetch('/membership/sections', { method: 'GET' });
    populateSectionSelect(form.sectionId, sections);
  } catch (err) {
    const errorEl = document.getElementById('zg-form-error');
    errorEl.textContent = `Nie udało się wczytać listy sekcji: ${err.message}`;
    errorEl.hidden = false;
  }

  if (!submitHandlerAttached) {
    submitHandlerAttached = true;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const errorEl = document.getElementById('zg-form-error');
      const progressEl = document.getElementById('zg-progress');
      const submitBtn = document.getElementById('zg-form-submit');
      errorEl.hidden = true;
      if (!form.description.value.trim()) {
        errorEl.textContent = 'Napisz kilka słów o sobie.';
        errorEl.hidden = false;
        return;
      }
      const selectedPhotos = selectedPhotoEntries();
      const photoError = photoSelectionError(selectedPhotos);
      if (photoError) {
        errorEl.textContent = photoError;
        errorEl.hidden = false;
        return;
      }
      submitBtn.disabled = true;
      try {
        await window.MutationFeedback.confirmed({
          control: submitBtn,
          anchor: panels.pending,
          // Photos go up only after the application exists - the server accepts them only from a
          // pending applicant. If a photo fails, the application is already saved; re-sending the
          // form just edits it and retries the photos.
          execute: async () => {
            const result = await apiFetch('/membership/apply', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                lastName: form.lastName.value,
                firstName: form.firstName.value,
                nickname: form.nickname.value || null,
                sectionId: form.sectionId.value,
                description: form.description.value,
              }),
            });
            if (selectedPhotos.length) {
              try {
                await uploadApplicationPhotos(selectedPhotos, progressEl);
              } catch (err) {
                throw new Error(`Zgłoszenie zapisane, ale nie udało się przesłać zdjęć: ${err.message}`);
              } finally {
                progressEl.hidden = true;
              }
            }
            return result;
          },
          apply: () => showOnly(panels.pending),
          viewRoot: panels.form,
          refreshFragment: () => showOnly(panels.pending),
        });
      } catch (err) {
        errorEl.textContent = `Błąd: ${err.message}`;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  showOnly(panels.form);
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/membership/whoami',
  onSignedOut: () => showOnly(panels.signedOut),
  onSignedIn: identity => {
    if (identity.status === 'active') {
      showOnly(panels.active);
    } else if (identity.status === 'pending') {
      showOnly(panels.pending);
    } else if (identity.status === 'suspended') {
      showOnly(panels.suspended);
    } else {
      showForm(identity.status, identity.email);
    }
  },
});
