/**
 * Renders a single "person" tile (name, main photo, extra-photo thumbnail row, description) -
 * shared between o-nas.js (the real About Us category grids, fed by GET /about-us) and the
 * Wojownicy "Wrzucam swoje zdjęcie" upload page's live preview (fed by locally-selected
 * File objects via URL.createObjectURL), so the preview really is "dokładnie taki sam kafelek",
 * not a lookalike copy.
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function personTileHtml(person, personIndex) {
  const mainPhotoHtml = person.mainPhoto
    ? `<div class="person-main-photo" data-person-index="${personIndex}" data-photo-index="0">
         <img src="${escapeAttr(person.mainPhoto.url)}" alt="${escapeAttr(person.name)}" loading="lazy" />
       </div>`
    : '';
  const galleryHtml = person.photos.length
    ? `<div class="person-gallery">${person.photos
        .map((p, i) => `<img src="${escapeAttr(p.url)}" alt="" loading="lazy" data-person-index="${personIndex}" data-photo-index="${i + (person.mainPhoto ? 1 : 0)}" />`)
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
