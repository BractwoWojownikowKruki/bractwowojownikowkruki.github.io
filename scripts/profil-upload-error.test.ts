import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createMutationFeedbackMock, createPersonRegistrationPromptMock } from './test-helpers/person-registration-prompt.js';

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
      querySelector: () => null,
    },
    window: {
      MutationFeedback: createMutationFeedbackMock(),
    },
    CSS: { escape: (value: string) => value },
    apiFetch,
    initGoogleSignIn: () => {},
    Cropper: class {},
    URL: { createObjectURL: () => '' },
    URLSearchParams, Map, Array, JSON, Date, encodeURIComponent,
  };
  vm.runInNewContext(profilSource, context, { filename: 'profil.js' });
  (context.window as any).PersonRegistrationPrompt = createPersonRegistrationPromptMock((context.window as any).MutationFeedback);
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

test('profile person registration retries with duplicateConfirmed after explicit confirmation', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const { context } = loadProfil(async (url?: string, init?: Record<string, unknown>) => {
    if (url === '/lista-wyjazdowa/roster') return { roster: [] };
    requests.push(init ?? {});
    if (requests.length === 1) {
      throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Anna', lastName: 'Nowak' }] });
    }
    return { person: { personId: 'new-person' } };
  });
  vm.runInContext("viewerEmail = 'owner@example.test'", context);
  await (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(
    { ksywka: 'Wilk', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'krakow' },
    {},
  );
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(String(requests[1].body)).duplicateConfirmed, true);
  assert.equal((context as any).document.getElementById('persons-error').hidden, true, (context as any).document.getElementById('persons-error').textContent);
});

test('profile registration keeps selected category and section values and focuses the refreshed row', async () => {
  let postedBody = '';
  const { context } = loadProfil(async (url?: string, init?: Record<string, unknown>) => {
    if (url === '/lista-wyjazdowa/roster') return { roster: [] };
    postedBody = String(init?.body ?? '');
    return { person: { personId: 'created-person', categoryId: 'kandydat', sectionId: 'krakow' } };
  });
  vm.runInContext("viewerEmail = 'owner@example.test'; personLookupLists = { categories: [{ id: 'kandydat', label: 'Kandydat' }], sections: [{ id: 'krakow', label: 'Kraków' }], weapons: [] }", context);
  let selector = '';
  let focused = 0;
  (context as any).document.querySelector = (value: string) => {
    selector = value;
    return { isConnected: true, disabled: false, focus: () => { focused += 1; } };
  };

  await (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(
    { ksywka: 'Wilk', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'krakow' },
    { disabled: false },
  );

  assert.deepEqual(JSON.parse(postedBody), {
    ksywka: 'Wilk', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'krakow', ownerPersonId: 'owner@example.test',
  });
  assert.equal(selector, '.person-row[data-person-id="created-person"] .person-first-name');
  assert.equal(focused, 1);
});

test('profile duplicate cancellation restores focus to the companion form field', async () => {
  let requestCount = 0;
  let focused = 0;
  const { context } = loadProfil(async () => {
    requestCount += 1;
    throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ firstName: 'Anna', lastName: 'Nowak' }] });
  });
  (context as any).window.PersonRegistrationPrompt = createPersonRegistrationPromptMock((context as any).window.MutationFeedback, {
    shouldCancelDuplicate: () => true,
  });
  const field = { focus: () => { focused += 1; } };
  const control = { closest: (selector: string) => selector === '.person-row' ? { querySelector: () => field } : null };
  vm.runInContext("viewerEmail = 'owner@example.test'", context);
  await (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(
    { ksywka: 'Wilk', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'krakow' },
    control,
  );
  assert.equal(requestCount, 1);
  assert.equal(focused, 1);
});

test('profile person registration ignores a second submit while the first request is in flight', async () => {
  let finishPost!: (value: unknown) => void;
  const postRequests: unknown[] = [];
  const { context } = loadProfil(async (url?: string, init?: Record<string, unknown>) => {
    if (url === '/lista-wyjazdowa/persons' && init?.method === 'POST') {
      postRequests.push(init);
      return new Promise((resolve) => { finishPost = resolve; });
    }
    if (url === '/lista-wyjazdowa/roster') return { roster: [] };
    return {};
  });
  vm.runInContext("viewerEmail = 'owner@example.test'", context);
  const control = { disabled: false };
  const fields = { ksywka: 'Wilk', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'krakow' };
  const firstSubmit = (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(fields, control);
  assert.equal(control.disabled, true);
  await (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(fields, control);
  assert.equal(postRequests.length, 1);
  finishPost({ person: { personId: 'new-person' } });
  await firstSubmit;
  assert.equal(control.disabled, false);
});

test('profile person registration ignores a second submit while the confirmed retry is in flight', async () => {
  let finishRetry!: (value: unknown) => void;
  const postBodies: Array<Record<string, unknown>> = [];
  const { context } = loadProfil();
  context.apiFetch = async (_url?: string, init?: Record<string, unknown>) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      postBodies.push(body);
      if (!body.duplicateConfirmed) throw Object.assign(new Error('duplicate'), { duplicateMatches: [{ nickname: 'Wilk' }] });
      return new Promise((resolve) => { finishRetry = resolve; });
    }
    if (_url === '/lista-wyjazdowa/roster') return { roster: [] };
    return {};
  };
  vm.runInContext("viewerEmail = 'owner@example.test'", context);
  const control = { disabled: false };
  const fields = { ksywka: 'Wilk', firstName: 'Anna', lastName: 'Nowak', categoryId: 'kandydat', sectionId: 'krakow' };
  const firstSubmit = (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(fields, control);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(postBodies.length, 2);
  await (context.createPerson as (fields: Record<string, string>, control: unknown) => Promise<void>)(fields, control);
  assert.equal(postBodies.length, 2);
  finishRetry({ person: { personId: 'new-person' } });
  await firstSubmit;
  assert.equal(control.disabled, false);
});

test('profile deactivation focuses the persistent add button after its row disappears', async () => {
  const { context, elements } = loadProfil(async (url?: string) => url === '/lista-wyjazdowa/roster' ? { roster: [] } : { ok: true });
  const focusTarget = (context as any).document.getElementById('add-person-row') as StubElement & { focusCount?: number; focus?: () => void };
  focusTarget.focusCount = 0;
  focusTarget.focus = () => { focusTarget.focusCount = (focusTarget.focusCount ?? 0) + 1; };
  (context as any).document.querySelector = () => null;
  (context as any).window.MutationFeedback.confirmed = async ({ execute, apply, skipApplyWhen, focusAfterApply }: any) => {
    const result = await execute();
    if (skipApplyWhen?.(result)) return result;
    await apply?.(result);
    focusAfterApply?.(result)?.focus?.();
    return result;
  };

  await (context.deletePerson as (personId: string, control: unknown) => Promise<void>)('gone-person', { disabled: false });

  assert.equal(focusTarget.focusCount, 1);
});
