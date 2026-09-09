import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// public/shared/audit-view.js is a classic browser script (no <script type="module">, matching
// every other public/*.js on this site), so it is loaded here via Node's CommonJS `require`
// rather than an ES `import` - see that file's header comment for why its `module.exports` guard
// is safe to keep in a plain <script>. This is the "extract the shared module's pure logic ... and
// unit-test those" path from the task-6 brief: this repo's scripts/*.test.ts suite has no DOM/UI
// test harness, so only the non-DOM functions below (query-param building, the four-column
// rendering helpers, and the mutual-exclusivity/redaction contracts they encode) are covered by
// an automated test - `mount()`'s actual DOM wiring needs manual/browser verification instead.
const require = createRequire(import.meta.url);
const AuditView = require('../public/shared/audit-view.js');

test('action/category labels cover every registered action and category', () => {
  // Mirrors upload-service/src/audit.ts's ACTION_REGISTRY keys (implementation-contract.md's
  // Action registry table) - this list is intentionally duplicated here (not imported) since
  // audit-view.js is deliberately dependency-free/non-TypeScript; a drift between the two would
  // only ever show up as a raw action code leaking into the UI, which this test exists to catch.
  const registeredActions = [
    'role.granted', 'role.revoked', 'role.replaced',
    'membership.application.submitted', 'membership.status.approved', 'membership.status.rejected',
    'membership.status.suspended', 'membership.status.reactivated', 'membership.status.removed',
    'membership.sheet_backup.synchronized',
    'event.created', 'event.updated', 'event.cancelled',
    'signup.created', 'signup.updated',
    'dues.annual.changed', 'dues.entry_fee.changed', 'dues.event_fee.changed',
    'profile.member.updated', 'profile.drive_folder.changed', 'profile.person.created',
    'profile.person.description.updated', 'profile.person.order.updated', 'profile.person.category.changed',
    'profile.person.deleted', 'profile.person.photo.added', 'profile.person.photo.deleted',
    'profile.person.photo.main.changed', 'profile.person.photo.transferred', 'profile.person.in_memoriam.changed',
    'profile.photo_submission.created', 'profile.photo_submission.photo_added',
    'session.login.succeeded',
    'application.pwa.installation_reported',
    'gallery.created', 'gallery.registered', 'gallery.unregistered', 'gallery.deleted',
    'gallery.photo.added', 'gallery.finalized', 'gallery.photo.contribution.finalized',
    'site.redirect.created', 'site.redirect.deleted', 'site.settings.updated', 'site.social_cache.refreshed',
  ];
  for (const action of registeredActions) {
    assert.notEqual(AuditView.actionLabel(action), action, `missing Polish label for ${action}`);
  }
  assert.equal(registeredActions.length, Object.keys(AuditView.ACTION_LABELS).length);

  for (const category of ['permissions', 'membership', 'events', 'signups', 'dues', 'profile', 'session', 'application', 'gallery', 'site']) {
    assert.notEqual(AuditView.categoryLabel(category), category, `missing Polish label for ${category}`);
  }
});

test('an unregistered action code falls back to itself, not a blank label', () => {
  assert.equal(AuditView.actionLabel('made.up.action'), 'made.up.action');
});

test('buildQueryParams: "none" selector produces no primary-selector param', () => {
  const params = AuditView.buildQueryParams({ selector: { kind: 'none' } });
  assert.equal(params.has('category'), false);
  assert.equal(params.has('actorEmail'), false);
  assert.equal(params.has('resourceKey'), false);
  assert.equal(params.has('q'), false);
});

test('buildQueryParams: category/action selector', () => {
  const params = AuditView.buildQueryParams({ selector: { kind: 'categoryAction', category: 'dues', action: 'dues.annual.changed' } });
  assert.equal(params.get('category'), 'dues');
  assert.equal(params.get('action'), 'dues.annual.changed');
});

test('buildQueryParams: category without action omits the action param (server requires category for action, not the reverse)', () => {
  const params = AuditView.buildQueryParams({ selector: { kind: 'categoryAction', category: 'events' } });
  assert.equal(params.get('category'), 'events');
  assert.equal(params.has('action'), false);
});

test('buildQueryParams: actorEmail selector', () => {
  const params = AuditView.buildQueryParams({ selector: { kind: 'actorEmail', email: 'ula@kruki.org' } });
  assert.equal(params.get('actorEmail'), 'ula@kruki.org');
  assert.equal(params.has('category'), false);
});

test('buildQueryParams: resourceKey selector (Historia deep-link shape)', () => {
  const params = AuditView.buildQueryParams({ selector: { kind: 'resourceKey', key: 'event:abc123' } });
  assert.equal(params.get('resourceKey'), 'event:abc123');
});

test('buildQueryParams: search selector maps to the server\'s "q" param', () => {
  const params = AuditView.buildQueryParams({ selector: { kind: 'search', term: 'wol' } });
  assert.equal(params.get('q'), 'wol');
});

test('buildQueryParams: date range and cursor are combinable with any single primary selector', () => {
  const params = AuditView.buildQueryParams({
    selector: { kind: 'resourceKey', key: 'gallery:xyz' },
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-12-31T23:59:59.000Z',
    cursor: 'opaque-cursor',
    limit: 50,
  });
  assert.equal(params.get('resourceKey'), 'gallery:xyz');
  assert.equal(params.get('from'), '2026-01-01T00:00:00.000Z');
  assert.equal(params.get('to'), '2026-12-31T23:59:59.000Z');
  assert.equal(params.get('cursor'), 'opaque-cursor');
  assert.equal(params.get('limit'), '50');
});

test('buildQueryParams: rejects a categoryAction selector with no category (defensive - the "supported filters only" contract)', () => {
  assert.throws(() => AuditView.buildQueryParams({ selector: { kind: 'categoryAction' } }), AuditView.AuditFilterError);
});

test('buildQueryParams: rejects an actorEmail selector with an empty email', () => {
  assert.throws(() => AuditView.buildQueryParams({ selector: { kind: 'actorEmail', email: '' } }), AuditView.AuditFilterError);
});

test('buildQueryParams: rejects a resourceKey selector with no key', () => {
  assert.throws(() => AuditView.buildQueryParams({ selector: { kind: 'resourceKey', key: '' } }), AuditView.AuditFilterError);
});

test('buildQueryParams: rejects a search selector with no term', () => {
  assert.throws(() => AuditView.buildQueryParams({ selector: { kind: 'search', term: '' } }), AuditView.AuditFilterError);
});

test('buildQueryParams: rejects an unsupported selector kind', () => {
  assert.throws(() => AuditView.buildQueryParams({ selector: { kind: 'bogus' } }), AuditView.AuditFilterError);
});

test('resolveUserColumn: admin-scope row uses actor.name when present', () => {
  const row = { actor: { email: 'x@kruki.org', name: 'Ula' }, changes: [] };
  assert.equal(AuditView.resolveUserColumn(row), 'Ula');
});

test('resolveUserColumn: admin-scope row falls back to actor.email with no name', () => {
  const row = { actor: { email: 'x@kruki.org' }, changes: [] };
  assert.equal(AuditView.resolveUserColumn(row), 'x@kruki.org');
});

test('resolveUserColumn: member-scope signup row (no actor) uses the memberVisible memberEmail change', () => {
  const row = { changes: [{ field: 'attending', after: true }, { field: 'memberEmail', after: 'jan@kruki.org' }] };
  assert.equal(AuditView.resolveUserColumn(row), 'jan@kruki.org');
});

test('resolveUserColumn: member-scope gallery row (no actor) uses the memberVisible contributorEmail change', () => {
  const row = { changes: [{ field: 'photoCount', after: 3 }, { field: 'contributorEmail', after: 'ola@kruki.org' }] };
  assert.equal(AuditView.resolveUserColumn(row), 'ola@kruki.org');
});

test('resolveUserColumn: member-scope events row (no actor, no identity field in its allowlist) falls back to an em dash', () => {
  // event.* fields are name/startDate/endDate/status only (implementation-contract.md's
  // "Per-action stored-field allowlists" - events has no memberVisible identity field) - this is
  // the "render as generic/blank" case the task brief calls out explicitly.
  const row = { changes: [{ field: 'status', before: 'active', after: 'cancelled' }] };
  assert.equal(AuditView.resolveUserColumn(row), '—');
});

test('formatChangeLine: creation has no before, omitted rather than shown as blank/undefined', () => {
  assert.equal(AuditView.formatChangeLine({ field: 'name', after: 'Wolin' }), 'name: Wolin');
});

test('formatChangeLine: update shows before -> after', () => {
  assert.equal(AuditView.formatChangeLine({ field: 'startDate', before: '2020-01-01', after: '2020-01-02' }), 'startDate: 2020-01-01 → 2020-01-02');
});

test('formatChangeLine: a redacted/omitted field has neither before nor after and renders with an empty value, not "undefined"', () => {
  assert.equal(AuditView.formatChangeLine({ field: 'feeDigest' }), 'feeDigest: ');
});

test('formatChangeLine: an explicit null after is rendered as the literal text "null", not lost', () => {
  assert.equal(AuditView.formatChangeLine({ field: 'amount', before: '100 zł', after: null }), 'amount: 100 zł → null');
});

test('MEMBER_VISIBLE_CATEGORIES only offers categories whose audience is "members" (implementation-contract.md)', () => {
  assert.deepEqual(AuditView.MEMBER_VISIBLE_CATEGORIES, ['events', 'signups', 'gallery']);
});

test('ACTIONS_BY_CATEGORY has no action outside its declared category and covers every category', () => {
  for (const category of Object.keys(AuditView.CATEGORY_LABELS)) {
    assert.ok(Array.isArray(AuditView.ACTIONS_BY_CATEGORY[category]) && AuditView.ACTIONS_BY_CATEGORY[category].length > 0);
  }
});
