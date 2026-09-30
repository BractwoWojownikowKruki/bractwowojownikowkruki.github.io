import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import {
  getNotificationSettings,
  membershipDecisionMessage,
  normalizeRejectionReason,
  parseNotifiableRoles,
  photoDecisionMessage,
  resolveRegistrationRecipients,
} from './notifications.ts';

test('parseNotifiableRoles accepts only known roles, returned in canonical order without duplicates', () => {
  assert.deepEqual(parseNotifiableRoles(['hovding', 'admin', 'hovding']), ['admin', 'hovding']);
  assert.deepEqual(parseNotifiableRoles([]), []);
  assert.equal(parseNotifiableRoles(['member']), null);
  assert.equal(parseNotifiableRoles('admin'), null);
});

test('getNotificationSettings defaults to admin + hovding when nothing (or garbage) is stored', async () => {
  const client = createInMemoryFirestoreClient();
  assert.deepEqual(await getNotificationSettings(client), { registrationRecipientRoles: ['admin', 'hovding'] });
  client.seed('notificationSettings', 'default', { registrationRecipientRoles: ['nope'] });
  assert.deepEqual(await getNotificationSettings(client), { registrationRecipientRoles: ['admin', 'hovding'] });
  client.seed('notificationSettings', 'default', { registrationRecipientRoles: [] });
  assert.deepEqual(await getNotificationSettings(client), { registrationRecipientRoles: [] });
});

test('resolveRegistrationRecipients: role holders must be active; the allowlist counts only when admin is selected', async () => {
  const client = createInMemoryFirestoreClient();
  const member = (email: string, status: string) => client.seed('members', email, { email, status });
  member('h@example.com', 'active');
  member('h-suspended@example.com', 'suspended');
  member('acc@example.com', 'active');
  client.seed('userRoles', 'h@example.com', { roles: ['hovding'] });
  client.seed('userRoles', 'h-suspended@example.com', { roles: ['hovding'] });
  client.seed('userRoles', 'acc@example.com', { roles: ['accountant'] });
  const sources = { firestore: client, listAdminAllowlistEmails: async () => ['H@example.com', 'boss@example.com'] };
  assert.deepEqual(await resolveRegistrationRecipients(sources, ['hovding']), ['h@example.com']);
  assert.deepEqual(await resolveRegistrationRecipients(sources, ['admin', 'accountant']), ['acc@example.com', 'boss@example.com', 'h@example.com']);
  assert.deepEqual(await resolveRegistrationRecipients(sources, []), []);
  const failingAllowlist = { firestore: client, listAdminAllowlistEmails: async () => { throw new Error('sheet down'); } };
  assert.deepEqual(await resolveRegistrationRecipients(failingAllowlist, ['admin', 'hovding']), ['h@example.com']);
});

test('rejection messages use the admin comment, or the generic hovding text when there is none', () => {
  assert.match(photoDecisionMessage('a@example.com', 'rejected', 3, 'Nieostre', 'https://x.test').text, /Komentarz: Nieostre/);
  const generic = photoDecisionMessage('a@example.com', 'rejected', 1, null, 'https://x.test');
  assert.match(generic.text, /Twoje zdjęcia zostały odrzucone z powodu problemów\. Jeśli nie wiesz, o co chodzi, skontaktuj się ze swoim hovdingiem\./);
  assert.match(generic.text, /https:\/\/x\.test\/profil\//);
  assert.match(membershipDecisionMessage('a@example.com', 'rejected', null, 'https://x.test').text, /hovdingiem/);
  assert.match(membershipDecisionMessage('a@example.com', 'approved', null, 'https://x.test').subject, /zaakceptowane/);
});

test('normalizeRejectionReason trims, treats blank as no comment, and rejects non-strings and over-long text', () => {
  assert.equal(normalizeRejectionReason(undefined), null);
  assert.equal(normalizeRejectionReason('  '), null);
  assert.equal(normalizeRejectionReason(' ok '), 'ok');
  assert.equal(normalizeRejectionReason(42), undefined);
  assert.equal(normalizeRejectionReason('x'.repeat(1001)), undefined);
});
