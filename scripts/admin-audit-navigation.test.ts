import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const memberManagementHtml = readFileSync(
  new URL('../public/admin/zarzadzanie-ludzmi/index.html', import.meta.url),
  'utf8',
);
const memberManagementScript = readFileSync(
  new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url),
  'utf8',
);
const adminAuditHtml = readFileSync(new URL('../public/admin/audyt/index.html', import.meta.url), 'utf8');
const stylesheet = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('member management exposes one unfiltered Historia icon button beside the Członkowie heading', () => {
  const membersSection = memberManagementHtml.match(/<section style="margin-bottom: 2rem;">([\s\S]*?)<\/section>/)?.[1];

  assert.ok(membersSection, 'the Członkowie section should be present');
  assert.match(
    membersSection,
    /<header class="member-management-heading-row">\s*<h2>Członkowie<\/h2>\s*<a class="audyt-history-btn" href="\/admin\/audyt\/" title="Historia" aria-label="Historia">\s*<svg[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*><path d="M3 12a9 9 0 1 0 3-6.7L3 8"\/><path d="M3 3v5h5"\/><path d="M12 7v5l4 2"\/><\/svg>\s*<\/a>\s*<\/header>/,
  );
  assert.equal((membersSection.match(/class="audyt-history-btn"/g) ?? []).length, 1);
  assert.match(stylesheet, /a\.audyt-history-btn\s*\{[^}]*border:\s*1px solid var\(--border\);/);
  assert.match(stylesheet, /\.member-management-heading-row\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
});

test('member table leaves member audit history out of its row template and preserves roles history', () => {
  assert.doesNotMatch(memberManagementScript, /resourceKey=\$\{encodeURIComponent\(`member:/);
  assert.doesNotMatch(memberManagementScript, /member:\$\{m\.email\}/);
  assert.match(memberManagementHtml, /<details id="roles-audit-log-panel"/);
});

test('admin audit shell authorizes through the admin and moderator whoami endpoint', () => {
  assert.match(adminAuditHtml, /whoamiPath:\s*'\/admin\/members\/whoami'/);
  assert.doesNotMatch(adminAuditHtml, /whoamiPath:\s*'\/wojownicy-upload\/whoami'/);
});
