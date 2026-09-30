import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisabledPusher, createWebPusher, parsePushSubscription } from './pusher.ts';

const P256DH = 'B' + 'A'.repeat(86);
const AUTH = 'A'.repeat(22);
const SUBSCRIPTION = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: P256DH, auth: AUTH } };
const MESSAGE = { title: 'T', body: 'B', url: '/admin/zgloszenia/' };

test('parsePushSubscription keeps only endpoint + keys and rejects anything off-shape', () => {
  assert.deepEqual(parsePushSubscription({ ...SUBSCRIPTION, expirationTime: null, extra: 1 }), SUBSCRIPTION);
  assert.equal(parsePushSubscription(null), null);
  assert.equal(parsePushSubscription({ ...SUBSCRIPTION, endpoint: 'http://push.example.com/x' }), null);
  assert.equal(parsePushSubscription({ ...SUBSCRIPTION, endpoint: 'not a url' }), null);
  assert.equal(parsePushSubscription({ ...SUBSCRIPTION, endpoint: `https://x.example.com/${'a'.repeat(2100)}` }), null);
  assert.equal(parsePushSubscription({ endpoint: SUBSCRIPTION.endpoint }), null);
  assert.equal(parsePushSubscription({ ...SUBSCRIPTION, keys: { p256dh: 'short', auth: AUTH } }), null);
  assert.equal(parsePushSubscription({ ...SUBSCRIPTION, keys: { p256dh: P256DH, auth: 'bad chars here!!!!!!!' } }), null);
});

test('createWebPusher maps success, 404/410 and other failures to a status and never throws', async () => {
  const calls: unknown[][] = [];
  let failWith: unknown = null;
  const pusher = createWebPusher({
    publicKey: 'pub',
    privateKey: 'priv',
    subject: 'mailto:x@example.com',
    sendImpl: (async (...args: unknown[]) => {
      calls.push(args);
      if (failWith) throw failWith;
      return { statusCode: 201, body: '', headers: {} };
    }) as never,
  });
  assert.equal(pusher.publicKey, 'pub');
  assert.equal(await pusher.send(SUBSCRIPTION, MESSAGE), 'sent');
  assert.deepEqual(JSON.parse(calls[0][1] as string), MESSAGE);
  assert.deepEqual((calls[0][2] as { vapidDetails: unknown }).vapidDetails, { subject: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' });
  failWith = Object.assign(new Error('gone'), { statusCode: 410 });
  assert.equal(await pusher.send(SUBSCRIPTION, MESSAGE), 'gone');
  failWith = Object.assign(new Error('not found'), { statusCode: 404 });
  assert.equal(await pusher.send(SUBSCRIPTION, MESSAGE), 'gone');
  failWith = Object.assign(new Error('boom'), { statusCode: 500 });
  assert.equal(await pusher.send(SUBSCRIPTION, MESSAGE), 'failed');
  failWith = new Error('network');
  assert.equal(await pusher.send(SUBSCRIPTION, MESSAGE), 'failed');
});

test('createDisabledPusher has no public key and reports not_configured', async () => {
  const pusher = createDisabledPusher();
  assert.equal(pusher.publicKey, null);
  assert.equal(await pusher.send(SUBSCRIPTION, MESSAGE), 'not_configured');
});
