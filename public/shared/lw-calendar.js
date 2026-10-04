// Calendar helpers for the event detail page's date popover: "add to calendar" links/files for one
// trip, and the month grid (trips marked on their day) shown under it. Pure functions only - the
// page owns the DOM and the open/month state, same split as shared/lw-nav.js.
//
// Trips only carry a bare startDate ("YYYY-MM-DD", no time, no end), so every trip is a one-day
// all-day calendar entry. All date maths stays on plain strings / Date.UTC, never a local Date, so
// a timezone or DST change can never shift a trip onto a neighbouring day.
(function () {
  const MONTH_NAMES = [
    'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
    'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
  ];
  const WEEKDAY_SHORT = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function toIso(y, m, d) {
    const date = new Date(Date.UTC(y, m - 1, d));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return toIso(y, m, d + days);
  }

  function compact(isoDate) {
    return isoDate.replace(/-/g, '');
  }

  function eventLink(event) {
    // A payment deadline (Składki page) is a marker on the grid, not a trip: it has no page.
    if (event.deadline) return '';
    return window.LwFriendlyUrl ? window.LwFriendlyUrl.eventUrl(event) : '';
  }

  // Google Calendar's "template" link: the user confirms the entry in their own calendar. The
  // all-day end date is exclusive, hence +1 day.
  function googleUrl(event) {
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: event.name,
      dates: `${compact(event.startDate)}/${compact(addDays(event.startDate, 1))}`,
    });
    const details = [event.description, eventLink(event)].filter(Boolean).join('\n\n');
    if (details) params.set('details', details);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  // RFC 5545 text escaping + 75-octet line folding is skipped on purpose for folding (every client
  // accepts long lines); escaping is not optional.
  function icsText(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  }

  // Apple Calendar, Outlook, Thunderbird (and Google, via import) all read this. A stable UID
  // means re-adding the same trip updates the entry instead of duplicating it.
  function icsContent(event) {
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    const details = [event.description, eventLink(event)].filter(Boolean).join('\n\n');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Bractwo Wojownikow Kruki//Lista wyjazdowa//PL',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${event.id}@kruki.org`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(event.startDate)}`,
      `DTEND;VALUE=DATE:${compact(addDays(event.startDate, 1))}`,
      `SUMMARY:${icsText(event.name)}`,
    ];
    if (details) lines.push(`DESCRIPTION:${icsText(details)}`);
    if (event.status === 'cancelled') lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
  }

  function icsFilename(event) {
    const slug = window.LwFriendlyUrl ? window.LwFriendlyUrl.eventSlug(event) : event.startDate;
    return `${slug}.ics`;
  }

  /**
   * One month as full weeks, Monday first. Cancelled trips are not "booked", so they are left off.
   *
   * @param {number} year
   * @param {number} month 1-12
   * @param {Array<{id: string, name: string, startDate: string, status: string}>} events
   * @returns {Array<Array<{iso: string, day: number, inMonth: boolean, events: object[]}>>} weeks
   */
  function monthGrid(year, month, events) {
    const byDate = new Map();
    for (const e of events) {
      if (e.status === 'cancelled') continue;
      if (!byDate.has(e.startDate)) byDate.set(e.startDate, []);
      byDate.get(e.startDate).push(e);
    }
    const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const weekCount = Math.ceil((firstWeekday + daysInMonth) / 7);
    const weeks = [];
    for (let w = 0; w < weekCount; w += 1) {
      const week = [];
      for (let i = 0; i < 7; i += 1) {
        const dayOffset = w * 7 + i - firstWeekday + 1; // 1 = first of the month
        const iso = toIso(year, month, dayOffset);
        week.push({
          iso,
          day: Number(iso.slice(8)),
          inMonth: dayOffset >= 1 && dayOffset <= daysInMonth,
          events: byDate.get(iso) ?? [],
        });
      }
      weeks.push(week);
    }
    return weeks;
  }

  // Shifts a {year, month} pair by whole months (negative = back), rolling over the year.
  function shiftMonth({ year, month }, delta) {
    const index = year * 12 + (month - 1) + delta;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
  }

  // Tiny label for a day cell: the first few characters, with an ellipsis when cut.
  function shortName(name, max = 6) {
    const chars = Array.from(String(name).trim());
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
  }

  /**
   * Markup of the whole popover body: the add-to-calendar actions on top, then the month view.
   * `currentEventId` marks the open trip's day. Buttons carry data-lw-cal-* attributes; the page
   * wires one delegated click listener.
   */
  function popoverHtml({ event, events, view, today }) {
    const weeks = monthGrid(view.year, view.month, events);
    const head = WEEKDAY_SHORT.map((d) => `<span class="lw-cal-weekday">${d}</span>`).join('');
    const cells = weeks.flat().map((cell) => {
      const classes = ['lw-cal-day'];
      if (!cell.inMonth) classes.push('lw-cal-day--outside');
      if (cell.iso === today) classes.push('lw-cal-day--today');
      if (cell.events.length) classes.push('lw-cal-day--has-event');
      if (cell.events.some((e) => e.id === event.id)) classes.push('lw-cal-day--current');
      const trips = cell.events.map((e, i) => e.deadline
        ? `<span class="lw-cal-trip lw-cal-trip--deadline" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>`
        : `<a class="lw-cal-trip${i === 0 ? ' lw-cal-trip--cover' : ''}" href="${escapeHtml(eventLink(e))}" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</a>`).join('');
      return `<div class="${classes.join(' ')}"><span class="lw-cal-daynum">${cell.day}</span>${trips}</div>`;
    }).join('');
    return `
      <div class="lw-cal-actions">
        <button type="button" class="lw-cal-add" data-lw-cal-action="google">Dodaj do swojego kalendarza</button>
        <button type="button" class="lw-cal-ics" data-lw-cal-action="ics">Pobierz plik .ics (Apple, Outlook)</button>
      </div>
      <div class="lw-cal-month">
        <div class="lw-cal-nav">
          <button type="button" class="lw-cal-step" data-lw-cal-action="prev" aria-label="Poprzedni miesiąc">‹</button>
          <span class="lw-cal-title" aria-live="polite">${MONTH_NAMES[view.month - 1]} ${view.year}</span>
          <button type="button" class="lw-cal-step" data-lw-cal-action="next" aria-label="Następny miesiąc">›</button>
        </div>
        <div class="lw-cal-grid">${head}${cells}</div>
      </div>`;
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function downloadIcs(event) {
    const blob = new Blob([icsContent(event)], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = icsFilename(event);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /**
   * Wires every date pill on the page to its calendar dropdown. Markup contract:
   *   <div class="lw-date-wrap" data-lw-cal-key="unique" data-lw-cal-event="<event id>">
   *     <button data-lw-cal-toggle>...</button><div class="lw-cal-popover" hidden></div>
   *   </div>
   * Only one dropdown is open at a time; it opens on the month of its own trip. `refresh()` repaints
   * after the page re-renders (the open key survives, the DOM nodes do not).
   *
   * Clicks are classified through composedPath(): a month step re-renders the popover, which
   * detaches the clicked button, and a plain `target.closest()` on the detached node would read as
   * an outside click and close the dropdown right after every prev/next press.
   */
  function mountDropdowns({ getEvents, findEvent }) {
    let open = null; // { key, view }

    function refresh() {
      document.querySelectorAll('.lw-date-wrap[data-lw-cal-key]').forEach((wrap) => {
        const popover = wrap.querySelector('.lw-cal-popover');
        const pill = wrap.querySelector('[data-lw-cal-toggle]');
        const event = open && open.key === wrap.dataset.lwCalKey ? findEvent(wrap.dataset.lwCalEvent) : null;
        if (popover) popover.hidden = !event;
        if (pill) pill.setAttribute('aria-expanded', String(Boolean(event)));
        if (event && popover) {
          popover.innerHTML = popoverHtml({ event, events: getEvents(), view: open.view, today: todayIso() });
        }
      });
    }

    function close() {
      open = null;
      refresh();
    }

    document.addEventListener('click', (e) => {
      const path = e.composedPath().filter((n) => n && typeof n.matches === 'function');
      const within = (selector) => path.find((n) => n.matches(selector));
      const wrap = within('.lw-date-wrap[data-lw-cal-key]');
      if (!wrap) {
        if (open) close();
        return;
      }
      const key = wrap.dataset.lwCalKey;
      const event = findEvent(wrap.dataset.lwCalEvent);
      if (within('[data-lw-cal-toggle]')) {
        if (open && open.key === key) {
          close();
        } else if (event) {
          const [year, month] = event.startDate.split('-').map(Number);
          open = { key, view: { year, month } };
          refresh();
        }
        return;
      }
      const button = within('[data-lw-cal-action]');
      if (!button || !event || !open || open.key !== key) return;
      const action = button.dataset.lwCalAction;
      if (action === 'google') {
        window.open(googleUrl(event), '_blank', 'noopener');
      } else if (action === 'ics') {
        downloadIcs(event);
      } else if (action === 'prev' || action === 'next') {
        open.view = shiftMonth(open.view, action === 'next' ? 1 : -1);
        refresh();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !open) return;
      const key = open.key;
      close();
      document.querySelector(`.lw-date-wrap[data-lw-cal-key="${key}"] [data-lw-cal-toggle]`)?.focus();
    });

    return { refresh, close };
  }

  // Quiet date pill + dropdown anchor for dashboard cards and list rows. Must not be placed inside a
  // <p>: the popover is a <div>, which the HTML parser would pull out of the wrapper.
  // `options.iconOnly` drops the date text (the Składki page's payment deadline); `options.label` is
  // then the button's tooltip and accessible name.
  function datePillHtml(event, key, popoverSide, options = {}) {
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const [y, m, d] = event.startDate.split('-');
    const text = options.iconOnly ? '' : `${d}.${m}.${y}`;
    const title = escapeHtml(options.label ?? 'Pokaż w kalendarzu');
    const classes = `lw-date-pill lw-date-pill--quiet${options.iconOnly ? ' lw-date-pill--icon' : ''}`;
    return `<span class="lw-date-wrap lw-date-wrap--quiet" data-lw-cal-key="${escapeHtml(key)}" data-lw-cal-event="${escapeHtml(event.id)}">
    <button type="button" class="${classes}" data-lw-cal-toggle aria-haspopup="true" aria-expanded="false" title="${title}"${options.iconOnly ? ` aria-label="${title}"` : ''}>${icon}${text}</button>
    <div class="lw-cal-popover lw-cal-popover--${popoverSide}" hidden></div>
  </span>`;
  }

  window.LwCalendar = {
    mountDropdowns,
    datePillHtml,
    googleUrl,
    icsContent,
    icsFilename,
    monthGrid,
    shiftMonth,
    shortName,
    popoverHtml,
  };
})();
