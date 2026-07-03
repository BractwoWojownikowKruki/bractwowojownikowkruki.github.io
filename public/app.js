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

function renderCard(album) {
  const badge = album.date
    ? `<span class="date-badge">${album.date}</span>`
    : `<span class="no-date-badge">bez daty</span>`;

  const countBadge = album.photoCount != null
    ? `<button class="btn-count" aria-label="Informacja o liczbie zdjęć"><span>${album.photoCount >= 300 ? '300+' : album.photoCount}</span>${ICON_PHOTO}</button>`
    : '';

  return `
    <article class="card" role="listitem">
      <div class="card-cover">
        <a href="${escapeAttr(album.url)}" target="_blank" rel="noopener noreferrer" aria-label="Otwórz album">
          <img
            src="${escapeAttr(album.cover)}"
            alt="${escapeAttr(album.title)}"
            loading="lazy"
            onerror="this.src='covers/placeholder.jpg'"
          />
        </a>
        ${badge}
      </div>
      <div class="card-body">
        <div class="title-row">
          <p class="card-title">${escapeHtml(displayTitle(album.title))}</p>
          ${countBadge}
          <button
            class="btn-copy"
            data-url="${escapeAttr(album.url)}"
            title="Kopiuj link"
            aria-label="Kopiuj link do albumu"
          >${ICON_LINK}</button>
        </div>
      </div>
    </article>`;
}

function renderYearGroup(label, albums) {
  const heading = label ? `<h2 class="year-label">${escapeHtml(label)}</h2>` : '';
  return `
    <section class="year-group">
      ${heading}
      <div class="year-grid" role="list">${albums.map(renderCard).join('')}</div>
    </section>`;
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

document.getElementById('grid').addEventListener('click', e => {
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

fetch('data/albums.generated.json')
  .then(r => r.json())
  .then(data => {
    allAlbums = data;
    update();
  })
  .catch(() => {
    document.getElementById('count').textContent = 'Błąd ładowania danych';
  });
