import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePersonFolderName,
  buildPersonFolderName,
  sortPeopleByFolderName,
  computeOrderForDepartmentMove,
} from './about-us.ts';

test('parsePersonFolderName extracts a leading "N. " order prefix', () => {
  assert.deepEqual(parsePersonFolderName('1. Ragnar'), { order: 1, name: 'Ragnar' });
});

test('parsePersonFolderName handles multi-digit order and extra whitespace', () => {
  assert.deepEqual(parsePersonFolderName('12.   Anna Nowak'), { order: 12, name: 'Anna Nowak' });
});

test('parsePersonFolderName treats a name with no leading number as unordered', () => {
  assert.deepEqual(parsePersonFolderName('Jan Kowalski'), { order: null, name: 'Jan Kowalski' });
});

// Regression: repeatedly prepending to Emeryci (computeOrderForDepartmentMove's lowest - 1)
// eventually produces a negative order - a pattern that didn't accept "-" treated the whole
// "-1. Ragnar" as an unparsed name instead of {order: -1, name: "Ragnar"}, which both showed
// the "-1. " prefix in the displayed name and sorted the person to the end of the list (as an
// "unnumbered" entry) instead of the top.
test('parsePersonFolderName handles a negative order', () => {
  assert.deepEqual(parsePersonFolderName('-1. Ragnar'), { order: -1, name: 'Ragnar' });
});

test('buildPersonFolderName and parsePersonFolderName round-trip a negative order', () => {
  const folderName = buildPersonFolderName('Ragnar', -2);
  assert.equal(folderName, '-2. Ragnar');
  assert.deepEqual(parsePersonFolderName(folderName), { order: -2, name: 'Ragnar' });
});

test('buildPersonFolderName prefixes the order when given', () => {
  assert.equal(buildPersonFolderName('Ragnar', 1), '1. Ragnar');
});

test('buildPersonFolderName omits the prefix when order is null', () => {
  assert.equal(buildPersonFolderName('Ragnar', null), 'Ragnar');
});

test('sortPeopleByFolderName orders numbered entries ascending, gaps allowed', () => {
  const items = [{ folderName: '9. Marcin' }, { folderName: '1. Ragnar' }, { folderName: '5. Zenek' }];
  const sorted = sortPeopleByFolderName(items).map(i => i.folderName);
  assert.deepEqual(sorted, ['1. Ragnar', '5. Zenek', '9. Marcin']);
});

test('sortPeopleByFolderName places unnumbered entries after all numbered ones, alphabetically', () => {
  const items = [{ folderName: 'Zenon' }, { folderName: '1. Ragnar' }, { folderName: 'Adam' }];
  const sorted = sortPeopleByFolderName(items).map(i => i.folderName);
  assert.deepEqual(sorted, ['1. Ragnar', 'Adam', 'Zenon']);
});

test('sortPeopleByFolderName places a negative-order entry before positive ones (Emeryci prepend)', () => {
  const items = [{ folderName: '1. Anna' }, { folderName: '-1. Ragnar' }, { folderName: '2. Jan' }];
  const sorted = sortPeopleByFolderName(items).map(i => i.folderName);
  assert.deepEqual(sorted, ['-1. Ragnar', '1. Anna', '2. Jan']);
});

test('sortPeopleByFolderName keeps duplicate-order entries together as a group, in either relative order', () => {
  const items = [{ folderName: '2. Piotr' }, { folderName: '1. Ragnar A' }, { folderName: '1. Ragnar B' }, { folderName: '3. Jan' }];
  const sorted = sortPeopleByFolderName(items).map(i => i.folderName);
  const order1Names = ['1. Ragnar A', '1. Ragnar B'];
  assert.deepEqual(sorted.slice(0, 2).sort(), order1Names.sort());
  assert.deepEqual(sorted.slice(2), ['2. Piotr', '3. Jan']);
});

test('computeOrderForDepartmentMove appends after the highest existing order for a normal department', () => {
  assert.equal(computeOrderForDepartmentMove('Blachowi', ['3. Anna', '1. Piotr']), 4);
});

test('computeOrderForDepartmentMove prepends before the lowest existing order for Emeryci', () => {
  assert.equal(computeOrderForDepartmentMove('Emeryci', ['2. Jan', '5. Piotr']), 1);
});

test('computeOrderForDepartmentMove defaults to 1 for an empty normal department', () => {
  assert.equal(computeOrderForDepartmentMove('Kandydaci', []), 1);
});

test('computeOrderForDepartmentMove defaults to 1 for an empty Emeryci department', () => {
  assert.equal(computeOrderForDepartmentMove('Emeryci', []), 1);
});

test('computeOrderForDepartmentMove ignores unnumbered folders when computing the new order', () => {
  assert.equal(computeOrderForDepartmentMove('Niewiasty', ['Zenon', '2. Anna', 'Adam']), 3);
});
