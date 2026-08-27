import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePersonFolderName,
  buildPersonFolderName,
  sortPeopleByFolderName,
  computeOrderForDepartmentMove,
  bootstrapAboutUsStructure,
  resetAboutUsBootstrapForTests,
} from './about-us.ts';
import type { DriveClient } from './drive.ts';

// Records every ensureFolder(parentFolderId, name) call and every setFolderPublic(folderId)
// call, assigning each distinct (parentFolderId, name) pair its own fake id - enough to trace
// the actual parent/child shape bootstrapAboutUsStructure builds, which the fake DriveClient
// used elsewhere (server.test.ts's makeFakeDrive, returning a single constant id regardless of
// arguments) is not detailed enough to verify.
function makeTracingDrive() {
  const ensureFolderCalls: { parentFolderId: string; name: string }[] = [];
  const publicFolderIds: string[] = [];
  const idsByCall = new Map<string, string>();
  let nextId = 0;

  const drive: Pick<DriveClient, 'ensureFolder' | 'setFolderPublic'> = {
    async ensureFolder(parentFolderId, name) {
      ensureFolderCalls.push({ parentFolderId, name });
      const key = `${parentFolderId}::${name}`;
      let id = idsByCall.get(key);
      if (!id) {
        nextId += 1;
        id = `folder-${nextId}`;
        idsByCall.set(key, id);
      }
      return id;
    },
    async setFolderPublic(folderId) {
      publicFolderIds.push(folderId);
    },
  };

  return { drive: drive as DriveClient, ensureFolderCalls, publicFolderIds };
}

test('bootstrapAboutUsStructure creates upload/deleted under a private root, never under the public "O Nas" folder', async () => {
  resetAboutUsBootstrapForTests();
  const { drive, ensureFolderCalls, publicFolderIds } = makeTracingDrive();

  const folders = await bootstrapAboutUsStructure(drive);

  // Exactly one folder is ever made public, and it's "O Nas" (folders.root) - not the private
  // root, not upload/deleted, not "Strona".
  assert.deepEqual(publicFolderIds, [folders.root]);

  const uploadCall = ensureFolderCalls.find(c => c.name === 'upload');
  const deletedCall = ensureFolderCalls.find(c => c.name === 'deleted');
  assert.ok(uploadCall && deletedCall, 'expected ensureFolder calls creating "upload" and "deleted"');

  // The critical assertion (KRKG-0029): upload/deleted's parent must not be "O Nas" itself, and
  // must not be "O Nas" nested any deeper - it must sit outside the public folder's own subtree.
  assert.notEqual(uploadCall!.parentFolderId, folders.root);
  assert.notEqual(deletedCall!.parentFolderId, folders.root);

  // Both share one private-root parent, and that parent is a sibling of "O Nas" (same
  // grandparent - "Strona" - not a descendant of "O Nas").
  assert.equal(uploadCall!.parentFolderId, deletedCall!.parentFolderId);
  const oNasCall = ensureFolderCalls.find(c => c.name === 'O Nas');
  const privateRootCall = ensureFolderCalls.find(c => c.name !== 'O Nas' && c.parentFolderId === oNasCall!.parentFolderId && c.name !== 'Strona');
  assert.ok(privateRootCall, 'expected the private root to be created as a sibling of "O Nas"');
});

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
