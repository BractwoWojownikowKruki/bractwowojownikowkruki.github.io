// KRKG: shared top-level nav for the Lista Wyjazdowa pages (events list, event detail). Replaces
// the old lw-subnav pill row ("Lista wyjazdów" / "Dodaj wyjazd" / "Składki") with a single
// dropdown: "Wszystkie" (first, set apart from the trip list by a divider rather than an
// underline) followed by every not-yet-past trip in chronological order, the trip currently open
// (if any) highlighted in place. Składki dropped entirely: it is already a top-level link in the
// site nav (public/nav.js), so it never belonged in this trip-scoped menu. "Dodaj wyjazd" is NOT
// part of this dropdown - it is its own standalone button next to it (see .lw-topbar in both
// index.html files), since it is an action, not a place to navigate to.
//
// Pure HTML-string generator, same pattern as shared/event-edit-form.js: the caller owns the
// open/closed state (a module-level boolean, re-rendered through its own render function) and
// wires up the `.lw-nav-toggle` click itself via its own delegated listener - this module never
// touches the DOM directly.
(function () {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  // Bare DD.MM.YYYY string manipulation, not a Date object - startDate is already a bare calendar
  // date with no time/timezone component (see lista-wyjazdowa.js's own formatDate for why parsing
  // it through `new Date(...)` would risk a UTC-vs-local skew).
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

  /**
   * The trips the dropdown offers: active and not yet past, oldest first. The currently open trip
   * (if it has already passed) is deliberately not force-included - matches "ta lista nie zawiera
   * wyjazdów już minionych" from the design conversation.
   *
   * @param {Array<{id: string, name: string, startDate: string, status: string}>} events
   */
  function upcomingEvents(events) {
    const today = todayIsoDate();
    return events
      .filter((e) => e.status === 'active' && e.startDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  function currentLabel(events, currentEventId) {
    if (!currentEventId) return 'Wszystkie';
    const event = events.find((e) => e.id === currentEventId);
    return event ? event.name : 'Wyjazd';
  }

  /**
   * @param {{events: Array<{id: string, name: string, startDate: string, status: string}>, currentEventId: string|null, open: boolean}} params
   */
  function html({ events, currentEventId, open }) {
    const itemsHtml = upcomingEvents(events)
      .map((e) => {
        const active = e.id === currentEventId;
        return `<a href="/lista-wyjazdowa/wyjazd/?eventId=${encodeURIComponent(e.id)}" class="lw-nav-item${active ? ' lw-nav-item--active' : ''}" role="menuitem">${escapeHtml(e.name)}<span class="lw-nav-item-date">${escapeHtml(formatDate(e.startDate))}</span></a>`;
      })
      .join('');
    return `
      <div class="lw-nav">
        <button type="button" class="lw-nav-toggle" aria-haspopup="true" aria-expanded="${open ? 'true' : 'false'}">
          <span>${escapeHtml(currentLabel(events, currentEventId))}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <div class="lw-nav-menu" role="menu"${open ? '' : ' hidden'}>
          <a href="/lista-wyjazdowa/" class="lw-nav-item lw-nav-item--all${!currentEventId ? ' lw-nav-item--active' : ''}" role="menuitem">Wszystkie</a>
          ${itemsHtml}
        </div>
      </div>
    `;
  }

  window.LwNav = { html, upcomingEvents };
}());
