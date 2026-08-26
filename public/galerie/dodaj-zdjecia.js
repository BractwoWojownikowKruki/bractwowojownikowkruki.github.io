const MAX_CONCURRENT_UPLOADS = 4;
const MAX_RETRIES_PER_FILE = 2;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const params = new URLSearchParams(location.search);
const folderId = params.get('folderId');
const galleryName = params.get('name');
const galleryHash = params.get('hash');

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

const backLink = document.getElementById('back-to-gallery-link');
if (galleryHash) backLink.href = `index.html#${galleryHash}`;

if (galleryName) {
  document.getElementById('gallery-name-intro').textContent = `Prześlij nowe zdjęcia do galerii „${galleryName}”.`;
}

if (!folderId) {
  document.getElementById('upload-signin').hidden = true;
  showError('upload-error', 'Brak wskazanej galerii - wróć do listy galerii i wybierz „Dodaj zdjęcia” z widoku konkretnej galerii.');
  document.getElementById('upload-submit-button').disabled = true;
} else {
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
}

function storageKeyFor(id) {
  return `krucze-galery-add-photos:${id}`;
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

async function uploadOneFile(targetFolderId, submissionToken, file, attempt = 1) {
  try {
    await apiFetch(
      `/upload?folderId=${encodeURIComponent(targetFolderId)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
      { method: 'POST', body: file, headers: { 'X-Submission-Token': submissionToken } },
      showReauth,
      hideReauth,
    );
    return true;
  } catch (err) {
    if (attempt < MAX_RETRIES_PER_FILE) {
      return uploadOneFile(targetFolderId, submissionToken, file, attempt + 1);
    }
    return false;
  }
}

async function uploadAllFiles(targetFolderId, submissionToken, files, onProgress) {
  const failed = [];
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < files.length) {
      const file = files[nextIndex++];
      const ok = await uploadOneFile(targetFolderId, submissionToken, file);
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
  const listEl = document.getElementById('upload-failed-list');
  progressEl.hidden = false;
  textEl.textContent = `Przesłano ${completed} / ${total}`;
  if (failed.length) {
    listEl.hidden = false;
    listEl.innerHTML = failed.map(name => `<li>Nie udało się przesłać: ${name}</li>`).join('');
  }
}

async function submitPhotos(files) {
  const oversized = files.filter(f => f.size > MAX_FILE_BYTES);
  if (oversized.length) {
    throw new Error(`Za duży plik (limit ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB): ${oversized.map(f => f.name).join(', ')}`);
  }

  const key = storageKeyFor(folderId);
  let state = loadUploadState(key);

  let submissionToken;
  if (state?.submissionToken) {
    submissionToken = state.submissionToken;
    const { uploadedFiles } = await apiFetch(`/status?folderId=${encodeURIComponent(folderId)}`, {
      method: 'GET',
      headers: { 'X-Submission-Token': submissionToken },
    }, showReauth, hideReauth);
    const uploadedKeys = new Set(uploadedFiles.map(f => fileKey(f.name, f.size)));
    files = files.filter(f => !uploadedKeys.has(fileKey(f.name, f.size)));
  } else {
    ({ submissionToken } = await apiFetch('/gallery-photos/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId }),
    }, showReauth, hideReauth));
    state = { submissionToken };
    saveUploadState(key, state);
  }

  const failed = await uploadAllFiles(folderId, submissionToken, files, renderProgress);
  if (failed.length) {
    throw new Error(`Nie udało się przesłać ${failed.length} plik(ów). Spróbuj przesłać ponownie — pominiemy już przesłane zdjęcia.`);
  }

  await apiFetch('/gallery-photos/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Submission-Token': submissionToken },
    body: JSON.stringify({ folderId }),
  }, showReauth, hideReauth);
  clearUploadState(key);
}

document.getElementById('upload-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError('upload-error');

  const files = Array.from(document.getElementById('upload-files').files);
  if (!files.length) {
    showError('upload-error', 'Wybierz co najmniej jedno zdjęcie.');
    return;
  }

  const submitButton = document.getElementById('upload-submit-button');
  submitButton.disabled = true;
  try {
    await submitPhotos(files);
    document.getElementById('upload-form').hidden = true;
    document.getElementById('upload-success').hidden = false;
  } catch (err) {
    showError('upload-error', err.message);
  } finally {
    submitButton.disabled = false;
  }
});
