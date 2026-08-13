import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDriveFolderId } from './urls.ts';

test('extractDriveFolderId reads the folder id out of a Drive folder URL', () => {
  assert.equal(extractDriveFolderId('https://drive.google.com/drive/folders/1AbC-2dEf_3'), '1AbC-2dEf_3');
});

test('extractDriveFolderId ignores trailing query params and path segments', () => {
  assert.equal(extractDriveFolderId('https://drive.google.com/drive/folders/1AbC?usp=sharing'), '1AbC');
});

test('extractDriveFolderId returns null for a Google Photos share URL', () => {
  assert.equal(extractDriveFolderId('https://photos.app.goo.gl/AbCdEf123'), null);
});

test('extractDriveFolderId returns null for an unrelated URL', () => {
  assert.equal(extractDriveFolderId('https://example.com/not-drive'), null);
});
