// Zgłoszenia (KRKG-0049): pending membership applications - approve/reject. Split out of the
// original single-page admin.js. showReauth/hideReauth/escapeHtml/escapeAttr/sheetSyncStatusMessage
// come from ../admin-shared.js, loaded before this file.
initGoogleSignIn({
  buttonIds: ['google-signin-button', 'google-reauth-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadMembershipApplications();
  },
  onSignedOut: () => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = false;
  },
  onForbidden: () => {
    document.getElementById('admin-checking').hidden = true;
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-forbidden').hidden = false;
  },
});

// A pending application always leaves this list after either server-confirmed transition. Keeping
// that small DOM update local preserves the administrator's scroll position and nearby focus.
async function postMembershipTransition(row, email, transition, reason) {
  const list = document.getElementById('membership-applications-list');
  const result = await window.MutationFeedback.confirmed({
    control: row.querySelector(`.${transition}-application`),
    anchor: list,
    execute: () => apiFetch(
      '/admin/members/transition',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, transition, reason: reason || undefined }) },
      showReauth,
      hideReauth,
    ),
    apply: () => {
      row.remove();
      if (!list.querySelector('.membership-application')) list.innerHTML = '<p>Brak oczekujących zgłoszeń.</p>';
    },
    shouldShowCheck: result => !sheetSyncStatusMessage(result.sheetSyncStatus),
    viewRoot: list,
    refreshFragment: loadMembershipApplications,
  });
  return result.sheetSyncStatus;
}

// The application itself only carries the section id and no photos: the label comes from the
// lookup lists and the photos from the applicant's upload-staging folder (matched by its owner
// e-mail, like Publiczne wizytówki's Upload view). Both are best-effort - a failure there must not
// hide the applications themselves.
async function loadApplicationExtras() {
  const [lookups, staging] = await Promise.allSettled([
    apiFetch('/admin/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/admin/people?category=upload', { method: 'GET' }, showReauth, hideReauth),
  ]);
  const sectionLabels = new Map(
    (lookups.status === 'fulfilled' ? lookups.value.sections ?? [] : []).map(section => [section.id, section.label]),
  );
  const photosByEmail = new Map();
  for (const person of staging.status === 'fulfilled' ? staging.value.people ?? [] : []) {
    const email = person.owner?.email?.toLowerCase();
    if (!email) continue;
    const photos = [person.mainPhoto, ...(person.photos ?? [])].filter(photo => photo?.url);
    photosByEmail.set(email, [...(photosByEmail.get(email) ?? []), ...photos]);
  }
  return { sectionLabels, photosByEmail };
}

async function loadMembershipApplications() {
  const list = document.getElementById('membership-applications-list');
  list.textContent = 'Ładowanie...';
  try {
    const [{ members }, extras] = await Promise.all([
      apiFetch('/admin/members?status=pending', { method: 'GET' }, showReauth, hideReauth),
      loadApplicationExtras(),
    ]);
    renderMembershipApplications(members, extras);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function applicationFocusId(email, action) {
  return `membership-application-${encodeURIComponent(email)}-${action}`;
}

// Clicking a photo opens the same lightbox as the profile drawer and O nas (shared .lightbox*
// styles; each page hand-copies the pattern - see shared/profile-panel.js) over that one
// applicant's photos.
let applicationPhotos = new Map();

function applicationPhotosHtml(email, photos) {
  if (!photos?.length) return '<p class="membership-application-photos-empty" style="margin:0.25rem 0 0; color:var(--text-muted); font-size:12px;">Brak zdjęć.</p>';
  return `<div class="membership-application-photos" style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem;">${photos
    .map((photo, index) => `<button type="button" class="membership-application-photo" data-email="${escapeAttr(email)}" data-photo-index="${index}" aria-label="Powiększ zdjęcie ${index + 1}" style="padding:0; border:0; background:none; cursor:zoom-in;"><img src="${escapeAttr(photo.url)}" alt="Zdjęcie ze zgłoszenia" style="width:100px; height:100px; object-fit:cover; border-radius:4px; display:block;" /></button>`)
    .join('')}</div>`;
}

const ICON_CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
let lightboxEls = null;
let lightboxPhotos = [];
let lightboxIndex = -1;

// Drive thumbnail URLs end in =sNNN; a bigger number gives a sharper copy for the lightbox.
function resizePhotoUrl(url, size) {
  return url.replace(/=s\d+$/, `=s${size}`);
}

function ensureLightbox() {
  if (lightboxEls) return lightboxEls;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="lightbox" id="application-lightbox" hidden>
      <button class="lightbox-close" id="application-lightbox-close" aria-label="Zamknij">&times;</button>
      <button class="lightbox-prev" id="application-lightbox-prev" aria-label="Poprzednie">${ICON_CHEVRON_LEFT}</button>
      <div class="lightbox-image-wrap">
        <img id="application-lightbox-img" alt="" />
        <span class="spinner"></span>
      </div>
      <button class="lightbox-next" id="application-lightbox-next" aria-label="Następne">${ICON_CHEVRON_RIGHT}</button>
      <div class="lightbox-filmstrip" id="application-lightbox-filmstrip"></div>
    </div>`;
  const lightbox = wrapper.firstElementChild;
  document.body.append(lightbox);
  lightboxEls = {
    lightbox,
    img: lightbox.querySelector('#application-lightbox-img'),
    filmstrip: lightbox.querySelector('#application-lightbox-filmstrip'),
  };
  return lightboxEls;
}

function setLightboxIndex(index) {
  lightboxIndex = index;
  const { img, filmstrip } = ensureLightbox();
  const wrap = img.closest('.lightbox-image-wrap');
  wrap.classList.remove('loaded');
  img.addEventListener('load', () => wrap.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => wrap.classList.add('loaded'), { once: true });
  img.src = resizePhotoUrl(lightboxPhotos[index].url, 1600);
  filmstrip.querySelectorAll('.lightbox-filmstrip-thumb').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.index) === index);
  });
}

function openLightbox(photos, index) {
  lightboxPhotos = photos;
  const { lightbox, filmstrip } = ensureLightbox();
  filmstrip.innerHTML = photos
    .map((photo, i) => `<button class="lightbox-filmstrip-thumb" data-index="${i}" aria-label="Otwórz zdjęcie ${i + 1}"><img src="${escapeAttr(photo.url)}" alt="" loading="lazy" /></button>`)
    .join('');
  lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  setLightboxIndex(index);
}

function stepLightbox(delta) {
  if (lightboxIndex === -1) return;
  setLightboxIndex((lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length);
}

function closeLightbox() {
  if (!lightboxEls || lightboxEls.lightbox.hidden) return;
  lightboxEls.lightbox.hidden = true;
  document.body.style.overflow = '';
  lightboxIndex = -1;
}

document.addEventListener('click', e => {
  const thumb = e.target.closest('.membership-application-photo');
  if (thumb) {
    const photos = applicationPhotos.get(thumb.dataset.email);
    if (photos?.length) openLightbox(photos, Number(thumb.dataset.photoIndex));
    return;
  }
  if (e.target.id === 'application-lightbox' || e.target.closest('#application-lightbox-close')) closeLightbox();
  else if (e.target.closest('#application-lightbox-prev')) stepLightbox(-1);
  else if (e.target.closest('#application-lightbox-next')) stepLightbox(1);
  else {
    const filmThumb = e.target.closest('.lightbox-filmstrip-thumb');
    if (filmThumb?.closest('#application-lightbox')) setLightboxIndex(Number(filmThumb.dataset.index));
  }
});

document.addEventListener('keydown', e => {
  if (lightboxIndex === -1) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') stepLightbox(-1);
  if (e.key === 'ArrowRight') stepLightbox(1);
});

function renderMembershipApplications(members, { sectionLabels = new Map(), photosByEmail = new Map() } = {}) {
  const list = document.getElementById('membership-applications-list');
  if (!members.length) {
    list.innerHTML = '<p>Brak oczekujących zgłoszeń.</p>';
    return;
  }
  applicationPhotos = new Map(members.map(m => [m.email, photosByEmail.get(m.email.toLowerCase()) ?? []]));
  list.innerHTML = members
    .map(
      m => `
    <div class="membership-application" data-email="${escapeAttr(m.email)}" style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; padding:0.5rem 0; border-bottom:1px solid var(--border);">
      <div style="flex:1; min-width:200px;">
        <strong>${escapeHtml(m.lastName ?? '')}, ${escapeHtml(m.firstName ?? '')}</strong>${m.nickname ? ` (${escapeHtml(m.nickname)})` : ''}
        <br><span style="color:var(--text-muted);">${escapeHtml(m.email)}</span>
        <br><span style="color:var(--text-muted);">Sekcja: ${escapeHtml(sectionLabels.get(m.sectionId) ?? m.sectionId ?? 'brak')}</span>
        ${m.description ? `<p class="membership-application-description" style="margin:0.25rem 0 0; white-space:pre-wrap;">${escapeHtml(m.description)}</p>` : ''}
        ${applicationPhotosHtml(m.email, photosByEmail.get(m.email.toLowerCase()))}
      </div>
      <button id="${applicationFocusId(m.email, 'approve')}" class="approve-application" style="color:var(--gold);">Zatwierdź</button>
      <button id="${applicationFocusId(m.email, 'reject')}" class="reject-application" style="color:var(--accent);">Odrzuć</button>
    </div>`,
    )
    .join('');
}

// try/catch here matters beyond the step-up 401 case handled by showReauth: without it, any
// other failure (network blip, 403 from a role change, 500) rejected silently - the confirm
// dialog closes and the click just looks like it did nothing.
document.getElementById('membership-applications-list').addEventListener('click', async e => {
  const row = e.target.closest('.membership-application');
  if (!row) return;
  const email = row.dataset.email;
  try {
    if (e.target.closest('.approve-application')) {
      const sheetSyncStatus = await postMembershipTransition(row, email, 'approve');
      const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
      if (sheetWarning) window.alert(sheetWarning);
    } else if (e.target.closest('.reject-application')) {
      // Doubles as the confirmation: Cancel (null) aborts, OK with an empty field rejects with the
      // generic e-mail text instead of a comment.
      const reason = window.prompt(
        `Na pewno odrzucić zgłoszenie ${email}?\n\nKomentarz dla tej osoby (opcjonalnie, zostanie wysłany e-mailem):`,
        '',
      );
      if (reason === null) return;
      const sheetSyncStatus = await postMembershipTransition(row, email, 'reject', reason.trim().slice(0, 1000));
      const sheetWarning = sheetSyncStatusMessage(sheetSyncStatus);
      if (sheetWarning) window.alert(sheetWarning);
    }
  } catch (err) {
    window.alert(`Błąd: ${err.message}`);
  }
});
