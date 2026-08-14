/**
 * Renders the "O nas" category tile grid from GET /about-us?category=<X>.
 * Each page including this script sets data-category on <body>.
 */
async function loadAboutUsCategory() {
  const category = document.body.dataset.category;
  const grid = document.getElementById('people-grid');
  if (!category || !grid) return;

  try {
    const res = await fetch(`${UPLOAD_SERVICE_URL}/about-us?category=${encodeURIComponent(category)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPeople(data.people || []);
  } catch (err) {
    grid.innerHTML = '<p class="empty">Nie udało się załadować tej sekcji. Spróbuj odświeżyć stronę.</p>';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPerson(person) {
  const mainPhotoHtml = person.mainPhoto
    ? `<div class="person-main-photo"><img src="${person.mainPhoto.url}" alt="${escapeHtml(person.name)}" loading="lazy" /></div>`
    : '';
  const galleryHtml = person.photos.length
    ? `<div class="person-gallery">${person.photos
        .map(p => `<img src="${p.url}" alt="" loading="lazy" />`)
        .join('')}</div>`
    : '';
  return `
    <article class="person-tile">
      <h3 class="person-name">${escapeHtml(person.name)}</h3>
      ${mainPhotoHtml}
      ${galleryHtml}
      <p class="person-description">${escapeHtml(person.description)}</p>
    </article>`;
}

function renderPeople(people) {
  const grid = document.getElementById('people-grid');
  if (!people.length) {
    grid.innerHTML = '<p class="empty">Brak osób do wyświetlenia w tej kategorii.</p>';
    return;
  }
  grid.innerHTML = people.map(renderPerson).join('');
}

document.addEventListener('DOMContentLoaded', loadAboutUsCategory);
