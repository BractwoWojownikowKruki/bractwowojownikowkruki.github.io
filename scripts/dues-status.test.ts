import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { effectiveDuesStatus as serverEffectiveDuesStatus, effectiveWpisoweStatus as serverEffectiveWpisoweStatus, type DuesDoc, type DuesStatus } from '../upload-service/src/dues.ts';

const duesStatusSource = readFileSync(new URL('../public/shared/dues-status.js', import.meta.url), 'utf8');
const profilSource = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');

interface DuesStatusHelpers {
  effectiveDuesStatus: (storedStatus: string | null | undefined, categoryId: string | null) => string;
  duesStatusLabel: (year: number, status: string) => string;
}

function loadHelpers(): DuesStatusHelpers {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(`${duesStatusSource}\n;globalThis.__h = { effectiveDuesStatus, duesStatusLabel };`, context, { filename: 'dues-status.js' });
  return context.__h as DuesStatusHelpers;
}

test('shared effectiveDuesStatus matches upload-service dues.ts for every stored status and category', () => {
  const { effectiveDuesStatus } = loadHelpers();
  const storedStatuses: Array<DuesStatus | null> = [null, 'unpaid', 'paid', 'not_applicable'];
  for (const stored of storedStatuses) {
    for (const categoryId of [null, 'emeryt', 'wojownik']) {
      const doc: DuesDoc | null = stored ? { email: 'a@b.pl', year: 2026, status: stored, updatedBy: 'x', updatedAt: 'x' } : null;
      assert.equal(effectiveDuesStatus(stored, categoryId), serverEffectiveDuesStatus(doc, categoryId), `stored=${stored} category=${categoryId}`);
    }
  }
});

test('duesStatusLabel names all three states', () => {
  const { duesStatusLabel } = loadHelpers();
  assert.equal(duesStatusLabel(2026, 'paid'), 'Składka 2026: opłacona');
  assert.equal(duesStatusLabel(2026, 'unpaid'), 'Składka 2026: nieopłacona');
  assert.equal(duesStatusLabel(2026, 'not_applicable'), 'Składka 2026: nie dotyczy');
});

// Regression: Mój profil read the legacy `dues.paid` boolean, which the stored record no longer
// has, so a paid member saw "nieopłacona" there while the profile drawer showed "opłacona".
test('Mój profil renders the server-resolved duesStatus, the same status the profile drawer shows', () => {
  const elements = new Map<string, { hidden: boolean; innerHTML: string; textContent: string; value: string; dataset: Record<string, string>; addEventListener(): void }>();
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { hidden: true, innerHTML: '', textContent: '', value: '', dataset: {}, addEventListener() {} });
        return elements.get(id);
      },
    },
    window: {},
    apiFetch: async () => { throw new Error('not called on load'); },
    initGoogleSignIn: () => {},
    Cropper: class {},
    URL: { createObjectURL: () => '' },
    URLSearchParams, Map, Array, JSON, Date, encodeURIComponent,
  };
  vm.runInNewContext(duesStatusSource, context, { filename: 'dues-status.js' });
  vm.runInNewContext(profilSource, context, { filename: 'profil.js' });
  const renderDuesStatus = context.renderDuesStatus as (wpisoweStatus: string, duesStatus: string) => void;
  const year = new Date().getFullYear();

  renderDuesStatus('unpaid', 'paid');
  assert.match(elements.get('lw-dues-status')!.innerHTML, /Wpisowe: nieopłacone/);
  renderDuesStatus('not_applicable', 'paid');
  assert.doesNotMatch(elements.get('lw-dues-status')!.innerHTML, /Wpisowe/);

  renderDuesStatus('paid', 'paid');
  assert.match(elements.get('lw-dues-status')!.innerHTML, new RegExp(`Składka ${year}: opłacona`));
  assert.match(elements.get('lw-dues-status')!.innerHTML, /data-status="paid"/);

  renderDuesStatus('paid', 'not_applicable');
  assert.match(elements.get('lw-dues-status')!.innerHTML, /nie dotyczy/);

  renderDuesStatus('paid', 'unpaid');
  assert.match(elements.get('lw-dues-status')!.innerHTML, /nieopłacona/);

  assert.doesNotMatch(profilSource, /dues\?\.paid/);
  assert.match(profilSource, /duesResponse\.duesStatus/);
  assert.match(profilSource, /duesResponse\.wpisoweStatus/);
});

test('shared effectiveWpisoweStatus matches upload-service dues.ts (Bobo defaults to nie dotyczy)', () => {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(`${duesStatusSource}\n;globalThis.__f = effectiveWpisoweStatus;`, context, { filename: 'dues-status.js' });
  const clientEffectiveWpisoweStatus = context.__f as (stored: string | null, categoryId: string | null) => string;
  for (const stored of [null, 'unpaid', 'paid', 'not_applicable'] as Array<DuesStatus | null>) {
    for (const categoryId of [null, 'bobo', 'emeryt', 'blacha']) {
      const profile = stored ? { wpisoweStatus: stored } : null;
      assert.equal(clientEffectiveWpisoweStatus(stored, categoryId), serverEffectiveWpisoweStatus(profile, categoryId), `stored=${stored} category=${categoryId}`);
    }
  }
});

test('the dashboard trusts the server-resolved duesStatus instead of re-deriving it', () => {
  assert.match(appSource, /myDuesResponse\.duesStatus === 'unpaid'/);
  assert.match(appSource, /myDuesResponse\.wpisoweStatus === 'unpaid'/);
  assert.doesNotMatch(appSource, /function effectiveDuesStatus/);
});

test('every page that shows dues status loads shared/dues-status.js before the scripts using it', () => {
  const pages = [
    'profil/index.html', 'czlonkowie/index.html', 'pliki/index.html', 'sprzet-obozowy/index.html',
    'admin/publiczne-wizytowki/index.html', 'admin/zarzadzanie-ludzmi/index.html',
    'lista-wyjazdowa/wyjazd/index.html', 'lista-wyjazdowa/skladki/index.html',
  ];
  for (const page of pages) {
    const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const helperAt = html.indexOf('shared/dues-status.js');
    assert.notEqual(helperAt, -1, `${page} must load shared/dues-status.js`);
    for (const consumer of ['shared/profile-panel.js', 'src="profil.js"', 'src="skladki.js"', 'src="wyjazd.js"']) {
      const consumerAt = html.indexOf(consumer);
      if (consumerAt !== -1) assert.ok(helperAt < consumerAt, `${page}: dues-status.js must load before ${consumer}`);
    }
  }
});
