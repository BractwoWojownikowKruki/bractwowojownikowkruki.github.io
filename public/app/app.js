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

showOnly(panels.checking);

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

function renderNearestEventWidget(events) {
  const upcoming = events
    .filter((e) => e.status === 'active' && e.startDate >= todayIsoDate())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (upcoming.length === 0) return null;
  const event = upcoming[0];
  const widget = document.createElement('a');
  widget.href = '/lista-wyjazdowa/';
  widget.className = 'dashboard-widget';
  widget.innerHTML = `
    <h3>Najbliższy wyjazd</h3>
    <p class="dashboard-event-name"></p>
    <p class="dashboard-event-date">
      <span class="dashboard-event-date-text"></span>
      ${event.viewerAttending ? '<span class="dashboard-event-signedup"><span aria-hidden="true">✓</span> Zapisany(a)</span>' : ''}
    </p>
    <p class="dashboard-event-countdown"></p>
  `;
  widget.querySelector('.dashboard-event-name').textContent = event.name;
  widget.querySelector('.dashboard-event-date-text').textContent = formatDate(event.startDate);
  const days = daysUntil(event.startDate);
  widget.querySelector('.dashboard-event-countdown').textContent = `za ${days} ${days === 1 ? 'dzień' : 'dni'} · ${event.attendingCount} ${event.attendingCount === 1 ? 'osoba zapisana' : 'osób zapisanych'}`;
  return widget;
}

function renderMySignupsWidget(events) {
  const mine = events
    .filter((e) => e.status === 'active' && e.viewerAttending && e.startDate >= todayIsoDate())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const widget = document.createElement('a');
  widget.href = '/lista-wyjazdowa/';
  widget.className = 'dashboard-widget';
  if (mine.length === 0) {
    widget.innerHTML = `<h3>Twoje zapisy</h3><p class="dashboard-widget-empty">Nie jesteś jeszcze zapisany(a) na żaden wyjazd.</p>`;
    return widget;
  }
  const rows = mine.map((e) => `
    <div class="dashboard-mini-item">
      <span class="dashboard-mini-item-name"></span>
      <span class="dashboard-mini-item-meta"></span>
    </div>
  `).join('');
  widget.innerHTML = `<h3>Twoje zapisy</h3><div class="dashboard-mini-list">${rows}</div>`;
  const items = widget.querySelectorAll('.dashboard-mini-item');
  mine.forEach((e, i) => {
    items[i].querySelector('.dashboard-mini-item-name').textContent = e.name;
    items[i].querySelector('.dashboard-mini-item-meta').textContent = formatDate(e.startDate);
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
    thumbsEl.innerHTML = recent.map(() => '<span class="dashboard-gallery-thumb"><img alt="" /></span>').join('');
    const thumbEls = thumbsEl.querySelectorAll('.dashboard-gallery-thumb img');
    recent.forEach((album, i) => {
      thumbEls[i].src = `/galerie/${album.cover}`;
      thumbEls[i].alt = album.title;
    });
  } catch (err) {
    widget.querySelector('.dashboard-gallery-thumbs').outerHTML = '<p class="dashboard-widget-empty">Nie udało się wczytać galerii.</p>';
  }
  return widget;
}

function effectiveDuesStatus(dues, categoryId) {
  if (dues) return dues.status;
  return categoryId === 'emeryt' ? 'not_applicable' : 'unpaid';
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
  const [duesResult, memberResult, profileResult] = await Promise.all([
    apiFetch(`/lista-wyjazdowa/dues?year=${year}`, { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
  ]);
  const owed = [];

  // Roczna - GET /lista-wyjazdowa/dues?year= returns the whole club's dues array; this dashboard
  // deliberately discards it and only reads yearFee.note/dueDate (design.md §2a's documented
  // data-minimization trade-off - no self-scoped GET /dues/year-fee endpoint exists).
  const categoryId = memberResult.member?.categoryId ?? null;
  const myDuesResponse = await apiFetch(`/lista-wyjazdowa/dues/mine?year=${year}`, { method: 'GET' }, showReauth, hideReauth);
  const rocznaStatus = effectiveDuesStatus(myDuesResponse.dues, categoryId);
  if (rocznaStatus === 'unpaid') {
    owed.push({ name: `Roczna składka ${year}`, detail: duesResult.yearFee?.note ?? null, dueDate: duesResult.yearFee?.dueDate ?? null });
  }

  // Wpisowe - profile may be null if the member never saved a Lista Wyjazdowa profile; treat that
  // identically to wpisowePaid === false (design.md §2a, round-2 advisory #3).
  const wpisowePaid = profileResult.profile?.wpisowePaid === true;
  if (!wpisowePaid) {
    owed.push({ name: 'Wpisowe', detail: null, dueDate: null });
  }

  // Per-event składka - only events the viewer actually attends and hasn't paid for.
  for (const event of events) {
    if (event.viewerAttending && !event.viewerSkladkaPaid) {
      owed.push({ name: `Składka — ${event.name}`, detail: event.skladkaFee ?? null, dueDate: event.dueDate ?? null });
    }
  }

  return owed;
}

initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    showOnly(panels.panel);
    const widgetSlot = document.getElementById('app-widget-grid-slot');
    const duesSlot = document.getElementById('app-dues-panel-slot');
    try {
      const [{ events }, galleriesWidget] = await Promise.all([
        apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth),
        renderNewGalleriesWidget(),
      ]);
      const widgetGrid = document.createElement('div');
      widgetGrid.className = 'dashboard-widget-grid';
      const nearestWidget = renderNearestEventWidget(events);
      if (nearestWidget) widgetGrid.append(nearestWidget);
      widgetGrid.append(renderMySignupsWidget(events), galleriesWidget);
      // Render into this task's own fixed slot - never panels.panel.prepend(...) - so the final
      // vertical position is guaranteed by static HTML order (design.md §3), not by which of the
      // two independent initGoogleSignIn callbacks (this one and Task 8's admin-only one) happens
      // to resolve first.
      widgetSlot.replaceChildren(widgetGrid);

      const owedItems = await buildDuesOwedItems(events);
      duesSlot.replaceChildren(renderDuesPanel(owedItems));
    } catch (err) {
      // A failed widget fetch degrades only the widgets, not the whole dashboard (design.md
      // §5a's error-isolation note) - the tile grid below still works regardless.
      const errorEl = document.createElement('p');
      errorEl.className = 'add-album-error';
      errorEl.textContent = `Nie udało się wczytać podsumowania: ${err.message}`;
      widgetSlot.replaceChildren(errorEl);
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
