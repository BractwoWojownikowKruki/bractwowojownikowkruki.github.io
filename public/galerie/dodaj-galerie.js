const MAX_CONCURRENT_UPLOADS = 4;
const MAX_RETRIES_PER_FILE = 2;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function isValidAlbumUrl(url) {
  return /^https:\/\/photos\.app\.goo\.gl\/\S+$/.test(url)
    || /^https:\/\/photos\.google\.com\/share\/\S+$/.test(url)
    || /^https:\/\/drive\.google\.com\/drive\/folders\/[a-zA-Z0-9_-]+/.test(url);
}

function showError(errorElId, msg) {
  const el = document.getElementById(errorElId);
  el.textContent = msg;
  el.hidden = false;
}

function hideError(errorElId) {
  document.getElementById(errorElId).hidden = true;
}

function showReauth() {
  document.getElementById('upload-reauth').hidden = false;
}

function hideReauth() {
  document.getElementById('upload-reauth').hidden = true;
}

initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  onSignedIn: payload => {
    document.getElementById('upload-signin').hidden = true;
    document.getElementById('upload-signed-in-email').textContent = payload.email;
    document.getElementById('upload-signed-in').hidden = false;
  },
  onForbidden: () => {
    document.getElementById('upload-signin').hidden = true;
    document.getElementById('upload-forbidden').hidden = false;
  },
});

function storageKeyFor(date, name) {
  return `krucze-galery-upload:${date}:${name || ''}`;
}

function saveUploadState(key, state) {
  localStorage.setItem(key, JSON.stringify(state));
}

function loadUploadState(key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

function clearUploadState(key) {
  localStorage.removeItem(key);
}

function fileKey(name, size) {
  return `${name}:${size}`;
}

async function uploadOneFile(folderId, submissionToken, file, attempt = 1) {
  try {
    await apiFetch(
      `/upload?folderId=${encodeURIComponent(folderId)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
      { method: 'POST', body: file, headers: { 'X-Submission-Token': submissionToken } },
      showReauth,
      hideReauth,
    );
    return true;
  } catch (err) {
    if (attempt < MAX_RETRIES_PER_FILE) {
      return uploadOneFile(folderId, submissionToken, file, attempt + 1);
    }
    return false;
  }
}

async function uploadAllFiles(folderId, submissionToken, files, onProgress) {
  const failed = [];
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < files.length) {
      const file = files[nextIndex++];
      const ok = await uploadOneFile(folderId, submissionToken, file);
      completed++;
      if (!ok) failed.push(file.name);
      onProgress(completed, files.length, failed);
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, files.length) }, worker);
  await Promise.all(workers);
  return failed;
}

function renderProgress(completed, total, failed) {
  const progressEl = document.getElementById('upload-progress');
  const textEl = document.getElementById('upload-progress-text');
  const fillEl = document.getElementById('upload-progress-fill');
  const listEl = document.getElementById('upload-failed-list');
  progressEl.hidden = false;
  textEl.textContent = `Przesłano ${completed} / ${total}`;
  if (fillEl) fillEl.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  if (failed.length) {
    listEl.hidden = false;
    listEl.innerHTML = failed.map(name => `<li>Nie udało się przesłać: ${name}</li>`).join('');
  }
}

// Shown the instant the submit handler starts, before /start or the first file upload has even
// resolved - otherwise the only feedback for however long that takes is the disabled button,
// which easily reads as "did clicking that do anything at all?".
function renderUploadStarting() {
  const progressEl = document.getElementById('upload-progress');
  const textEl = document.getElementById('upload-progress-text');
  const fillEl = document.getElementById('upload-progress-fill');
  const listEl = document.getElementById('upload-failed-list');
  progressEl.hidden = false;
  textEl.textContent = 'Rozpoczynanie przesyłania...';
  if (fillEl) fillEl.style.width = '0%';
  listEl.hidden = true;
  listEl.innerHTML = '';
}

async function submitViaUpload(name, date, files) {
  const oversized = files.filter(f => f.size > MAX_FILE_BYTES);
  if (oversized.length) {
    throw new Error(`Za duży plik (limit ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB): ${oversized.map(f => f.name).join(', ')}`);
  }

  const key = storageKeyFor(date, name);
  let state = loadUploadState(key);

  let folderId;
  let submissionToken;
  if (state?.folderId && state?.submissionToken) {
    folderId = state.folderId;
    submissionToken = state.submissionToken;
    const { uploadedFiles } = await apiFetch(`/status?folderId=${encodeURIComponent(folderId)}`, {
      method: 'GET',
      headers: { 'X-Submission-Token': submissionToken },
    }, showReauth, hideReauth);
    const uploadedKeys = new Set(uploadedFiles.map(f => fileKey(f.name, f.size)));
    files = files.filter(f => !uploadedKeys.has(fileKey(f.name, f.size)));
  } else {
    ({ folderId, submissionToken } = await apiFetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, date }),
    }, showReauth, hideReauth));
    state = { folderId, submissionToken, date, name };
    saveUploadState(key, state);
  }

  const failed = await uploadAllFiles(folderId, submissionToken, files, renderProgress);
  if (failed.length) {
    throw new Error(`Nie udało się przesłać ${failed.length} plik(ów). Spróbuj przesłać ponownie — pominiemy już przesłane zdjęcia.`);
  }

  await apiFetch('/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Submission-Token': submissionToken },
    body: JSON.stringify({ folderId, name, date }),
  }, showReauth, hideReauth);
  clearUploadState(key);
}

document.getElementById('upload-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('upload-error');

  const name = document.getElementById('upload-name').value.trim();
  const date = document.getElementById('upload-date').value;
  if (!date) {
    showError('upload-error', 'Podaj datę albumu.');
    return;
  }

  const files = Array.from(document.getElementById('upload-files').files);
  if (!files.length) {
    showError('upload-error', 'Wybierz co najmniej jedno zdjęcie.');
    return;
  }

  const submitButton = document.getElementById('upload-submit-button');
  submitButton.disabled = true;
  renderUploadStarting();
  try {
    await submitViaUpload(name, date, files);
    // /finalize succeeding means the gallery is already owned and published by
    // upload-service and picked up by GET /galleries - near-instant, no pipeline involved.
    document.getElementById('upload-form').hidden = true;
    document.getElementById('upload-success').hidden = false;
  } catch (err) {
    showError('upload-error', err.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('register-error');

  const name = document.getElementById('register-name').value.trim();
  const date = document.getElementById('register-date').value;
  if (!date) {
    showError('register-error', 'Podaj datę albumu.');
    return;
  }

  const url = document.getElementById('register-url').value.trim();
  if (!isValidAlbumUrl(url)) {
    showError('register-error', 'Link nie wygląda na udostępniony album Google Photos ani folder Google Drive. Oczekiwany format: https://photos.app.goo.gl/XYZ, https://photos.google.com/share/... lub https://drive.google.com/drive/folders/XYZ.');
    return;
  }

  const submitButton = document.getElementById('register-submit-button');
  submitButton.disabled = true;
  try {
    // Registers an existing gallery directly - requires being signed in with an allowlisted
    // account (see /register in upload-service), which apiFetch's ensureFreshIdToken prompts
    // for if the user hasn't signed in yet. Committed to albums.json and picked up by the CI
    // pipeline, same as before - not instant.
    await apiFetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name, date }),
    }, showReauth, hideReauth);
    document.getElementById('register-form').hidden = true;
    document.getElementById('register-success').hidden = false;
  } catch (err) {
    showError('register-error', err.message);
  } finally {
    submitButton.disabled = false;
  }
});
