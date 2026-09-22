import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
const lwFriendlyUrlSource = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');

// Only the four page-gating panels and sessionStorage are touched at load time; the two
// initGoogleSignIn callbacks (and their fetches) never run here, so a minimal stub is enough to
// evaluate the file and reach its top-level function declarations. lw-friendly-url.js is loaded
// first (matching the real <script> order in app/index.html) since eventDetailHref() now calls
// window.LwFriendlyUrl.eventUrl().
function loadApp(): Record<string, unknown> {
  const elements = new Map<string, { id: string; hidden: boolean }>();
  const context: Record<string, unknown> = {
    window: {},
    sessionStorage: { getItem: () => null, removeItem: () => {} },
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { id, hidden: false });
        return elements.get(id);
      },
    },
    initGoogleSignIn: () => {},
  };
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(appSource, context, { filename: 'app.js' });
  return context;
}

test('eventDetailHref builds the friendly ?do= trip detail URL', () => {
  const context = loadApp();
  const eventDetailHref = context.eventDetailHref as (event: { name: string; startDate: string }) => string;
  assert.equal(
    eventDetailHref({ name: 'Wolin', startDate: '2027-01-01' }),
    'https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=2027-01-01-wolin',
  );
});

test('the nearest-trip card links straight to the trip, not to the generic list', () => {
  assert.match(appSource, /widget\.href = eventDetailHref\(event\)/);
  assert.doesNotMatch(appSource, /widget\.href = '\/lista-wyjazdowa\/'/);
});

test('each "Twoje zapisy" trip name is its own link to that trip', () => {
  assert.match(appSource, /<a class="dashboard-mini-item-name"><\/a>/);
  assert.match(appSource, /nameLink\.href = eventDetailHref\(e\)/);
  // The card cannot be one whole-card link when it lists several trips.
  assert.match(appSource, /function renderMySignupsWidget\(events\)[\s\S]*?document\.createElement\('div'\)/);
  assert.match(css, /\.dashboard-mini-item-name\s*\{[^}]*text-decoration:\s*none/);
  assert.match(css, /\.dashboard-mini-item-name:hover/);
});
