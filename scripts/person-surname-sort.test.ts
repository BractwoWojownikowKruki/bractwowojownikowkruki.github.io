import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/display-name.js', import.meta.url), 'utf8');
const context: Record<string, unknown> = {};
vm.runInNewContext(`${source}\nglobalThis.__surnameSortValue = typeof surnameSortValue === 'function' ? surnameSortValue : null;`, context);
const surnameSortValue = context.__surnameSortValue as ((person: Record<string, string | null>) => string) | null;

test('sorts people by surname and falls back to their display name when surname is missing', () => {
  assert.equal(typeof surnameSortValue, 'function', 'shared surname sort helper exists');
  if (!surnameSortValue) return;
  assert.equal(surnameSortValue({ lastName: '  Żuraw  ', firstName: 'Ala', nickname: 'A' }), 'Żuraw');
  assert.equal(surnameSortValue({ lastName: ' ', firstName: 'Ala', nickname: 'A' }), 'A');
  assert.equal(surnameSortValue({ lastName: null, firstName: null, nickname: null, email: 'jan@example.com' }), 'jan');
});

test("wiring guard: every person table uses the shared surname key", () => {
  const files = [
    '../public/lista-wyjazdowa/skladki/skladki.js',
    '../public/lista-wyjazdowa/wyjazd/wyjazd.js',
    '../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js',
    '../public/czlonkowie/czlonkowie.js',
    '../public/sprzet-obozowy/sprzet-obozowy.js',
  ];
  for (const file of files) {
    const pageSource = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(pageSource, /surnameSortValue\(/, `${file} must use surnameSortValue for a person-name sort`);
  }
});
