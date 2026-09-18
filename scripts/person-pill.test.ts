import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const personPillSource = readFileSync(new URL('../public/shared/person-pill.js', import.meta.url), 'utf8');
const wyjazdSource = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/lista-wyjazdowa/wyjazd/index.html', import.meta.url), 'utf8');

function loadHelper(): { personPillHtml: (person: unknown) => string } {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(personPillSource, context, { filename: 'person-pill.js' });
  return context as unknown as { personPillHtml: (person: unknown) => string };
}

test('personPillHtml renders the shared pill and adds a meaningful marker only for accountless people', () => {
  const { personPillHtml } = loadHelper();

  const member = personPillHtml({ name: 'Ala', categoryId: 'thing', categoryLabel: 'Thing', accountless: false });
  assert.match(member, /class="category-name-pill"/);
  assert.match(member, /data-category="thing"/);
  assert.match(member, /title="Thing"/);
  assert.match(member, />Ala</);
  assert.doesNotMatch(member, /person-pill-icon/, 'a member has no "osoba bez konta" marker');

  const person = personPillHtml({ name: 'Jan', categoryId: 'thing', categoryLabel: 'Thing', accountless: true });
  assert.match(person, /person-pill-icon/);
  assert.match(person, /role="img"/);
  assert.match(person, /aria-label="osoba bez konta"/);
  assert.doesNotMatch(person, /aria-hidden/, 'the marker is meaningful, not decorative');
  // KRKG-0089: the marker uses the add-companion child figure, not the profile-open person icon.
  assert.match(person, /M9\.2 22l2\.8-7/);
  assert.doesNotMatch(person, /M20 21v-2a4 4 0 0 0-4-4H8/);
});

test('personPillHtml escapes the name and appends an extra class without duplicating class=', () => {
  const { personPillHtml } = loadHelper();
  const html = personPillHtml({ name: '<b>Ala</b>', categoryId: null, categoryLabel: null, accountless: false, extraClass: 'lw-summary-chip' });
  assert.match(html, /&lt;b&gt;Ala&lt;\/b&gt;/);
  assert.match(html, /class="lw-summary-chip category-name-pill"/);
  assert.match(html, /title="Brak statusu"/);
});

test('the event page renders pills through the shared helper, keys rows by personId and fetches the historical roster', () => {
  assert.match(wyjazdSource, /personPillHtml\(/);
  assert.doesNotMatch(wyjazdSource, /categoryNamePillAttrs/);
  assert.match(wyjazdSource, /class="lw-attend-toggle" data-person-id=/);
  assert.match(wyjazdSource, /data-person-id="\$\{personIdAttr\}"/);
  assert.match(wyjazdSource, /\/lista-wyjazdowa\/roster\?eventId=/);
  assert.match(indexHtml, /shared\/person-pill\.js/);
});
