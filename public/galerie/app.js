const ICON_PHOTO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
  <circle cx="8.5" cy="8.5" r="1.5"/>
  <polyline points="21 15 16 10 5 21"/>
</svg>`;

const ICON_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
</svg>`;

const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" aria-hidden="true">
  <path d="M20 6 9 17l-5-5"/>
</svg>`;

const ICON_GOOGLE_PHOTOS = `<svg viewBox="0 0 59 59" aria-hidden="true">
  <path d="M14.75 13.41c8.146 0 14.75 6.603 14.75 14.75v1.34H1.34C.6 29.5 0 28.9 0 28.16c0-8.147 6.604-14.75 14.75-14.75z" fill="#FBBC04"/>
  <path d="M45.59 14.75c0 8.146-6.603 14.75-14.75 14.75H29.5V1.34C29.5.6 30.1 0 30.84 0c8.147 0 14.75 6.604 14.75 14.75z" fill="#EA4335"/>
  <path d="M44.25 45.59c-8.146 0-14.75-6.603-14.75-14.75V29.5h28.16c.74 0 1.34.6 1.34 1.34 0 8.147-6.604 14.75-14.75 14.75z" fill="#4285F4"/>
  <path d="M13.41 44.25c0-8.146 6.603-14.75 14.75-14.75h1.34v28.16c0 .74-.6 1.34-1.34 1.34-8.147 0-14.75-6.604-14.75-14.75z" fill="#34A853"/>
</svg>`;

const ICON_GOOGLE_DRIVE = `<svg viewBox="0 0 87.3 78" aria-hidden="true">
  <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
  <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
  <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
  <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
  <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
  <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
</svg>`;

const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M12 3v12"/>
  <path d="m7 10 5 5 5-5"/>
  <path d="M5 21h14"/>
</svg>`;

const ICON_CHEVRON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="15 18 9 12 15 6"/>
</svg>`;

const ICON_CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="9 18 15 12 9 6"/>
</svg>`;

const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
</svg>`;

let allAlbums = [];
let sortMode = 'newest';

function displayTitle(title) {
  const clean = s => s.replace(/^[^\p{L}]+/u, '').replace(/[\s,\-–—]+$/g, '').trim();
  let s = title.replace(/\d{4}[-./]\d{2}[-./]\d{2}(?:-\d{2})?/, '');
  if (s !== title) return clean(s) || title;
  s = title.replace(/\d{4}[-./]\d{2}(?=[^-./\d]|$)/, '');
  if (s !== title) return clean(s) || title;
  return title;
}

// Normalises date to YYYY-MM-DD for comparison; pads month-only dates with -01.
function sortKey(date) {
  if (!date) return null;
  return date.length === 7 ? date + '-01' : date;
}

function sort(list) {
  return [...list].sort((a, b) => {
    if (sortMode === 'alpha') return displayTitle(a.title).localeCompare(displayTitle(b.title), 'pl');
    const da = sortKey(a.date), db = sortKey(b.date);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return sortMode === 'newest' ? db.localeCompare(da) : da.localeCompare(db);
  });
}

function filter(list, query) {
  if (!query) return list;
  return list.filter(a => a.searchText.includes(query));
}

// Groups already-sorted albums by year, preserving order; undated albums land in "Bez daty".
function groupByYear(albums) {
  const groups = new Map();
  for (const album of albums) {
    const key = album.date ? album.date.slice(0, 4) : 'Bez daty';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(album);
  }
  return groups;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;');
}

const DIACRITICS = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

function normalizeDiacritics(str) {
  return str.replace(/[ąćęłńóśźż]/g, ch => DIACRITICS[ch]);
}

// Friendly URL slug for an album, derived from its date-stripped title.
// e.g. "Trening Zbiorczy Poznań" -> "trening-zbiorczy-poznan"
function slugify(title) {
  const base = normalizeDiacritics(title.toLowerCase());
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Words (3+ letters) from an album's date-stripped title, for related-gallery matching.
function tokenize(title) {
  const base = normalizeDiacritics(displayTitle(title).toLowerCase());
  return base.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
}

// Scores every other album by shared title words with `album`, descending by score
// then by date (newest first), capped at 12. Returns [] if nothing scores >= 1.
function findRelated(album, albums) {
  const words = new Set(tokenize(album.title));
  if (words.size === 0) return [];

  const scored = albums
    .filter(a => a !== album)
    .map(a => {
      const otherWords = new Set(tokenize(a.title));
      let score = 0;
      for (const w of words) if (otherWords.has(w)) score++;
      return { album: a, score };
    })
    .filter(s => s.score >= 1);

  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const dx = sortKey(x.album.date), dy = sortKey(y.album.date);
    if (dx !== dy) {
      if (!dx) return 1;
      if (!dy) return -1;
      return dy.localeCompare(dx);
    }
    return displayTitle(x.album.title).localeCompare(displayTitle(y.album.title), 'pl');
  });

  return scored.slice(0, 12).map(s => s.album);
}

let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

function renderCard(album, mode = 'focus') {
  const badge = album.date
    ? `<span class="date-badge">${album.date}</span>`
    : `<span class="no-date-badge">bez daty</span>`;

  const countBadge = album.photoCount != null
    ? `<button class="btn-count" aria-label="Informacja o liczbie zdjęć"><span>${album.photoCount >= 300 ? '300+' : album.photoCount}</span>${ICON_PHOTO}</button>`
    : '';

  const isFocusLink = mode === 'focus';
  const coverHref = isFocusLink ? `#${slugify(album.title)}` : album.url;
  const coverExtraAttrs = isFocusLink ? '' : ' target="_blank" rel="noopener noreferrer"';

  return `
    <article class="card" role="listitem">
      <div class="card-cover">
        <a href="${escapeAttr(coverHref)}"${coverExtraAttrs} aria-label="Otwórz album">
          <img
            src="${escapeAttr(album.cover)}"
            alt="${escapeAttr(album.title)}"
            loading="lazy"
            onerror="this.src='../covers/placeholder.jpg'"
          />
        </a>
        ${badge}
      </div>
      <div class="card-body">
        <div class="title-row">
          <p class="card-title">${escapeHtml(displayTitle(album.title))}</p>
          ${countBadge}
          <a
            class="btn-open-photos"
            href="${escapeAttr(album.url)}"
            target="_blank"
            rel="noopener noreferrer"
            title="${album.source === 'drive' ? 'Otwórz folder' : 'Otwórz w Google Photos'}"
            aria-label="${album.source === 'drive' ? 'Otwórz folder' : 'Otwórz w Google Photos'}"
          >${album.source === 'drive' ? ICON_GOOGLE_DRIVE : ICON_GOOGLE_PHOTOS}</a>
          <button
            class="btn-copy"
            data-url="${escapeAttr(`https://www.kruki.org/galerie/#${slugify(album.title)}`)}"
            title="Kopiuj link"
            aria-label="Kopiuj link do albumu"
          >${ICON_LINK}</button>
        </div>
      </div>
    </article>`;
}

function renderYearGroup(label, albums, mode = 'focus') {
  const heading = label ? `<h2 class="year-label">${escapeHtml(label)}</h2>` : '';
  return `
    <section class="year-group">
      ${heading}
      <div class="year-grid" role="list">${albums.map(a => renderCard(a, mode)).join('')}</div>
    </section>`;
}

function renderThumbCol(album, urls) {
  if (!urls.length) return '<div class="thumb-col"></div>';
  return `<div class="thumb-col">${urls.map(u => `
    <a class="thumb" href="${escapeAttr(album.url)}" target="_blank" rel="noopener noreferrer" aria-label="Otwórz album">
      <img src="${escapeAttr(u)}" alt="" loading="lazy" />
    </a>`).join('')}</div>`;
}

function renderDeleteButton() {
  return `<button class="btn-delete-gallery" type="button" id="delete-gallery-btn">${ICON_TRASH} Usuń galerię</button>`;
}

function renderFocusedView(album, albums) {
  const related = findRelated(album, albums);
  const relatedHtml = related.length
    ? `
      <h2 class="related-label">Powiązane</h2>
      <div class="year-grid" role="list">${related.map(a => renderCard(a, 'focus')).join('')}</div>`
    : '';

  const thumbs = album.thumbs ?? [];
  const leftThumbs = thumbs.slice(0, 12);
  const rightThumbs = thumbs.slice(12, 24);

  return `
    <div class="focused-header">
      <a href="#" class="back-link">&larr; Wszystkie galerie</a>
      ${renderDeleteButton()}
    </div>
    <div class="focused-layout">
      ${renderThumbCol(album, leftThumbs)}
      <div class="focused-card">${renderCard(album, 'external')}</div>
      ${renderThumbCol(album, rightThumbs)}
    </div>
    ${relatedHtml}`;
}

const DRIVE_API_KEY_PUBLIC = 'AIzaSyCNnBUsUnpNyfyCeJqPghBraIRjg-YHyPQ';
// UPLOAD_SERVICE_URL comes from auth.js, loaded before this file.

async function fetchDriveFiles(folderId) {
  let files = [];
  let pageToken;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/'`);
    let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,thumbnailLink)&pageSize=1000`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(url, { headers: { 'X-Goog-Api-Key': DRIVE_API_KEY_PUBLIC } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    files = files.concat(data.files ?? []);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

function driveThumbUrl(thumbnailLink, size) {
  return thumbnailLink.replace(/=s\d+$/, `=s${size}`);
}

function driveDownloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

let driveGalleryFiles = [];
let currentIndex = -1;

function renderDriveGalleryView(album) {
  const badge = album.date ? `<span class="drive-gallery-date">${album.date}</span>` : '';
  return `
    <a href="#" class="back-link">&larr; Wszystkie galerie</a>
    <div class="drive-gallery-header">
      <h1 class="drive-gallery-title">${escapeHtml(displayTitle(album.title))}</h1>
      ${badge}
      <div class="drive-gallery-actions">
        <a class="btn-drive-action" href="${escapeAttr(album.url)}" target="_blank" rel="noopener noreferrer">${ICON_GOOGLE_DRIVE} Otwórz w Google Drive</a>
        <button class="btn-drive-action" id="drive-download-album" type="button">${ICON_DOWNLOAD} Pobierz album</button>
        ${renderDeleteButton()}
      </div>
    </div>
    <p class="drive-gallery-status" id="drive-gallery-status"><span class="spinner"></span> Ładowanie…</p>
    <div class="drive-gallery-browser">
      <div class="drive-hero" id="drive-hero" hidden>
        <button class="drive-hero-prev" id="drive-hero-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
        <div class="drive-hero-image-wrap">
          <img id="drive-hero-img" alt="" />
          <span class="spinner"></span>
          <a class="btn-download-image" id="drive-hero-download" download target="_blank" rel="noopener" title="Pobierz zdjęcie" aria-label="Pobierz zdjęcie">${ICON_DOWNLOAD}</a>
        </div>
        <button class="drive-hero-next" id="drive-hero-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
      </div>
      <div class="drive-gallery-grid" id="drive-gallery-grid"></div>
    </div>
    <div class="lightbox" id="lightbox" hidden>
      <button class="lightbox-close" id="lightbox-close" aria-label="Zamknij">&times;</button>
      <button class="lightbox-prev" id="lightbox-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
      <div class="lightbox-image-wrap">
        <img id="lightbox-img" alt="" />
        <span class="spinner"></span>
        <a class="btn-download-image" id="lightbox-download" download target="_blank" rel="noopener" title="Pobierz zdjęcie" aria-label="Pobierz zdjęcie">${ICON_DOWNLOAD}</a>
      </div>
      <button class="lightbox-next" id="lightbox-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
      <div class="lightbox-filmstrip" id="lightbox-filmstrip"></div>
    </div>`;
}

function isMobileGrid() {
  return !window.matchMedia('(min-width: 900px)').matches;
}

// Sizes a masonry cell's grid-row span from its image's own rendered height
// (measured after load, post any CSS max-height clamp) so cells pack without
// gaps or overlap. CSS multi-column and flex-column layouts both failed at
// this (KRKG-0020): multicol overflows in the wrong axis and silently clips
// content, and flex items shrink to fit by default instead of overflowing.
function applyRowSpan(img) {
  const cell = img.closest('.drive-gallery-thumb');
  if (!cell) return;
  const compute = () => {
    const height = img.getBoundingClientRect().height;
    if (!height) return;
    const rowUnit = 1;
    const gap = 8;
    const span = Math.max(1, Math.ceil((height + gap) / (rowUnit + gap)));
    cell.style.gridRowEnd = `span ${span}`;
  };
  if (img.complete && img.naturalWidth) {
    requestAnimationFrame(compute);
  } else {
    img.addEventListener('load', () => requestAnimationFrame(compute), { once: true });
  }
}

function renderGalleryCell(f, i) {
  if (i === currentIndex && isMobileGrid()) {
    return `
      <div class="drive-gallery-thumb drive-gallery-expanded" data-index="${i}">
        <button class="drive-hero-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
        <div class="drive-hero-image-wrap">
          <img src="${escapeAttr(driveThumbUrl(f.thumbnailLink, 1200))}" alt="" />
          <span class="spinner"></span>
          <a class="btn-download-image" download target="_blank" rel="noopener" href="${escapeAttr(driveDownloadUrl(f.id))}" title="Pobierz zdjęcie" aria-label="Pobierz zdjęcie">${ICON_DOWNLOAD}</a>
        </div>
        <button class="drive-hero-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
      </div>`;
  }
  return `
    <button class="drive-gallery-thumb${i === currentIndex ? ' active' : ''}" data-index="${i}" aria-label="Otwórz zdjęcie ${i + 1}">
      <img src="${escapeAttr(driveThumbUrl(f.thumbnailLink, 300))}" alt="" loading="lazy" />
    </button>`;
}

// Shows a spinner over an image's wrap until it finishes loading (or fails).
function watchImageLoad(img) {
  const wrap = img.closest('.drive-hero-image-wrap, .lightbox-image-wrap');
  if (!wrap) return;
  wrap.classList.remove('loaded');
  if (img.complete && img.naturalWidth) {
    wrap.classList.add('loaded');
  } else {
    img.addEventListener('load', () => wrap.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => wrap.classList.add('loaded'), { once: true });
  }
}

function renderGalleryGrid() {
  const grid = document.getElementById('drive-gallery-grid');
  if (!grid) return;
  grid.innerHTML = driveGalleryFiles.map((f, i) => renderGalleryCell(f, i)).join('');
  grid.querySelectorAll('.drive-gallery-thumb img').forEach(applyRowSpan);
  const expandedImg = grid.querySelector('.drive-gallery-expanded img');
  if (expandedImg) watchImageLoad(expandedImg);
}

async function loadDriveGallery(album) {
  const status = document.getElementById('drive-gallery-status');
  const grid = document.getElementById('drive-gallery-grid');
  driveGalleryFiles = [];
  currentIndex = -1;
  try {
    driveGalleryFiles = await fetchDriveFiles(album.driveFolderId);
    if (!status || !grid) return; // user navigated away before this resolved
    if (driveGalleryFiles.length === 0) {
      status.textContent = 'Brak zdjęć w tym folderze.';
      return;
    }
    status.hidden = true;

    renderGalleryGrid();

    const filmstrip = document.getElementById('lightbox-filmstrip');
    if (filmstrip) {
      filmstrip.innerHTML = driveGalleryFiles.map((f, i) => `
        <button class="lightbox-filmstrip-thumb" data-index="${i}" aria-label="Otwórz zdjęcie ${i + 1}">
          <img src="${escapeAttr(driveThumbUrl(f.thumbnailLink, 150))}" alt="" loading="lazy" />
        </button>`).join('');
    }

    const hero = document.getElementById('drive-hero');
    if (hero) hero.hidden = isMobileGrid();
    setCurrentIndex(0);
  } catch (e) {
    if (status) status.textContent = 'Nie udało się załadować zdjęć z Google Drive. Spróbuj odświeżyć stronę.';
  }
}

function setCurrentIndex(index) {
  if (driveGalleryFiles.length === 0) return;
  const prevIndex = currentIndex;
  currentIndex = index;
  const file = driveGalleryFiles[index];
  const largeSrc = driveThumbUrl(file.thumbnailLink, 1600);
  const downloadHref = driveDownloadUrl(file.id);

  const heroImg = document.getElementById('drive-hero-img');
  if (heroImg) {
    heroImg.src = largeSrc;
    watchImageLoad(heroImg);
  }
  const heroDownload = document.getElementById('drive-hero-download');
  if (heroDownload) heroDownload.href = downloadHref;

  const lightboxImg = document.getElementById('lightbox-img');
  if (lightboxImg) {
    lightboxImg.src = largeSrc;
    watchImageLoad(lightboxImg);
  }
  const lightboxDownload = document.getElementById('lightbox-download');
  if (lightboxDownload) lightboxDownload.href = downloadHref;

  document.querySelectorAll('.lightbox-filmstrip-thumb').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.index) === index);
  });

  if (isMobileGrid()) {
    if (prevIndex !== index) renderGalleryGrid();
  } else {
    document.querySelectorAll('.drive-gallery-thumb').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.index) === index);
    });
  }
}

function stepCurrent(delta) {
  if (currentIndex === -1 || driveGalleryFiles.length === 0) return;
  const next = (currentIndex + delta + driveGalleryFiles.length) % driveGalleryFiles.length;
  setCurrentIndex(next);
}

function openLightbox(index) {
  setCurrentIndex(index);
  const box = document.getElementById('lightbox');
  if (box) box.hidden = false;
}

function closeLightbox() {
  const box = document.getElementById('lightbox');
  if (box) box.hidden = true;
}

function downloadAlbum() {
  driveGalleryFiles.forEach((f, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = driveDownloadUrl(f.id);
      a.download = '';
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400);
  });
}

function update() {
  const query = document.getElementById('search').value.trim().toLowerCase();
  const albums = sort(filter(allAlbums, query));

  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');

  const n = albums.length;
  count.textContent = n === 1 ? '1 album' : `${n} albumów`;

  if (!n) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  if (sortMode === 'alpha') {
    grid.innerHTML = renderYearGroup(null, albums);
  } else {
    const groups = groupByYear(albums);
    grid.innerHTML = [...groups.entries()]
      .map(([year, list]) => renderYearGroup(year, list))
      .join('');
  }
}

function route() {
  const hash = location.hash.slice(1);
  const viewGrid = document.getElementById('view-grid');
  const viewFocused = document.getElementById('view-focused');
  const toolbar = document.getElementById('toolbar');

  const album = hash ? allAlbums.find(a => slugify(a.title) === hash) : null;

  if (album) {
    if (album.source === 'drive') {
      viewFocused.innerHTML = renderDriveGalleryView(album);
      loadDriveGallery(album);
    } else {
      viewFocused.innerHTML = renderFocusedView(album, allAlbums);
    }
    viewFocused.hidden = false;
    viewGrid.hidden = true;
    toolbar.hidden = true;
  } else {
    viewFocused.hidden = true;
    viewFocused.innerHTML = '';
    viewGrid.hidden = false;
    toolbar.hidden = false;
  }
}

window.addEventListener('hashchange', route);

function showDeleteReauth() {
  document.getElementById('delete-reauth-modal').hidden = false;
}

function hideDeleteReauth() {
  document.getElementById('delete-reauth-modal').hidden = true;
}

// Drive-folder galleries the app created itself (see mapDiscoveredGallery's `deletable` marker)
// are deleted for real via Drive; everything else - Google Photos, or a Drive folder someone
// registered by pasting a link - only ever exists as an albums.json entry, so "deleting" it
// means removing that entry and waiting for the same CI pipeline /register's writes go through.
async function handleDeleteGallery(album) {
  const isAppOwned = album.deletable === 'drive-folder';
  const warning = isAppOwned
    ? 'Na pewno chcesz usunąć tę galerię? Tej operacji nie można cofnąć.'
    : 'Na pewno chcesz usunąć tę galerię? Tej operacji nie można cofnąć. Galeria zniknie ze strony po około 10 minutach.';
  if (!window.confirm(warning)) return;

  try {
    if (isAppOwned) {
      await apiFetch('/delete-drive-gallery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: album.driveFolderId }),
      }, showDeleteReauth, hideDeleteReauth);
    } else {
      await apiFetch('/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: album.url }),
      }, showDeleteReauth, hideDeleteReauth);
    }
    allAlbums = allAlbums.filter(a => a !== album);
    location.hash = '';
    update();
    showToast(isAppOwned ? 'Galeria usunięta.' : 'Galeria zostanie usunięta ze strony po około 10 minutach.');
  } catch (err) {
    window.alert(`Nie udało się usunąć galerii: ${err.message}`);
  }
}

document.addEventListener('click', e => {
  if (e.target.closest('#delete-gallery-btn')) {
    const hash = location.hash.slice(1);
    const album = hash ? allAlbums.find(a => slugify(a.title) === hash) : null;
    if (album) handleDeleteGallery(album);
    return;
  }
  if (e.target.closest('#drive-download-album')) {
    downloadAlbum();
    return;
  }
  if (e.target.id === 'lightbox' || e.target.closest('#lightbox-close')) {
    closeLightbox();
    return;
  }
  if (e.target.closest('#lightbox-prev')) {
    stepCurrent(-1);
    return;
  }
  if (e.target.closest('#lightbox-next')) {
    stepCurrent(1);
    return;
  }
  if (e.target.closest('.drive-hero-prev')) {
    stepCurrent(-1);
    return;
  }
  if (e.target.closest('.drive-hero-next')) {
    stepCurrent(1);
    return;
  }
  const filmThumb = e.target.closest('.lightbox-filmstrip-thumb');
  if (filmThumb) {
    setCurrentIndex(Number(filmThumb.dataset.index));
    return;
  }
  if (e.target.closest('#drive-hero-img') || e.target.closest('.drive-gallery-expanded img')) {
    openLightbox(currentIndex);
    return;
  }
  const gridThumb = e.target.closest('.drive-gallery-thumb:not(.drive-gallery-expanded)');
  if (gridThumb) {
    setCurrentIndex(Number(gridThumb.dataset.index));
    return;
  }
  if (e.target.closest('.btn-count')) {
    showToast('Liczba zdjęć orientacyjna, z chwili importu ostatniego albumu');
    return;
  }
  const btn = e.target.closest('.btn-copy');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.url).catch(() => {});
  const orig = btn.innerHTML;
  btn.innerHTML = ICON_CHECK;
  setTimeout(() => { btn.innerHTML = orig; }, 1500);
});

document.getElementById('search').addEventListener('input', update);
document.getElementById('sort').addEventListener('change', e => {
  sortMode = e.target.value;
  update();
});

function makeSearchText(title) {
  return title.toLowerCase().replace(/[–—]/g, '-');
}

// Maps a discovered Drive folder (see GET /galleries in upload-service) into the same album
// shape renderCard/route/filter/sort already expect - so a dynamically discovered gallery is
// indistinguishable from a pipeline-generated one everywhere else in this file.
function mapDiscoveredGallery(gallery) {
  const title = gallery.name;
  return {
    title,
    date: gallery.date ? gallery.date.slice(0, 10) : null,
    photoCount: null,
    cover: gallery.coverThumbnailLink ? driveThumbUrl(gallery.coverThumbnailLink, 480) : null,
    url: `https://drive.google.com/drive/folders/${gallery.id}`,
    source: 'drive',
    driveFolderId: gallery.id,
    searchText: makeSearchText(title),
    // Only galleries discovered this way were created by upload-service itself, which is what
    // makes deleting the actual Drive folder possible (drive.file scope can't touch a folder
    // the app didn't create) - see handleDeleteGallery.
    deletable: 'drive-folder',
  };
}

Promise.allSettled([
  fetch('../data/albums.generated.json').then(r => r.json()),
  fetch(`${UPLOAD_SERVICE_URL}/galleries`).then(r => r.json()),
]).then(([generatedResult, discoveredResult]) => {
  const generated = generatedResult.status === 'fulfilled' ? generatedResult.value : null;
  const discovered = discoveredResult.status === 'fulfilled' ? discoveredResult.value.galleries : null;

  if (!generated && !discovered) {
    document.getElementById('count').textContent = 'Błąd ładowania danych';
    return;
  }

  allAlbums = [...(generated ?? []), ...(discovered ?? []).map(mapDiscoveredGallery)];
  update();
  route();
}).finally(() => {
  const gridLoading = document.getElementById('grid-loading');
  if (gridLoading) gridLoading.hidden = true;
});

// Sign-in is only ever needed on demand, when deleting a gallery (see handleDeleteGallery) -
// no persistent sign-in UI on this page, just the reauth modal wired up ahead of time.
initGoogleSignIn({ buttonIds: ['delete-google-signin-button'] });
