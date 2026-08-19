/**
 * "Wrzucam swoje zdjęcie" - self-service photo submission for Wojownicy group members.
 * Sign-in gated by GET /wojownicy-upload/whoami (kruki Google Group membership, see
 * upload-service/src/allowlist.ts's createAppsScriptAllowlist). The preview tile is built with
 * the exact same personTileHtml() the real About Us grids use (person-tile.js) - nothing here
 * touches Drive until "Zatwierdzam" is clicked; until then every URL in the preview is a local
 * blob: URL from the files the user picked (or the cropped version of one), never uploaded.
 *
 * photoEntries[0] is the main photo, photoEntries[1..N] the extras - same index scheme
 * data-photo-index already uses elsewhere (see person-tile.js), so a crop button's index maps
 * straight onto this array. Each entry is {file, croppedBlob}: croppedBlob is null until the
 * user actually opens that photo's crop modal and saves - an uncropped photo just uploads the
 * original file untouched.
 */
function showReauth() {
  document.getElementById('upload-reauth').hidden = false;
}
function hideReauth() {
  document.getElementById('upload-reauth').hidden = true;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: payload => {
    document.getElementById('upload-signin').hidden = true;
    document.getElementById('upload-signed-in-email').textContent = payload.email;
    document.getElementById('upload-signed-in').hidden = false;
    document.getElementById('wrzuc-form').hidden = false;
  },
  onForbidden: () => {
    document.getElementById('upload-signin').hidden = true;
    document.getElementById('upload-forbidden').hidden = false;
  },
});

let photoEntries = [];

function entrySourceBlob(entry) {
  return entry.croppedBlob || entry.file;
}

function renderPreview() {
  const name = document.getElementById('wrzuc-name').value.trim();
  const wrap = document.getElementById('wrzuc-preview-wrap');
  const mainEntry = photoEntries[0];

  if (!name || !mainEntry) {
    wrap.hidden = true;
    return;
  }

  const extraEntries = photoEntries.slice(1).filter(Boolean);
  const fakePerson = {
    name,
    description: '',
    mainPhoto: { url: URL.createObjectURL(entrySourceBlob(mainEntry)) },
    photos: extraEntries.map(entry => ({ url: URL.createObjectURL(entrySourceBlob(entry)) })),
  };
  document.getElementById('wrzuc-preview').innerHTML = personTileHtml(fakePerson, 0, { editable: true });
  wrap.hidden = false;
}

document.getElementById('wrzuc-name').addEventListener('input', renderPreview);

document.getElementById('wrzuc-main-photo').addEventListener('input', () => {
  const file = document.getElementById('wrzuc-main-photo').files[0] || null;
  photoEntries[0] = file ? { file, croppedBlob: null } : undefined;
  renderPreview();
});

document.getElementById('wrzuc-extra-photos').addEventListener('input', () => {
  const extraFiles = Array.from(document.getElementById('wrzuc-extra-photos').files);
  photoEntries.length = 1; // keep index 0 (main photo) untouched, drop everything after it
  extraFiles.forEach((file, i) => {
    photoEntries[i + 1] = { file, croppedBlob: null };
  });
  renderPreview();
});

document.getElementById('wrzuc-cancel').addEventListener('click', () => {
  document.getElementById('wrzuc-form').reset();
  photoEntries = [];
  document.getElementById('wrzuc-preview-wrap').hidden = true;
});

// ── Crop modal ──────────────────────────────────────────────────────────────

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
  // Most browsers (everything but Safari) can't decode HEIC/HEIF into an <img> at all - rather
  // than leave the user staring at a broken modal, fail gracefully and keep the original file
  // uploadable as-is; cropping is optional, not a requirement to submit.
  img.onerror = () => {
    errorEl.hidden = false;
    saveBtn.hidden = true;
    img.hidden = true;
  };
  img.src = URL.createObjectURL(entrySourceBlob(entry));
}

document.getElementById('wrzuc-preview').addEventListener('click', e => {
  const btn = e.target.closest('.photo-crop-btn');
  if (btn) openCropModal(Number(btn.dataset.photoIndex));
});

document.getElementById('crop-cancel').addEventListener('click', closeCropModal);

document.getElementById('crop-save').addEventListener('click', () => {
  if (!activeCropper) return;
  const canvas = activeCropper.getCroppedCanvas({ maxWidth: 2000, maxHeight: 2000 });
  const entry = photoEntries[activeCropIndex];
  if (!canvas || !entry) {
    closeCropModal();
    return;
  }
  // Always re-encoded as JPEG regardless of the source format - canvas can't encode back to
  // HEIC/HEIF anyway (browsers silently fall back to PNG for unsupported output types), and
  // JPEG is the right choice for a cropped photograph either way.
  canvas.toBlob(
    blob => {
      if (blob) {
        entry.croppedBlob = blob;
        renderPreview();
      }
      closeCropModal();
    },
    'image/jpeg',
    0.9,
  );
});

// ── Submit ──────────────────────────────────────────────────────────────────

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

document.getElementById('wrzuc-confirm').addEventListener('click', async () => {
  const name = document.getElementById('wrzuc-name').value.trim();
  const mainEntry = photoEntries[0];
  const extraEntries = photoEntries.slice(1).filter(Boolean);
  const errorEl = document.getElementById('wrzuc-error');
  const progressEl = document.getElementById('wrzuc-progress');
  const confirmBtn = document.getElementById('wrzuc-confirm');
  const cancelBtn = document.getElementById('wrzuc-cancel');

  if (!mainEntry) return;

  errorEl.hidden = true;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  progressEl.hidden = false;
  progressEl.textContent = 'Zapisywanie...';

  try {
    const { folderId, submissionToken } = await apiFetch(
      '/wojownicy-upload/submit',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
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

    document.getElementById('wrzuc-form').hidden = true;
    document.getElementById('wrzuc-preview-wrap').hidden = true;
    document.getElementById('wrzuc-success').hidden = false;
  } catch (err) {
    errorEl.textContent = `Błąd: ${err.message}`;
    errorEl.hidden = false;
    progressEl.hidden = true;
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});
