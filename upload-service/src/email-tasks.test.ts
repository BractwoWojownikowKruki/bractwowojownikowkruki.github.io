import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloudTasksEnqueuer,
  createEmailDeliveryId,
  resetCloudTasksTokenCacheForTests,
  type EmailTaskPayload,
} from './email-tasks.ts';

const payload: EmailTaskPayload = { deliveryId: 'event-1-abc123' };

test('createEmailDeliveryId is stable and scoped to event and normalized recipient', () => {
  assert.equal(createEmailDeliveryId('event-1', ' Member@Example.com '), createEmailDeliveryId('event-1', 'member@example.com'));
  assert.notEqual(createEmailDeliveryId('event-1', 'member@example.com'), createEmailDeliveryId('event-2', 'member@example.com'));
  assert.match(createEmailDeliveryId('event-1', 'member@example.com'), /^event-1-[a-f0-9]{32}$/);
});

test('Cloud Tasks enqueuer creates an authenticated task containing only the delivery id', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.includes('metadata.google.internal')) {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ name: 'created-task' }), { status: 200 });
  }) as typeof fetch;

  const enqueue = createCloudTasksEnqueuer({
    projectId: 'krucze-galery-upload',
    location: 'europe-west1',
    queueName: 'email-notifications',
    serviceUrl: 'https://upload.example.run.app',
    serviceAccountEmail: 'email-worker@example.iam.gserviceaccount.com',
    fetchImpl,
  });

  assert.deepEqual(await enqueue(payload), { status: 'created', taskName: 'projects/krucze-galery-upload/locations/europe-west1/queues/email-notifications/tasks/event-1-abc123' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  assert.equal((calls[0].init.headers as Record<string, string>)['Metadata-Flavor'], 'Google');
  assert.equal(calls[1].url, 'https://cloudtasks.googleapis.com/v2/projects/krucze-galery-upload/locations/europe-west1/queues/email-notifications/tasks');
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, 'Bearer access-token');
  const request = JSON.parse(String(calls[1].init.body));
  assert.equal(request.task.name, 'projects/krucze-galery-upload/locations/europe-west1/queues/email-notifications/tasks/event-1-abc123');
  assert.equal(request.task.httpRequest.url, 'https://upload.example.run.app/internal/notifications/email');
  assert.deepEqual(request.task.httpRequest.oidcToken, {
    serviceAccountEmail: 'email-worker@example.iam.gserviceaccount.com',
    audience: 'https://upload.example.run.app',
  });
  assert.deepEqual(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64').toString('utf8')), payload);
});

test('Cloud Tasks duplicate task names are treated as already enqueued', async () => {
  const fetchImpl = (async (url: string) => url.includes('metadata.google.internal')
    ? new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }))
    : new Response(JSON.stringify({ error: { message: 'Task already exists' } }), { status: 409 })) as typeof fetch;
  const enqueue = createCloudTasksEnqueuer({
    projectId: 'krucze-galery-upload', location: 'europe-west1', queueName: 'email-notifications',
    serviceUrl: 'https://upload.example.run.app', serviceAccountEmail: 'email-worker@example.iam.gserviceaccount.com', fetchImpl,
  });

  assert.deepEqual(await enqueue(payload), { status: 'already_exists', taskName: 'projects/krucze-galery-upload/locations/europe-west1/queues/email-notifications/tasks/event-1-abc123' });
});

test('Cloud Tasks enqueuer refreshes a rejected cached access token once', async () => {
  resetCloudTasksTokenCacheForTests();
  let tokenNumber = 0;
  let taskRequestNumber = 0;
  const fetchImpl = (async (url: string) => {
    if (url.includes('metadata.google.internal')) {
      tokenNumber++;
      return new Response(JSON.stringify({ access_token: `token-${tokenNumber}`, expires_in: 3600 }));
    }
    taskRequestNumber++;
    return taskRequestNumber === 1 ? new Response('', { status: 401 }) : new Response('{}', { status: 200 });
  }) as typeof fetch;
  const enqueue = createCloudTasksEnqueuer({
    projectId: 'krucze-galery-upload', location: 'europe-west1', queueName: 'email-notifications',
    serviceUrl: 'https://upload.example.run.app', serviceAccountEmail: 'email-worker@example.iam.gserviceaccount.com', fetchImpl,
  });
  assert.equal((await enqueue(payload)).status, 'created');
  assert.equal(tokenNumber, 2);
  assert.equal(taskRequestNumber, 2);
  resetCloudTasksTokenCacheForTests();
});
