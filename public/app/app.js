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

initGoogleSignIn({
  buttonIds: [],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    showOnly(panels.panel);
    const widgetSlot = document.getElementById('app-widget-grid-slot');
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
