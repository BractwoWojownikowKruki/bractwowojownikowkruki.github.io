import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/lw-calendar.js', import.meta.url), 'utf8');

type Ev = { id: string; name: string; startDate: string; status: string; description?: string };
type Cell = { iso: string; day: number; inMonth: boolean; events: Ev[] };
type Cal = {
  googleUrl: (e: Ev) => string;
  icsContent: (e: Ev) => string;
  icsFilename: (e: Ev) => string;
  monthGrid: (y: number, m: number, events: Ev[]) => Cell[][];
  shiftMonth: (v: { year: number; month: number }, d: number) => { year: number; month: number };
  shortName: (n: string, max?: number) => string;
  popoverHtml: (p: { event: Ev; events: Ev[]; view: { year: number; month: number }; today: string }) => string;
};

const context: Record<string, unknown> = {
  Date, String, Array, Map, URLSearchParams, Math, Number,
  window: {
    LwFriendlyUrl: {
      eventSlug: (e: Ev) => `${e.startDate}-x`,
      eventUrl: (e: Ev) => `https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=${e.startDate}-x`,
    },
  },
};
vm.runInNewContext(source, context, { filename: 'lw-calendar.js' });
const cal = (context.window as { LwCalendar: Cal }).LwCalendar;

const wolin: Ev = { id: 'w', name: 'Wolin, Festiwal; Słowian', startDate: '2026-07-31', status: 'active' };

test('google link is an all-day entry with exclusive end date across a month boundary', () => {
  const url = new URL(cal.googleUrl(wolin));
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), wolin.name);
  assert.equal(url.searchParams.get('dates'), '20260731/20260801');
});

test('ics is an escaped all-day VEVENT with a stable UID', () => {
  const ics = cal.icsContent(wolin);
  assert.match(ics, /DTSTART;VALUE=DATE:20260731\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20260801\r\n/);
  assert.ok(ics.includes('SUMMARY:Wolin\\, Festiwal\\; Słowian\r\n'));
  assert.match(ics, /UID:w@kruki\.org/);
  assert.equal(cal.icsFilename(wolin), '2026-07-31-x.ics');
});

test('month grid is Monday-first full weeks and marks only non-cancelled trips', () => {
  const events: Ev[] = [wolin, { id: 'c', name: 'Odwołany', startDate: '2026-07-10', status: 'cancelled' }];
  const weeks = cal.monthGrid(2026, 7, events); // 1 July 2026 is a Wednesday
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks[0][0].iso, '2026-06-29');
  assert.equal(weeks[0][0].inMonth, false);
  assert.equal(weeks[0][2].iso, '2026-07-01');
  const flat = weeks.flat();
  assert.equal(flat.find((c) => c.iso === '2026-07-31')?.events[0].id, 'w');
  assert.equal(flat.find((c) => c.iso === '2026-07-10')?.events.length, 0);
  assert.equal(flat.filter((c) => c.inMonth).length, 31);
});

test('shiftMonth rolls over year boundaries both ways', () => {
  assert.deepEqual({ ...cal.shiftMonth({ year: 2026, month: 12 }, 1) }, { year: 2027, month: 1 });
  assert.deepEqual({ ...cal.shiftMonth({ year: 2026, month: 1 }, -1) }, { year: 2025, month: 12 });
});

test('shortName cuts long names with an ellipsis and leaves short ones alone', () => {
  assert.equal(cal.shortName('Wolin'), 'Wolin');
  assert.equal(cal.shortName('Festiwal Słowian'), 'Festiw…');
});

test('popover puts "Dodaj do kalendarza" before the month and escapes names', () => {
  const evil: Ev = { id: 'e', name: '<b>x</b>', startDate: '2026-07-05', status: 'active' };
  const html = cal.popoverHtml({ event: evil, events: [evil], view: { year: 2026, month: 7 }, today: '2026-07-01' });
  assert.ok(html.indexOf('Dodaj do kalendarza') < html.indexOf('lw-cal-month'));
  assert.doesNotMatch(html, /<b>x/);
  assert.match(html, /lipiec 2026/);
  assert.match(html, /lw-cal-day--current/);
});
