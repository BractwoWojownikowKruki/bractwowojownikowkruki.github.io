/**
 * Lista wyjazdowa - events list (Plan B, KRKG-0037). Replaces the "coming soon" placeholder
 * shipped in Plan A. A member without a listaWyjazdowaProfile yet is routed to /profil/ instead
 * of the list - signing up needs equipment/companion choices that come from that profile
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
let currentRoster = [];
let categoryOptions = [];
let panelSignups = [];
let openAddPanelEventId = null;
let companionDataPromise = null;

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
      // appears once the viewer is attending. It does not require the roster to be loaded yet -
      // the panel it opens lazy-loads that on first use.
      const canAddCompanion = e.viewerAttending && Boolean(viewerPersonId);
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
      return `
        <div class="lw-event-row">
          <a href="wyjazd/?eventId=${encodeURIComponent(e.id)}" class="lw-event-name">${escapeHtml(e.name)}${statusLabel}</a>
          <span class="lw-event-date">${escapeHtml(formatDate(e.startDate))}</span>
          <span class="lw-event-count">${e.attendingCount} os.</span>
          <button type="button" class="lw-attend-toggle" data-event-id="${e.id}" data-attending="${e.viewerAttending}" aria-pressed="${e.viewerAttending}">
            <span class="lw-attend-toggle-track" aria-hidden="true"></span>
            ${e.viewerAttending ? 'Jadę' : 'Nie jadę'}
          </button>
          ${addCompanionHtml}
          ${panelHtml}
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

// The quick toggle has no equipment/companion picker of its own (that's the event detail page's
// job), so it round-trips whatever the existing signup already stored - but it must filter that
// list against the member's *current* profile first. Deleting an equipment or companion row on
// /profil/ drops its id entirely, leaving any signup that referenced it holding an orphaned id;
// resubmitting it verbatim is then rejected outright by the server's referential check
// ("Wybrany sprzęt nie należy do tego członka."), which would break this button permanently for
// that member. Filtering here preserves the selections that are still real and quietly drops the
// ones that aren't, so a normal profile edit self-heals instead of jamming the toggle.
function stillValidIds(ids, items) {
  const valid = new Set((items ?? []).map((item) => item.id));
  return (ids ?? []).filter((id) => valid.has(id));
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

async function quickAddNew(eventId, ownerPersonId, ksywka, categoryId, control) {
  await quickAddCompanion({ eventId, ownerPersonId, mode: 'new', ksywka, categoryId }, control);
}

document.getElementById('events-list').addEventListener('click', async (e) => {
  const errorEl = document.getElementById('events-error');

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
    const categoryId = document.getElementById('lw-inline-new-category')?.value ?? '';
    if (!ksywka || !categoryId) {
      errorEl.textContent = 'Podaj ksywkę i kategorię nowej osoby.';
      errorEl.hidden = false;
      return;
    }
    addNewBtn.disabled = true;
    try {
      await quickAddNew(openAddPanelEventId, viewerPersonId, ksywka, categoryId, addNewBtn);
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
      execute: async () => {
    const [{ signup: mine }, { profile }] = await Promise.all([
      apiFetch(`/lista-wyjazdowa/signups/mine?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
    ]);
    await apiFetch(
      `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}&personId=${encodeURIComponent(viewerEmail)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attending: nextAttending,
          equipmentIds: stillValidIds(mine?.equipmentIds, profile?.equipment),
        }),
      },
      showReauth,
      hideReauth,
    );
      },
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

// The sub-nav's "Dodaj wyjazd" is a plain link (href="?new=1") so it still works as a normal
// navigation from the other two Lista Wyjazdowa pages - this handler only intercepts it when
// we're already on this page, to avoid a pointless full reload for something the page can just
// reveal in place. openAddEventForm() is also called directly below on page load when arriving
// via that link from elsewhere (or a bookmarked/shared ?new=1 URL).
//
// The existing list (and its "pokaż wszystkie"/error row) is hidden while the form is open -
// with both visible at once the list is just noise between the sub-nav and the form the member
// actually came here to fill in.
function setListVisible(visible) {
  document.getElementById('toggle-past-events').hidden = !visible;
  document.getElementById('events-error').hidden = !visible;
  document.getElementById('events-list').hidden = !visible;
}

// The sub-nav's --active pill and the <h1> both need to track which of the two tabs is
// actually showing - otherwise "Lista wyjazdów" stays highlighted (and the heading stays
// "Lista wyjazdowa") while the form is the only thing on screen, which reads as if the click
// didn't do anything.
function setAddFormActive(active) {
  document.getElementById('lw-subnav-list').classList.toggle('lw-subnav-link--active', !active);
  document.getElementById('lw-subnav-add').classList.toggle('lw-subnav-link--active', active);
  document.getElementById('lw-page-title').textContent = active ? 'Dodaj wyjazd' : 'Lista wyjazdowa';
}

function openAddEventForm() {
  const form = document.getElementById('add-event-form');
  form.hidden = false;
  setListVisible(false);
  setAddFormActive(true);
  form.scrollIntoView({ block: 'center' });
}

document.getElementById('lw-subnav-add').addEventListener('click', (e) => {
  e.preventDefault();
  const form = document.getElementById('add-event-form');
  if (form.hidden) {
    openAddEventForm();
  } else {
    form.hidden = true;
    setListVisible(true);
    setAddFormActive(false);
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
        body: JSON.stringify({ name: form.name.value, startDate: form.startDate.value }),
      },
      showReauth,
      hideReauth,
    ),
      apply: ({ event: created }) => {
        cachedEvents.push(created);
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
