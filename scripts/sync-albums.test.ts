import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, extractTitle, makeSearchText, displayTitle, parseAlbumsTxt, extractPhotoCount } from './utils.ts';

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

describe('parseAlbumsTxt', () => {
  it('parses a plain URL line', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: undefined }]);
  });

  it('parses a URL with name override', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc | 2024-08-03 Wolin');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: '2024-08-03 Wolin' }]);
  });

  it('skips comment lines', () => {
    const result = parseAlbumsTxt('# comment\nhttps://photos.app.goo.gl/abc');
    assert.equal(result.length, 1);
  });

  it('skips blank lines', () => {
    const result = parseAlbumsTxt('\nhttps://photos.app.goo.gl/abc\n\n');
    assert.equal(result.length, 1);
  });

  it('deduplicates URLs', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc\nhttps://photos.app.goo.gl/abc');
    assert.equal(result.length, 1);
  });

  it('trims whitespace around url and name', () => {
    const result = parseAlbumsTxt('  https://photos.app.goo.gl/abc  |  2024-08-03 Wolin  ');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: '2024-08-03 Wolin' }]);
  });

  it('ignores a comment after "||" with no name override', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc || not synced, ask Jan');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: undefined }]);
  });

  it('ignores a comment after "||" following a name override', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc | 2024-08-03 Wolin || not synced yet');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: '2024-08-03 Wolin' }]);
  });

  it('ignores comment content even if it contains a single pipe', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc | 2024-08-03 Wolin || rejected | needs a re-share');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: '2024-08-03 Wolin' }]);
  });

  it('a single pipe still separates url and name (not treated as a comment)', () => {
    const result = parseAlbumsTxt('https://photos.app.goo.gl/abc | 2024-08-03 Wolin');
    assert.deepEqual(result, [{ url: 'https://photos.app.goo.gl/abc', nameOverride: '2024-08-03 Wolin' }]);
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
