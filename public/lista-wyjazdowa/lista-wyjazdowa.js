/**
 * Lista wyjazdowa - events list (Plan B, KRKG-0037). Replaces the "coming soon" placeholder
 * shipped in Plan A. A member without a listaWyjazdowaProfile yet is routed to /profil/ instead
 * of the list - signing up needs companion choices that come from that profile
 * (design.md §8).
 *
 * The caller's own email (needed for the PUT /lista-wyjazdowa/signups?personId= query param
 * below) comes from the `identity` argument auth.js's initGoogleSignIn already passes into
 * onSignedIn - the parsed JSON body of whoamiPath (/wojownicy-upload/whoami), which always
 * includes `email` (see identityResponseBody in upload-service/src/server.ts). No extra fetch is
 * needed for it, and MemberDoc (GET /lista-wyjazdowa/member's `member`) has no email field at all
 * - that would be the wrong place to look for it.
 */

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Same share glyph as wyjazd/index.html's "Udostępnij" button (KRKG-0106) - icon-only here, like
// the row's Edytuj toggle, since every row needs its own compact trigger.
const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

const panels = {
  checking: document.getElementById('lw-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
  noProfile: document.getElementById('no-profile-panel'),
  events: document.getElementById('events-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

showOnly(panels.checking);

function showReauth() {} // no reauth banner on this page yet - matches the placeholder's scope; add one if apiFetch calls start failing with 401 in practice
function hideReauth() {}

let showAll = false;
let cachedEvents = [];
let viewerEmail = null;

// KRKG-0094: the events list now offers the same "add companion" panel as the trip detail page.
// The viewer's own roster row, the categories and the event's signups are only needed once the
// member actually opens that panel, so they are fetched lazily (see ensureCompanionData) and the
// plain list stays as light as before. `viewerPersonId` is the viewer's canonical key (lowercased
// e-mail), set from the whoami identity; `openAddPanelEventId` is the single event whose panel is
// open, or null.
let viewerPersonId = null;
// KRKG-0094 review: whether the viewer is a real (non-hidden) roster account. The roster itself
// is lazy-loaded, but onSignedIn already fetches /lista-wyjazdowa/member (to decide the
// no-profile gate), and a hidden member is the one case the roster excludes - so this is the
// cheap, no-extra-fetch check that keeps the "+" from appearing for a viewer who could never own
// a companion.
let viewerHasAccount = false;
let currentRoster = [];
let categoryOptions = [];
let panelSignups = [];
let openAddPanelEventId = null;
let companionDataPromise = null;

// KRKG-0102: which event's edit panel (Nazwa/Data/Opis/Odwołaj wyjazd) is open on the list, if
// any - same single-panel-open convention as openAddPanelEventId above, and mutually exclusive
// with it (opening one closes the other) so a row never shows both panels stacked.
let openEditPanelEventId = null;

// Whether the shared top-level dropdown (shared/lw-nav.js) is currently expanded. Same
// module-level-boolean-drives-re-render convention as the two ids above, since the dropdown's
// menu markup is rebuilt from scratch on every renderLwNav() call rather than toggled in place.
let lwNavOpen = false;

function renderLwNav() {
  document.getElementById('lw-nav-container').innerHTML = window.LwNav.html({
    events: cachedEvents,
    currentEventId: null,
    open: lwNavOpen,
  });
}

function ensureCompanionData() {
  if (!companionDataPromise) {
    companionDataPromise = Promise.all([
      apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
    ]).then(([rosterResult, lookup]) => {
      currentRoster = rosterResult.roster;
      categoryOptions = lookup.categories ?? [];
    }).catch((err) => {
      // Reset so a failed first attempt can be retried by clicking "+" again.
      companionDataPromise = null;
      throw err;
    });
  }
  return companionDataPromise;
}

function todayIsoDate() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// Plain DD.MM.YYYY string manipulation, not a Date object: startDate is already a bare calendar
// date ("2027-05-01") with no time/timezone component, so parsing it through `new Date(...)`
// and reading local getters back out would risk exactly the UTC-vs-local skew that
// todayIsoDate()'s own fix (above) exists to avoid.
function formatDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function visibleEvents() {
  if (showAll) return [...cachedEvents].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return cachedEvents
    .filter((e) => e.status === 'active' && e.startDate >= todayIsoDate())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function renderEvents() {
  renderLwNav();
  const container = document.getElementById('events-list');
  const events = visibleEvents();
  if (events.length === 0) {
    container.innerHTML = '<p>Brak wyjazdów do wyświetlenia.</p>';
    return;
  }
  const viewerMember = currentRoster.find((m) => m.personId === viewerPersonId) ?? null;
  container.innerHTML = events
    .map((e) => {
      const statusLabel = e.status === 'cancelled' ? ' (odwołany)' : '';
      // KRKG-0094: the "+ osoba towarzysząca" control sits to the right of the toggle and only
      // appears once the viewer is attending and is a real (non-hidden) account. It does not
      // require the roster to be loaded yet - the panel it opens lazy-loads that on first use.
      const canAddCompanion = e.viewerAttending && viewerHasAccount;
      const addCompanionHtml = canAddCompanion
        ? window.CompanionAdd.buttonHtml({ ownerPersonId: viewerPersonId, eventId: e.id, expanded: openAddPanelEventId === e.id })
        : '';
      const panelHtml = canAddCompanion && openAddPanelEventId === e.id && viewerMember
        ? `<div class="lw-inline-form lw-event-inline-form">${window.CompanionAdd.panelHtml(viewerMember, {
            roster: currentRoster,
            signups: panelSignups,
            categories: categoryOptions,
          })}</div>`
        : '';
      // KRKG-0102: icon-only Edytuj toggle (no "Edytuj" label - the row is dense enough already)
      // opening the same Nazwa/Data/Opis/Odwołaj-wyjazd panel the detail page offers, via the
      // shared EventEditForm module. idPrefix is per-event so the one open panel's field ids never
      // collide with a previously-rendered (now closed) one still cached in cachedEvents.
      const editToggleHtml = window.EventEditForm.toggleButtonHtml({ eventId: e.id, expanded: openEditPanelEventId === e.id, withLabel: false });
      const editPanelHtml = openEditPanelEventId === e.id
        ? window.EventEditForm.panelHtml(e, { idPrefix: `lw-event-edit-${e.id}` })
        : '';
      return `
        <div class="lw-event-row">
          <a href="${escapeAttr(window.LwFriendlyUrl.eventUrl(e))}" class="lw-event-name">${escapeHtml(e.name)}${statusLabel}</a>
          <span class="lw-event-date">${escapeHtml(formatDate(e.startDate))}</span>
          <span class="lw-event-count">${e.attendingCount} os.</span>
          <div class="lw-event-actions">
            <button type="button" class="lw-attend-toggle" data-event-id="${e.id}" data-attending="${e.viewerAttending}" aria-pressed="${e.viewerAttending}">
              <span class="lw-attend-toggle-track" aria-hidden="true"></span>
              ${e.viewerAttending ? 'Jadę' : 'Nie jadę'}
            </button>
            ${addCompanionHtml}
            <button type="button" class="lw-edit-toggle lw-edit-toggle--icon lw-event-share-button" data-event-id="${escapeAttr(e.id)}" aria-label="Udostępnij wyjazd" title="Udostępnij wyjazd">${SHARE_ICON}</button>
            ${editToggleHtml}
          </div>
          ${panelHtml}
          ${editPanelHtml}
        </div>
      `;
    })
    .join('');
}

async function loadEvents() {
  const { events } = await apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth);
  cachedEvents = events;
  renderEvents();
}

// KRKG-0094: quick-add a companion from the events list, reusing the trip detail page's endpoint
// and local-apply pattern. `openAddPanelEventId` is still the event the panel was opened for when
// this runs, so the new signup is recorded against it and the event's count bumps by one (the
// panel only ever offers people who are not already attending, so this is always a real +1).
function applyQuickAdd(result) {
  const signup = result?.signup;
  if (signup) {
    const existing = panelSignups.find((item) => item.memberEmail === signup.memberEmail);
    if (existing) Object.assign(existing, signup);
    else panelSignups.push(signup);
  }
  const event = cachedEvents.find((item) => item.id === openAddPanelEventId);
  if (event && signup?.attending) event.attendingCount = (event.attendingCount ?? 0) + 1;
  // A brand-new companion has to be offered as an existing person the next time any panel opens,
  // so drop the cached roster/categories rather than leaving them stale; the next "+" re-fetches.
  companionDataPromise = null;
  openAddPanelEventId = null;
  renderEvents();
}

async function quickAddCompanion(body, control) {
  const errorEl = document.getElementById('events-error');
  errorEl.hidden = true;
  try {
    await window.MutationFeedback.confirmed({
      control,
      anchor: document.getElementById('events-list'),
      execute: () => apiFetch(
        '/lista-wyjazdowa/signups/quick-add',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        showReauth,
        hideReauth,
      ),
      apply: (result) => applyQuickAdd(result),
      viewRoot: document.getElementById('events-panel'),
      refreshFragment: loadEvents,
    });
  } catch (err) {
    errorEl.textContent = `Nie udało się dodać osoby: ${err.message}`;
    errorEl.hidden = false;
  }
}

async function quickAddExisting(eventId, ownerPersonId, personId, control) {
  await quickAddCompanion({ eventId, ownerPersonId, mode: 'existing', personId }, control);
}

async function quickAddNew(eventId, ownerPersonId, ksywka, lastName, firstName, categoryId, control) {
  await quickAddCompanion({ eventId, ownerPersonId, mode: 'new', ksywka, lastName, firstName, categoryId }, control);
}

// KRKG-0102: saves the per-row edit panel's Nazwa/Data/Opis (diff-only body, same contract as the
// detail page's saveEventDetails) and closes the panel on success. `event` is patched in place via
// Object.assign rather than replaced outright, so attendingCount/viewerAttending/viewerSkladkaPaid
// (summary fields the PUT response does not return) survive the update.
async function saveEventEdit(eventId, idPrefix, control) {
  const errorEl = document.getElementById('events-error');
  errorEl.hidden = true;
  const event = cachedEvents.find((item) => item.id === eventId);
  if (!event) return;
  const formValues = window.EventEditForm.readForm(idPrefix);
  const body = window.EventEditForm.buildUpdateBody(event, formValues);
  if (Object.keys(body).length === 0) {
    openEditPanelEventId = null;
    renderEvents();
    return;
  }
  try {
    await window.MutationFeedback.confirmed({
      control,
      anchor: document.getElementById('events-list'),
      execute: () => apiFetch(
        `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        showReauth,
        hideReauth,
      ),
      apply: (result) => {
        Object.assign(event, result.event);
        openEditPanelEventId = null;
        renderEvents();
      },
      viewRoot: document.getElementById('events-panel'),
      refreshFragment: loadEvents,
    });
  } catch (err) {
    errorEl.textContent = `Nie udało się zapisać zmian wyjazdu: ${err.message}`;
    errorEl.hidden = false;
  }
}

// KRKG-0102: the edit panel's Odwołaj/Przywróć wyjazd button - same PUT {status} the detail page's
// setEventStatus sends, just from the list row instead.
async function setEventStatusFromList(eventId, status, control) {
  const errorEl = document.getElementById('events-error');
  errorEl.hidden = true;
  try {
    await window.MutationFeedback.confirmed({
      control,
      anchor: document.getElementById('events-list'),
      execute: () => apiFetch(
        `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) },
        showReauth,
        hideReauth,
      ),
      apply: (result) => {
        const event = cachedEvents.find((item) => item.id === eventId);
        if (event) Object.assign(event, result.event);
        openEditPanelEventId = null;
        renderEvents();
      },
      viewRoot: document.getElementById('events-panel'),
      refreshFragment: loadEvents,
    });
  } catch (err) {
    errorEl.textContent = `Nie udało się zmienić statusu wyjazdu: ${err.message}`;
    errorEl.hidden = false;
  }
}

document.getElementById('events-list').addEventListener('click', async (e) => {
  const errorEl = document.getElementById('events-error');

  // KRKG-0106: per-row "Udostępnij" - icon-only, so shareEvent() gets no textEl (no room in the
  // row for a "Skopiowano!" label); the button's own lw-share--active pulse is the only feedback
  // on the clipboard-fallback path, same as the detail page's button.
  const shareBtn = e.target.closest('.lw-event-share-button');
  if (shareBtn) {
    const targetEvent = cachedEvents.find((ev) => ev.id === shareBtn.dataset.eventId);
    if (targetEvent) window.LwFriendlyUrl.shareEvent(targetEvent, { button: shareBtn });
    return;
  }

  // KRKG-0094: the "+ osoba towarzysząca" control opens/closes the same inline panel the trip
  // detail page renders. Opening it lazy-loads the roster/categories (once) and this event's
  // signups (so already-attending companions are not offered again).
  const addBtn = e.target.closest('.lw-add-companion');
  if (addBtn) {
    const targetEventId = addBtn.dataset.eventId;
    if (openAddPanelEventId === targetEventId) {
      openAddPanelEventId = null;
      renderEvents();
      return;
    }
    errorEl.hidden = true;
    addBtn.disabled = true;
    try {
      await ensureCompanionData();
      if (!currentRoster.some((m) => m.personId === viewerPersonId && !m.accountless)) {
        throw new Error('nie znaleziono Twojej osoby na liście');
      }
      const { signups } = await apiFetch(
        `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(targetEventId)}`,
        { method: 'GET' },
        showReauth,
        hideReauth,
      );
      panelSignups = signups;
      openAddPanelEventId = targetEventId;
      renderEvents();
    } catch (err) {
      errorEl.textContent = `Nie udało się otworzyć panelu osoby towarzyszącej: ${err.message}`;
      errorEl.hidden = false;
    } finally {
      addBtn.disabled = false;
    }
    return;
  }

  if (e.target.closest('.lw-inline-cancel')) {
    openAddPanelEventId = null;
    renderEvents();
    return;
  }

  // KRKG-0102: the per-row Edytuj toggle. Mutually exclusive with the add-companion panel (same
  // "one panel open per row" reasoning as openAddPanelEventId's own toggle above) - opening either
  // one closes the other.
  const editToggleBtn = e.target.closest('.lw-event-edit-toggle');
  if (editToggleBtn) {
    const targetEventId = editToggleBtn.dataset.eventId;
    openEditPanelEventId = openEditPanelEventId === targetEventId ? null : targetEventId;
    openAddPanelEventId = null;
    renderEvents();
    return;
  }

  const editCancelBtn = e.target.closest('.lw-event-edit-cancel');
  if (editCancelBtn) {
    openEditPanelEventId = null;
    renderEvents();
    return;
  }

  const editSaveBtn = e.target.closest('.lw-event-edit-save');
  if (editSaveBtn) {
    editSaveBtn.disabled = true;
    saveEventEdit(openEditPanelEventId, editSaveBtn.dataset.idPrefix, editSaveBtn).finally(() => { editSaveBtn.disabled = false; });
    return;
  }

  const editStatusBtn = e.target.closest('.lw-event-edit-toggle-status');
  if (editStatusBtn) {
    const nextStatus = editStatusBtn.dataset.nextStatus;
    if (nextStatus === 'cancelled' && !window.confirm('Czy na pewno odwołać ten wyjazd?')) return;
    editStatusBtn.disabled = true;
    setEventStatusFromList(openEditPanelEventId, nextStatus, editStatusBtn).finally(() => { editStatusBtn.disabled = false; });
    return;
  }

  const addExistingBtn = e.target.closest('.lw-inline-add-existing');
  if (addExistingBtn) {
    const personId = document.getElementById('lw-inline-existing-select')?.value;
    if (!personId) return;
    addExistingBtn.disabled = true;
    try {
      await quickAddExisting(openAddPanelEventId, viewerPersonId, personId, addExistingBtn);
    } finally {
      addExistingBtn.disabled = false;
    }
    return;
  }

  const addNewBtn = e.target.closest('.lw-inline-add-new');
  if (addNewBtn) {
    const ksywka = document.getElementById('lw-inline-new-name')?.value.trim() ?? '';
    const lastName = document.getElementById('lw-inline-new-last-name')?.value.trim() ?? '';
    const firstName = document.getElementById('lw-inline-new-first-name')?.value.trim() ?? '';
    const categoryId = document.getElementById('lw-inline-new-category')?.value ?? '';
    if (!ksywka || !lastName || !firstName || !categoryId) {
      errorEl.textContent = 'Podaj ksywkę, nazwisko, imię i kategorię nowej osoby.';
      errorEl.hidden = false;
      return;
    }
    addNewBtn.disabled = true;
    try {
      await quickAddNew(openAddPanelEventId, viewerPersonId, ksywka, lastName, firstName, categoryId, addNewBtn);
    } finally {
      addNewBtn.disabled = false;
    }
    return;
  }

  const btn = e.target.closest('.lw-attend-toggle');
  if (!btn) return;
  const eventId = btn.dataset.eventId;
  const nextAttending = btn.dataset.attending !== 'true';
  errorEl.hidden = true;
  btn.disabled = true;
  try {
    await window.MutationFeedback.confirmed({
      control: btn,
      // Anchor on the list container, not the button: apply re-renders the list (so the "+" appears
      // or disappears with the new attendance), which would detach a button anchor.
      anchor: document.getElementById('events-list'),
      execute: () => apiFetch(
        `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}&personId=${encodeURIComponent(viewerEmail)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attending: nextAttending }),
        },
        showReauth,
        hideReauth,
      ),
      // Patch the cached event and re-render, rather than rewriting btn.textContent: that used to
      // drop the toggle track and show "Wypisz się / Zapisz się" instead of the rendered "Jadę /
      // Nie jadę" label, and it could not reveal the companion "+" (KRKG-0094).
      apply: () => {
        const event = cachedEvents.find((item) => item.id === eventId);
        if (event) {
          event.viewerAttending = nextAttending;
          event.attendingCount = Math.max(0, (event.attendingCount ?? 0) + (nextAttending ? 1 : -1));
        }
        renderEvents();
      },
      viewRoot: document.getElementById('events-list'),
      refreshFragment: loadEvents,
    });
  } catch (err) {
    // Without this the click just silently did nothing: the button re-enabled itself and the row
    // stayed as it was, with no way for the member to tell the change hadn't been saved.
    errorEl.textContent = `Nie udało się zapisać zmiany: ${err.message}`;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// The dropdown's "+ Dodaj wyjazd" is a plain link (href="?new=1") so it still works as a normal
// navigation from the event detail page - this handler only intercepts it when we're already on
// this page, to avoid a pointless full reload for something the page can just reveal in place.
// openAddEventForm() is also called directly below on page load when arriving via that link from
// elsewhere (or a bookmarked/shared ?new=1 URL).
//
// The existing list (and its "pokaż wszystkie"/error row) is hidden while the form is open -
// with both visible at once the list is just noise between the dropdown and the form the member
// actually came here to fill in.
function setListVisible(visible) {
  document.getElementById('toggle-past-events').hidden = !visible;
  document.getElementById('events-error').hidden = !visible;
  document.getElementById('events-list').hidden = !visible;
}

// The <h1> needs to track which of the two views is actually showing - otherwise the heading
// stays "Lista wyjazdowa" while the form is the only thing on screen, which reads as if the click
// didn't do anything.
function setAddFormActive(active) {
  document.getElementById('lw-page-title').textContent = active ? 'Dodaj wyjazd' : 'Lista wyjazdowa';
}

function openAddEventForm() {
  const form = document.getElementById('add-event-form');
  form.hidden = false;
  setListVisible(false);
  setAddFormActive(true);
  form.scrollIntoView({ block: 'center' });
}

function closeAddEventForm() {
  const form = document.getElementById('add-event-form');
  form.hidden = true;
  setListVisible(true);
  setAddFormActive(false);
}

// Delegated click handler for the shared dropdown (shared/lw-nav.js): its whole markup is
// rebuilt on every renderLwNav() call, so listeners live on the persistent container instead of
// the elements it renders - same reasoning as the #events-list delegated handler below.
document.getElementById('lw-nav-container').addEventListener('click', (e) => {
  if (!e.target.closest('.lw-nav-toggle')) return;
  lwNavOpen = !lwNavOpen;
  renderLwNav();
});

// "Dodaj wyjazd" is its own standalone button next to the dropdown (not one of its items - it's an
// action, not a place to navigate to), so it's static markup with a plain listener, same as
// #toggle-past-events below. Its href ("?new=1") still works as a normal navigation from the trip
// detail page; this only intercepts it here to avoid a pointless full reload for something this
// page can just reveal in place.
document.getElementById('lw-nav-add').addEventListener('click', (e) => {
  e.preventDefault();
  const form = document.getElementById('add-event-form');
  if (form.hidden) {
    openAddEventForm();
  } else {
    closeAddEventForm();
  }
});

document.getElementById('toggle-past-events').addEventListener('click', (e) => {
  showAll = !showAll;
  e.target.textContent = showAll ? 'Pokaż tylko nadchodzące' : 'Pokaż wszystkie (w tym odwołane i przeszłe)';
  renderEvents();
});

document.getElementById('add-event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('add-event-error');
  const submitBtn = form.querySelector('button[type="submit"]');
  errorEl.hidden = true;
  try {
    await window.MutationFeedback.confirmed({
      control: submitBtn,
      anchor: document.getElementById('events-list'),
      execute: () => apiFetch(
      '/lista-wyjazdowa/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.value, startDate: form.startDate.value, description: form.description.value.trim() || undefined }),
      },
      showReauth,
      hideReauth,
    ),
      apply: ({ event: created }) => {
        // POST /lista-wyjazdowa/events returns the bare event doc (no summary fields - those are
        // only computed by the GET /events join against signups), so a brand-new event has none
        // signed up yet: fill them in here rather than rendering `undefined os.` until the next
        // loadEvents.
        cachedEvents.push({ ...created, attendingCount: 0, viewerAttending: false, viewerSkladkaPaid: false });
        form.reset();
        form.hidden = true;
        setListVisible(true);
        setAddFormActive(false);
        renderEvents();
      },
      viewRoot: document.getElementById('events-panel'),
      refreshFragment: loadEvents,
    });
  } catch (err) {
    errorEl.textContent = `Błąd: ${err.message}`;
    errorEl.hidden = false;
  }
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  // auth.js only routes a failed whoami check to onForbidden - anything this body throws is ours
  // to report, and must not be mistaken for "not a member" (see initGoogleSignIn's comment). The
  // events panel is shown alongside the error so the member sees *why* the list is empty rather
  // than being left staring at the "please sign in" panel they just signed in from.
  onSignedIn: async (identity) => {
    viewerEmail = identity.email;
    // KRKG-0094: the viewer's canonical person key for the companion panel, and a clean slate for
    // its lazy-loaded data (a re-sign-in must not reuse a previous member's roster/signups).
    viewerPersonId = identity.email?.toLowerCase() ?? null;
    viewerHasAccount = false;
    currentRoster = [];
    categoryOptions = [];
    panelSignups = [];
    openAddPanelEventId = null;
    companionDataPromise = null;
    try {
      const [{ member }, { profile }] = await Promise.all([
        apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
      ]);
      if (!member || !profile) {
        showOnly(panels.noProfile);
        return;
      }
      viewerHasAccount = member.hidden !== true;
      await loadEvents();
      showOnly(panels.events);
      // Arrived from the sub-nav's "Dodaj wyjazd" on another page (?new=1) - open the form the
      // same way the in-page button does, now that #events-panel is actually visible to scroll
      // within. A stale ?new=1 left in the address bar after this just re-opens an already-empty
      // form on refresh, which is harmless.
      if (new URLSearchParams(window.location.search).get('new') === '1') openAddEventForm();
    } catch (err) {
      showOnly(panels.events);
      const errorEl = document.getElementById('events-error');
      errorEl.textContent = `Nie udało się wczytać listy wyjazdów: ${err.message}`;
      errorEl.hidden = false;
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
