import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import type { MailMessage } from './mailer.ts';
import type { PushMessage, PushSubscriptionRecord } from './pusher.ts';
import {
  addPushSubscriptionInTransaction,
  eventAddedMessage,
  eventAddedPush,
  enqueueEmailNotifications,
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

test('new event e-mail includes form details and the friendly share link', () => {
  const message = eventAddedMessage('member@example.com', {
    name: 'Zjazd Łódź 2027!',
    startDate: '2027-05-01',
    description: 'Szczegóły spotkania.',
    discordUrl: 'https://discord.com/channels/123/456',
    mapUrl: 'https://maps.app.goo.gl/example',
    noCampEquipment: true,
  }, 'https://example.test');
  assert.equal(message.to, 'member@example.com');
  assert.equal(message.subject, 'Nowy wyjazd: Zjazd Łódź 2027!');
  assert.match(message.text, /Zjazd Łódź 2027!\nData rozpoczęcia: 2027-05-01/);
  assert.match(message.text, /https:\/\/example\.test\/lista-wyjazdowa\/wyjazd\/\?do=2027-05-01-zjazd-lodz-2027/);
  assert.match(message.text, /Szczegóły spotkania\./);
  assert.match(message.text, /https:\/\/discord\.com\/channels\/123\/456/);
  assert.match(message.text, /https:\/\/maps\.app\.goo\.gl\/example/);
  assert.match(message.text, /Bez sprzętu obozowego: tak/);
  assert.doesNotMatch(message.text, /eventId=/);
});

test('new event push uses the friendly share link without exposing the event ID', () => {
  assert.deepEqual(
    eventAddedPush({ name: 'Zjazd Łódź 2027!', startDate: '2027-05-01' }),
    { title: 'Nowy wyjazd', body: 'Zjazd Łódź 2027! · 2027-05-01', url: '/lista-wyjazdowa/wyjazd/?do=2027-05-01-zjazd-lodz-2027' },
  );
});

test('new event friendly links trim and collapse separators in the event name', () => {
  assert.equal(
    eventAddedPush({ name: '  --Zjazd / Łódź!! ', startDate: '2027-05-01' }).url,
    '/lista-wyjazdowa/wyjazd/?do=2027-05-01-zjazd-lodz',
  );
});

test('new event e-mail omits optional form details when they were not supplied', () => {
  const message = eventAddedMessage('member@example.com', {
    name: 'Zjazd', startDate: '2027-05-01', description: null, mapUrl: null, discordUrl: null, noCampEquipment: false,
  }, 'https://example.test');
  assert.doesNotMatch(message.text, /Dodatkowe informacje|Temat na Discordzie|Google Maps|Bez sprzętu obozowego/);

  const emptyMessage = eventAddedMessage('member@example.com', {
    name: 'Zjazd', startDate: '2027-05-01', description: '', mapUrl: '', discordUrl: undefined, noCampEquipment: undefined,
  }, 'https://example.test');
  assert.doesNotMatch(emptyMessage.text, /Dodatkowe informacje|Temat na Discordzie|Google Maps|Bez sprzętu obozowego/);
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

test('enqueueEmailNotifications respects email preferences and records deterministic per-recipient deliveries without redundant taskName writes', async () => {
  const client = createInMemoryFirestoreClient();
  await client.runTransaction(tx => setEmailEnabledInTransaction(tx, 'out@example.com', false));
  const enqueued: Array<{ deliveryId: string }> = [];
  const enqueue = async (payload: { deliveryId: string }) => {
    enqueued.push(payload);
    return { status: 'created' as const, taskName: `projects/test/queues/q/tasks/${payload.deliveryId}` };
  };
  const setDocCalls: Array<{ collection: string; id: string }> = [];
  const originalSetDoc = client.setDoc.bind(client);
  client.setDoc = async (collection, id, data) => {
    setDocCalls.push({ collection, id });
    return originalSetDoc(collection, id, data);
  };
  const messages = ['in@example.com', 'out@example.com'].map(to => ({ to, subject: 's', text: 'event snapshot' }));
  await enqueueEmailNotifications(client, messages, 'event-1', enqueue);
  assert.equal(enqueued.length, 1);
  const records = await client.listDocs<{ status: string; recipient: string; message: MailMessage; taskName?: string }>('emailNotificationDeliveries');
  assert.equal(records.length, 1);
  assert.equal(records[0].data.status, 'queued');
  assert.equal(records[0].data.recipient, 'in@example.com');
  assert.deepEqual(records[0].data.message, { to: 'in@example.com', subject: 's', text: 'event snapshot' });
  // Task name is not written to Firestore during enqueue; worker resolves it from headers/deliveryId.
  assert.equal(records[0].data.taskName, undefined);
  assert.equal(enqueued[0].deliveryId, records[0].id);
  // Zero secondary setDoc writes were performed for emailNotificationDeliveries.
  assert.equal(setDocCalls.filter(c => c.collection === 'emailNotificationDeliveries').length, 0);
});

test('enqueueEmailNotifications skips deliveries already queued or sent', async () => {
  const client = createInMemoryFirestoreClient();
  const { createEmailDeliveryId } = await import('./email-tasks.ts');
  for (const status of ['queued', 'sent', 'failed']) {
    const deliveryId = createEmailDeliveryId('event-2', `${status}@example.com`);
    client.seed('emailNotificationDeliveries', deliveryId, { deliveryId, status });
  }
  let calls = 0;
  await enqueueEmailNotifications(client, ['queued@example.com', 'sent@example.com', 'failed@example.com'].map(to => ({ to, subject: 's', text: 't' })), 'event-2', async () => {
    calls++;
    return { status: 'created' };
  });
  assert.equal(calls, 0);
});

test('enqueueEmailNotifications skips re-enqueueing when createDoc loses a concurrent creation race', async () => {
  const client = createInMemoryFirestoreClient();
  const { createEmailDeliveryId } = await import('./email-tasks.ts');
  const deliveryId = createEmailDeliveryId('event-concurrent', 'race@example.com');
  let createDocAttempted = false;
  const originalCreateDoc = client.createDoc.bind(client);
  client.createDoc = async (collection, id, data) => {
    if (collection === 'emailNotificationDeliveries' && id === deliveryId) {
      createDocAttempted = true;
      // Simulate another request creating the doc concurrently right before this createDoc
      client.seed('emailNotificationDeliveries', deliveryId, {
        deliveryId, eventId: 'event-concurrent', recipient: 'race@example.com',
        message: { to: 'race@example.com', subject: 's', text: 't' }, status: 'queued',
      });
      throw new Error(`Document already exists: ${collection}/${id}`);
    }
    return originalCreateDoc(collection, id, data);
  };
  let calls = 0;
  await enqueueEmailNotifications(client, [{ to: 'race@example.com', subject: 's', text: 't' }], 'event-concurrent', async () => {
    calls++;
    return { status: 'created' };
  });
  assert.equal(createDocAttempted, true);
  assert.equal(calls, 0);
});

test('enqueueEmailNotifications retries enqueueing when previous status is enqueue_failed', async () => {
  const client = createInMemoryFirestoreClient();
  const { createEmailDeliveryId } = await import('./email-tasks.ts');
  const deliveryId = createEmailDeliveryId('event-retry', 'failed@example.com');
  client.seed('emailNotificationDeliveries', deliveryId, {
    deliveryId, eventId: 'event-retry', recipient: 'failed@example.com',
    message: { to: 'failed@example.com', subject: 's', text: 't' }, status: 'enqueue_failed', error: 'previous failure',
  });
  let calls = 0;
  await enqueueEmailNotifications(client, [{ to: 'failed@example.com', subject: 's', text: 't' }], 'event-retry', async () => {
    calls++;
    return { status: 'created' };
  });
  assert.equal(calls, 1);
  const doc = await client.getDoc<{ status: string }>('emailNotificationDeliveries', deliveryId);
  assert.equal(doc?.status, 'queued');
});

test('enqueueEmailNotifications preserves worker terminal status if delivery completes before enqueue returns', async () => {
  const client = createInMemoryFirestoreClient();
  const { createEmailDeliveryId } = await import('./email-tasks.ts');
  const deliveryId = createEmailDeliveryId('event-fast-worker', 'fast@example.com');
  client.seed('emailNotificationDeliveries', deliveryId, {
    deliveryId, eventId: 'event-fast-worker', recipient: 'fast@example.com',
    message: { to: 'fast@example.com', subject: 's', text: 't' }, status: 'enqueue_failed', error: 'previous failure',
  });
  await enqueueEmailNotifications(client, [{ to: 'fast@example.com', subject: 's', text: 't' }], 'event-fast-worker', async () => {
    // Simulate fast worker processing task immediately and writing 'sent' before enqueue returns
    await client.setDoc('emailNotificationDeliveries', deliveryId, { status: 'sent', sentAt: new Date().toISOString() });
    return { status: 'created' };
  });
  const doc = await client.getDoc<{ status: string }>('emailNotificationDeliveries', deliveryId);
  assert.equal(doc?.status, 'sent');
});

test('enqueueEmailNotifications skips deliveries already being sent or retried', async () => {
  const client = createInMemoryFirestoreClient();
  const { createEmailDeliveryId } = await import('./email-tasks.ts');
  for (const status of ['sending', 'retrying']) {
    const deliveryId = createEmailDeliveryId('event-3', `${status}@example.com`);
    client.seed('emailNotificationDeliveries', deliveryId, { deliveryId, status });
  }
  let calls = 0;
  await enqueueEmailNotifications(client, ['sending@example.com', 'retrying@example.com'].map(to => ({ to, subject: 's', text: 't' })), 'event-3', async () => {
    calls++;
    return { status: 'created' };
  });
  assert.equal(calls, 0);
});

test('enqueueEmailNotifications logs failures even when delivery-record persistence fails and continues other recipients', async () => {
  const client = createInMemoryFirestoreClient();
  const { createEmailDeliveryId } = await import('./email-tasks.ts');
  const failedId = createEmailDeliveryId('event-4', 'first@example.com');
  const errors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const firestore = {
    ...client,
    getDoc: async <T>(collection: string, id: string): Promise<T | null> => {
      if (collection === 'emailNotificationDeliveries' && id === failedId) throw new Error('Firestore read unavailable');
      return client.getDoc<T>(collection, id);
    },
    setDoc: async <T extends object>(collection: string, id: string, data: T): Promise<void> => {
      if (collection === 'emailNotificationDeliveries' && id === failedId) throw new Error('Firestore write unavailable');
      return client.setDoc(collection, id, data);
    },
  };
  const enqueued: string[] = [];
  try {
    await enqueueEmailNotifications(firestore, ['first@example.com', 'second@example.com'].map(to => ({ to, subject: 's', text: 't' })), 'event-4', async ({ deliveryId }) => {
      enqueued.push(deliveryId);
      return { status: 'created' };
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(enqueued, [createEmailDeliveryId('event-4', 'second@example.com')]);
  assert.ok(errors.some(line => line.includes('event_email_enqueue_failed')));
  assert.ok(errors.some(line => line.includes('event_email_enqueue_failure_persist_failed')));
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
