import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, extractTitle, makeSearchText, displayTitle, parseAlbumsJson, extractPhotoCount, extractThumbEntries, extractDriveFolderId } from './utils.ts';

describe('parseDate', () => {
  // --- prefix, hyphens ---
  it('parses YYYY-MM-DD prefix', () => {
    assert.equal(parseDate('2024-08-03 Wolin'), '2024-08-03');
  });
  it('parses YYYY-MM prefix (month only)', () => {
    assert.equal(parseDate('2010-05 Dziesięciolecie'), '2010-05');
  });
  it('parses YYYY-MM with no trailing text', () => {
    assert.equal(parseDate('2010-05'), '2010-05');
  });

  // --- prefix, dots ---
  it('parses YYYY.MM.DD prefix', () => {
    assert.equal(parseDate('2024.08.03 Wolin'), '2024-08-03');
  });
  it('parses YYYY.MM.DD with Polish name', () => {
    assert.equal(parseDate('2014.06.21 Poznań Kupała'), '2014-06-21');
  });
  it('parses YYYY.MM prefix (month only, dots)', () => {
    assert.equal(parseDate('2010.05 Dziesięciolecie'), '2010-05');
  });

  // --- prefix, slashes ---
  it('parses YYYY/MM/DD prefix', () => {
    assert.equal(parseDate('2024/08/03 Wolin'), '2024-08-03');
  });
  it('parses YYYY/MM prefix (month only, slashes)', () => {
    assert.equal(parseDate('2025/05 Radzim'), '2025-05');
  });

  // --- date at end (the Radzim 2025.05 case) ---
  it('parses YYYY.MM at end of title', () => {
    assert.equal(parseDate('Radzim 2025.05'), '2025-05');
  });
  it('parses YYYY-MM-DD at end of title', () => {
    assert.equal(parseDate('Radzim 2025-05-23'), '2025-05-23');
  });
  it('parses YYYY-MM in middle of title', () => {
    assert.equal(parseDate('Wolin 2024-08 letni obóz'), '2024-08');
  });

  // --- day ranges YYYY-MM-DD-DD ---
  it('parses start date from a day-range prefix YYYY-MM-DD-DD', () => {
    assert.equal(parseDate('2021-01-23-25 Wolin'), '2021-01-23');
  });
  it('parses start date from a day-range with no trailing text', () => {
    assert.equal(parseDate('2021-01-23-25'), '2021-01-23');
  });

  // --- day ranges DD-DD.MM.YYYY ---
  it('parses start date from a DD-DD.MM.YYYY day-range suffix', () => {
    assert.equal(parseDate('Noc Kupały Szczecin 12-14.06.2026'), '2026-06-12');
  });
  it('parses start date from a DD-DD.MM.YYYY day-range with no surrounding text', () => {
    assert.equal(parseDate('12-14.06.2026'), '2026-06-12');
  });

  // --- full date preferred over month-only ---
  it('prefers full date over month-only when both could match', () => {
    assert.equal(parseDate('2024-08-03 Wolin'), '2024-08-03');
  });

  // --- no date ---
  it('returns null for year only', () => {
    assert.equal(parseDate('Wolin 2024'), null);
  });
  it('returns null for title with no date at all', () => {
    assert.equal(parseDate('Album bez tytułu'), null);
  });
  it('returns null for empty string', () => {
    assert.equal(parseDate(''), null);
  });
});

describe('extractTitle', () => {
  it('strips og:title date+emoji suffix', () => {
    const html = '<meta property="og:title" content="2024-08-03 Wolin · Saturday, Aug 3, 2024 📸">';
    assert.equal(extractTitle(html), '2024-08-03 Wolin');
  });

  it('strips "- Google Photos" from page title', () => {
    const html = '<title>2024-08-03 Wolin - Google Photos</title>';
    assert.equal(extractTitle(html), '2024-08-03 Wolin');
  });

  it('prefers og:title over page title', () => {
    const html = '<meta property="og:title" content="OG Title · suffix"><title>Page Title - Google Photos</title>';
    assert.equal(extractTitle(html), 'OG Title');
  });

  it('returns null when no title found', () => {
    assert.equal(extractTitle('<html><body></body></html>'), null);
  });
});

describe('displayTitle', () => {
  // --- date at prefix ---
  it('strips YYYY-MM-DD prefix', () => {
    assert.equal(displayTitle('2024-08-03 Wolin'), 'Wolin');
  });
  it('strips YYYY.MM.DD prefix', () => {
    assert.equal(displayTitle('2024.08.03 Wolin'), 'Wolin');
  });
  it('strips YYYY/MM/DD prefix', () => {
    assert.equal(displayTitle('2024/08/03 Wolin'), 'Wolin');
  });
  it('strips YYYY-MM prefix', () => {
    assert.equal(displayTitle('2010-05 Dziesięciolecie'), 'Dziesięciolecie');
  });
  it('strips YYYY.MM prefix', () => {
    assert.equal(displayTitle('2010.05 Dziesięciolecie'), 'Dziesięciolecie');
  });

  // --- date at suffix (the Radzim 2025.05 case) ---
  it('strips YYYY.MM suffix', () => {
    assert.equal(displayTitle('Radzim 2025.05'), 'Radzim');
  });
  it('strips YYYY-MM-DD suffix', () => {
    assert.equal(displayTitle('Radzim 2025-05-23'), 'Radzim');
  });

  // --- day range ---
  it('strips YYYY-MM-DD-DD range prefix leaving only the name', () => {
    assert.equal(displayTitle('2021-01-23-25 Wolin'), 'Wolin');
  });

  it('strips YYYY.MM.DD-DD mixed-separator range (the 2019.08.02-04 Wolin case)', () => {
    assert.equal(displayTitle('2019.08.02-04 Wolin'), 'Wolin');
  });

  it('strips DD-DD.MM.YYYY day-range suffix', () => {
    assert.equal(displayTitle('Noc Kupały Szczecin 12-14.06.2026'), 'Noc Kupały Szczecin');
  });

  it('strips leading non-letter orphan fragments after date removal', () => {
    assert.equal(displayTitle('2019.08.02-04'), '2019.08.02-04'); // no name → return original
  });

  // --- no name left → return original ---
  it('returns original when title is only a date', () => {
    assert.equal(displayTitle('2024-08-03'), '2024-08-03');
  });
  it('returns original when title is only a range date', () => {
    assert.equal(displayTitle('2021-01-23-25'), '2021-01-23-25');
  });

  // --- no date ---
  it('returns original title when no date', () => {
    assert.equal(displayTitle('Album bez tytułu'), 'Album bez tytułu');
  });
});

describe('parseAlbumsJson', () => {
  it('parses a plain entry', () => {
    const result = parseAlbumsJson('[{"url":"https://photos.app.goo.gl/abc"}]');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: undefined, dateOverride: undefined, hiddenComment: undefined }]);
  });

  it('preserves nameOverride, dateOverride, and hiddenComment', () => {
    const result = parseAlbumsJson('[{"url":"https://photos.app.goo.gl/abc","nameOverride":"Wolin","dateOverride":"2024-08-03","hiddenComment":"note"}]');
    assert.deepEqual(result, [{
      url: 'https://photos.app.goo.gl/abc',
      nameOverride: 'Wolin',
      dateOverride: '2024-08-03',
      hiddenComment: 'note',
    }]);
  });

  it('drops an entry with no url', () => {
    const result = parseAlbumsJson('[{"nameOverride":"Wolin"}]');
    assert.equal(result.length, 0);
  });

  it('deduplicates by url, keeping the first occurrence', () => {
    const result = parseAlbumsJson('[{"url":"https://photos.app.goo.gl/abc","nameOverride":"First"},{"url":"https://photos.app.goo.gl/abc","nameOverride":"Second"}]');
    assert.equal(result.length, 1);
    assert.equal(result[0].nameOverride, 'First');
  });

  it('throws for invalid JSON syntax', () => {
    assert.throws(() => parseAlbumsJson('not json'));
  });

  it('throws when the top level is not an array', () => {
    assert.throws(() => parseAlbumsJson('{"url":"https://photos.app.goo.gl/abc"}'));
  });
});

describe('extractPhotoCount', () => {
  it('counts unique photo IDs with lh3 URLs', () => {
    const html = [
      '["AF1Qip111",["https://lh3.googleusercontent.com/a",1024,680]]',
      '["AF1Qip222",["https://lh3.googleusercontent.com/b",1024,680]]',
      '["AF1Qip333",["https://lh3.googleusercontent.com/c",1024,680]]',
    ].join('\n');
    assert.equal(extractPhotoCount(html), 3);
  });

  it('deduplicates the same photo ID appearing twice', () => {
    const html = [
      '["AF1Qip111",["https://lh3.googleusercontent.com/a",1024,680]]',
      '["AF1Qip111",["https://lh3.googleusercontent.com/a",1024,680]]',
    ].join('\n');
    assert.equal(extractPhotoCount(html), 1);
  });

  it('returns null when no photo IDs are present', () => {
    assert.equal(extractPhotoCount('<html><head></head><body></body></html>'), null);
  });
});

describe('extractThumbEntries', () => {
  it('returns id+URL pairs with the size suffix appended, in page order', () => {
    const html = [
      '["AF1Qip111",["https://lh3.googleusercontent.com/a",1024,680]]',
      '["AF1Qip222",["https://lh3.googleusercontent.com/b",1024,680]]',
    ].join('\n');
    assert.deepEqual(extractThumbEntries(html), [
      { id: 'AF1Qip111', url: 'https://lh3.googleusercontent.com/a=w220-h220-c' },
      { id: 'AF1Qip222', url: 'https://lh3.googleusercontent.com/b=w220-h220-c' },
    ]);
  });

  it('deduplicates the same photo ID appearing twice', () => {
    const html = [
      '["AF1Qip111",["https://lh3.googleusercontent.com/a",1024,680]]',
      '["AF1Qip111",["https://lh3.googleusercontent.com/a",1024,680]]',
    ].join('\n');
    assert.deepEqual(extractThumbEntries(html), [
      { id: 'AF1Qip111', url: 'https://lh3.googleusercontent.com/a=w220-h220-c' },
    ]);
  });

  it('caps results at the given limit', () => {
    const html = Array.from({ length: 20 }, (_, i) =>
      `["AF1Qip${i}",["https://lh3.googleusercontent.com/${i}",1024,680]]`
    ).join('\n');
    assert.equal(extractThumbEntries(html, 5).length, 5);
  });

  it('defaults to a limit of 24', () => {
    const html = Array.from({ length: 30 }, (_, i) =>
      `["AF1Qip${i}",["https://lh3.googleusercontent.com/${i}",1024,680]]`
    ).join('\n');
    assert.equal(extractThumbEntries(html).length, 24);
  });

  it('returns an empty array when no photo IDs are present', () => {
    assert.deepEqual(extractThumbEntries('<html><head></head><body></body></html>'), []);
  });
});

describe('extractDriveFolderId', () => {
  it('extracts the folder id from a plain folder link', () => {
    assert.equal(extractDriveFolderId('https://drive.google.com/drive/folders/1kZewclHqNiTA7Tf47cVRzMm8ZN99kGmY'), '1kZewclHqNiTA7Tf47cVRzMm8ZN99kGmY');
  });

  it('extracts the folder id when the link has a query string', () => {
    assert.equal(extractDriveFolderId('https://drive.google.com/drive/folders/1kZewclHqNiTA7Tf47cVRzMm8ZN99kGmY?usp=sharing'), '1kZewclHqNiTA7Tf47cVRzMm8ZN99kGmY');
  });

  it('returns null for a Google Photos link', () => {
    assert.equal(extractDriveFolderId('https://photos.app.goo.gl/XYZ'), null);
  });

  it('returns null for an unrelated url', () => {
    assert.equal(extractDriveFolderId('https://example.com/foo'), null);
  });
});

describe('makeSearchText', () => {
  it('lowercases the title', () => {
    assert.equal(makeSearchText('Wolin Walki'), 'wolin walki');
  });

  it('replaces en-dash with hyphen', () => {
    assert.equal(makeSearchText('Wolin – Walki'), 'wolin - walki');
  });

  it('replaces em-dash with hyphen', () => {
    assert.equal(makeSearchText('Wolin — Walki'), 'wolin - walki');
  });
});
