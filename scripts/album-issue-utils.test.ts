import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueForm, validateAlbumUrl, validateAlbumName, isDuplicate } from './album-issue-utils.ts';

describe('parseIssueForm', () => {
  it('extracts url and name when both are given', () => {
    const body = [
      '### Link do albumu Google Photos',
      '',
      'https://photos.app.goo.gl/XYZ',
      '',
      '### Własna nazwa (opcjonalnie)',
      '',
      '2024-08-03 Wolin',
      '',
    ].join('\n');
    assert.deepEqual(parseIssueForm(body), { url: 'https://photos.app.goo.gl/XYZ', name: '2024-08-03 Wolin' });
  });

  it('returns null name when the optional field is unanswered', () => {
    const body = [
      '### Link do albumu Google Photos',
      '',
      'https://photos.app.goo.gl/XYZ',
      '',
      '### Własna nazwa (opcjonalnie)',
      '',
      '_No response_',
      '',
    ].join('\n');
    assert.deepEqual(parseIssueForm(body), { url: 'https://photos.app.goo.gl/XYZ', name: null });
  });

  it('returns null url when the body has no matching section', () => {
    assert.deepEqual(parseIssueForm('random text'), { url: null, name: null });
  });

  it('trims surrounding whitespace from extracted values', () => {
    const body = [
      '### Link do albumu Google Photos',
      '',
      '  https://photos.app.goo.gl/XYZ  ',
      '',
      '### Własna nazwa (opcjonalnie)',
      '',
      '_No response_',
      '',
    ].join('\n');
    assert.equal(parseIssueForm(body).url, 'https://photos.app.goo.gl/XYZ');
  });
});

describe('validateAlbumUrl', () => {
  it('accepts a photos.app.goo.gl short link', () => {
    assert.equal(validateAlbumUrl('https://photos.app.goo.gl/XYZ'), null);
  });

  it('accepts a photos.google.com/share link', () => {
    assert.equal(validateAlbumUrl('https://photos.google.com/share/AF1QipXYZ?key=abc'), null);
  });

  it('rejects a null url', () => {
    assert.equal(validateAlbumUrl(null), 'Nie podano linku do albumu.');
  });

  it('rejects an unrelated url', () => {
    assert.match(validateAlbumUrl('https://example.com/foo')!, /nie wygląda na udostępniony album/);
  });
});

describe('validateAlbumName', () => {
  it('accepts a null name (optional field)', () => {
    assert.equal(validateAlbumName(null), null);
  });

  it('rejects a name starting with "#"', () => {
    assert.match(validateAlbumName('#hashtag album')!, /nie może zaczynać się od "#"/);
  });

  it('rejects a name containing "|"', () => {
    assert.match(validateAlbumName('2024-08-03 | Wolin')!, /nie może zawierać znaku "\|"/);
  });

  it('accepts a normal name', () => {
    assert.equal(validateAlbumName('2024-08-03 Wolin'), null);
  });
});

describe('isDuplicate', () => {
  it('detects an existing url', () => {
    const albumsTxt = 'https://photos.app.goo.gl/XYZ | 2024-08-03 Wolin\n';
    assert.equal(isDuplicate('https://photos.app.goo.gl/XYZ', albumsTxt), true);
  });

  it('returns false for a new url', () => {
    const albumsTxt = 'https://photos.app.goo.gl/XYZ | 2024-08-03 Wolin\n';
    assert.equal(isDuplicate('https://photos.app.goo.gl/ABC', albumsTxt), false);
  });
});
