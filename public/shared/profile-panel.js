// Shared "user profile" side drawer (KRKG-0067). Any page that includes this script gets:
//   - a document-wide click listener opening the drawer for any [data-profile-trigger] element
//   - window.ProfilePanel.open(email) to open it programmatically
// The drawer injects itself into document.body on first use - no per-page mount call needed,
// unlike audit-view.js's AuditView.mount (that one needs a container to render a whole page
// into; this is just an overlay any page can add on top of its existing content).
//
// Unlike audit-view.js's drawer, this one closes on Escape and manages focus (move to the close
// button on open, restore to the trigger on close) - a deliberate improvement, not a copy of
// that pattern, since audit-view.js's drawer has neither.
//
// Photos render full-scale, gallery-style, not as small circles: the drawer reuses
// .person-main-photo/.person-gallery (style.css) - the exact same classes person-tile.js/o-nas.js
// use for the public "O Nas" grid - and clicking one opens a lightbox, adapted 1:1 from o-nas.js's
// own lightbox (own ids/state below, same shared .lightbox* CSS classes; there is no shared
// lightbox module in this codebase to import, each page that has one hand-copies the pattern).
(function () {
  const ICON_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

  let els = null;
  let lastFocused = null;
  let lightboxEls = null;
  let currentPhotos = [];
  let lightboxPhotoIndex = -1;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function initials(fullName) {
    return (fullName || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  }

  // Google Drive thumbnail URLs (both mainPhoto's 800px and photos[]'s 300px versions) end in
  // =sNNN - bumping that number gets a sharper version of the same image for the lightbox
  // without the backend needing to serve a separate full-resolution field (same trick as
  // o-nas.js's resizeUrl).
  function resizeUrl(url, size) {
    return url.replace(/=s\d+$/, `=s${size}`);
  }

  function ensureDrawer() {
    if (els) return els;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="profile-drawer" hidden>
        <div class="profile-drawer-backdrop"></div>
        <div class="profile-drawer-panel" role="dialog" aria-label="Profil użytkownika">
          <button type="button" class="profile-drawer-close" aria-label="Zamknij">✕</button>
          <div class="profile-drawer-content"></div>
        </div>
      </div>
    `;
    const drawer = wrapper.firstElementChild;
    document.body.append(drawer);
    els = {
      drawer,
      content: drawer.querySelector('.profile-drawer-content'),
      close: drawer.querySelector('.profile-drawer-close'),
      backdrop: drawer.querySelector('.profile-drawer-backdrop'),
    };
    els.close.addEventListener('click', closeDrawer);
    els.backdrop.addEventListener('click', closeDrawer);
    return els;
  }

  function closeDrawer() {
    if (!els || els.drawer.hidden) return;
    els.drawer.hidden = true;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  function ensureLightbox() {
    if (lightboxEls) return lightboxEls;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="lightbox" id="profile-lightbox" hidden>
        <button class="lightbox-close" id="profile-lightbox-close" aria-label="Zamknij">&times;</button>
        <button class="lightbox-prev" id="profile-lightbox-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
        <div class="lightbox-image-wrap">
          <img id="profile-lightbox-img" alt="" />
          <span class="spinner"></span>
        </div>
        <button class="lightbox-next" id="profile-lightbox-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
        <div class="lightbox-filmstrip" id="profile-lightbox-filmstrip"></div>
      </div>
    `;
    const lightbox = wrapper.firstElementChild;
    document.body.append(lightbox);
    lightboxEls = {
      lightbox,
      img: lightbox.querySelector('#profile-lightbox-img'),
      filmstrip: lightbox.querySelector('#profile-lightbox-filmstrip'),
    };
    return lightboxEls;
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

  function openLightbox(photoIndex) {
    if (!currentPhotos.length) return;
    const { lightbox, filmstrip } = ensureLightbox();
    filmstrip.innerHTML = currentPhotos
      .map((p, i) => `
        <button class="lightbox-filmstrip-thumb" data-index="${i}" aria-label="Otwórz zdjęcie ${i + 1}">
          <img src="${escapeHtml(p.url)}" alt="" loading="lazy" />
        </button>`)
      .join('');
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    setLightboxIndex(photoIndex);
  }

  function setLightboxIndex(photoIndex) {
    lightboxPhotoIndex = photoIndex;
    const { img, filmstrip } = ensureLightbox();
    img.src = resizeUrl(currentPhotos[photoIndex].url, 1600);
    watchImageLoad(img);
    filmstrip.querySelectorAll('.lightbox-filmstrip-thumb').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.index) === photoIndex);
    });
  }

  function stepLightbox(delta) {
    if (lightboxPhotoIndex === -1) return;
    const next = (lightboxPhotoIndex + delta + currentPhotos.length) % currentPhotos.length;
    setLightboxIndex(next);
  }

  function closeLightbox() {
    if (!lightboxEls || lightboxEls.lightbox.hidden) return;
    lightboxEls.lightbox.hidden = true;
    document.body.style.overflow = '';
    lightboxPhotoIndex = -1;
  }

  function renderProfile(profile) {
    currentPhotos = profile.mainPhoto ? [profile.mainPhoto, ...profile.photos] : [];
    const avatarHtml = profile.mainPhoto
      ? `<div class="person-main-photo" data-photo-index="0">
           <img src="${escapeHtml(profile.mainPhoto.url)}" alt="${escapeHtml(profile.fullName)}" />
         </div>`
      : `<div class="person-main-photo profile-avatar-placeholder">${escapeHtml(initials(profile.fullName))}</div>`;
    const weaponsHtml = profile.weapons.length
      ? `<dt>Broń</dt><dd>${escapeHtml(profile.weapons.join(', '))}</dd>`
      : '';
    // photos is populated for both a published public profile and a still-pending upload (see
    // GET /member-profile) - render it unconditionally rather than re-checking `published` here,
    // so this can't drift out of sync with what the backend actually decided to return.
    const descriptionHtml = profile.published && profile.description
      ? `<div class="profile-description">${escapeHtml(profile.description)}</div>`
      : '';
    const galleryHtml = profile.photos.length
      ? `<div class="person-gallery">${profile.photos
          .map((p, i) => `<img src="${escapeHtml(p.url)}" alt="" data-photo-index="${i + 1}" />`)
          .join('')}</div>`
      : '';
    return `
      ${avatarHtml}
      ${galleryHtml}
      <h3>${escapeHtml(profile.fullName)}</h3>
      <dl class="profile-fields">
        ${profile.nickname ? `<dt>Ksywka</dt><dd>${escapeHtml(profile.nickname)}</dd>` : ''}
        ${profile.sectionLabel ? `<dt>Sekcja</dt><dd>${escapeHtml(profile.sectionLabel)}</dd>` : ''}
        ${profile.categoryLabel ? `<dt>Typ</dt><dd>${escapeHtml(profile.categoryLabel)}</dd>` : ''}
        ${weaponsHtml}
      </dl>
      ${descriptionHtml}
    `;
  }

  // Same full-size "busy sticker" loader used elsewhere for a full-page loading state (e.g.
  // wyjazd/index.html's #lw-checking, galerie's own loading state) - the --feature modifier,
  // label text included. No minimum display time here, it's just swapped out the moment the
  // fetch settles.
  function loadingHtml() {
    return `
      <div class="profile-drawer-loading busy-sticker-loader--feature">
        <span class="busy-sticker-aura busy-sticker-aura--feature" aria-hidden="true">
          <img src="/icons/hold-the-line.png" class="busy-sticker busy-sticker--feature" alt="" />
        </span>
        <span class="busy-sticker-label">PLEASE HOLD THE LINE...</span>
      </div>
    `;
  }

  async function open(email) {
    lastFocused = document.activeElement;
    const { drawer, content, close } = ensureDrawer();
    content.innerHTML = loadingHtml();
    drawer.hidden = false;
    close.focus();
    try {
      const profile = await apiFetch(`/member-profile?email=${encodeURIComponent(email)}`, { method: 'GET' });
      content.innerHTML = renderProfile(profile);
    } catch (err) {
      currentPhotos = [];
      content.innerHTML = `<p class="profile-drawer-error">Nie udało się wczytać profilu: ${escapeHtml(err.message)}</p>`;
    }
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-profile-trigger]');
    if (trigger) {
      open(trigger.dataset.email);
      return;
    }

    const photoTrigger = e.target.closest('.profile-drawer .person-main-photo, .profile-drawer .person-gallery img');
    if (photoTrigger && currentPhotos.length) {
      openLightbox(Number(photoTrigger.dataset.photoIndex));
      return;
    }

    if (e.target.id === 'profile-lightbox' || e.target.closest('#profile-lightbox-close')) {
      closeLightbox();
      return;
    }
    if (e.target.closest('#profile-lightbox-prev')) {
      stepLightbox(-1);
      return;
    }
    if (e.target.closest('#profile-lightbox-next')) {
      stepLightbox(1);
      return;
    }
    const filmThumb = e.target.closest('.lightbox-filmstrip-thumb');
    if (filmThumb && filmThumb.closest('#profile-lightbox')) {
      setLightboxIndex(Number(filmThumb.dataset.index));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (lightboxPhotoIndex !== -1) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
      return;
    }
    if (e.key === 'Escape' && els && !els.drawer.hidden) closeDrawer();
  });

  window.ProfilePanel = { open };
})();
