import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const profilSource = readFileSync(new URL('../public/profil/profil.js', import.meta.url), 'utf8');

// Same minimal DOM stub as dues-status.test.ts: just enough for profil.js's module-load-time
// statements to run so its top-level functions can be called directly.
interface StubElement { hidden: boolean; innerHTML: string; textContent: string; value: string; disabled?: boolean; dataset: Record<string, string>; addEventListener(): void; lastName?: { value: string }; firstName?: { value: string } }

function loadProfil(apiFetch: () => Promise<unknown> = async () => { throw new Error('not called on load'); }): { context: Record<string, unknown>; elements: Map<string, StubElement> } {
  const elements = new Map<string, StubElement>();
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { hidden: true, innerHTML: '', textContent: '', value: '', dataset: {}, addEventListener() {}, lastName: { value: 'Kowalski' }, firstName: { value: 'Jan' } });
        return elements.get(id)!;
      },
    },
    // MutationFeedback.confirmed rethrows the original error (public/mutation-feedback.js), so a plain pass-through is faithful here.
    window: { MutationFeedback: { confirmed: async ({ execute }: { execute: () => Promise<unknown> }) => execute() } },
    apiFetch,
    initGoogleSignIn: () => {},
    Cropper: class {},
    URL: { createObjectURL: () => '' },
    URLSearchParams, Map, Array, JSON, Date, encodeURIComponent,
  };
  vm.runInNewContext(profilSource, context, { filename: 'profil.js' });
  return { context, elements };
}

// KRKG-127: a member's photo upload died with the raw browser text "Błąd: Failed to fetch" when the
// request never completed (preflight passed, POST never reached the server).
test('a network-level fetch failure shows the Polish retry hint instead of "Failed to fetch"', () => {
  const { context } = loadProfil();
  const photoUploadErrorMessage = context.photoUploadErrorMessage as (err: unknown) => string;
  // Created inside the profil.js realm: `instanceof TypeError` there only matches that realm's TypeError.
  const networkError = vm.runInContext('new TypeError("Failed to fetch")', vm.createContext(context));
  assert.equal(photoUploadErrorMessage(networkError), 'Nie udało się przesłać. Odśwież się i spróbuj ponownie.');
});

test('errors that carry a server message keep the "Błąd: <message>" text', () => {
  const photoUploadErrorMessage = loadProfil().context.photoUploadErrorMessage as (err: unknown) => string;
  const serverError = Object.assign(new Error('Plik przekracza maksymalny dozwolony rozmiar (10 MB).'), { status: 413 });
  assert.equal(photoUploadErrorMessage(serverError), 'Błąd: Plik przekracza maksymalny dozwolony rozmiar (10 MB).');
  assert.equal(photoUploadErrorMessage(new Error('Coś innego')), 'Błąd: Coś innego');
});

// The acceptance criteria are about what the member sees, so drive the real uploadSelectedPhotos()
// with a rejected fetch rather than only the message helper.
test('uploadSelectedPhotos shows the Polish hint and re-enables the button when fetch rejects', async () => {
  const { context, elements } = loadProfil();
  const networkError = vm.runInContext('new TypeError("Failed to fetch")', vm.createContext(context));
  context.apiFetch = async () => { throw networkError; };
  vm.runInContext("photoEntries = [{ file: { name: '1000018289.jpg', type: 'image/jpeg' } }]", context);

  await (context.uploadSelectedPhotos as () => Promise<void>)();

  const errorEl = elements.get('photos-error')!;
  assert.equal(errorEl.textContent, 'Nie udało się przesłać. Odśwież się i spróbuj ponownie.');
  assert.equal(errorEl.hidden, false);
  assert.equal(elements.get('photos-progress')!.hidden, true);
  assert.equal(elements.get('photos-submit')!.disabled, false);
});

test('uploadSelectedPhotos keeps the server message for HTTP errors', async () => {
  const { context, elements } = loadProfil();
  context.apiFetch = async () => { throw Object.assign(new Error('Plik przekracza maksymalny dozwolony rozmiar (10 MB).'), { status: 413 }); };
  vm.runInContext("photoEntries = [{ file: { name: 'big.jpg', type: 'image/jpeg' } }]", context);

  await (context.uploadSelectedPhotos as () => Promise<void>)();

  assert.equal(elements.get('photos-error')!.textContent, 'Błąd: Plik przekracza maksymalny dozwolony rozmiar (10 MB).');
});
