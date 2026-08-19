/**
 * "Wrzucam swoje zdjęcie" - self-service photo submission for Wojownicy group members.
 * Sign-in gated by GET /wojownicy-upload/whoami (kruki Google Group membership, see
 * upload-service/src/allowlist.ts's createAppsScriptAllowlist). The preview tile is built with
 * the exact same personTileHtml() the real About Us grids use (person-tile.js) - nothing here
 * touches Drive until "Zatwierdzam" is clicked; until then every URL in the preview is a local
 * blob: URL from the files the user picked, never uploaded.
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

function selectedFiles() {
  const name = document.getElementById('wrzuc-name').value.trim();
  const mainPhoto = document.getElementById('wrzuc-main-photo').files[0] || null;
  const extraPhotos = Array.from(document.getElementById('wrzuc-extra-photos').files);
  return { name, mainPhoto, extraPhotos };
}

function updatePreview() {
  const { name, mainPhoto, extraPhotos } = selectedFiles();
  const wrap = document.getElementById('wrzuc-preview-wrap');

  if (!name || !mainPhoto) {
    wrap.hidden = true;
    return;
  }

  const fakePerson = {
    name,
    description: '',
    mainPhoto: { url: URL.createObjectURL(mainPhoto) },
    photos: extraPhotos.map(f => ({ url: URL.createObjectURL(f) })),
  };
  document.getElementById('wrzuc-preview').innerHTML = personTileHtml(fakePerson, 0);
  wrap.hidden = false;
}

['wrzuc-name', 'wrzuc-main-photo', 'wrzuc-extra-photos'].forEach(id => {
  document.getElementById(id).addEventListener('input', updatePreview);
});

document.getElementById('wrzuc-cancel').addEventListener('click', () => {
  document.getElementById('wrzuc-form').reset();
  document.getElementById('wrzuc-preview-wrap').hidden = true;
});

async function uploadPhoto(folderId, submissionToken, file, isMain) {
  const query = new URLSearchParams({
    folderId,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    isMain: String(isMain),
  });
  await apiFetch(
    `/wojownicy-upload/photo?${query.toString()}`,
    { method: 'POST', headers: { 'X-Submission-Token': submissionToken }, body: file },
    showReauth,
    hideReauth,
  );
}

document.getElementById('wrzuc-confirm').addEventListener('click', async () => {
  const { name, mainPhoto, extraPhotos } = selectedFiles();
  const errorEl = document.getElementById('wrzuc-error');
  const progressEl = document.getElementById('wrzuc-progress');
  const confirmBtn = document.getElementById('wrzuc-confirm');
  const cancelBtn = document.getElementById('wrzuc-cancel');

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

    const total = 1 + extraPhotos.length;
    progressEl.textContent = `Przesyłanie zdjęć (0/${total})...`;
    await uploadPhoto(folderId, submissionToken, mainPhoto, true);
    progressEl.textContent = `Przesyłanie zdjęć (1/${total})...`;
    for (let i = 0; i < extraPhotos.length; i++) {
      await uploadPhoto(folderId, submissionToken, extraPhotos[i], false);
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
