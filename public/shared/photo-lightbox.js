// Shared photo lightbox for admin pages: window.PhotoLightbox.open(photos, index), photos being
// [{ url }]. Same markup and .lightbox* styles (style.css) as the profile drawer's and O nas's
// own copies - prev/next, filmstrip, Esc/arrow keys, a sharper =s1600 copy of Drive thumbnails.
(function () {
  const ICON_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  let els = null;
  let photos = [];
  let index = -1;

  function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // Drive thumbnail URLs end in =sNNN; a bigger number gives a sharper copy.
  function resizeUrl(url, size) {
    return url.replace(/=s\d+$/, `=s${size}`);
  }

  function ensure() {
    if (els) return els;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="lightbox" id="photo-lightbox" hidden>
        <button class="lightbox-close" id="photo-lightbox-close" aria-label="Zamknij">&times;</button>
        <button class="lightbox-prev" id="photo-lightbox-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
        <div class="lightbox-image-wrap">
          <img id="photo-lightbox-img" alt="" />
          <span class="spinner"></span>
        </div>
        <button class="lightbox-next" id="photo-lightbox-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
        <div class="lightbox-filmstrip" id="photo-lightbox-filmstrip"></div>
      </div>`;
    const lightbox = wrapper.firstElementChild;
    document.body.append(lightbox);
    els = {
      lightbox,
      img: lightbox.querySelector('#photo-lightbox-img'),
      filmstrip: lightbox.querySelector('#photo-lightbox-filmstrip'),
    };
    return els;
  }

  function setIndex(next) {
    index = next;
    const { img, filmstrip } = ensure();
    const wrap = img.closest('.lightbox-image-wrap');
    wrap.classList.remove('loaded');
    img.addEventListener('load', () => wrap.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => wrap.classList.add('loaded'), { once: true });
    img.src = resizeUrl(photos[next].url, 1600);
    filmstrip.querySelectorAll('.lightbox-filmstrip-thumb').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.index) === next);
    });
  }

  function open(list, start) {
    if (!list.length) return;
    photos = list;
    const { lightbox, filmstrip } = ensure();
    filmstrip.innerHTML = photos
      .map((photo, i) => `<button class="lightbox-filmstrip-thumb" data-index="${i}" aria-label="Otwórz zdjęcie ${i + 1}"><img src="${escapeAttr(photo.url)}" alt="" loading="lazy" /></button>`)
      .join('');
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    setIndex(start);
  }

  function step(delta) {
    if (index === -1) return;
    setIndex((index + delta + photos.length) % photos.length);
  }

  function close() {
    if (!els || els.lightbox.hidden) return;
    els.lightbox.hidden = true;
    document.body.style.overflow = '';
    index = -1;
  }

  document.addEventListener('click', e => {
    if (e.target.id === 'photo-lightbox' || e.target.closest('#photo-lightbox-close')) close();
    else if (e.target.closest('#photo-lightbox-prev')) step(-1);
    else if (e.target.closest('#photo-lightbox-next')) step(1);
    else {
      const thumb = e.target.closest('.lightbox-filmstrip-thumb');
      if (thumb && thumb.closest('#photo-lightbox')) setIndex(Number(thumb.dataset.index));
    }
  });

  document.addEventListener('keydown', e => {
    if (index === -1) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  window.PhotoLightbox = { open };
})();
