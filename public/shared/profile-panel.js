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
(function () {
  let els = null;
  let lastFocused = null;

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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.drawer.hidden) closeDrawer();
    });
    return els;
  }

  function closeDrawer() {
    if (!els || els.drawer.hidden) return;
    els.drawer.hidden = true;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  function renderProfile(profile) {
    const avatarHtml = profile.mainPhoto
      ? `<img class="profile-avatar" src="${escapeHtml(profile.mainPhoto.url)}" alt="" />`
      : `<div class="profile-avatar profile-avatar-placeholder">${escapeHtml(initials(profile.fullName))}</div>`;
    const weaponsHtml = profile.weapons.length
      ? `<dt>Broń</dt><dd>${escapeHtml(profile.weapons.join(', '))}</dd>`
      : '';
    // photos is populated for both a published public profile and a still-pending upload (see
    // GET /member-profile) - render it unconditionally rather than re-checking `published` here,
    // so this can't drift out of sync with what the backend actually decided to return.
    const descriptionHtml = profile.published && profile.description
      ? `<div class="profile-description">${escapeHtml(profile.description)}</div>`
      : '';
    const photosHtml = profile.photos.length
      ? `<div class="profile-photos">${profile.photos
          .map((p) => `<img src="${escapeHtml(p.url)}" alt="" />`)
          .join('')}</div>`
      : '';
    return `
      ${avatarHtml}
      <h3>${escapeHtml(profile.fullName)}</h3>
      <dl class="profile-fields">
        ${profile.nickname ? `<dt>Ksywka</dt><dd>${escapeHtml(profile.nickname)}</dd>` : ''}
        ${profile.sectionLabel ? `<dt>Sekcja</dt><dd>${escapeHtml(profile.sectionLabel)}</dd>` : ''}
        ${profile.categoryLabel ? `<dt>Typ</dt><dd>${escapeHtml(profile.categoryLabel)}</dd>` : ''}
        ${weaponsHtml}
      </dl>
      ${descriptionHtml}
      ${photosHtml}
    `;
  }

  async function open(email) {
    lastFocused = document.activeElement;
    const { drawer, content, close } = ensureDrawer();
    content.innerHTML = '<p>Ładowanie...</p>';
    drawer.hidden = false;
    close.focus();
    try {
      const profile = await apiFetch(`/member-profile?email=${encodeURIComponent(email)}`, { method: 'GET' });
      content.innerHTML = renderProfile(profile);
    } catch (err) {
      content.innerHTML = `<p class="profile-drawer-error">Nie udało się wczytać profilu: ${escapeHtml(err.message)}</p>`;
    }
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-profile-trigger]');
    if (trigger) open(trigger.dataset.email);
  });

  window.ProfilePanel = { open };
})();
