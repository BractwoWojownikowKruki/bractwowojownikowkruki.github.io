/**
 * Renders the "O nas" category tile grid from GET /about-us?category=<X>, plus a click-to-
 * fullscreen lightbox for each person's photos (mirrors the galleries page's lightbox markup/
 * CSS classes so it needs no styles of its own). Tile markup itself lives in person-tile.js,
 * shared with the Wojownicy upload page's preview - loaded before this script.
 */
const ICON_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

// GET /about-us is public and unauthenticated, so - like the social feed widgets - it stays on
// Cloud Run's own default URL rather than auth.js's UPLOAD_SERVICE_URL (api.kruki.org): that
// domain mapping is Preview-status infrastructure accepted only for the login/session flow,
// and this page shouldn't go down with it if it ever has a bad day.
const ABOUT_US_BACKEND_URL = 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';

let people = [];
let lightboxPersonIndex = -1;
let lightboxPhotoIndex = -1;

async function loadAboutUsCategory() {
  const category = document.body.dataset.category;
  const grid = document.getElementById('people-grid');
  if (!category || !grid) return;

  try {
    const res = await fetch(`${ABOUT_US_BACKEND_URL}/about-us?category=${encodeURIComponent(category)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPeople(data.people || []);
  } catch (err) {
    grid.innerHTML = '<p class="empty">Nie udało się załadować tej sekcji. Spróbuj odświeżyć stronę.</p>';
  }
}

// Google Drive thumbnail URLs (both mainPhoto's 800px and photos[]'s 300px versions) end in
// =sNNN - bumping that number gets a sharper version of the same image for the lightbox
// without the backend needing to serve a separate full-resolution field.
function resizeUrl(url, size) {
  return url.replace(/=s\d+$/, `=s${size}`);
}

// Every photo a person has, main photo first - what the lightbox steps through. Deduplicated
// mostly by construction (mainPhoto and photos[] are already Drive's own distinct files).
function personPhotos(person) {
  const list = [];
  if (person.mainPhoto) list.push(person.mainPhoto);
  list.push(...person.photos);
  return list;
}

function renderPeople(peopleData) {
  const grid = document.getElementById('people-grid');
  people = peopleData;
  if (!people.length) {
    grid.innerHTML = '<p class="empty">Brak osób do wyświetlenia w tej kategorii.</p>';
    return;
  }
  // Array.prototype.map also passes the array itself as a 3rd argument - wrapped so
  // personTileHtml never sees that as its options parameter.
  grid.innerHTML = people.map((person, i) => personTileHtml(person, i)).join('');
}

function lightboxMarkup() {
  return `
    <div class="lightbox" id="person-lightbox" hidden>
      <button class="lightbox-close" id="person-lightbox-close" aria-label="Zamknij">&times;</button>
      <button class="lightbox-prev" id="person-lightbox-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
      <div class="lightbox-image-wrap">
        <img id="person-lightbox-img" alt="" />
        <span class="spinner"></span>
      </div>
      <button class="lightbox-next" id="person-lightbox-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
      <div class="lightbox-filmstrip" id="person-lightbox-filmstrip"></div>
    </div>`;
}

function watchImageLoad(img) {
  const wrap = img.closest('.lightbox-image-wrap');
  if (!wrap) return;
  wrap.classList.remove('loaded');
  if (img.complete && img.naturalWidth) {
    wrap.classList.add('loaded');
  } else {
    img.addEventListener('load', () => wrap.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => wrap.classList.add('loaded'), { once: true });
  }
}

function openLightbox(personIndex, photoIndex) {
  const photos = personPhotos(people[personIndex]);
  if (!photos.length) return;
  lightboxPersonIndex = personIndex;

  const filmstrip = document.getElementById('person-lightbox-filmstrip');
  filmstrip.innerHTML = photos.map((p, i) => `
    <button class="lightbox-filmstrip-thumb" data-index="${i}" aria-label="Otwórz zdjęcie ${i + 1}">
      <img src="${escapeAttr(p.url)}" alt="" loading="lazy" />
    </button>`).join('');

  document.getElementById('person-lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  setLightboxIndex(photoIndex);
}

function setLightboxIndex(photoIndex) {
  const photos = personPhotos(people[lightboxPersonIndex]);
  lightboxPhotoIndex = photoIndex;
  const photo = photos[photoIndex];

  const img = document.getElementById('person-lightbox-img');
  img.src = resizeUrl(photo.url, 1600);
  watchImageLoad(img);

  document.querySelectorAll('#person-lightbox-filmstrip .lightbox-filmstrip-thumb').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.index) === photoIndex);
  });
}

function stepLightbox(delta) {
  if (lightboxPersonIndex === -1) return;
  const photos = personPhotos(people[lightboxPersonIndex]);
  const next = (lightboxPhotoIndex + delta + photos.length) % photos.length;
  setLightboxIndex(next);
}

function closeLightbox() {
  document.getElementById('person-lightbox').hidden = true;
  document.body.style.overflow = '';
  lightboxPersonIndex = -1;
  lightboxPhotoIndex = -1;
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.insertAdjacentHTML('beforeend', lightboxMarkup());
  loadAboutUsCategory();
});

document.addEventListener('click', e => {
  const trigger = e.target.closest('.person-main-photo, .person-gallery img');
  if (trigger) {
    openLightbox(Number(trigger.dataset.personIndex), Number(trigger.dataset.photoIndex));
    return;
  }

  if (e.target.id === 'person-lightbox' || e.target.closest('#person-lightbox-close')) {
    closeLightbox();
    return;
  }
  if (e.target.closest('#person-lightbox-prev')) {
    stepLightbox(-1);
    return;
  }
  if (e.target.closest('#person-lightbox-next')) {
    stepLightbox(1);
    return;
  }
  const filmThumb = e.target.closest('.lightbox-filmstrip-thumb');
  if (filmThumb && filmThumb.closest('#person-lightbox')) {
    setLightboxIndex(Number(filmThumb.dataset.index));
  }
});

document.addEventListener('keydown', e => {
  if (lightboxPersonIndex === -1) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') stepLightbox(-1);
  if (e.key === 'ArrowRight') stepLightbox(1);
});
