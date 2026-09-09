import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  ACTION_REGISTRY,
  AuditInputError,
  createCanonicalAuditEvent,
  executeAuditedFirestoreMutation,
  formatTechnicalValue,
} from './audit.ts';

test('checked-in Firestore index manifest covers every supported audit primary selector', async () => {
  const manifest = JSON.parse(await readFile(new URL('../firestore.indexes.json', import.meta.url), 'utf8')) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; arrayConfig?: string }> }>;
  };
  const auditIndexFields = manifest.indexes
    .filter(index => index.collectionGroup === 'auditEvents')
    .map(index => index.fields.map(field => `${field.fieldPath}:${field.arrayConfig ?? 'ORDER'}`).join('|'));

  assert.ok(auditIndexFields.includes('category:ORDER|timestamp:ORDER'));
  assert.ok(auditIndexFields.includes('action:ORDER|timestamp:ORDER'));
  assert.ok(auditIndexFields.includes('actor.email:ORDER|timestamp:ORDER'));
  assert.ok(auditIndexFields.includes('resource.key:ORDER|timestamp:ORDER'));
  assert.ok(auditIndexFields.includes('searchTokens:CONTAINS|timestamp:ORDER'));
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
  });
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
