import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueForm, validateAlbumUrl, validateAlbumDate, isDuplicate } from './album-issue-utils.ts';

describe('parseIssueForm', () => {
  it('extracts url, name, and date when all are given', () => {
    const body = [
      '### Link do albumu (Google Photos lub Google Drive)',
      '',
      'https://photos.app.goo.gl/XYZ',
      '',
      '### Własna nazwa (opcjonalnie)',
      '',
      'Wolin',
      '',
      '### Data',
      '',
      '2024-08-03',
      '',
    ].join('\n');
    assert.deepEqual(parseIssueForm(body), { url: 'https://photos.app.goo.gl/XYZ', name: 'Wolin', date: '2024-08-03' });
  });

  it('returns null name when the optional field is unanswered', () => {
    const body = [
      '### Link do albumu (Google Photos lub Google Drive)',
      '',
      'https://photos.app.goo.gl/XYZ',
      '',
      '### Własna nazwa (opcjonalnie)',
      '',
      '_No response_',
      '',
      '### Data',
      '',
      '2024-08-03',
      '',
    ].join('\n');
    assert.deepEqual(parseIssueForm(body), { url: 'https://photos.app.goo.gl/XYZ', name: null, date: '2024-08-03' });
  });

  it('returns all null when the body has no matching sections', () => {
    assert.deepEqual(parseIssueForm('random text'), { url: null, name: null, date: null });
  });

  it('trims surrounding whitespace from extracted values', () => {
    const body = [
      '### Link do albumu (Google Photos lub Google Drive)',
      '',
      '  https://photos.app.goo.gl/XYZ  ',
      '',
      '### Własna nazwa (opcjonalnie)',
      '',
      '_No response_',
      '',
      '### Data',
      '',
      '  2024-08-03  ',
      '',
    ].join('\n');
    const result = parseIssueForm(body);
    assert.equal(result.url, 'https://photos.app.goo.gl/XYZ');
    assert.equal(result.date, '2024-08-03');
  });
});

describe('validateAlbumUrl', () => {
  it('accepts a photos.app.goo.gl short link', () => {
    assert.equal(validateAlbumUrl('https://photos.app.goo.gl/XYZ'), null);
  });

  it('accepts a photos.google.com/share link', () => {
    assert.equal(validateAlbumUrl('https://photos.google.com/share/AF1QipXYZ?key=abc'), null);
  });

  it('accepts a Google Drive folder link', () => {
    assert.equal(validateAlbumUrl('https://drive.google.com/drive/folders/1kZewclHqNiTA7Tf47cVRzMm8ZN99kGmY?usp=sharing'), null);
  });

  it('rejects a null url', () => {
    assert.equal(validateAlbumUrl(null), 'Nie podano linku do albumu.');
  });

  it('rejects an unrelated url', () => {
    assert.match(validateAlbumUrl('https://example.com/foo')!, /nie wygląda na udostępniony album/);
  });
});

describe('validateAlbumDate', () => {
  it('accepts a well-formed date', () => {
    assert.equal(validateAlbumDate('2024-08-03'), null);
  });

  it('rejects a null date', () => {
    assert.match(validateAlbumDate(null)!, /nie podano daty/i);
  });

  it('rejects a date with the wrong separator', () => {
    assert.match(validateAlbumDate('2024.08.03')!, /RRRR-MM-DD/);
  });

  it('rejects an impossible month', () => {
    assert.match(validateAlbumDate('2024-13-01')!, /RRRR-MM-DD/);
  });

  it('rejects an impossible day', () => {
    assert.match(validateAlbumDate('2024-02-30')!, /RRRR-MM-DD/);
  });
});

describe('isDuplicate', () => {
  it('detects an existing url', () => {
    const albumsJson = '[{"url":"https://photos.app.goo.gl/XYZ","nameOverride":"Wolin"}]';
    assert.equal(isDuplicate('https://photos.app.goo.gl/XYZ', albumsJson), true);
  });

  it('returns false for a new url', () => {
    const albumsJson = '[{"url":"https://photos.app.goo.gl/XYZ","nameOverride":"Wolin"}]';
    assert.equal(isDuplicate('https://photos.app.goo.gl/ABC', albumsJson), false);
  });
});
