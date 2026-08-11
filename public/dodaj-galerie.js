const REPO_URL = 'https://github.com/BractwoWojownikowKruki/krucze-galery';
const UPLOAD_SERVICE_URL = 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';
const GOOGLE_OAUTH_CLIENT_ID = '895090213384-cqac9v2tvmjhkkertjjj5q4h8qf41g3d.apps.googleusercontent.com';
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_RETRIES_PER_FILE = 2;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Refresh a little before the token's real expiry, not exactly at it, so an in-flight
// request never straddles the boundary between "was valid" and "just expired".
const ID_TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS = 30;

let idToken = null;
let idTokenExp = 0;
let pendingReauth = null;
let uploadMode = false;

function isValidAlbumUrl(url) {
  return /^https:\/\/photos\.app\.goo\.gl\/\S+$/.test(url)
    || /^https:\/\/photos\.google\.com\/share\/\S+$/.test(url)
    || /^https:\/\/drive\.google\.com\/drive\/folders\/[a-zA-Z0-9_-]+/.test(url);
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.hidden = false;
}

function hideError() {
  document.getElementById('error').hidden = true;
}

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
}

function isIdTokenValid() {
  return Boolean(idToken) && idTokenExp - ID_TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS > Date.now() / 1000;
}

// Pauses the caller and shows a visible re-sign-in prompt if the current Google ID token has
// expired or is about to. Resolves once handleCredentialResponse fires again with a fresh one.
// Deliberately explicit/visible rather than a silent background refresh - Identity Services
// doesn't offer a reliable silent-refresh path across third-party-cookie-restricted browsers.
async function ensureFreshIdToken() {
  if (isIdTokenValid()) return;
  document.getElementById('upload-reauth').hidden = false;
  await new Promise(resolve => { pendingReauth = resolve; });
}

async function apiFetch(path, options) {
  await ensureFreshIdToken();
  const res = await fetch(`${UPLOAD_SERVICE_URL}${path}`, {
    ...options,
    headers: { ...(options?.headers ?? {}), Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function handleCredentialResponse(response) {
  idToken = response.credential;
  const payload = decodeJwtPayload(idToken);
  idTokenExp = payload.exp;

  if (pendingReauth) {
    const resolve = pendingReauth;
    pendingReauth = null;
    document.getElementById('upload-reauth').hidden = true;
    resolve();
    return;
  }

  document.getElementById('upload-signin').hidden = true;
  try {
    await apiFetch('/whoami', { method: 'GET' });
    document.getElementById('upload-signed-in-email').textContent = payload.email;
    document.getElementById('upload-signed-in').hidden = false;
  } catch {
    document.getElementById('upload-forbidden').hidden = false;
  }
}

function initGoogleSignIn() {
  if (!window.google?.accounts?.id) return;
  window.google.accounts.id.initialize({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    callback: handleCredentialResponse,
  });
  window.google.accounts.id.renderButton(document.getElementById('google-signin-button'), {
    type: 'standard',
    text: 'signin_with',
    locale: 'pl',
  });
  window.google.accounts.id.renderButton(document.getElementById('google-reauth-button'), {
    type: 'standard',
    text: 'signin_with',
    locale: 'pl',
  });
}

function setUploadMode(enabled) {
  uploadMode = enabled;
  document.getElementById('url-field').hidden = enabled;
  document.getElementById('url').required = !enabled;
  document.getElementById('files-field').hidden = !enabled;
  document.getElementById('files').required = enabled;
  document.getElementById('upload-mode-toggle').textContent = enabled
    ? 'Wróć do wklejania linku'
    : 'Prześlij pliki zamiast linku';
}

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
  const listEl = document.getElementById('upload-failed-list');
  progressEl.hidden = false;
  textEl.textContent = `Przesłano ${completed} / ${total}`;
  if (failed.length) {
    listEl.hidden = false;
    listEl.innerHTML = failed.map(name => `<li>Nie udało się przesłać: ${name}</li>`).join('');
  }
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
    });
    const uploadedKeys = new Set(uploadedFiles.map(f => fileKey(f.name, f.size)));
    files = files.filter(f => !uploadedKeys.has(fileKey(f.name, f.size)));
  } else {
    ({ folderId, submissionToken } = await apiFetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, date }),
    }));
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
  });
  clearUploadState(key);
}

document.getElementById('upload-mode-toggle')?.addEventListener('click', () => setUploadMode(!uploadMode));

document.getElementById('add-album-form').addEventListener('submit', async e => {
  e.preventDefault();
  hideError();

  const name = document.getElementById('name').value.trim();
  const date = document.getElementById('date').value;

  if (!date) {
    showError('Podaj datę albumu.');
    return;
  }

  if (uploadMode) {
    const files = Array.from(document.getElementById('files').files);
    if (!files.length) {
      showError('Wybierz co najmniej jedno zdjęcie.');
      return;
    }
    const submitButton = document.getElementById('submit-button');
    submitButton.disabled = true;
    try {
      await submitViaUpload(name, date, files);
      // /finalize succeeding only means the GitHub commit was accepted, not that pages.yml
      // has finished testing/building/deploying - so this shows an "accepted" message and a
      // manual link back, rather than redirecting in a way that implies the gallery is
      // already live.
      document.getElementById('add-album-form').hidden = true;
      document.getElementById('upload-success').hidden = false;
    } catch (err) {
      showError(err.message);
    } finally {
      submitButton.disabled = false;
    }
    return;
  }

  const url = document.getElementById('url').value.trim();
  if (!isValidAlbumUrl(url)) {
    showError('Link nie wygląda na udostępniony album Google Photos ani folder Google Drive. Oczekiwany format: https://photos.app.goo.gl/XYZ, https://photos.google.com/share/... lub https://drive.google.com/drive/folders/XYZ.');
    return;
  }

  const params = new URLSearchParams({
    template: 'add-album.yml',
    title: `Nowy album: ${name || date}`,
    url,
    name,
    date,
  });

  window.location.href = `${REPO_URL}/issues/new?${params.toString()}`;
});

initGoogleSignIn();
