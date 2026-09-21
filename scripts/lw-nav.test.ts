import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/lw-nav.js', import.meta.url), 'utf8');

function loadLwNav(now: string): { html: (params: { events: unknown[]; currentEventId: string | null; open: boolean }) => string } {
  class FixedDate extends Date {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) super(now);
      else super(...(args as []));
    }
  }
  const context: Record<string, unknown> = { Date: FixedDate, String, encodeURIComponent, window: {} };
  vm.runInNewContext(source, context, { filename: 'lw-nav.js' });
  return (context.window as { LwNav: { html: (params: { events: unknown[]; currentEventId: string | null; open: boolean }) => string } }).LwNav;
}

const events = [
  { id: 'past', name: 'Wyjazd Zimowy', startDate: '2020-01-01', status: 'active' },
  { id: 'cancelled', name: 'Wyjazd Odwołany', startDate: '2026-06-01', status: 'cancelled' },
  { id: 'later', name: 'Wyjazd Jesienny', startDate: '2026-11-01', status: 'active' },
  { id: 'current', name: 'Wyjazd Letni', startDate: '2026-08-01', status: 'active' },
  { id: 'earlier-upcoming', name: 'Wyjazd Wiosenny', startDate: '2026-07-01', status: 'active' },
];

test('"Wszystkie" is always first and permanently underlined, regardless of which trip is open', () => {
  const { html } = loadLwNav('2026-06-15');
  const menu = html({ events, currentEventId: 'current', open: true });
  const wszystkieIndex = menu.indexOf('Wszystkie');
  const firstTripIndex = menu.indexOf('Wyjazd Wiosenny');
  assert.ok(wszystkieIndex > -1 && wszystkieIndex < firstTripIndex);
  assert.match(menu, /class="lw-nav-item lw-nav-item--all[^"]*"[^>]*>Wszystkie/);
});

test('excludes past and cancelled trips, keeps the rest in chronological order', () => {
  const { html } = loadLwNav('2026-06-15');
  const menu = html({ events, currentEventId: null, open: true });
  assert.doesNotMatch(menu, /Wyjazd Zimowy/);
  assert.doesNotMatch(menu, /Wyjazd Odwołany/);
  const wiosennyIndex = menu.indexOf('Wyjazd Wiosenny');
  const letniIndex = menu.indexOf('Wyjazd Letni');
  const jesiennyIndex = menu.indexOf('Wyjazd Jesienny');
  assert.ok(wiosennyIndex > -1 && letniIndex > wiosennyIndex && jesiennyIndex > letniIndex);
});

test('the currently open trip is highlighted in its natural chronological position, "Wszystkie" is not', () => {
  const { html } = loadLwNav('2026-06-15');
  const menu = html({ events, currentEventId: 'current', open: true });
  assert.match(menu, /class="lw-nav-item lw-nav-item--active" role="menuitem">Wyjazd Letni/);
  assert.doesNotMatch(menu, /lw-nav-item--all lw-nav-item--active/);
  assert.doesNotMatch(menu, /lw-nav-item--active lw-nav-item--all/);
});

test('with no current trip, "Wszystkie" is the active item and no trip is highlighted', () => {
  const { html } = loadLwNav('2026-06-15');
  const menu = html({ events, currentEventId: null, open: true });
  assert.match(menu, /class="lw-nav-item lw-nav-item--all lw-nav-item--active"[^>]*>Wszystkie/);
  assert.doesNotMatch(menu, /class="lw-nav-item lw-nav-item--active"/);
});

test('the toggle label follows the current view: "Wszystkie" or the open trip\'s name', () => {
  const { html } = loadLwNav('2026-06-15');
  assert.match(html({ events, currentEventId: null, open: false }), /<span>Wszystkie<\/span>/);
  assert.match(html({ events, currentEventId: 'current', open: false }), /<span>Wyjazd Letni<\/span>/);
});

test('"Dodaj wyjazd" is always the trailing item, linking to ?new=1', () => {
  const { html } = loadLwNav('2026-06-15');
  const menu = html({ events, currentEventId: null, open: true });
  const addIndex = menu.indexOf('id="lw-nav-add"');
  assert.ok(addIndex > menu.indexOf('Wyjazd Jesienny'));
  assert.match(menu, /<a href="\/lista-wyjazdowa\/\?new=1" class="lw-nav-item lw-nav-item--add" id="lw-nav-add" role="menuitem">\+ Dodaj wyjazd<\/a>/);
});

test('the menu is hidden when closed and shown when open', () => {
  const { html } = loadLwNav('2026-06-15');
  assert.match(html({ events, currentEventId: null, open: false }), /class="lw-nav-menu" role="menu" hidden>/);
  assert.doesNotMatch(html({ events, currentEventId: null, open: true }), /class="lw-nav-menu" role="menu" hidden>/);
});

test('trip names are HTML-escaped', () => {
  const { html } = loadLwNav('2026-06-15');
  const menu = html({ events: [{ id: 'x', name: '<b>Zły</b>', startDate: '2026-07-01', status: 'active' }], currentEventId: null, open: true });
  assert.match(menu, /&lt;b&gt;Zły&lt;\/b&gt;/);
  assert.doesNotMatch(menu, /<b>Zły<\/b>/);
});
