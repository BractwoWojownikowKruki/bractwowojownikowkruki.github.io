import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
const companionAddSource = readFileSync(new URL('../public/shared/companion-add.js', import.meta.url), 'utf8');
const lwFriendlyUrlSource = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');
const eventLinkActionsSource = readFileSync(new URL('../public/shared/event-link-actions.js', import.meta.url), 'utf8');
const eventEditFormSource = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');

// Only the four page-gating panels and sessionStorage are touched at load time; the two
// initGoogleSignIn callbacks (and their fetches) never run here, so a minimal stub is enough to
// evaluate the file and reach its top-level function declarations. lw-friendly-url.js is loaded
// first (matching the real <script> order in app/index.html) since eventDetailHref() now calls
// window.LwFriendlyUrl.eventUrl().
function loadApp(): Record<string, unknown> {
  const elements = new Map<string, { id: string; hidden: boolean; disabled?: boolean; focusCount: number; focus(): void; addEventListener?: () => void; querySelector?: () => null }>();
  const context: Record<string, unknown> = {
    window: {},
    sessionStorage: { getItem: () => null, removeItem: () => {} },
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { id, hidden: false, disabled: false, focusCount: 0, focus() { this.focusCount += 1; }, addEventListener: () => {}, querySelector: () => null });
        return elements.get(id);
      },
      querySelector: () => null,
    },
    CSS: { escape: (value: string) => value },
    initGoogleSignIn: () => {},
  };
  vm.runInNewContext(lwFriendlyUrlSource, context, { filename: 'lw-friendly-url.js' });
  vm.runInNewContext(companionAddSource, context, { filename: 'companion-add.js' });
  vm.runInNewContext(eventEditFormSource, context, { filename: 'event-edit-form.js' });
  vm.runInNewContext(eventLinkActionsSource, context, { filename: 'event-link-actions.js' });
  vm.runInNewContext(appSource, context, { filename: 'app.js' });
  return context;
}

test('dashboard companion registration confirms duplicates and refreshes the signup card', async () => {
  const context = loadApp() as any;
  const requests: Array<Record<string, unknown>> = [];
  let applied = 0;
  context.window.MutationFeedback = {
    confirmed: async ({ execute, apply, skipApplyWhen }: any) => {
      const result = await execute();
      if (!skipApplyWhen(result)) await apply(result);
    },
  };
  context.window.PersonRegistrationPrompt = {
    run: async (execute: (confirmed: boolean) => Promise<unknown>) => {
      try { return await execute(false); } catch (error: any) {
        if (!Array.isArray(error?.duplicateMatches)) throw error;
        return execute(true);
      }
    },
    wasCancelled: () => false,
    confirmed: async (options: any) => context.window.MutationFeedback.confirmed({
      ...options,
      execute: () => context.window.PersonRegistrationPrompt.run(options.execute, { fallbackFocus: options.fallbackFocus }),
      skipApplyWhen: (result: unknown) => context.window.PersonRegistrationPrompt.wasCancelled(result),
    }),
  };
  context.apiFetch = async (_url: string, init: Record<string, unknown>) => {
    if (_url === '/lista-wyjazdowa/events') {
      return { events: [{ id: 'trip-1', attendingCount: 3, viewerCompanions: [{ firstName: 'Anna', nickname: 'Wilk' }] }] };
    }
    requests.push(init);
    if (requests.length === 1) throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Iga' }] });
    return { signup: { attending: true } };
  };
  context.renderDashboardWidgets = () => { applied += 1; };
  context.refreshDuesPanel = () => {};
  vm.runInNewContext("dash.events = [{ id: 'trip-1', attendingCount: 2 }]", context);

  await context.quickAddDashCompanion({ eventId: 'trip-1', ownerPersonId: 'owner@example.test', mode: 'new', ksywka: 'Wilk' }, { disabled: false });

  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(String(requests[1].body)).duplicateConfirmed, true);
  assert.equal(applied, 1);
  assert.equal(vm.runInNewContext("signupStatusText(dash.events[0])", context), 'Jadę + Anna');
});

test('dashboard companion duplicate cancellation keeps the panel and focuses its form field', async () => {
  const context = loadApp() as any;
  const requests: Array<Record<string, unknown>> = [];
  const control = { disabled: false };
  let applied = 0;
  const cancelled = Object.freeze({ cancelled: true });
  context.window.MutationFeedback = {
    confirmed: async ({ execute, apply, skipApplyWhen }: any) => {
      const result = await execute();
      if (!skipApplyWhen(result)) apply(result);
    },
  };
  context.window.PersonRegistrationPrompt = {
    run: async (execute: (confirmed: boolean) => Promise<unknown>, options: { fallbackFocus?: () => any } = {}) => {
      try { return await execute(false); } catch (error: any) {
        if (!Array.isArray(error?.duplicateMatches)) throw error;
        options.fallbackFocus?.()?.focus();
        return cancelled;
      }
    },
    wasCancelled: (result: unknown) => result === cancelled,
    confirmed: async (options: any) => context.window.MutationFeedback.confirmed({
      ...options,
      execute: () => context.window.PersonRegistrationPrompt.run(options.execute, { fallbackFocus: options.fallbackFocus }),
      skipApplyWhen: (result: unknown) => context.window.PersonRegistrationPrompt.wasCancelled(result),
    }),
  };
  context.apiFetch = async (_url: string, init: Record<string, unknown>) => {
    requests.push(init);
    throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ nickname: 'Wilk' }] });
  };
  context.renderDashboardWidgets = () => { applied += 1; };
  context.refreshDuesPanel = () => {};
  vm.runInNewContext("dash.events = [{ id: 'trip-1', attendingCount: 2 }]", context);

  await context.quickAddDashCompanion({ eventId: 'trip-1', ownerPersonId: 'owner@example.test', mode: 'new', ksywka: 'Wilk' }, control);

  assert.equal(requests.length, 1);
  assert.equal(applied, 0);
  assert.equal(context.document.getElementById('lw-inline-new-name').focusCount, 1);
  assert.equal(control.disabled, false);
});

test('eventDetailHref builds the friendly ?do= trip detail URL', () => {
  const context = loadApp();
  const eventDetailHref = context.eventDetailHref as (event: { name: string; startDate: string }) => string;
  assert.equal(
    eventDetailHref({ name: 'Wolin', startDate: '2027-01-01' }),
    'https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=2027-01-01-wolin',
  );
});

test('the nearest-trip card links straight to the trip, not to the generic list', () => {
  // The card now holds the attend toggle, so it cannot be one whole-card link; the name is the link.
  assert.match(appSource, /nameLink\.href = eventDetailHref\(event\)/);
  assert.doesNotMatch(appSource, /widget\.href = '\/lista-wyjazdowa\/'/);
});

test('the nearest-trip card renders map and Discord actions beside the headcount', () => {
  const widget = appSource.match(/function renderNearestEventWidget\(events\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(widget, /EventLinkActions\.html\(event\)/);
  assert.match(widget, /attendeeBadge\(event\.attendingCount\)[\s\S]*EventLinkActions/);
  assert.match(appSource, /EventLinkActions\.wire\(/);
});

test('each "Twoje zapisy" trip name is its own link to that trip', () => {
  assert.match(appSource, /<a class="dashboard-mini-item-name"><\/a>/);
  assert.match(appSource, /nameLink\.href = eventDetailHref\(e\)/);
  // The card cannot be one whole-card link when it lists several trips.
  assert.match(appSource, /function renderMySignupsWidget\(events\)[\s\S]*?document\.createElement\('div'\)/);
  assert.match(css, /\.dashboard-mini-item-name\s*\{[^}]*text-decoration:\s*none/);
  assert.match(css, /\.dashboard-mini-item-name:hover/);
  assert.match(appSource, /attendance\.textContent = signupStatusText\(e\)/);
});

test('dashboard signup status lists a first name or nickname only, without surnames', () => {
  const context = loadApp() as any;
  assert.equal(context.signupStatusText({ viewerCompanions: [] }), 'Jadę');
  assert.equal(context.signupStatusText({ viewerCompanions: [{ firstName: 'Anna', lastName: 'Nowak', nickname: 'Wilk' }] }), 'Jadę + Anna');
  assert.equal(context.signupStatusText({ viewerCompanions: [{ firstName: '', lastName: 'Nowak', nickname: 'Wilk' }] }), 'Jadę + Wilk');
  assert.equal(context.signupStatusText({ viewerCompanions: [{ firstName: 'Jan', lastName: 'Lis' }, { firstName: 'Anna', lastName: 'Nowak' }] }), 'Jadę + Anna, Jan');
});

test('dashboard signup card metadata wraps companion names instead of forcing one long row', () => {
  assert.match(css, /\.dashboard-mini-item-meta\s*\{[^}]*white-space:\s*normal[^}]*flex-wrap:\s*wrap/);
});

test('dashboard companion form validation does not require the nickname', () => {
  const addHandler = appSource.match(/const addNewBtn = e\.target\.closest\('\.lw-inline-add-new'\);[\s\S]*?\n    }/)?.[0] ?? '';
  assert.match(addHandler, /if \(!lastName \|\| !firstName \|\| !categoryId\)/);
  assert.match(addHandler, /Podaj nazwisko, imię i kategorię nowej osoby\./);
});

test('the new-galleries widget combines static and member-created galleries', () => {
  const widgetSource = appSource.match(/async function renderNewGalleriesWidget\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(widgetSource, /Promise\.allSettled\(/);
  assert.match(widgetSource, /fetch\('\/galerie\/data\/albums\.generated\.json'\)/);
  assert.match(widgetSource, /apiFetch\('\/galleries'/);
  assert.match(widgetSource, /title: gallery\.name/);
  assert.match(widgetSource, /date: gallery\.date\?\.slice\(0, 10\)/);
  assert.match(widgetSource, /cover: gallery\.coverThumbnailLink/);
  assert.match(widgetSource, /albums\.sort\(\(a, b\) => b\.date\.localeCompare\(a\.date\)\)\.slice\(0, 3\)/);
});
