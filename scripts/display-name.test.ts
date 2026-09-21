import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const displayNameSource = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');

function loadHelper(): { displayName: (member: unknown) => string; personSubline: (member: unknown) => string | null } {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(displayNameSource, context, { filename: 'display-name.js' });
  return context as unknown as { displayName: (member: unknown) => string; personSubline: (member: unknown) => string | null };
}

test('displayName prefers nickname, then firstName, then lastName, then the email local part', () => {
  const { displayName } = loadHelper();
  assert.equal(displayName({ nickname: 'Wilk', firstName: 'Jan', lastName: 'Kowalski', email: 'jan@x.pl' }), 'Wilk');
  assert.equal(displayName({ nickname: null, firstName: 'Jan', lastName: 'Kowalski', email: 'jan@x.pl' }), 'Jan');
  // KRKG-0103 migration window: firstName still blank, lastName holds the old unsplit value.
  assert.equal(displayName({ nickname: null, firstName: '', lastName: 'Kowalski', email: 'jan@x.pl' }), 'Kowalski');
  assert.equal(displayName({ nickname: null, firstName: '', lastName: '', email: 'jan@x.pl' }), 'jan');
});

test('displayName strips the domain off whichever field wins, including a name field that is itself an e-mail', () => {
  const { displayName } = loadHelper();
  assert.equal(displayName({ nickname: 'jan.kowalski@gmail.com', firstName: '', lastName: '', email: 'jan@x.pl' }), 'jan.kowalski');
  assert.equal(displayName({ nickname: null, firstName: '', lastName: '', email: undefined }), '', 'must not throw when even email is missing');
});

test('personSubline renders "Nazwisko, Imię" when both are set, falls back to lastName alone, or null', () => {
  const { personSubline } = loadHelper();
  assert.equal(personSubline({ lastName: 'Kowalski', firstName: 'Jan' }), 'Kowalski, Jan');
  assert.equal(personSubline({ lastName: 'Kowalski', firstName: '' }), 'Kowalski');
  assert.equal(personSubline({ lastName: '', firstName: 'Jan' }), null, 'a lone firstName with no lastName has nothing to pair it with');
  assert.equal(personSubline({ lastName: '', firstName: '' }), null);
});
