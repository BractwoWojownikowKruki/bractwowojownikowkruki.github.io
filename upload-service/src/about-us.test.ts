import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonFolderName, buildPersonFolderName, sortPeopleByFolderName } from './about-us.ts';

test('parsePersonFolderName extracts a leading "N. " order prefix', () => {
  assert.deepEqual(parsePersonFolderName('1. Ragnar'), { order: 1, name: 'Ragnar' });
});

test('parsePersonFolderName handles multi-digit order and extra whitespace', () => {
  assert.deepEqual(parsePersonFolderName('12.   Anna Nowak'), { order: 12, name: 'Anna Nowak' });
});

test('parsePersonFolderName treats a name with no leading number as unordered', () => {
  assert.deepEqual(parsePersonFolderName('Jan Kowalski'), { order: null, name: 'Jan Kowalski' });
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

test('sortPeopleByFolderName keeps duplicate-order entries together as a group, in either relative order', () => {
  const items = [{ folderName: '2. Piotr' }, { folderName: '1. Ragnar A' }, { folderName: '1. Ragnar B' }, { folderName: '3. Jan' }];
  const sorted = sortPeopleByFolderName(items).map(i => i.folderName);
  const order1Names = ['1. Ragnar A', '1. Ragnar B'];
  assert.deepEqual(sorted.slice(0, 2).sort(), order1Names.sort());
  assert.deepEqual(sorted.slice(2), ['2. Piotr', '3. Jan']);
});
