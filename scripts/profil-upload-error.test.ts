import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const profilSource = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');

// Same minimal DOM stub as dues-status.test.ts: just enough for profil.js's module-load-time
// statements to run so its top-level functions can be called directly.
function loadProfil(): Record<string, unknown> {
  const context: Record<string, unknown> = {
    document: {
      getElementById: () => ({ hidden: true, innerHTML: '', textContent: '', value: '', dataset: {}, addEventListener() {} }),
    },
    window: {},
    apiFetch: async () => { throw new Error('not called on load'); },
    initGoogleSignIn: () => {},
    Cropper: class {},
    URL: { createObjectURL: () => '' },
    URLSearchParams, Map, Array, JSON, Date, encodeURIComponent,
  };
  vm.runInNewContext(profilSource, context, { filename: 'profil.js' });
  return context;
}

// KRKG-127: a member's photo upload died with the raw browser text "Błąd: Failed to fetch" when the
// request never completed (preflight passed, POST never reached the server).
test('a network-level fetch failure shows the Polish retry hint instead of "Failed to fetch"', () => {
  const context = loadProfil();
  const photoUploadErrorMessage = context.photoUploadErrorMessage as (err: unknown) => string;
  // Created inside the profil.js realm: `instanceof TypeError` there only matches that realm's TypeError.
  const networkError = vm.runInContext('new TypeError("Failed to fetch")', vm.createContext(context));
  assert.equal(photoUploadErrorMessage(networkError), 'Nie udało się przesłać. Odśwież się i spróbuj ponownie.');
});

test('errors that carry a server message keep the "Błąd: <message>" text', () => {
  const photoUploadErrorMessage = loadProfil().photoUploadErrorMessage as (err: unknown) => string;
  const serverError = Object.assign(new Error('Plik przekracza maksymalny dozwolony rozmiar (10 MB).'), { status: 413 });
  assert.equal(photoUploadErrorMessage(serverError), 'Błąd: Plik przekracza maksymalny dozwolony rozmiar (10 MB).');
  assert.equal(photoUploadErrorMessage(new Error('Coś innego')), 'Błąd: Coś innego');
});
