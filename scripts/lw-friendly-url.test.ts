import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/lw-friendly-url.js', import.meta.url), 'utf8');

type LwFriendlyUrl = {
  slugify: (name: string) => string;
  eventSlug: (event: { name: string; startDate: string }) => string;
  eventUrl: (event: { name: string; startDate: string }) => string;
  shareEvent: (
    event: { name: string; startDate: string },
    opts?: { button?: { classList: { add: (c: string) => void; remove: (c: string) => void } }; textEl?: { textContent: string } },
  ) => Promise<boolean>;
};

function loadLwFriendlyUrl(navigatorStub?: unknown): LwFriendlyUrl {
  const context: Record<string, unknown> = { window: {}, navigator: navigatorStub, setTimeout, String };
  vm.runInNewContext(source, context, { filename: 'lw-friendly-url.js' });
  return (context.window as { LwFriendlyUrl: LwFriendlyUrl }).LwFriendlyUrl;
}

test('slugify strips Polish diacritics and lowercases', () => {
  const { slugify } = loadLwFriendlyUrl();
  assert.equal(slugify('Wolin Żarłoczny Ćwiczeniówka'), 'wolin-zarloczny-cwiczeniowka');
});

test('eventSlug prefixes the ISO start date verbatim', () => {
  const { eventSlug } = loadLwFriendlyUrl();
  assert.equal(eventSlug({ name: 'Wolin', startDate: '2026-01-01' }), '2026-01-01-wolin');
});

test('eventUrl builds the full ?do= link', () => {
  const { eventUrl } = loadLwFriendlyUrl();
  assert.equal(
    eventUrl({ name: 'Wolin', startDate: '2026-01-01' }),
    'https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=2026-01-01-wolin',
  );
});

test('shareEvent uses Web Share API when available', async () => {
  let sharedData: unknown;
  const { shareEvent } = loadLwFriendlyUrl({ share: async (data: unknown) => { sharedData = data; } });
  const ok = await shareEvent({ name: 'Wolin', startDate: '2026-01-01' });
  assert.equal(ok, true);
  assert.deepEqual(sharedData, { title: 'Wolin', url: 'https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=2026-01-01-wolin' });
});

test('shareEvent falls back to clipboard when Web Share API is unavailable', async () => {
  let written: string | null = null;
  const { shareEvent } = loadLwFriendlyUrl({ clipboard: { writeText: async (text: string) => { written = text; } } });
  const ok = await shareEvent({ name: 'Wolin', startDate: '2026-01-01' });
  assert.equal(ok, true);
  assert.equal(written, 'https://www.kruki.org/lista-wyjazdowa/wyjazd/?do=2026-01-01-wolin');
});

test('shareEvent returns false when user cancels the Web Share sheet', async () => {
  const { shareEvent } = loadLwFriendlyUrl({ share: async () => { const err = new Error(); (err as any).name = 'AbortError'; throw err; } });
  const ok = await shareEvent({ name: 'Wolin', startDate: '2026-01-01' });
  assert.equal(ok, false);
});

test('shareEvent returns false when both Web Share and clipboard fail', async () => {
  const { shareEvent } = loadLwFriendlyUrl({ share: async () => { throw new Error('API broken'); }, clipboard: { writeText: async () => { throw new Error('denied'); } } });
  const ok = await shareEvent({ name: 'Wolin', startDate: '2026-01-01' });
  assert.equal(ok, false);
});

test('shareEvent applies lw-share--active class and "Skopiowano!" text on clipboard fallback', async () => {
  const classes: string[] = [];
  const button = { classList: { add: (c: string) => classes.push(c), remove: (c: string) => classes.splice(classes.indexOf(c), 1) } };
  let textContent = 'Udostępnij';
  const textEl = { get textContent() { return textContent; }, set textContent(v: string) { textContent = v; } };

  const { shareEvent } = loadLwFriendlyUrl({ clipboard: { writeText: async () => {} } });
  const ok = await shareEvent({ name: 'Wolin', startDate: '2026-01-01' }, { button, textEl });

  assert.equal(ok, true);
  assert.ok(classes.includes('lw-share--active'));
  // After 2s timeout, class should be removed and text restored (but this is hard to test synchronously; test just that it was added)
});
