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

const CROP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>';

// options.editable (default false) adds a "Kadruj" button over each photo - only the Wrzuc
// preview (wrzuc.js) turns this on; the real About Us grids (o-nas.js) render with the default,
// so this never appears on the live category pages.
function personTileHtml(person, personIndex, options = {}) {
  const editable = options.editable || false;
  const cropBtn = photoIndex =>
    editable ? `<button type="button" class="photo-crop-btn" data-photo-index="${photoIndex}" aria-label="Kadruj zdjęcie">${CROP_ICON}</button>` : '';

  const inMemoriamRibbon = person.inMemoriam ? '<span class="in-memoriam-ribbon" aria-hidden="true"></span>' : '';

  const mainPhotoHtml = person.mainPhoto
    ? `<div class="person-main-photo" data-person-index="${personIndex}" data-photo-index="0">
         <img src="${escapeAttr(person.mainPhoto.url)}" alt="${escapeAttr(person.name)}" loading="lazy" />
         ${inMemoriamRibbon}
         ${cropBtn(0)}
       </div>`
    : '';
  const galleryHtml = person.photos.length
    ? `<div class="person-gallery">${person.photos
        .map((p, i) => {
          const photoIndex = i + (person.mainPhoto ? 1 : 0);
          const img = `<img src="${escapeAttr(p.url)}" alt="" loading="lazy" data-person-index="${personIndex}" data-photo-index="${photoIndex}" />`;
          return editable
            ? `<div class="person-gallery-item" data-photo-index="${photoIndex}">${img}${cropBtn(photoIndex)}</div>`
            : img;
        })
        .join('')}</div>`
    : '';
  // In memoriam: photos render grayscale (main photo + gallery thumbnails alike, via the
  // class below) plus a diagonal ribbon on the main photo specifically - .person-main-photo
  // already has the position:relative/overflow:hidden the ribbon needs; the small gallery
  // thumbnails don't have an equivalent wrapper, so they get the grayscale treatment only.
  return `
    <article class="person-tile${person.inMemoriam ? ' person-tile--in-memoriam' : ''}">
      <h3 class="person-name">${escapeHtml(person.name)}</h3>
      ${mainPhotoHtml}
      ${galleryHtml}
      <p class="person-description">${escapeHtml(person.description)}</p>
    </article>`;
}
