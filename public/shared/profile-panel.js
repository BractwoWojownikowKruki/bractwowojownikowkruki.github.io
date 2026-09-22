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
  // KRKG-0087/KRKG-0089: the same "osoba bez konta" marker the person pills carry - the child/
  // companion figure from the roster's add-companion button, not the profile-open person icon.
  const PERSON_MARKER_ICON = '<svg class="person-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="osoba bez konta"><circle cx="12" cy="5.5" r="2.6"/><path d="M12 8.5v6.5"/><path d="M8.2 11h7.6"/><path d="M9.2 22l2.8-7 2.8 7"/></svg>';

  // Weapon icons (KRKG-0074): the same hand-drawn PNG set wyjazd.js/profil.js use for a member's
  // weapons. The seeded lookup label "Duńczyk (D)" still carries its "(D)" placeholder, which
  // reads as broken when printed as plain text - so Broń renders the same icon + short item-name
  // pair the roster and "Wg broni" chips use (see wyjazd.js's WEAPON_ICON_KEYS/WEAPON_ITEM_NAMES,
  // duplicated per-file by the same established convention). weaponGroupIconFile mirrors
  // wyjazd.js's of the same name: one combo PNG for a member holding two or three weapons
  // (KRKG-0100 added the three-weapon combo).
  const WEAPON_ICON_KEYS = {
    tarczownik: 'tarcza',
    wlocznik: 'wlocznia',
    dunczyk: 'topor',
  };
  const WEAPON_ITEM_NAMES = {
    tarczownik: 'tarcza',
    wlocznik: 'włócznia',
    dunczyk: 'dun',
  };
  const WEAPON_DISPLAY_ORDER = ['tarczownik', 'wlocznik', 'dunczyk'];

  function weaponGroupIconFile(weaponIds) {
    if (weaponIds.length === 0 || weaponIds.length > 3) return null;
    const keys = [...weaponIds]
      .sort((a, b) => WEAPON_DISPLAY_ORDER.indexOf(a) - WEAPON_DISPLAY_ORDER.indexOf(b))
      .map((id) => WEAPON_ICON_KEYS[id]);
    if (keys.some((key) => !key)) return null;
    return `/icons/bron-${keys.join('-')}.png`;
  }

  // Icon(s) + short item-name label ("tarcza / włócznia" for two). Unknown weapon ids (not in
  // WEAPON_ITEM_NAMES) fall back to the server-provided label at the same index - the backend
  // builds profile.weapons from the same weaponIds array in order, so the two stay aligned.
  function weaponFieldHtml(profile) {
    const weaponIds = Array.isArray(profile.weaponIds) ? profile.weaponIds : null;
    // A backend without weaponIds yet (KRKG-0074 rollout skew): plain labels, same as before.
    if (!weaponIds) {
      return profile.weapons.length
        ? `<dt>Broń</dt><dd>${escapeHtml(profile.weapons.join(', '))}</dd>`
        : '';
    }
    if (!weaponIds.length) return '';
    const labelByIndex = new Map(weaponIds.map((id, i) => [id, profile.weapons[i] ?? id]));
    const ordered = [...weaponIds].sort((a, b) => WEAPON_DISPLAY_ORDER.indexOf(a) - WEAPON_DISPLAY_ORDER.indexOf(b));
    const label = ordered.map((id) => WEAPON_ITEM_NAMES[id] ?? labelByIndex.get(id)).join(' / ');
    const comboFile = weaponGroupIconFile(weaponIds);
    const icon = comboFile
      ? `<img class="lw-weapon-icon" src="${comboFile}" alt="" width="20" height="20">`
      : ordered
          .map((id) => {
            const file = weaponGroupIconFile([id]);
            return file ? `<img class="lw-weapon-icon" src="${file}" alt="" width="20" height="20">` : '';
          })
          .join('');
    return `<dt>Broń</dt><dd><span class="lw-weapon-group">${icon}<span class="lw-weapon-group-label">${escapeHtml(label)}</span></span></dd>`;
  }

  let els = null;
  let lastFocused = null;
  let lightboxEls = null;
  let currentPhotos = [];
  let lightboxPhotoIndex = -1;
  // The drawer has one independent draft per editable section. Batch 2 introduces identity;
  // future sections can retain their own draft when a successful identity save GET-refreshes the
  // server view, rather than one section's save unexpectedly discarding another's work.
  const editorState = {
    profile: null,
    target: null,
    editingSection: null,
    drafts: {},
    errors: {},
    pending: {},
  };

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

  function drawerShowReauth() {
    window.showReauth?.();
  }

  function drawerHideReauth() {
    window.hideReauth?.();
  }

  function identityDraft(profile) {
    return {
      firstName: profile.firstName ?? '',
      lastName: profile.lastName ?? '',
      nickname: profile.nickname ?? '',
      sectionId: profile.sectionId ?? '',
      categoryId: profile.categoryId ?? '',
    };
  }

  function selectOptions(items, selectedId, includeBlank = false) {
    return `${includeBlank ? '<option value="">—</option>' : ''}${(items ?? []).map((item) =>
      `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}`;
  }

  function profileIdentityHtml(profile) {
    if (!profile.editor?.canEditIdentity) return '';
    if (editorState.editingSection !== 'identity') {
      return `<section class="profile-identity-section">
        <button type="button" class="profile-identity-edit" data-profile-edit="identity">Edytuj</button>
      </section>`;
    }
    const draft = editorState.drafts.identity ?? identityDraft(profile);
    const lookupLists = profile.editor.lookupLists;
    const errorHtml = editorState.errors.identity
      ? `<p class="profile-identity-error" role="alert">${escapeHtml(editorState.errors.identity)}</p>`
      : '';
    return `<section class="profile-identity-section">
      <form class="profile-identity-form" data-profile-section="identity">
        <label>Nazwisko<input name="lastName" value="${escapeHtml(draft.lastName)}" required></label>
        <label>Imię<input name="firstName" value="${escapeHtml(draft.firstName)}" required></label>
        <label>Ksywka<input name="nickname" value="${escapeHtml(draft.nickname)}"></label>
        <label>Sekcja<select name="sectionId" required>${selectOptions(lookupLists.sections, draft.sectionId)}</select></label>
        <label>Status<select name="categoryId">${selectOptions(lookupLists.categories, draft.categoryId, true)}</select></label>
        ${errorHtml}
        <div class="profile-identity-actions">
          <button type="submit" class="profile-identity-save">Zapisz</button>
          <button type="button" class="profile-identity-cancel" data-profile-cancel="identity">Anuluj</button>
        </div>
      </form>
    </section>`;
  }

  function weaponsDraft(profile) {
    return { weaponIds: [...(profile.weaponIds ?? [])] };
  }

  // Weapons and dues deliberately stay separate from identity: their permissions, backend
  // resources, audit events, drafts, errors, and pending controls are all independent.
  function profileWeaponsHtml(profile) {
    if (!profile.editor?.canEditWeapons) return '';
    const draft = editorState.drafts.weapons ?? weaponsDraft(profile);
    const errorHtml = editorState.errors.weapons
      ? `<p class="profile-weapons-error" role="alert">${escapeHtml(editorState.errors.weapons)}</p>`
      : '';
    return `<section class="profile-weapons-section">
      <form class="profile-weapons-form" data-profile-section="weapons">
        <fieldset><legend>Broń</legend>
          ${(profile.editor.lookupLists.weapons ?? []).map((weapon) => `<label class="profile-weapons-option">
            <input type="checkbox" name="weaponIds" value="${escapeHtml(weapon.id)}"${draft.weaponIds.includes(weapon.id) ? ' checked' : ''}>
            ${escapeHtml(weapon.label)}
          </label>`).join('')}
        </fieldset>
        ${errorHtml}
        <button type="submit" class="profile-weapons-save">Zapisz broń</button>
      </form>
    </section>`;
  }

  function profileDuesHtml(profile) {
    if (!profile.editor?.canEditDues) return '';
    const entryFeeDraft = editorState.drafts.entryFee ?? { paid: Boolean(profile.wpisowePaid) };
    const annualDuesDraft = editorState.drafts.annualDues ?? { status: profile.duesStatus ?? 'unpaid' };
    const error = editorState.errors.entryFee ?? editorState.errors.annualDues;
    const errorHtml = error
      ? `<p class="profile-dues-error" role="alert">${escapeHtml(error)}</p>`
      : '';
    return `<section class="profile-dues-section">
      <form class="profile-dues-form" data-profile-section="dues">
        <fieldset><legend>Składki</legend>
          <label class="profile-dues-option"><input type="checkbox" name="wpisowePaid"${entryFeeDraft.paid ? ' checked' : ''}> Wpisowe opłacone</label>
          <button type="button" class="profile-dues-save" data-profile-dues-save="wpisowe">Zapisz wpisowe</button>
          <label>Składka ${escapeHtml(profile.duesYear)}
            <select name="duesStatus">
              ${['unpaid', 'paid', 'not_applicable'].map((status) => `<option value="${status}"${annualDuesDraft.status === status ? ' selected' : ''}>${({ unpaid: 'nieopłacona', paid: 'opłacona', not_applicable: 'nie dotyczy' })[status]}</option>`).join('')}
            </select>
          </label>
          <button type="button" class="profile-dues-save" data-profile-dues-save="annual">Zapisz składkę</button>
        </fieldset>
        ${errorHtml}
      </form>
    </section>`;
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
    const pendingPhotos = profile.pendingPhotos || [];
    // KRKG-0070: pendingPhotos are a member's own still-unapproved staging-folder uploads,
    // folded into the same currentPhotos/lightbox index space as mainPhoto+photos (the lightbox
    // has no notion of "sections" - it just steps through one flat list by index) but rendered
    // under their own heading below so a viewer can tell what's live from what's awaiting review.
    currentPhotos = profile.mainPhoto ? [profile.mainPhoto, ...profile.photos, ...pendingPhotos] : [...pendingPhotos];
    // Follow-up to KRKG-0070: a member with no approved public photo yet but at least one
    // pending (unaccepted) upload shows that pending photo in the main-photo slot instead of the
    // bare initials placeholder - it's always index 0 in currentPhotos above (mainPhoto is null in
    // this branch, so currentPhotos is exactly [...pendingPhotos]), so data-photo-index stays "0"
    // either way. Shown identically to an approved main photo, by explicit product decision - no
    // "pending" label - and still also listed again below in the "Oczekujące" section.
    const effectiveMainPhoto = profile.mainPhoto || pendingPhotos[0] || null;
    // KRKG-0076 UI feedback: this drawer used to header/avatar itself on the raw fullName,
    // inconsistent with every trigger that opens it (skladki.js/wyjazd.js/czlonkowie.js/pliki.js
    // all label their .profile-trigger with displayName()'s nickname-priority name) - a member
    // known site-wide by their ksywka would open a drawer greeting them by legal name instead.
    const shownName = displayName(profile);
    const avatarHtml = effectiveMainPhoto
      ? `<div class="person-main-photo" data-photo-index="0">
           <img src="${escapeHtml(effectiveMainPhoto.url)}" alt="${escapeHtml(shownName)}" />
         </div>`
      : `<div class="person-main-photo profile-avatar-placeholder">${escapeHtml(initials(shownName))}</div>`;
    const weaponsHtml = weaponFieldHtml(profile);
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
    const pendingOffset = profile.mainPhoto ? 1 + profile.photos.length : profile.photos.length;
    const pendingHtml = pendingPhotos.length
      ? `<h4 class="profile-pending-heading">Zdjęcia oczekujące na publikację na publicznej części strony</h4>
         <div class="person-gallery">${pendingPhotos
           .map((p, i) => `<img src="${escapeHtml(p.url)}" alt="" data-photo-index="${pendingOffset + i}" />`)
           .join('')}</div>`
      : '';
    // Same visibility as the Lista Wyjazdowa Składki page itself (read-only for every signed-in
    // member) - GET /member-profile always includes these fields now, see server.ts's
    // handleMemberProfile. Same check/cross + coin convention as skladki.js's paidIconHtml, and the
    // same three-state roczna status (data-status, grey "nie dotyczy") as its rocznaIconHtml -
    // server.ts's effectiveDuesStatus already resolves an emeryt-with-no-record to
    // 'not_applicable' before this ever sees it, so no category check is needed here.
    const rocznaLabels = { unpaid: 'nieopłacona', paid: 'opłacona', not_applicable: 'nie dotyczy' };
    const duesStatusHtml = `
      <div class="lw-dues-status">
        <span class="lw-dues-status-item">
          <span class="lw-skladka-icon" data-paid="${profile.wpisowePaid}" aria-hidden="true">${profile.wpisowePaid ? '✓' : '✕'}</span>
          Wpisowe: ${profile.wpisowePaid ? 'opłacone' : 'nieopłacone'}
        </span>
        <span class="lw-dues-status-item">
          <span class="lw-skladka-icon" data-status="${profile.duesStatus}" aria-hidden="true">💰</span>
          Składka ${profile.duesYear}: ${rocznaLabels[profile.duesStatus]}
        </span>
      </div>
    `;
    return `
      ${avatarHtml}
      ${duesStatusHtml}
      ${galleryHtml}
      <h3>${profile.accountless ? PERSON_MARKER_ICON : ''}${escapeHtml(shownName)}</h3>
      ${profileIdentityHtml(profile)}
      ${profileWeaponsHtml(profile)}
      ${profileDuesHtml(profile)}
      <dl class="profile-fields">
        ${(profile.lastName || profile.firstName) ? `<dt>Nazwisko i imię</dt><dd>${escapeHtml([profile.lastName, profile.firstName].filter(Boolean).join(', '))}</dd>` : ''}
        ${profile.nickname ? `<dt>Ksywka</dt><dd>${escapeHtml(profile.nickname)}</dd>` : ''}
        ${profile.sectionLabel ? `<dt>Sekcja</dt><dd><span class="section-pill" data-section="${escapeHtml(profile.sectionId ?? '')}">${escapeHtml(profile.sectionLabel)}</span></dd>` : ''}
        ${profile.categoryLabel ? `<dt>Status</dt><dd><span class="category-name-pill" data-category="${escapeHtml(profile.categoryId ?? '')}" title="${escapeHtml(profile.categoryLabel)}">${categoryPillBroccoliIconHtml(profile.categoryId, 'category-label')}${escapeHtml(profile.categoryLabel)}</span></dd>` : ''}
        ${profile.ownerName ? `<dt>Osoba towarzysząca</dt><dd>${escapeHtml(profile.ownerName)}</dd>` : ''}
        ${weaponsHtml}
      </dl>
      ${descriptionHtml}
      ${pendingHtml}
    `;
  }

  function renderProfileDrawer() {
    if (!els || !editorState.profile) return;
    els.content.innerHTML = renderProfile(editorState.profile);
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

  async function loadProfileTarget(target) {
    if (target.kind === 'person') {
      const { profile } = await apiFetch(
        `/lista-wyjazdowa/person-profile?personId=${encodeURIComponent(target.personId)}`,
        { method: 'GET' },
        drawerShowReauth,
        drawerHideReauth,
      );
      return profile;
    }
    return apiFetch(
      `/member-profile?email=${encodeURIComponent(target.email)}`,
      { method: 'GET' },
      drawerShowReauth,
      drawerHideReauth,
    );
  }

  async function refreshProfileDrawer(savedSection = null) {
    const otherDrafts = { ...editorState.drafts };
    const profile = await loadProfileTarget(editorState.target);
    editorState.profile = profile;
    editorState.drafts = otherDrafts;
    if (savedSection) {
      editorState.drafts[savedSection] = null;
      editorState.errors[savedSection] = null;
      if (savedSection === 'identity') editorState.editingSection = null;
    }
    renderProfileDrawer();
  }

  function handleProfileDrawerError(err) {
    if (err.status === 401 || err.status === 403) {
      if (err.status === 401) drawerShowReauth();
      closeDrawer();
      return true;
    }
    return false;
  }

  async function open(email) {
    lastFocused = document.activeElement;
    const { drawer, content, close } = ensureDrawer();
    content.innerHTML = loadingHtml();
    drawer.hidden = false;
    close.focus();
    try {
      editorState.target = { kind: 'member', email };
      editorState.drafts = {};
      editorState.errors = {};
      editorState.editingSection = null;
      editorState.profile = await loadProfileTarget(editorState.target);
      renderProfileDrawer();
    } catch (err) {
      currentPhotos = [];
      if (handleProfileDrawerError(err)) return;
      content.innerHTML = `<p class="profile-drawer-error">Nie udało się wczytać profilu: ${escapeHtml(err.message)}</p>`;
    }
  }

  // KRKG-0087: an accountless person has no e-mail, so their drawer is keyed by personId and read
  // from the person-keyed endpoint. Same drawer/render path as open() above - the response carries
  // accountless:true and no photos, so the render is naturally the read-only person view.
  async function openPerson(personId) {
    lastFocused = document.activeElement;
    const { drawer, content, close } = ensureDrawer();
    content.innerHTML = loadingHtml();
    drawer.hidden = false;
    close.focus();
    try {
      editorState.target = { kind: 'person', personId };
      editorState.drafts = {};
      editorState.errors = {};
      editorState.editingSection = null;
      editorState.profile = await loadProfileTarget(editorState.target);
      renderProfileDrawer();
    } catch (err) {
      currentPhotos = [];
      if (handleProfileDrawerError(err)) return;
      content.innerHTML = `<p class="profile-drawer-error">Nie udało się wczytać profilu: ${escapeHtml(err.message)}</p>`;
    }
  }

  function updateIdentityDraft(form) {
    editorState.drafts.identity = {
      firstName: form.elements.firstName.value,
      lastName: form.elements.lastName.value,
      nickname: form.elements.nickname.value,
      sectionId: form.elements.sectionId.value,
      categoryId: form.elements.categoryId.value,
    };
  }

  async function saveIdentity(form) {
    if (editorState.pending.identity) return;
    editorState.pending.identity = true;
    const section = form.closest('.profile-identity-section');
    const save = form.querySelector('.profile-identity-save');
    updateIdentityDraft(form);
    const draft = editorState.drafts.identity;
    section.classList.add('profile-identity-section--pending');
    save.disabled = true;
    editorState.errors.identity = null;
    const profile = editorState.profile;
    const body = editorState.target.kind === 'person'
      ? {
          personId: editorState.target.personId,
          ksywka: draft.nickname.trim(),
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          categoryId: draft.categoryId,
          sectionId: draft.sectionId,
          // The person route is a complete-record PUT. Preserve existing weapon selections
          // without exposing weapon controls in this identity-only batch.
          weaponIds: profile.weaponIds ?? [],
        }
      : {
          email: editorState.target.email,
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          nickname: draft.nickname.trim() || null,
          sectionId: draft.sectionId,
          categoryId: draft.categoryId || null,
        };
    try {
      await window.MutationFeedback.confirmed({
        control: save,
        anchor: els.content,
        viewRoot: els.drawer.querySelector('.profile-drawer-panel'),
        execute: () => apiFetch(
          editorState.target.kind === 'person' ? '/lista-wyjazdowa/persons' : '/admin/members/profile',
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          drawerShowReauth,
          drawerHideReauth,
        ),
        apply: () => refreshProfileDrawer('identity'),
        refreshFragment: () => refreshProfileDrawer('identity'),
      });
    } catch (err) {
      if (handleProfileDrawerError(err)) return;
      editorState.errors.identity = `Nie udało się zapisać lub odświeżyć danych: ${err.message}`;
      renderProfileDrawer();
    } finally {
      editorState.pending.identity = false;
      section.classList.remove('profile-identity-section--pending');
      save.disabled = false;
    }
  }

  function updateWeaponsDraft(form) {
    editorState.drafts.weapons = {
      weaponIds: [...form.querySelectorAll('input[name="weaponIds"]:checked')].map((input) => input.value),
    };
  }

  async function saveWeapons(form) {
    if (editorState.pending.weapons) return;
    editorState.pending.weapons = true;
    const section = form.closest('.profile-weapons-section');
    const save = form.querySelector('.profile-weapons-save');
    updateWeaponsDraft(form);
    const draft = editorState.drafts.weapons;
    const profile = editorState.profile;
    const body = editorState.target.kind === 'person'
      ? {
          personId: editorState.target.personId,
          ksywka: profile.nickname ?? '',
          firstName: profile.firstName ?? '',
          lastName: profile.lastName ?? '',
          categoryId: profile.categoryId ?? '',
          sectionId: profile.sectionId ?? '',
          weaponIds: draft.weaponIds,
        }
      : { email: editorState.target.email, weaponIds: draft.weaponIds };
    section.classList.add('profile-weapons-section--pending');
    save.disabled = true;
    editorState.errors.weapons = null;
    try {
      await window.MutationFeedback.confirmed({
        control: save,
        anchor: els.content,
        viewRoot: els.drawer.querySelector('.profile-drawer-panel'),
        execute: () => apiFetch(
          editorState.target.kind === 'person' ? '/lista-wyjazdowa/persons' : '/admin/members/weapons',
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          drawerShowReauth,
          drawerHideReauth,
        ),
        apply: () => refreshProfileDrawer('weapons'),
        refreshFragment: () => refreshProfileDrawer('weapons'),
      });
    } catch (err) {
      if (handleProfileDrawerError(err)) return;
      editorState.errors.weapons = `Nie udało się zapisać broni: ${err.message}`;
      renderProfileDrawer();
    } finally {
      editorState.pending.weapons = false;
      section.classList.remove('profile-weapons-section--pending');
      save.disabled = false;
    }
  }

  function updateDuesDraft(form) {
    editorState.drafts.entryFee = { paid: form.elements.wpisowePaid.checked };
    editorState.drafts.annualDues = { status: form.elements.duesStatus.value };
  }

  async function saveDues(form, kind) {
    const pendingKey = kind === 'wpisowe' ? 'entryFee' : 'annualDues';
    if (editorState.pending[pendingKey]) return;
    editorState.pending[pendingKey] = true;
    const section = form.closest('.profile-dues-section');
    const save = form.querySelector(`[data-profile-dues-save="${kind}"]`);
    updateDuesDraft(form);
    const profile = editorState.profile;
    const personId = editorState.target.kind === 'person' ? editorState.target.personId : editorState.target.email;
    const isEntryFee = kind === 'wpisowe';
    const url = isEntryFee
      ? `/lista-wyjazdowa/wpisowe?personId=${encodeURIComponent(personId)}`
      : `/lista-wyjazdowa/dues?personId=${encodeURIComponent(personId)}&year=${encodeURIComponent(profile.duesYear)}`;
    const body = isEntryFee ? editorState.drafts.entryFee : editorState.drafts.annualDues;
    section.classList.add('profile-dues-section--pending');
    save.disabled = true;
    editorState.errors[isEntryFee ? 'entryFee' : 'annualDues'] = null;
    try {
      await window.MutationFeedback.confirmed({
        control: save,
        anchor: els.content,
        viewRoot: els.drawer.querySelector('.profile-drawer-panel'),
        execute: () => apiFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, drawerShowReauth, drawerHideReauth),
        apply: () => refreshProfileDrawer(isEntryFee ? 'entryFee' : 'annualDues'),
        refreshFragment: () => refreshProfileDrawer(isEntryFee ? 'entryFee' : 'annualDues'),
      });
    } catch (err) {
      if (handleProfileDrawerError(err)) return;
      editorState.errors[isEntryFee ? 'entryFee' : 'annualDues'] = `Nie udało się zapisać składki: ${err.message}`;
      renderProfileDrawer();
    } finally {
      editorState.pending[pendingKey] = false;
      section.classList.remove('profile-dues-section--pending');
      save.disabled = false;
    }
  }

  document.addEventListener('click', (e) => {
    const identityEdit = e.target.closest('[data-profile-edit="identity"]');
    if (identityEdit) {
      editorState.editingSection = 'identity';
      editorState.drafts.identity = identityDraft(editorState.profile);
      editorState.errors.identity = null;
      renderProfileDrawer();
      return;
    }

    const identityCancel = e.target.closest('[data-profile-cancel="identity"]');
    if (identityCancel) {
      editorState.editingSection = null;
      editorState.drafts.identity = null;
      editorState.errors.identity = null;
      renderProfileDrawer();
      return;
    }

    const duesSave = e.target.closest('[data-profile-dues-save]');
    if (duesSave) {
      const form = duesSave.closest('.profile-dues-form');
      if (form) saveDues(form, duesSave.dataset.profileDuesSave);
      return;
    }

    const trigger = e.target.closest('[data-profile-trigger]');
    if (trigger) {
      if (trigger.dataset.personId) openPerson(trigger.dataset.personId);
      else open(trigger.dataset.email);
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

  document.addEventListener('input', (e) => {
    const form = e.target.closest('.profile-identity-form');
    if (form) updateIdentityDraft(form);
    const weaponsForm = e.target.closest('.profile-weapons-form');
    if (weaponsForm) updateWeaponsDraft(weaponsForm);
    const duesForm = e.target.closest('.profile-dues-form');
    if (duesForm) updateDuesDraft(duesForm);
  });

  document.addEventListener('change', (e) => {
    const form = e.target.closest('.profile-identity-form');
    if (form) updateIdentityDraft(form);
    const weaponsForm = e.target.closest('.profile-weapons-form');
    if (weaponsForm) updateWeaponsDraft(weaponsForm);
    const duesForm = e.target.closest('.profile-dues-form');
    if (duesForm) updateDuesDraft(duesForm);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('.profile-identity-form');
    if (form) {
      e.preventDefault();
      saveIdentity(form);
      return;
    }
    const weaponsForm = e.target.closest('.profile-weapons-form');
    if (weaponsForm) {
      e.preventDefault();
      saveWeapons(weaponsForm);
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
