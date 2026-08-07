const REPO_URL = 'https://github.com/BractwoWojownikowKruki/krucze-galery';

function isValidAlbumUrl(url) {
  return /^https:\/\/photos\.app\.goo\.gl\/\S+$/.test(url)
    || /^https:\/\/photos\.google\.com\/share\/\S+$/.test(url);
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.hidden = false;
}

function hideError() {
  document.getElementById('error').hidden = true;
}

document.getElementById('add-album-form').addEventListener('submit', e => {
  e.preventDefault();
  hideError();

  const url = document.getElementById('url').value.trim();
  const name = document.getElementById('name').value.trim();
  const date = document.getElementById('date').value;

  if (!isValidAlbumUrl(url)) {
    showError('Link nie wygląda na udostępniony album Google Photos. Oczekiwany format: https://photos.app.goo.gl/XYZ (lub https://photos.google.com/share/...).');
    return;
  }

  if (!date) {
    showError('Podaj datę albumu.');
    return;
  }

  const params = new URLSearchParams({
    template: 'add-album.yml',
    url,
    name,
    date,
  });

  window.location.href = `${REPO_URL}/issues/new?${params.toString()}`;
});
