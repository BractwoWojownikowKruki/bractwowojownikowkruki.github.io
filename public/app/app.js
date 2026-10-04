/**
 * Panel (/app/) - member dashboard. This page's own initGoogleSignIn call handles ONLY page-level
 * gating (design.md §3a) - it is intentionally independent of nav.js's own auth wiring, which
 * only drives the shared nav/sidebar menu. No shared cross-page auth-state module exists in this
 * repo; every member-gated page wires its own listener, same as lista-wyjazdowa/profil/pliki.
 */

const panels = {
  checking: document.getElementById('app-checking'),
  signedOut: document.getElementById('app-signed-out-panel'),
  forbidden: document.getElementById('app-forbidden-panel'),
  panel: document.getElementById('app-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

// One-shot: index-redirect.js sets this immediately before redirecting a confirmed signed-in
// member here, so this page's own whoami round-trip below (the same whoamiPath) is almost always
// going to confirm what / just verified. Consuming it lets the app shell (static tile grid,
// secondary links, and the now-empty admin/dues/widget slots - see the #app-panel comment below)
// paint immediately instead of behind the "checking" loader, with the slots filling in
// individually as their own fetches resolve, rather than one big loader-then-everything swap. Not
// a restored-session cache (see auth.js's KRKG-0036 comment) - it's read once, deleted
// immediately, only trusted for a few seconds, and the real whoami call still runs regardless; if
// it turns out signed-out/forbidden, onSignedOut/onForbidden below hide this shell again same as
// always.
const REDIRECT_HINT_KEY = 'kruki_app_redirect_hint';
const REDIRECT_HINT_MAX_AGE_MS = 5000;

function consumeFreshRedirectHint() {
  let hintTime = null;
  try {
    hintTime = sessionStorage.getItem(REDIRECT_HINT_KEY);
    sessionStorage.removeItem(REDIRECT_HINT_KEY);
  } catch {
    return false;
  }
  const ageMs = Date.now() - Number(hintTime);
  return hintTime !== null && ageMs >= 0 && ageMs < REDIRECT_HINT_MAX_AGE_MS;
}

showOnly(consumeFreshRedirectHint() ? panels.panel : panels.checking);

function showReauth() {}
function hideReauth() {}

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function todayIsoDate() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function daysUntil(isoDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const today = new Date(todayIsoDate() + 'T00:00:00Z').getTime();
  const target = new Date(isoDate + 'T00:00:00Z').getTime();
  return Math.round((target - today) / msPerDay);
}

// KRKG-0094: one trip's detail URL, shared by both dashboard trip widgets so tapping a trip
// always opens that specific trip rather than the generic Lista Wyjazdowa page. KRKG-0106: uses
// the friendly ?do=<slug> format via the shared module, like every other link to an event.
function eventDetailHref(event) {
  return window.LwFriendlyUrl.eventUrl(event);
}

// State for the interactive "Najbliższy wyjazd" card (attend toggle + companion panel). Kept at
// module level, like lista-wyjazdowa.js, because every change re-renders all the widgets that
// derive from `events` ("Najbliższy wyjazd", "Twoje zapisy") and the composite dues panel.
const dash = {
  events: [],
  galleriesWidget: null,
  viewerEmail: null,
  viewerPersonId: null,
  canSignUp: false,
  roster: [],
  categories: [],
  panelSignups: [],
  openPanelEventId: null,
  companionPromise: null,
};

// Same count badge as the Lista Wyjazdowa rows (.attendee-badge), so a trip's headcount looks
// identical on every card and is shown exactly once per card.
function attendeeBadge(count) {
  const n = count ?? 0;
  const badge = document.createElement('span');
  badge.className = 'attendee-badge';
  badge.title = `Zgłoszone osoby: ${n}`;
  badge.setAttribute('aria-label', `Zgłoszone osoby: ${n}`);
  badge.innerHTML = '<img class="attendee-badge-icon" src="/icons/attendees-badge.png" alt="" aria-hidden="true"> <span class="attendee-badge-count"></span>';
  badge.querySelector('.attendee-badge-count').textContent = String(n);
  return badge;
}

// Quiet date pill + calendar dropdown (shared/lw-calendar.js). `key` must be stable across
// re-renders so an open dropdown survives the widgets being rebuilt.
function datePillHtml(event, key, popoverSide) {
  return window.LwCalendar.datePillHtml(event, key, popoverSide);
}

function renderNearestEventWidget(events) {
  const upcoming = events
    .filter((e) => e.status === 'active' && e.startDate >= todayIsoDate())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (upcoming.length === 0) return null;
  const event = upcoming[0];
  // A plain <div> (not a whole-card <a>) since the card now holds interactive controls - the
  // Jadę/Nie jadę toggle and the companion button - and nested interactive elements inside a link
  // are invalid. The trip name is its own link instead, like in "Twoje zapisy".
  const widget = document.createElement('div');
  widget.className = 'dashboard-widget';
  const canManage = dash.canSignUp;
  const canAddCompanion = canManage && event.viewerAttending;
  const addCompanionHtml = canAddCompanion
    ? window.CompanionAdd.buttonHtml({ ownerPersonId: dash.viewerPersonId, eventId: event.id, expanded: dash.openPanelEventId === event.id })
    : '';
  const toggleHtml = canManage
    ? `<div class="lw-event-actions">
        <button type="button" class="lw-attend-toggle" data-event-id="${event.id}" data-attending="${event.viewerAttending === true}" aria-pressed="${event.viewerAttending === true}">
          <span class="lw-attend-toggle-track" aria-hidden="true"></span>
          ${event.viewerAttending ? 'Jadę' : 'Nie jadę'}
        </button>
        ${addCompanionHtml}
      </div>`
    : '';
  widget.innerHTML = `
    <h3>Najbliższy wyjazd</h3>
    <p class="dashboard-event-name"><a class="dashboard-event-name-link"></a></p>
    <div class="dashboard-event-date">
      ${datePillHtml(event, 'nearest', 'start')}
    </div>
    <p class="dashboard-event-countdown"></p>
    ${toggleHtml}
    <div class="dashboard-event-panel"></div>
    <p class="add-album-error dashboard-widget-error" role="alert" hidden></p>
  `;
  const nameLink = widget.querySelector('.dashboard-event-name-link');
  nameLink.href = eventDetailHref(event);
  nameLink.textContent = event.name;
  const days = daysUntil(event.startDate);
  widget.querySelector('.dashboard-event-countdown').textContent = `za ${days} ${days === 1 ? 'dzień' : 'dni'}`;
  widget.querySelector('.dashboard-event-date').append(attendeeBadge(event.attendingCount));
  if (canAddCompanion && dash.openPanelEventId === event.id) {
    const viewerMember = dash.roster.find((m) => m.personId === dash.viewerPersonId);
    if (viewerMember) {
      widget.querySelector('.dashboard-event-panel').innerHTML = `<div class="lw-inline-form lw-event-inline-form">${window.CompanionAdd.panelHtml(viewerMember, {
        roster: dash.roster,
        signups: dash.panelSignups,
        categories: dash.categories,
      })}</div>`;
    }
  }
  return widget;
}

function renderMySignupsWidget(events) {
  const mine = events
    .filter((e) => e.status === 'active' && e.viewerAttending && e.startDate >= todayIsoDate())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  // A plain <div>, not the whole-card <a> the other widgets use: this card can list several trips,
  // so the click target has to be each trip name on its own (KRKG-0094) - one card-wide link could
  // only ever point at one of them.
  const widget = document.createElement('div');
  widget.className = 'dashboard-widget';
  if (mine.length === 0) {
    widget.innerHTML = `<h3>Twoje zapisy</h3><p class="dashboard-widget-empty">Nie jesteś jeszcze zapisany(a) na żaden wyjazd.</p>`;
    return widget;
  }
  const rows = mine.map(() => `
    <div class="dashboard-mini-item">
      <a class="dashboard-mini-item-name"></a>
      <span class="dashboard-mini-item-meta"></span>
    </div>
  `).join('');
  widget.innerHTML = `<h3>Twoje zapisy</h3><div class="dashboard-mini-list">${rows}</div>`;
  const items = widget.querySelectorAll('.dashboard-mini-item');
  mine.forEach((e, i) => {
    const nameLink = items[i].querySelector('.dashboard-mini-item-name');
    nameLink.href = eventDetailHref(e);
    nameLink.textContent = e.name;
    const meta = items[i].querySelector('.dashboard-mini-item-meta');
    meta.innerHTML = datePillHtml(e, `mine-${e.id}`, 'end');
    meta.append(attendeeBadge(e.attendingCount));
  });
  return widget;
}

// Deliberate divergence from the approved mockup: the mockup renders this card as a plain,
// unlinked <div> (public/app/index.html's "Nowe galerie" block had no href), but every other
// dashboard card here is a whole-card link and there's no reason this one shouldn't also jump to
// /galerie/ - noted explicitly since design.md §3 only specifies whole-card links for the other
// two widgets by name.
async function renderNewGalleriesWidget() {
  const widget = document.createElement('a');
  widget.href = '/galerie/';
  widget.className = 'dashboard-widget';
  widget.innerHTML = `<h3>Nowe galerie</h3><div class="dashboard-gallery-thumbs"></div>`;
  try {
    const albums = await fetch('/galerie/data/albums.generated.json').then((r) => r.json());
    const recent = [...albums].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const thumbsEl = widget.querySelector('.dashboard-gallery-thumbs');
    if (recent.length === 0) {
      thumbsEl.outerHTML = '<p class="dashboard-widget-empty">Brak galerii.</p>';
      return widget;
    }
    thumbsEl.innerHTML = recent.map(() => `
      <span class="dashboard-gallery-item">
        <span class="dashboard-gallery-thumb"><img alt="" /></span>
        <span class="dashboard-gallery-thumb-caption"></span>
      </span>
    `).join('');
    const itemEls = thumbsEl.querySelectorAll('.dashboard-gallery-item');
    recent.forEach((album, i) => {
      // alt="" - the caption below is the visible label now; a non-empty alt would make screen
      // readers announce the same title twice for this link.
      itemEls[i].querySelector('.dashboard-gallery-thumb img').src = `/galerie/${album.cover}`;
      itemEls[i].querySelector('.dashboard-gallery-thumb-caption').textContent = album.title;
    });
  } catch (err) {
    widget.querySelector('.dashboard-gallery-thumbs').outerHTML = '<p class="dashboard-widget-empty">Nie udało się wczytać galerii.</p>';
  }
  return widget;
}

function renderDuesPanel(owedItems) {
  const panel = document.createElement('section');
  if (owedItems.length === 0) {
    panel.className = 'dashboard-dues-panel dashboard-dues-panel--settled';
    panel.innerHTML = `<span aria-hidden="true">✓</span> Składki opłacone — nie masz żadnych zaległości.`;
    return panel;
  }
  panel.className = 'dashboard-dues-panel';
  const rows = owedItems.map(() => `
    <div class="dashboard-dues-row">
      <span class="dashboard-dues-row-label">
        <span class="dashboard-dues-row-name"></span>
        <span class="dashboard-dues-row-detail"></span>
      </span>
      <span class="dashboard-dues-row-duedate"></span>
    </div>
  `).join('');
  panel.innerHTML = `<h3>Składki — do zapłaty</h3><div class="dashboard-dues-list">${rows}</div>`;
  const rowEls = panel.querySelectorAll('.dashboard-dues-row');
  owedItems.forEach((item, i) => {
    rowEls[i].querySelector('.dashboard-dues-row-name').textContent = item.name;
    if (item.detail) rowEls[i].querySelector('.dashboard-dues-row-detail').textContent = item.detail;
    if (item.dueDate) rowEls[i].querySelector('.dashboard-dues-row-duedate').textContent = `termin: ${formatDate(item.dueDate)}`;
  });
  return panel;
}

async function buildDuesOwedItems(events) {
  const year = new Date().getFullYear();
  const myDuesResponse = await apiFetch(`/lista-wyjazdowa/dues/mine?year=${year}`, { method: 'GET' }, showReauth, hideReauth);
  const owed = [];

  // Roczna - GET /lista-wyjazdowa/dues?year= returns the whole club's dues array (every member's
  // payment status); this dashboard only needs yearFee.note/dueDate, and only when the viewer's
  // own roczna status is actually unpaid, so it's fetched here rather than eagerly for everyone
  // (design.md §2a's documented data-minimization trade-off - no self-scoped GET /dues/year-fee
  // endpoint exists). duesStatus is already resolved server-side (emeryt default included) - the
  // same value Mój profil and the profile drawer show.
  if (myDuesResponse.duesStatus === 'unpaid') {
    const duesResult = await apiFetch(`/lista-wyjazdowa/dues?year=${year}`, { method: 'GET' }, showReauth, hideReauth);
    owed.push({ name: `Roczna składka ${year}`, detail: duesResult.yearFee?.note ?? null, dueDate: duesResult.yearFee?.dueDate ?? null });
  }

  // Wpisowe - resolved server-side by GET /dues/mine (a missing profile counts as unpaid, a Bobo
  // defaults to not_applicable); only 'unpaid' is a debt.
  if (myDuesResponse.wpisoweStatus === 'unpaid') {
    owed.push({ name: 'Wpisowe', detail: null, dueDate: null });
  }

  // Per-event składka - only active events the viewer actually attends and hasn't paid for.
  // GET /lista-wyjazdowa/events returns cancelled events too, and cancelling an event doesn't
  // clear signup docs, so without the status check a cancelled trip would become a permanent
  // phantom debt. No date filter here (unlike renderNearestEventWidget/renderMySignupsWidget
  // above): a past-but-still-unpaid active event should legitimately keep showing as owed.
  // skladkaFee is required too - until the accountant/admin sets it (design.md's "nie ustalono"
  // state, skladkaFee === null), there's no amount to owe yet, so it must not appear as a debt.
  for (const event of events) {
    if (event.status === 'active' && event.viewerAttending && event.viewerSkladkaStatus === 'unpaid' && event.skladkaFee) {
      owed.push({ name: `Składka — ${event.name}`, detail: event.skladkaFee, dueDate: event.dueDate ?? null });
    }
  }

  return owed;
}

// Same gate as the Lista Wyjazdowa page: signing up needs a roster account that isn't hidden and
// a saved Lista Wyjazdowa profile. Failing the check only hides the controls, never the card.
async function viewerCanSignUp() {
  try {
    const [{ member }, { profile }] = await Promise.all([
      apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
    ]);
    return Boolean(member && profile && member.hidden !== true);
  } catch {
    return false;
  }
}

const calendarDropdowns = window.LwCalendar?.mountDropdowns({
  getEvents: () => dash.events,
  findEvent: (id) => dash.events.find((e) => e.id === id),
});

// (Re)builds every widget derived from dash.events. The signups card and the nearest-trip card
// must stay in sync after an attend toggle or a companion add, so they always render together.
function renderDashboardWidgets() {
  const widgetGrid = document.createElement('div');
  widgetGrid.className = 'dashboard-widget-grid';
  const nearestWidget = renderNearestEventWidget(dash.events);
  if (nearestWidget) widgetGrid.append(nearestWidget);
  widgetGrid.append(renderMySignupsWidget(dash.events), dash.galleriesWidget);
  document.getElementById('app-widget-grid-slot').replaceChildren(widgetGrid);
  calendarDropdowns?.refresh();
}

// Per-event składka depends on attendance, so the dues panel is refreshed after every change too.
// A failure here keeps whatever the panel already shows: the signup itself already succeeded.
async function refreshDuesPanel() {
  try {
    const owedItems = await buildDuesOwedItems(dash.events);
    document.getElementById('app-dues-panel-slot').replaceChildren(renderDuesPanel(owedItems));
  } catch {
    // keep the previous panel
  }
}

function showDashboardError(message) {
  const el = document.querySelector('#app-widget-grid-slot .dashboard-widget-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

async function reloadDashboardEvents() {
  const result = await apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth);
  dash.events = result.events;
  dash.openPanelEventId = null;
  renderDashboardWidgets();
  refreshDuesPanel();
}

function ensureDashCompanionData() {
  if (!dash.companionPromise) {
    dash.companionPromise = Promise.all([
      apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
    ]).then(([rosterResult, lookup]) => {
      dash.roster = rosterResult.roster;
      dash.categories = lookup.categories ?? [];
    }).catch((err) => {
      dash.companionPromise = null;
      throw err;
    });
  }
  return dash.companionPromise;
}

// renderDashboardWidgets() replaces the clicked button, so the checkmark goes next to the same
// event's freshly rendered attend toggle (falling back to the toast).
function dashEventAnchor(eventId) {
  const slot = document.getElementById('app-widget-grid-slot');
  return () => slot.querySelector(`.lw-attend-toggle[data-event-id="${CSS.escape(String(eventId))}"]`) || null;
}

async function setDashAttending(eventId, nextAttending, control) {
  showDashboardError('');
  control.disabled = true;
  try {
    await window.MutationFeedback.confirmed({
      control,
      // The re-render below replaces the buttons, so fall back to the same event's fresh toggle.
      fallbackAnchor: dashEventAnchor(eventId),
      execute: () => apiFetch(
        `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}&personId=${encodeURIComponent(dash.viewerEmail)}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attending: nextAttending }) },
        showReauth,
        hideReauth,
      ),
      apply: () => {
        const event = dash.events.find((item) => item.id === eventId);
        if (event) {
          event.viewerAttending = nextAttending;
          event.attendingCount = Math.max(0, (event.attendingCount ?? 0) + (nextAttending ? 1 : -1));
        }
        dash.openPanelEventId = null;
        renderDashboardWidgets();
        refreshDuesPanel();
      },
      viewRoot: panels.panel,
      refreshFragment: reloadDashboardEvents,
    });
  } catch (err) {
    showDashboardError(`Nie udało się zapisać zmiany: ${err.message}`);
  } finally {
    control.disabled = false;
  }
}

async function quickAddDashCompanion(body, control) {
  showDashboardError('');
  control.disabled = true;
  try {
    await window.MutationFeedback.confirmed({
      control,
      fallbackAnchor: dashEventAnchor(body.eventId),
      execute: () => apiFetch(
        '/lista-wyjazdowa/signups/quick-add',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        showReauth,
        hideReauth,
      ),
      apply: (result) => {
        const event = dash.events.find((item) => item.id === body.eventId);
        if (event && result?.signup?.attending) event.attendingCount = (event.attendingCount ?? 0) + 1;
        // A brand-new companion must be offered as an existing person next time, so drop the cache.
        dash.companionPromise = null;
        dash.openPanelEventId = null;
        renderDashboardWidgets();
        refreshDuesPanel();
      },
      viewRoot: panels.panel,
      refreshFragment: reloadDashboardEvents,
    });
  } catch (err) {
    showDashboardError(`Nie udało się dodać osoby: ${err.message}`);
  } finally {
    control.disabled = false;
  }
}

let dashboardWidgetEventsBound = false;
function bindDashboardWidgetEvents() {
  if (dashboardWidgetEventsBound) return;
  dashboardWidgetEventsBound = true;
  document.getElementById('app-widget-grid-slot').addEventListener('click', async (e) => {
    const toggle = e.target.closest('.lw-attend-toggle');
    if (toggle) {
      await setDashAttending(toggle.dataset.eventId, toggle.dataset.attending !== 'true', toggle);
      return;
    }

    const addBtn = e.target.closest('.lw-add-companion');
    if (addBtn) {
      const eventId = addBtn.dataset.eventId;
      if (dash.openPanelEventId === eventId) {
        dash.openPanelEventId = null;
        renderDashboardWidgets();
        return;
      }
      showDashboardError('');
      addBtn.disabled = true;
      try {
        await ensureDashCompanionData();
        if (!dash.roster.some((m) => m.personId === dash.viewerPersonId && !m.accountless)) {
          throw new Error('nie znaleziono Twojej osoby na liście');
        }
        const { signups } = await apiFetch(
          `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}`,
          { method: 'GET' },
          showReauth,
          hideReauth,
        );
        dash.panelSignups = signups;
        dash.openPanelEventId = eventId;
        renderDashboardWidgets();
      } catch (err) {
        showDashboardError(`Nie udało się otworzyć panelu osoby towarzyszącej: ${err.message}`);
      } finally {
        addBtn.disabled = false;
      }
      return;
    }

    if (e.target.closest('.lw-inline-cancel')) {
      dash.openPanelEventId = null;
      renderDashboardWidgets();
      return;
    }

    const addExistingBtn = e.target.closest('.lw-inline-add-existing');
    if (addExistingBtn) {
      const personId = document.getElementById('lw-inline-existing-select')?.value;
      if (!personId) return;
      await quickAddDashCompanion(
        { eventId: dash.openPanelEventId, ownerPersonId: dash.viewerPersonId, mode: 'existing', personId },
        addExistingBtn,
      );
      return;
    }

    const addNewBtn = e.target.closest('.lw-inline-add-new');
    if (addNewBtn) {
      const ksywka = document.getElementById('lw-inline-new-name')?.value.trim() ?? '';
      const lastName = document.getElementById('lw-inline-new-last-name')?.value.trim() ?? '';
      const firstName = document.getElementById('lw-inline-new-first-name')?.value.trim() ?? '';
      const categoryId = document.getElementById('lw-inline-new-category')?.value ?? '';
      if (!ksywka || !lastName || !firstName || !categoryId) {
        showDashboardError('Podaj ksywkę, nazwisko, imię i kategorię nowej osoby.');
        return;
      }
      await quickAddDashCompanion(
        { eventId: dash.openPanelEventId, ownerPersonId: dash.viewerPersonId, mode: 'new', ksywka, lastName, firstName, categoryId },
        addNewBtn,
      );
    }
  });
}

// Tracks how the member gate below resolved, so the independent admin gate at the end of this
// file can tell whether it's safe to render (review finding: a confirmed admin who isn't in the
// live Google Group would otherwise get onSignedIn firing on /admin/whoami while the member gate
// hides #app-panel - and #app-admin-panel-slot lives inside #app-panel, so the rendered admin
// panel would be invisible). memberGateStatePromise is what makes this deterministic regardless of
// which whoami round-trip lands first: the admin callback AWAITS it before deciding whether to
// fetch, rather than reading memberGateState as a snapshot that might still be 'pending' if
// /admin/whoami's response happens to arrive before the member gate's own response does (a real
// race a prior version of this fix only handled for one arrival order - see the final whole-branch
// review). memberGateState itself is kept only for readability/debugging.
let memberGateState = 'pending';
let resolveMemberGateState;
const memberGateStatePromise = new Promise(resolve => { resolveMemberGateState = resolve; });

initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async (identity) => {
    memberGateState = 'panel';
    resolveMemberGateState('panel');
    showOnly(panels.panel);
    // Renews the homepage's fast-path hint (see auth.js's MEMBER_REDIRECT_HINT_KEY comment) on
    // every real visit here, including a direct/bookmarked /app/ visit that never went through
    // index.html at all - not just the redirect-from-/ path.
    setMemberRedirectHint();
    const widgetSlot = document.getElementById('app-widget-grid-slot');
    const duesSlot = document.getElementById('app-dues-panel-slot');
    let events;
    try {
      const [eventsResult, galleriesWidget, canSignUp] = await Promise.all([
        apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth),
        renderNewGalleriesWidget(),
        viewerCanSignUp(),
      ]);
      events = eventsResult.events;
      dash.events = events;
      dash.galleriesWidget = galleriesWidget;
      dash.viewerEmail = identity?.email ?? null;
      dash.viewerPersonId = identity?.email?.toLowerCase() ?? null;
      dash.canSignUp = canSignUp && dash.viewerPersonId !== null;
      dash.roster = [];
      dash.categories = [];
      dash.panelSignups = [];
      dash.openPanelEventId = null;
      dash.companionPromise = null;
      // Render into this task's own fixed slot - never panels.panel.prepend(...) - so the final
      // vertical position is guaranteed by static HTML order (design.md §3), not by which of the
      // two independent initGoogleSignIn callbacks (this one and Task 8's admin-only one) happens
      // to resolve first.
      renderDashboardWidgets();
      bindDashboardWidgetEvents();
    } catch (err) {
      // A failed widget fetch degrades only the widgets, not the whole dashboard (design.md
      // §5a's error-isolation note) - the tile grid below still works regardless.
      const errorEl = document.createElement('p');
      errorEl.className = 'add-album-error';
      errorEl.textContent = `Nie udało się wczytać podsumowania: ${err.message}`;
      widgetSlot.replaceChildren(errorEl);
    }

    // Independent error boundary from the widget fetch above: a failure here (or events being
    // unavailable because the widget fetch above failed) must only blank duesSlot, never touch
    // widgetSlot's already-rendered content (review finding on task 7).
    try {
      if (!events) throw new Error('brak danych o wyjazdach');
      const owedItems = await buildDuesOwedItems(events);
      duesSlot.replaceChildren(renderDuesPanel(owedItems));
    } catch (err) {
      const errorEl = document.createElement('p');
      errorEl.className = 'add-album-error';
      errorEl.textContent = `Nie udało się wczytać podsumowania: ${err.message}`;
      duesSlot.replaceChildren(errorEl);
    }
  },
  onSignedOut: () => {
    memberGateState = 'signedOut';
    resolveMemberGateState('signedOut');
    clearMemberRedirectHint();
    showOnly(panels.signedOut);
  },
  onForbidden: () => {
    memberGateState = 'forbidden';
    resolveMemberGateState('forbidden');
    clearMemberRedirectHint();
    showOnly(panels.forbidden);
  },
});

function hasUploadPhotos(person) {
  return !!person.mainPhoto || person.photos.length > 0;
}

function renderAdminPanelLoading() {
  const panel = document.createElement('section');
  panel.className = 'dashboard-admin-panel dashboard-admin-panel--loading';
  panel.setAttribute('role', 'status');
  panel.innerHTML = `<span class="busy-sticker-aura busy-sticker-aura--compact" aria-hidden="true"><img src="/icons/hold-the-line.png" class="busy-sticker busy-sticker--compact" alt=""></span> Sprawdzanie zadań administracyjnych…`;
  return panel;
}

function renderAdminPanel(pendingCount, uploadPendingCount) {
  const panel = document.createElement('section');
  panel.className = 'dashboard-admin-panel';
  const rows = [];
  if (pendingCount > 0) {
    rows.push(`
      <a href="/admin/zgloszenia/" class="dashboard-action-item">
        <span class="dashboard-action-item-label">
          <span class="dashboard-action-count">${pendingCount}</span>
          Zgłoszenia członkowskie oczekujące na akceptację
        </span>
        <span class="dashboard-action-chevron">→</span>
      </a>
    `);
  }
  if (uploadPendingCount > 0) {
    rows.push(`
      <a href="/admin/publiczne-wizytowki/" class="dashboard-action-item">
        <span class="dashboard-action-item-label">
          <span class="dashboard-action-count">${uploadPendingCount}</span>
          Zdjęcia do zatwierdzenia w Publicznych wizytówkach
        </span>
        <span class="dashboard-action-chevron">→</span>
      </a>
    `);
  }
  if (rows.length === 0) {
    // Same compact green confirmation row as the settled dues panel, so an admin can tell
    // "checked, nothing pending" apart from "still loading".
    panel.className = 'dashboard-admin-panel dashboard-admin-panel--clear';
    panel.innerHTML = `<span aria-hidden="true">✓</span> Brak zadań administracyjnych — nic nie oczekuje na Twoją akceptację.`;
    return panel;
  }
  panel.innerHTML = `
    <h2><span aria-hidden="true">🛠</span> Wymaga Twojej uwagi (Zarządzanie)</h2>
    <div class="dashboard-action-list">${rows.join('')}</div>
  `;
  return panel;
}

// Independent, admin-only gate - see design.md §4. Renders into its own fixed slot
// (#app-admin-panel-slot, Task 5) rather than panels.panel.prepend(...) - this callback and the
// member-gating one above it resolve at unrelated times (two separate whoami round-trips), so
// only a fixed-position slot - not prepend-call order - can guarantee design.md §3's required
// "admin panel first" placement. No DOM element or network request for this panel exists
// unless/until this call's own onSignedIn fires; a plain member never triggers either.
// Deliberately isAdmin-only (not isAdminOrHovding) - both queues below are isAdmin-only in
// nav.js's own ADMIN_ZONE_MENU (design.md §4, round-2 advisory #7). Note: nav.js itself (loaded
// by every page, including this one) always makes its own separate /admin/whoami call regardless
// of what this file does - a plain member on /app/ will see that one 403 in the Network tab; it
// is not this call and not something this task controls.
initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/admin/whoami',
  onSignedIn: async () => {
    // Wait for the member gate to definitively resolve before deciding whether to fetch - this is
    // what makes the guard deterministic regardless of which of the two independent whoami
    // round-trips lands first (see memberGateStatePromise's comment above). In the common case
    // (an admin who is also a group member) the member gate resolves to 'panel' at roughly the
    // same time as this callback fires, so this adds no perceptible delay.
    const resolvedMemberGateState = await memberGateStatePromise;
    if (resolvedMemberGateState === 'forbidden' || resolvedMemberGateState === 'signedOut') return;
    const slot = document.getElementById('app-admin-panel-slot');
    slot.replaceChildren(renderAdminPanelLoading());
    try {
      const [{ members }, { people }] = await Promise.all([
        apiFetch('/admin/members?status=pending', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/admin/people?category=upload', { method: 'GET' }, showReauth, hideReauth),
      ]);
      const uploadPendingCount = people.filter(hasUploadPhotos).length;
      slot.replaceChildren(renderAdminPanel(members.length, uploadPendingCount));
    } catch (err) {
      // Admin panel is a bonus for an admin who's already looking at their own dashboard - a
      // failed fetch here must not disturb the member-facing content above/below it, so just
      // drop the loading placeholder.
      slot.replaceChildren();
    }
  },
});
