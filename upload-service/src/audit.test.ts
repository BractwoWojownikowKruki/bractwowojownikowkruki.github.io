import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  ACTION_REGISTRY,
  AuditInputError,
  createCanonicalAuditEvent,
  executeAuditedExternalMutation,
  executeAuditedFirestoreMutation,
  formatTechnicalValue,
} from './audit.ts';

test('checked-in Firestore index manifest covers every supported audit primary selector', async () => {
  const manifest = JSON.parse(await readFile(new URL('../firestore.indexes.json', import.meta.url), 'utf8')) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; arrayConfig?: string }> }>;
  };
  // Each entry's own composite (category/action/actor/resource-key/searchTokens + timestamp) is
  // what the query contract requires; a trailing "__name__" tiebreak field (needed so a
  // two-field (timestamp, id) pagination cursor is servable by a real Firestore composite index)
  // is an implementation detail on top, so this checks a prefix rather than the whole field list.
  const auditIndexFields = manifest.indexes
    .filter(index => index.collectionGroup === 'auditEvents')
    .map(index => index.fields.map(field => `${field.fieldPath}:${field.arrayConfig ?? 'ORDER'}`).join('|'));

  const coversPrefix = (prefix: string) => auditIndexFields.some(fields => fields === prefix || fields.startsWith(`${prefix}|`));
  assert.ok(coversPrefix('category:ORDER|timestamp:ORDER'));
  assert.ok(coversPrefix('action:ORDER|timestamp:ORDER'));
  assert.ok(coversPrefix('actor.email:ORDER|timestamp:ORDER'));
  assert.ok(coversPrefix('resource.key:ORDER|timestamp:ORDER'));
  assert.ok(coversPrefix('searchTokens:CONTAINS|timestamp:ORDER'));
});

test('audit registry contains every required logical category and no unregistered action is accepted', () => {
  assert.deepEqual(
    [...new Set(Object.values(ACTION_REGISTRY).map(action => action.category))].sort(),
    ['application', 'dues', 'events', 'gallery', 'membership', 'permissions', 'profile', 'session', 'signups', 'site'],
  );
  assert.equal(ACTION_REGISTRY['profile.photo_submission.created'].audience, 'adminOrModerator');
  assert.equal(ACTION_REGISTRY['gallery.created'].audience, 'members');
  assert.throws(
    () =>
      createCanonicalAuditEvent({
        action: 'not.registered' as never,
        actor: { email: 'maja@example.test', name: 'Maja' },
        resource: { kind: 'member', key: 'member:ula@example.test', display: 'Ula' },
        changes: [],
      }),
    AuditInputError,
  );
});

test('canonical audit event is server-shaped and uses a compact technical value instead of prose', () => {
  const event = createCanonicalAuditEvent(
    {
      action: 'event.updated',
      actor: { email: 'bartek@example.test', name: 'Bartek' },
      resource: { kind: 'event', key: 'event:wolin-2020', display: 'Wolin' },
      changes: [{ field: 'startDate', before: '2019-01-01', after: '2020-01-01' }],
    },
    { createId: () => 'audit-1', now: () => new Date('2026-09-09T12:34:56.000Z') },
  );

  assert.deepEqual(event, {
    id: 'audit-1',
    schemaVersion: 1,
    timestamp: '2026-09-09T12:34:56.000Z',
    actor: { email: 'bartek@example.test', name: 'Bartek' },
    category: 'events',
    action: 'event.updated',
    audience: 'members',
    resource: { kind: 'event', key: 'event:wolin-2020', display: 'Wolin' },
    changes: [{ field: 'startDate', before: '2019-01-01', after: '2020-01-01', visibility: 'memberVisible' }],
    value: 'Wolin.startDate=2020-01-01',
    searchTokens: event.searchTokens,
  });
  // wol -> Wolin (prefix match), but not an interior substring like oli (plan-addendum-2.md).
  assert.ok(event.searchTokens.includes('wol'));
  assert.ok(event.searchTokens.includes('wolin'));
  assert.ok(!event.searchTokens.includes('oli'));
  assert.equal(formatTechnicalValue('Ula', 'role', 'Barman'), 'Ula.role=Barman');
});

test('audit event rejects values outside the action allowlist and never stores raw photo bytes', () => {
  assert.throws(
    () =>
      createCanonicalAuditEvent({
        action: 'profile.person.photo.added',
        actor: { email: 'maja@example.test' },
        resource: { kind: 'person', key: 'person:ula', display: 'Ula' },
        changes: [{ field: 'photoBytes', after: 'raw image data' }],
      }),
    /not allowed|never stored/i,
  );
});

test('audited Firestore mutation commits its business state and exactly one immutable event together', async () => {
  const firestore = createInMemoryFirestoreClient();
  const event = await executeAuditedFirestoreMutation(
    firestore,
    {
      action: 'event.created',
      actor: { email: 'maja@example.test', name: 'Maja' },
      resource: { kind: 'event', key: 'event:wolin-2020', display: 'Wolin' },
      changes: [{ field: 'name', after: 'Wolin' }],
    },
    async tx => {
      await tx.setDoc('events', 'wolin-2020', { name: 'Wolin' });
      return 'created';
    },
    { createId: () => 'audit-created', now: () => new Date('2026-09-09T12:00:00.000Z') },
  );

  assert.equal(event.result, 'created');
  assert.deepEqual(await firestore.getDoc('events', 'wolin-2020'), { name: 'Wolin' });
  assert.equal((await firestore.listDocs('auditEvents')).length, 1);
  assert.deepEqual(await firestore.getDoc('auditEvents', 'audit-created'), event.auditEvent);
  await assert.rejects(
    () =>
      executeAuditedFirestoreMutation(
        firestore,
        {
          action: 'event.created',
          actor: { email: 'maja@example.test' },
          resource: { kind: 'event', key: 'event:other', display: 'Inny' },
          changes: [{ field: 'name', after: 'Inny' }],
        },
        async tx => {
          await tx.setDoc('events', 'other', { name: 'Inny' });
          throw new Error('business failure');
        },
        { createId: () => 'audit-failed', now: () => new Date('2026-09-09T12:00:01.000Z') },
      ),
    /business failure/,
  );
  assert.equal(await firestore.getDoc('events', 'other'), null);
  assert.equal(await firestore.getDoc('auditEvents', 'audit-failed'), null);
});

test('audited Firestore mutation commits all declared canonical events or none of them', async () => {
  const firestore = createInMemoryFirestoreClient();
  await assert.rejects(
    () =>
      executeAuditedFirestoreMutation(
        firestore,
        [
          {
            action: 'event.updated',
            actor: { email: 'maja@example.test' },
            resource: { kind: 'event', key: 'event:wolin', display: 'Wolin' },
            changes: [{ field: 'name', before: 'Wolin', after: 'Wolin zimowy' }],
          },
          {
            action: 'dues.event_fee.changed',
            actor: { email: 'maja@example.test' },
            resource: { kind: 'eventFee', key: 'eventFee:wolin', display: 'Wolin zimowy' },
            changes: [{ field: 'feeDigest', before: null, after: 'digest' }],
          },
        ],
        async tx => {
          await tx.setDoc('events', 'wolin', { name: 'Wolin zimowy', skladkaFee: '100 zł' });
          throw new Error('business failure');
        },
      ),
    /business failure/,
  );
  assert.equal(await firestore.getDoc('events', 'wolin'), null);
  assert.deepEqual(await firestore.listDocs('auditEvents'), []);
});

test('audited external mutation persists its immutable intent before the effect and terminal evidence after success', async () => {
  const firestore = createInMemoryFirestoreClient();
  const observedIntents: unknown[] = [];
  const result = await executeAuditedExternalMutation(
    firestore,
    {
      action: 'gallery.created',
      actor: { email: 'maja@example.test' },
      resource: { kind: 'gallery', key: 'gallery:pending:create-1', display: 'Jesienny Wolin' },
      changes: [{ field: 'name', after: 'Jesienny Wolin' }],
    },
    async correlationId => {
      observedIntents.push(await firestore.getDoc('auditOperations', correlationId));
      return { folderId: 'drive-folder-1' };
    },
    {
      correlationId: 'create-1',
      createId: () => 'audit-gallery-created',
      now: () => new Date('2026-09-09T12:00:00.000Z'),
      eventInput: result => ({
        action: 'gallery.created',
        actor: { email: 'maja@example.test' },
        resource: { kind: 'gallery', key: `gallery:${result.folderId}`, display: 'Jesienny Wolin' },
        changes: [{ field: 'name', after: 'Jesienny Wolin' }],
      }),
    },
  );

  assert.deepEqual(result.result, { folderId: 'drive-folder-1' });
  assert.deepEqual(observedIntents, [{
    id: 'create-1',
    schemaVersion: 1,
    state: 'pending',
    startedAt: '2026-09-09T12:00:00.000Z',
    actor: { email: 'maja@example.test' },
    action: 'gallery.created',
    resource: { kind: 'gallery', key: 'gallery:pending:create-1', display: 'Jesienny Wolin' },
    requestLeaseExpiresAt: '2026-09-09T12:30:00.000Z',
  }]);
  assert.deepEqual(await firestore.getDoc('auditOperationOutcomes', 'create-1'), {
    id: 'create-1',
    schemaVersion: 1,
    state: 'succeeded',
    completedAt: '2026-09-09T12:00:00.000Z',
    auditEventId: 'audit-gallery-created',
    determinedBy: 'request',
    finalResourceKey: 'gallery:drive-folder-1',
  });
  const storedEvent = await firestore.getDoc<{ searchTokens: string[] }>('auditEvents', 'audit-gallery-created');
  assert.deepEqual(storedEvent, {
    id: 'audit-gallery-created',
    schemaVersion: 1,
    timestamp: '2026-09-09T12:00:00.000Z',
    actor: { email: 'maja@example.test' },
    category: 'gallery',
    action: 'gallery.created',
    audience: 'members',
    resource: { kind: 'gallery', key: 'gallery:drive-folder-1', display: 'Jesienny Wolin' },
    changes: [{ field: 'name', after: 'Jesienny Wolin', visibility: 'memberVisible' }],
    value: 'Jesienny Wolin.name=Jesienny Wolin',
    searchTokens: storedEvent!.searchTokens,
    correlationId: 'create-1',
  });
});

test('audited external mutation stores a failed terminal outcome without inventing a canonical success event', async () => {
  const firestore = createInMemoryFirestoreClient();
  await assert.rejects(
    () => executeAuditedExternalMutation(
      firestore,
      {
        action: 'site.redirect.created',
        actor: { email: 'maja@example.test' },
        resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' },
        changes: [{ field: 'path', after: 'discord' }],
      },
      async () => { throw new Error('GitHub unavailable'); },
      { correlationId: 'redirect-1', now: () => new Date('2026-09-09T12:01:00.000Z') },
    ),
    /GitHub unavailable/,
  );

  assert.deepEqual(await firestore.getDoc('auditOperationOutcomes', 'redirect-1'), {
    id: 'redirect-1',
    schemaVersion: 1,
    state: 'failed',
    completedAt: '2026-09-09T12:01:00.000Z',
    determinedBy: 'request',
  });
  assert.deepEqual(await firestore.listDocs('auditEvents'), []);
});

// ---------------------------------------------------------------------------------------------
// Query, role projection, and diagnostics (KRKG-0050 batch 4/6)
// ---------------------------------------------------------------------------------------------

import {
  AuditQueryError,
  completeExternalOperation,
  encodeAuditCursor,
  getAuditEventDetail,
  listAuditDiagnostics,
  listOpenOperationCorrelationIds,
  normalizeSearchTerm,
  projectAuditEvent,
  queryAuditEvents,
  reconcileExternalOperation,
  startExternalOperation,
  type AuditViewer,
} from './audit.ts';

test('normalizeSearchTerm folds Polish diacritics and rejects multi-word input', () => {
  assert.equal(normalizeSearchTerm('Wolin'), 'wolin');
  assert.equal(normalizeSearchTerm('WÓŁ'), 'wol');
  assert.equal(normalizeSearchTerm('Łukasz'), 'lukasz');
  assert.throws(() => normalizeSearchTerm('Jan Kowalski'), AuditQueryError);
  assert.throws(() => normalizeSearchTerm('  '), AuditQueryError);
});

test('search tokens: "wol" matches Wolin via a stored prefix, "oli" (an interior substring) does not', async () => {
  const firestore = createInMemoryFirestoreClient();
  await executeAuditedFirestoreMutation(
    firestore,
    {
      action: 'event.created',
      actor: { email: 'maja@example.test' },
      resource: { kind: 'event', key: 'event:wolin-2020', display: 'Wolin' },
      changes: [{ field: 'name', after: 'Wolin' }],
    },
    async tx => { await tx.setDoc('events', 'wolin-2020', { name: 'Wolin' }); },
    { createId: () => 'evt-wolin', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  const admin: AuditViewer = { scope: 'admin', isAdmin: true, isAccountant: false, isModerator: false };

  const matchWol = await queryAuditEvents(firestore, { selector: { kind: 'search', term: 'wol' } }, admin);
  assert.equal(matchWol.rows.length, 1);
  assert.equal(matchWol.rows[0].id, 'evt-wolin');

  const matchOli = await queryAuditEvents(firestore, { selector: { kind: 'search', term: 'oli' } }, admin);
  assert.equal(matchOli.rows.length, 0);
});

test('queryAuditEvents rejects an unsupported/multi-term search selector deterministically (400-mapped)', () => {
  const firestore = createInMemoryFirestoreClient();
  const admin: AuditViewer = { scope: 'admin', isAdmin: true, isAccountant: false, isModerator: false };
  assert.rejects(() => queryAuditEvents(firestore, { selector: { kind: 'search', term: 'jan kowalski' } }, admin), AuditQueryError);
  assert.rejects(() => queryAuditEvents(firestore, { selector: { kind: 'none' }, from: 'not-a-date' }, admin), AuditQueryError);
  assert.rejects(() => queryAuditEvents(firestore, { selector: { kind: 'none' }, cursor: 'not-base64-json' }, admin), AuditQueryError);
});

test('queryAuditEvents caps at 100 rows and paginates with a stable cursor', async () => {
  const firestore = createInMemoryFirestoreClient();
  for (let i = 0; i < 5; i += 1) {
    await executeAuditedFirestoreMutation(
      firestore,
      {
        action: 'event.created',
        actor: { email: 'maja@example.test' },
        resource: { kind: 'event', key: `event:e${i}`, display: `Event ${i}` },
        changes: [{ field: 'name', after: `Event ${i}` }],
      },
      async tx => { await tx.setDoc('events', `e${i}`, { name: `Event ${i}` }); },
      { createId: () => `evt-${i}`, now: () => new Date(`2026-01-0${i + 1}T00:00:00.000Z`) },
    );
  }
  const admin: AuditViewer = { scope: 'admin', isAdmin: true, isAccountant: false, isModerator: false };
  const page1 = await queryAuditEvents(firestore, { selector: { kind: 'none' }, limit: 2 }, admin);
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.rows[0].id, 'evt-4'); // newest first
  assert.ok(page1.nextCursor);
  const page2 = await queryAuditEvents(firestore, { selector: { kind: 'none' }, limit: 2, cursor: page1.nextCursor }, admin);
  assert.deepEqual(page2.rows.map(r => r.id), ['evt-2', 'evt-1']);
  // a limit above the 100-row cap is silently clamped, never rejected
  const clamped = await queryAuditEvents(firestore, { selector: { kind: 'none' }, limit: 10_000 }, admin);
  assert.equal(clamped.rows.length, 5);
});

/**
 * KRKG-0050 batch 6/6: closes the remaining gaps in implementation-contract.md's "Query and
 * Firestore-index contract" matrix - every supported primary selector kind (category alone,
 * category+action, actor, resource key; `none` and `search` are already covered above), each
 * combinable with a date range and a cursor. The `none`/`search` cases above already proved date
 * range and cursor pagination work at all; this test's job is to prove the other three selector
 * *kinds* actually filter (not just that the query call succeeds), and that a primary selector
 * still composes with date range and cursor rather than being mutually exclusive with them.
 */
test('queryAuditEvents: category, category+action, actor, and resourceKey selectors each filter correctly and compose with a date range and cursor', async () => {
  const firestore = createInMemoryFirestoreClient();
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'event.created', actor: { email: 'maja@example.test' }, resource: { kind: 'event', key: 'event:wolin', display: 'Wolin' }, changes: [{ field: 'name', after: 'Wolin' }] },
    async () => {},
    { createId: () => 'evt-created', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'event.updated', actor: { email: 'maja@example.test' }, resource: { kind: 'event', key: 'event:wolin', display: 'Wolin' }, changes: [{ field: 'startDate', after: '2026-06-01' }] },
    async () => {},
    { createId: () => 'evt-updated', now: () => new Date('2026-01-02T00:00:00.000Z') },
  );
  await executeAuditedFirestoreMutation(
    firestore,
    { action: 'event.created', actor: { email: 'bartek@example.test' }, resource: { kind: 'event', key: 'event:zima', display: 'Zima' }, changes: [{ field: 'name', after: 'Zima' }] },
    async () => {},
    { createId: () => 'evt-other-actor-resource', now: () => new Date('2026-01-03T00:00:00.000Z') },
  );
  const admin: AuditViewer = { scope: 'admin', isAdmin: true, isAccountant: false, isModerator: false };

  // category alone (no action): matches every "events" category row regardless of action.
  const byCategory = await queryAuditEvents(firestore, { selector: { kind: 'categoryAction', category: 'events' } }, admin);
  assert.deepEqual(byCategory.rows.map(r => r.id).sort(), ['evt-created', 'evt-other-actor-resource', 'evt-updated']);

  // category + action: narrows to exactly one action within the category.
  const byCategoryAction = await queryAuditEvents(firestore, { selector: { kind: 'categoryAction', category: 'events', action: 'event.updated' } }, admin);
  assert.deepEqual(byCategoryAction.rows.map(r => r.id), ['evt-updated']);

  // actor: matches only that actor's events, case-insensitively normalized the same way writes are.
  const byActor = await queryAuditEvents(firestore, { selector: { kind: 'actor', email: 'MAJA@example.test' } }, admin);
  assert.deepEqual(byActor.rows.map(r => r.id).sort(), ['evt-created', 'evt-updated']);

  // resourceKey: matches only events on that resource, across different actions/actors.
  const byResource = await queryAuditEvents(firestore, { selector: { kind: 'resourceKey', key: 'event:wolin' } }, admin);
  assert.deepEqual(byResource.rows.map(r => r.id).sort(), ['evt-created', 'evt-updated']);

  // A primary selector composes with a date range - bounding the actor selector to exclude the
  // earlier of its two matches.
  const actorWithDateRange = await queryAuditEvents(
    firestore,
    { selector: { kind: 'actor', email: 'maja@example.test' }, from: '2026-01-02T00:00:00.000Z' },
    admin,
  );
  assert.deepEqual(actorWithDateRange.rows.map(r => r.id), ['evt-updated']);

  // A primary selector composes with cursor pagination too, not just the `none` selector.
  const resourcePage1 = await queryAuditEvents(firestore, { selector: { kind: 'resourceKey', key: 'event:wolin' }, limit: 1 }, admin);
  assert.deepEqual(resourcePage1.rows.map(r => r.id), ['evt-updated']); // newest first
  assert.ok(resourcePage1.nextCursor);
  const resourcePage2 = await queryAuditEvents(
    firestore,
    { selector: { kind: 'resourceKey', key: 'event:wolin' }, limit: 1, cursor: resourcePage1.nextCursor },
    admin,
  );
  assert.deepEqual(resourcePage2.rows.map(r => r.id), ['evt-created']);
});

test('projectAuditEvent: admin sees actor and every allowed field; accountant-only is scoped to dues; member never sees actor', () => {
  const duesEvent = createCanonicalAuditEvent(
    {
      action: 'dues.annual.changed',
      actor: { email: 'skarbnik@example.test' },
      resource: { kind: 'due', key: 'due:ula@example.test:2026', display: 'Ula 2026' },
      changes: [{ field: 'paid', after: true }],
    },
    { createId: () => 'due-1', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  const admin: AuditViewer = { scope: 'admin', isAdmin: true, isAccountant: false, isModerator: false };
  const accountant: AuditViewer = { scope: 'admin', isAdmin: false, isAccountant: true, isModerator: false };
  const moderatorOnly: AuditViewer = { scope: 'admin', isAdmin: false, isAccountant: false, isModerator: true };

  assert.equal(projectAuditEvent(duesEvent, admin)?.actor?.email, 'skarbnik@example.test');
  assert.equal(projectAuditEvent(duesEvent, accountant)?.actor?.email, 'skarbnik@example.test');
  assert.equal(projectAuditEvent(duesEvent, moderatorOnly), null); // moderator-only cannot see dues

  const galleryEvent = createCanonicalAuditEvent(
    {
      action: 'gallery.created',
      actor: { email: 'maja@example.test' },
      resource: { kind: 'gallery', key: 'gallery:g1', display: 'Wolin' },
      changes: [{ field: 'name', after: 'Wolin' }],
    },
    { createId: () => 'gal-1', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  const member: AuditViewer = { scope: 'member' };
  const memberRow = projectAuditEvent(galleryEvent, member);
  assert.ok(memberRow);
  assert.equal(memberRow!.actor, undefined); // actor is never shown to the public member scope
  assert.equal(memberRow!.changes[0].after, 'Wolin');
  // member scope never sees an admin-only category at all
  assert.equal(projectAuditEvent(duesEvent, member), null);
});

test('getAuditEventDetail applies the same projection as list rows and hides a category the viewer cannot see', async () => {
  const firestore = createInMemoryFirestoreClient();
  await executeAuditedFirestoreMutation(
    firestore,
    {
      action: 'profile.member.updated',
      actor: { email: 'admin@example.test' },
      resource: { kind: 'member', key: 'member:ula@example.test', display: 'Ula' },
      changes: [{ field: 'name', after: 'Ula' }],
    },
    async tx => { await tx.setDoc('members', 'ula@example.test', { name: 'Ula' }); },
    { createId: () => 'profile-1', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  const moderator: AuditViewer = { scope: 'admin', isAdmin: false, isAccountant: false, isModerator: true };
  const accountant: AuditViewer = { scope: 'admin', isAdmin: false, isAccountant: true, isModerator: false };
  assert.ok(await getAuditEventDetail(firestore, 'profile-1', moderator));
  assert.equal(await getAuditEventDetail(firestore, 'profile-1', accountant), null);
  assert.equal(await getAuditEventDetail(firestore, 'does-not-exist', moderator), null);
});

test('completeExternalOperation is single-winner: a concurrent second completion never creates a duplicate audit event', async () => {
  const firestore = createInMemoryFirestoreClient();
  await startExternalOperation(
    firestore,
    { action: 'gallery.created', actor: { email: 'maja@example.test' }, resource: { kind: 'gallery', key: 'gallery:pending:race-1', display: 'Wyjazd' }, changes: [{ field: 'name', after: 'Wyjazd' }] },
    { correlationId: 'race-1', provisionalResourceKey: 'gallery:pending:race-1', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  const eventInput = { action: 'gallery.created' as const, actor: { email: 'maja@example.test' }, resource: { kind: 'gallery' as const, key: 'gallery:final-1', display: 'Wyjazd' }, changes: [{ field: 'name', after: 'Wyjazd' }] };
  const deps = { createId: () => 'audit-race-1', now: () => new Date('2026-01-01T00:05:00.000Z') };

  const [first, second] = await Promise.all([
    completeExternalOperation(firestore, { state: 'succeeded', correlationId: 'race-1', eventInput, determinedBy: 'request' }, deps),
    completeExternalOperation(firestore, { state: 'succeeded', correlationId: 'race-1', eventInput, determinedBy: 'reconciler' }, { ...deps, createId: () => 'audit-race-2' }),
  ]);
  const winners = [first, second].filter(r => r.won);
  const losers = [first, second].filter(r => !r.won);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].outcome.id, winners[0].outcome.id);
  assert.equal((await firestore.listDocs('auditEvents')).length, 1);
});

test('reconcileExternalOperation: not eligible before the 30-minute request lease expires, then claims and resolves', async () => {
  const firestore = createInMemoryFirestoreClient();
  const started = new Date('2026-01-01T00:00:00.000Z');
  await startExternalOperation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] },
    { correlationId: 'lease-1', now: () => started },
  );

  const tooSoon = await reconcileExternalOperation(
    firestore, 'lease-1',
    async () => ({ state: 'pending' }),
    { now: () => new Date(started.getTime() + 10 * 60 * 1000), createId: () => 'ignored' },
  );
  assert.equal(tooSoon.outcome, 'not_eligible');
  assert.equal((await listOpenOperationCorrelationIds(firestore)).length, 1);

  const afterLease = new Date(started.getTime() + 31 * 60 * 1000);
  const resolved = await reconcileExternalOperation(
    firestore, 'lease-1',
    async () => ({ state: 'succeeded', eventInput: { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] } }),
    { now: () => afterLease, createId: () => 'audit-reconciled-1' },
  );
  assert.equal(resolved.outcome, 'claimed_succeeded');
  assert.deepEqual(await listOpenOperationCorrelationIds(firestore), []);
  const outcome = await firestore.getDoc<{ determinedBy: string }>('auditOperationOutcomes', 'lease-1');
  assert.equal(outcome!.determinedBy, 'reconciler');
});

test('reconcileExternalOperation: an active 10-minute claim lease blocks a second concurrent reconciler run', async () => {
  const firestore = createInMemoryFirestoreClient();
  const started = new Date('2026-01-01T00:00:00.000Z');
  await startExternalOperation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] },
    { correlationId: 'claim-1', now: () => started },
  );
  const eligibleAt = new Date(started.getTime() + 31 * 60 * 1000);
  let probeCalls = 0;
  const slowProbe = async () => { probeCalls += 1; return { state: 'pending' as const }; };

  const firstClaim = await reconcileExternalOperation(firestore, 'claim-1', slowProbe, { now: () => eligibleAt, createId: () => 'x' });
  assert.equal(firstClaim.outcome, 'not_eligible'); // still pending, not yet past 24h
  assert.equal(probeCalls, 1);

  const secondClaimFiveMinLater = await reconcileExternalOperation(
    firestore, 'claim-1', slowProbe,
    { now: () => new Date(eligibleAt.getTime() + 5 * 60 * 1000), createId: () => 'x' },
  );
  assert.equal(secondClaimFiveMinLater.outcome, 'already_claimed');
  assert.equal(probeCalls, 1); // probe not invoked again while the claim lease holds

  const thirdClaimAfterLeaseExpiry = await reconcileExternalOperation(
    firestore, 'claim-1', slowProbe,
    { now: () => new Date(eligibleAt.getTime() + 11 * 60 * 1000), createId: () => 'x' },
  );
  assert.equal(thirdClaimAfterLeaseExpiry.outcome, 'not_eligible');
  assert.equal(probeCalls, 2);
});

test('reconcileExternalOperation records requires_review 24 hours after the operation started, never retrying the effect', async () => {
  const firestore = createInMemoryFirestoreClient();
  const started = new Date('2026-01-01T00:00:00.000Z');
  await startExternalOperation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] },
    { correlationId: 'review-1', now: () => started },
  );
  const result = await reconcileExternalOperation(
    firestore, 'review-1',
    async () => ({ state: 'pending' }),
    { now: () => new Date(started.getTime() + 25 * 60 * 60 * 1000), createId: () => 'x' },
  );
  assert.equal(result.outcome, 'claimed_requires_review');
  const outcome = await firestore.getDoc<{ state: string }>('auditOperationOutcomes', 'review-1');
  assert.equal(outcome!.state, 'requires_review');
});

test('listAuditDiagnostics lists pending/failed/requires_review by correlation id and omits succeeded operations', async () => {
  const firestore = createInMemoryFirestoreClient();
  await startExternalOperation(
    firestore,
    { action: 'gallery.created', actor: { email: 'maja@example.test' }, resource: { kind: 'gallery', key: 'gallery:pending:diag-pending', display: 'A' }, changes: [{ field: 'name', after: 'A' }] },
    { correlationId: 'diag-pending', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  await startExternalOperation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:x', display: 'x' }, changes: [{ field: 'path', after: 'x' }] },
    { correlationId: 'diag-succeeded', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  await completeExternalOperation(firestore, {
    state: 'succeeded', correlationId: 'diag-succeeded',
    eventInput: { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:x', display: 'x' }, changes: [{ field: 'path', after: 'x' }] },
    determinedBy: 'request',
  }, { createId: () => 'ev-1', now: () => new Date('2026-01-01T00:01:00.000Z') });

  const all = await listAuditDiagnostics(firestore);
  assert.deepEqual(all.map(r => r.correlationId).sort(), ['diag-pending']);
  const filtered = await listAuditDiagnostics(firestore, 'diag-pending');
  assert.equal(filtered.length, 1);
  const filteredSucceeded = await listAuditDiagnostics(firestore, 'diag-succeeded');
  assert.equal(filteredSucceeded.length, 0);
});

test('a later remediation action creates a distinct correlation id and never mutates the original terminal outcome', async () => {
  const firestore = createInMemoryFirestoreClient();
  await startExternalOperation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] },
    { correlationId: 'original-1', now: () => new Date('2026-01-01T00:00:00.000Z') },
  );
  await completeExternalOperation(firestore, { state: 'failed', correlationId: 'original-1', determinedBy: 'request' }, { createId: () => 'x', now: () => new Date('2026-01-01T00:01:00.000Z') });
  const originalOutcomeBefore = await firestore.getDoc('auditOperationOutcomes', 'original-1');

  // Administrator repeats the normal authenticated action - a brand-new correlation id.
  const retry = await executeAuditedExternalMutation(
    firestore,
    { action: 'site.redirect.created', actor: { email: 'admin@example.test' }, resource: { kind: 'redirect', key: 'redirect:discord', display: 'discord' }, changes: [{ field: 'path', after: 'discord' }] },
    async () => 'ok',
    { correlationId: 'remediation-1', createId: () => 'audit-remediation-1', now: () => new Date('2026-01-01T00:02:00.000Z') },
  );
  assert.equal(retry.correlationId, 'remediation-1');
  assert.notEqual(retry.correlationId, 'original-1');
  assert.deepEqual(await firestore.getDoc('auditOperationOutcomes', 'original-1'), originalOutcomeBefore);
});
