import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RELEASE_INFO_PLACEHOLDER,
  formatReleaseMetadata,
  renderReleaseInfo,
} from './release-info.ts';

test('formats deterministic release metadata in Polish', () => {
  const metadata = formatReleaseMetadata({
    buildTimestamp: new Date('2026-09-06T14:23:00.000Z'),
    runNumber: 123,
    commitSha: '0123456789abcdef0123456789abcdef01234567',
  });

  assert.deepEqual(metadata, {
    version: '2026.09.06.123',
    shortSha: '0123456',
    publishedAt: '06.09.2026, 14:23 UTC',
    text: 'wersja 2026.09.06.123 · commit 0123456 · opublikowano 06.09.2026, 14:23 UTC',
  });
});

test('renders release metadata into the stable placeholder', () => {
  const metadata = formatReleaseMetadata({
    buildTimestamp: new Date('2026-09-06T14:23:00.000Z'),
    runNumber: 123,
    commitSha: '0123456789abcdef0123456789abcdef01234567',
  });

  assert.equal(
    renderReleaseInfo(`<p>${RELEASE_INFO_PLACEHOLDER}</p>`, metadata),
    '<p>wersja 2026.09.06.123 · commit 0123456 · opublikowano 06.09.2026, 14:23 UTC</p>',
  );
});

test('rejects a commit SHA containing non-hexadecimal characters', () => {
  assert.throws(() =>
    formatReleaseMetadata({
      buildTimestamp: new Date('2026-09-06T14:23:00.000Z'),
      runNumber: 123,
      commitSha: '0123456<script>',
    }),
  );
});
