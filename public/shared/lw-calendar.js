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
      const trips = cell.events.map((e) => `<a class="lw-cal-trip" href="${escapeHtml(eventLink(e))}" title="${escapeHtml(e.name)}">${escapeHtml(shortName(e.name))}</a>`).join('');
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

  window.LwCalendar = {
    googleUrl,
    icsContent,
    icsFilename,
    monthGrid,
    shiftMonth,
    shortName,
    popoverHtml,
  };
})();
