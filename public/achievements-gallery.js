/**
 * Standalone photo mosaic for Nasze osiągnięcia (public/o-nas/nasze-osiagniecia/), pulling
 * directly from a public Google Drive folder. Reuses the same read-only, client-side Drive API
 * v3 fetch pattern as galerie/app.js's own galleries (same public, domain-restricted API key),
 * but is otherwise fully independent - no shared module, no upload-service backend, no album
 * registration anywhere. If this folder or its API key ever needs to change, only this file is
 * affected.
 */
const ACHIEVEMENTS_DRIVE_FOLDER_ID = '11lX0AKrH8g8qHC5OT9TJbf-9YlB4OlVE';
const ACHIEVEMENTS_DRIVE_API_KEY = 'AIzaSyCNnBUsUnpNyfyCeJqPghBraIRjg-YHyPQ';

async function fetchAchievementsPhotos() {
  let files = [];
  let pageToken;
  do {
    const q = encodeURIComponent(`'${ACHIEVEMENTS_DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/'`);
    let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,thumbnailLink)&pageSize=1000`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(url, { headers: { 'X-Goog-Api-Key': ACHIEVEMENTS_DRIVE_API_KEY } });
    if (!res.ok) throw new Error(`Drive API error ${res.status}`);
    const data = await res.json();
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

function driveThumbUrl(thumbnailLink, size) {
  return thumbnailLink.replace(/=s\d+$/, `=s${size}`);
}

// Drive filenames are used as-is for captions - only the extension is stripped, since
// "Zwycięstwo na Wolinie 2022.jpg" reads as a caption but the ".jpg" doesn't.
function captionFromFilename(name) {
  return name.replace(/\.[a-zA-Z0-9]+$/, '');
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

let achievementsPhotos = [];
let achievementsCurrentIndex = 0;

function renderAchievementsGrid(grid, photos) {
  grid.innerHTML = photos.map((f, i) => `
    <button type="button" class="achievements-gallery-tile" data-index="${i}" aria-label="Powiększ: ${escapeHtml(captionFromFilename(f.name))}">
      <img src="${escapeHtml(driveThumbUrl(f.thumbnailLink, 600))}" alt="" loading="lazy" />
      <span class="achievements-gallery-caption">${escapeHtml(captionFromFilename(f.name))}</span>
    </button>
  `).join('');
}

function setAchievementsIndex(index) {
  achievementsCurrentIndex = (index + achievementsPhotos.length) % achievementsPhotos.length;
  const file = achievementsPhotos[achievementsCurrentIndex];
  const img = document.getElementById('achievements-lightbox-img');
  const wrap = img ? img.closest('.lightbox-image-wrap') : null;
  if (wrap) wrap.classList.remove('loaded');
  if (img) {
    img.src = driveThumbUrl(file.thumbnailLink, 1600);
    img.onload = () => { if (wrap) wrap.classList.add('loaded'); };
  }
  const caption = document.getElementById('achievements-lightbox-caption');
  if (caption) caption.textContent = captionFromFilename(file.name);
}

function openAchievementsLightbox(index) {
  setAchievementsIndex(index);
  const box = document.getElementById('achievements-lightbox');
  if (box) box.hidden = false;
}

function closeAchievementsLightbox() {
  const box = document.getElementById('achievements-lightbox');
  if (box) box.hidden = true;
}

function stepAchievementsIndex(delta) {
  setAchievementsIndex(achievementsCurrentIndex + delta);
}

document.addEventListener('DOMContentLoaded', async () => {
  const section = document.getElementById('achievements-gallery');
  if (!section) return;
  const grid = document.getElementById('achievements-gallery-grid');
  const loading = document.getElementById('achievements-gallery-loading');
  try {
    const files = await fetchAchievementsPhotos();
    achievementsPhotos = shuffle(files.filter(f => f.thumbnailLink));
    if (loading) loading.hidden = true;
    if (!achievementsPhotos.length) {
      grid.innerHTML = '<p>Brak zdjęć do wyświetlenia.</p>';
      return;
    }
    renderAchievementsGrid(grid, achievementsPhotos);
  } catch (err) {
    console.error('Nie udało się wczytać zdjęć z Google Drive', err);
    if (loading) loading.hidden = true;
    grid.innerHTML = '<p>Nie udało się wczytać zdjęć.</p>';
  }
});

document.addEventListener('click', event => {
  const tile = event.target.closest('.achievements-gallery-tile');
  if (tile) {
    openAchievementsLightbox(Number(tile.dataset.index));
    return;
  }
  if (event.target.id === 'achievements-lightbox' || event.target.closest('#achievements-lightbox-close')) {
    closeAchievementsLightbox();
    return;
  }
  if (event.target.closest('#achievements-lightbox-prev')) {
    stepAchievementsIndex(-1);
    return;
  }
  if (event.target.closest('#achievements-lightbox-next')) {
    stepAchievementsIndex(1);
  }
});

document.addEventListener('keydown', event => {
  const box = document.getElementById('achievements-lightbox');
  if (!box || box.hidden) return;
  if (event.key === 'Escape') closeAchievementsLightbox();
  if (event.key === 'ArrowLeft') stepAchievementsIndex(-1);
  if (event.key === 'ArrowRight') stepAchievementsIndex(1);
});
