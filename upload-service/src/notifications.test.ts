import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import type { MailMessage } from './mailer.ts';
import type { PushMessage, PushSubscriptionRecord } from './pusher.ts';
import {
  addPushSubscriptionInTransaction,
  getNotificationPreferences,
  getNotificationSettings,
  MAX_PUSH_SUBSCRIPTIONS_PER_PERSON,
  membershipDecisionMessage,
  normalizeRejectionReason,
  parseNotifiableRoles,
  photoDecisionMessage,
  removePushSubscriptionInTransaction,
  resolveRegistrationRecipients,
  sendNotifications,
  sendPushNotifications,
  setEmailEnabledInTransaction,
} from './notifications.ts';

test('parseNotifiableRoles accepts only known roles, returned in canonical order without duplicates', () => {
  assert.deepEqual(parseNotifiableRoles(['hovding', 'admin', 'hovding']), ['admin', 'hovding']);
  assert.deepEqual(parseNotifiableRoles([]), []);
  assert.equal(parseNotifiableRoles(['member']), null);
  assert.equal(parseNotifiableRoles('admin'), null);
});

test('getNotificationSettings defaults to admin + hovding when nothing (or garbage) is stored', async () => {
  const client = createInMemoryFirestoreClient();
  const defaults = { registrationRecipientRoles: ['admin', 'hovding'], pushRecipientRoles: ['admin', 'hovding'] };
  assert.deepEqual(await getNotificationSettings(client), defaults);
  client.seed('notificationSettings', 'default', { registrationRecipientRoles: ['nope'], pushRecipientRoles: 'nope' });
  assert.deepEqual(await getNotificationSettings(client), defaults);
  client.seed('notificationSettings', 'default', { registrationRecipientRoles: [] });
  assert.deepEqual(await getNotificationSettings(client), { registrationRecipientRoles: [], pushRecipientRoles: ['admin', 'hovding'] });
  client.seed('notificationSettings', 'default', { registrationRecipientRoles: ['hovding'], pushRecipientRoles: ['admin'] });
  assert.deepEqual(await getNotificationSettings(client), { registrationRecipientRoles: ['hovding'], pushRecipientRoles: ['admin'] });
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

const subscription = (n: number): PushSubscriptionRecord => ({
  endpoint: `https://push.example.com/${n}`,
  keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) },
});

test('push subscriptions: same endpoint is refreshed not duplicated, oldest dropped past the cap, removal by endpoint', async () => {
  const client = createInMemoryFirestoreClient();
  const now = new Date('2026-09-30T12:00:00Z');
  await client.runTransaction(tx => addPushSubscriptionInTransaction(tx, 'A@example.com', subscription(1), now));
  await client.runTransaction(tx => addPushSubscriptionInTransaction(tx, 'a@example.com', subscription(1), now));
  assert.deepEqual((await getNotificationPreferences(client, 'a@example.com')).pushSubscriptions.map(s => s.endpoint), ['https://push.example.com/1']);
  for (let i = 2; i <= MAX_PUSH_SUBSCRIPTIONS_PER_PERSON + 1; i++) {
    await client.runTransaction(tx => addPushSubscriptionInTransaction(tx, 'a@example.com', subscription(i), now));
  }
  const endpoints = (await getNotificationPreferences(client, 'a@example.com')).pushSubscriptions.map(s => s.endpoint);
  assert.equal(endpoints.length, MAX_PUSH_SUBSCRIPTIONS_PER_PERSON);
  assert.equal(endpoints.includes('https://push.example.com/1'), false);
  await client.runTransaction(tx => removePushSubscriptionInTransaction(tx, 'a@example.com', 'https://push.example.com/2'));
  assert.equal((await getNotificationPreferences(client, 'a@example.com')).pushSubscriptions.some(s => s.endpoint.endsWith('/2')), false);
  // Adding devices never touches the e-mail choice.
  assert.equal((await getNotificationPreferences(client, 'a@example.com')).emailEnabled, true);
});

test('sendNotifications skips recipients who opted out of e-mail, and sends when preferences cannot be read', async () => {
  const client = createInMemoryFirestoreClient();
  await client.runTransaction(tx => setEmailEnabledInTransaction(tx, 'out@example.com', false));
  const sent: string[] = [];
  const mailer = { send: async (message: MailMessage) => { sent.push(message.to); return 'sent' as const; } };
  const messages = ['in@example.com', 'OUT@example.com'].map(to => ({ to, subject: 's', text: 't' }));
  await sendNotifications(mailer, client, messages);
  assert.deepEqual(sent, ['in@example.com']);
  sent.length = 0;
  await sendNotifications(mailer, { getDoc: async () => { throw new Error('firestore down'); } }, messages);
  assert.deepEqual(sent.sort(), ['OUT@example.com', 'in@example.com']);
});

test('sendPushNotifications sends to every device of every recipient and does nothing when push is disabled', async () => {
  const client = createInMemoryFirestoreClient();
  const now = new Date();
  await client.runTransaction(tx => addPushSubscriptionInTransaction(tx, 'a@example.com', subscription(1), now));
  await client.runTransaction(tx => addPushSubscriptionInTransaction(tx, 'a@example.com', subscription(2), now));
  await client.runTransaction(tx => addPushSubscriptionInTransaction(tx, 'b@example.com', subscription(3), now));
  const pushed: string[] = [];
  const pusher = {
    publicKey: 'pub',
    send: async (sub: PushSubscriptionRecord, _message: PushMessage) => { pushed.push(sub.endpoint); return sub.endpoint.endsWith('/2') ? 'gone' as const : 'sent' as const; },
  };
  const message = { title: 't', body: 'b', url: '/' };
  await sendPushNotifications(pusher, client, ['a@example.com', 'b@example.com', 'nobody@example.com'], message);
  assert.deepEqual(pushed.sort(), ['https://push.example.com/1', 'https://push.example.com/2', 'https://push.example.com/3']);
  pushed.length = 0;
  await sendPushNotifications({ ...pusher, publicKey: null }, client, ['a@example.com'], message);
  assert.deepEqual(pushed, []);
});
