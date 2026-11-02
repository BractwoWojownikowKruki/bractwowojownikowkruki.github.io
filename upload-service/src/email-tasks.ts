import { createHash } from 'node:crypto';
import type { MailMessage } from './mailer.ts';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const CLOUD_TASKS_API = 'https://cloudtasks.googleapis.com/v2';

export interface EmailTaskPayload {
  deliveryId: string;
  eventId: string;
  recipient: string;
  message: MailMessage;
}

export interface CloudTasksEnqueuerOptions {
  projectId: string;
  location: string;
  queueName: string;
  serviceUrl: string;
  serviceAccountEmail: string;
  fetchImpl?: typeof fetch;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/**
 * Builds a stable, opaque identifier for the single-recipient email produced by one event.
 * The event identifier provides event-level uniqueness; a hash keeps addresses out of task names.
 */
export function createEmailDeliveryId(eventId: string, recipient: string): string {
  const safeEventId = eventId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'event';
  const normalizedRecipient = recipient.trim().toLowerCase();
  const recipientHash = createHash('sha256').update(normalizedRecipient).digest('hex').slice(0, 32);
  return `${safeEventId}-${recipientHash}`;
}

/** Clears the metadata access-token cache between isolated tests. */
export function resetCloudTasksTokenCacheForTests(): void {
  cachedAccessToken = null;
}

async function getAccessToken(fetchImpl: typeof fetch): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.token;
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!response.ok) throw new Error(`Cloud Tasks credential lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error('Cloud Tasks credential lookup returned an invalid token response');
  }
  cachedAccessToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

/**
 * Enqueues one immutable email snapshot per active recipient. Cloud Tasks provides durable,
 * rate-controlled delivery; the deterministic task name makes repeated enqueue attempts safe.
 */
export function createCloudTasksEnqueuer(options: CloudTasksEnqueuerOptions): (payload: EmailTaskPayload) => Promise<{ status: 'created' | 'already_exists' }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const queuePath = `projects/${encodeURIComponent(options.projectId)}/locations/${encodeURIComponent(options.location)}/queues/${encodeURIComponent(options.queueName)}`;
  const workerUrl = `${options.serviceUrl.replace(/\/$/, '')}/internal/notifications/email`;

  return async payload => {
    const taskPath = `${queuePath}/tasks/${payload.deliveryId}`;
    const taskName = `${CLOUD_TASKS_API}/${taskPath}`;
    const token = await getAccessToken(fetchImpl);
    const response = await fetchImpl(`${CLOUD_TASKS_API}/${queuePath}/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        task: {
          name: taskName,
          httpRequest: {
            httpMethod: 'POST',
            url: workerUrl,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
            oidcToken: {
              serviceAccountEmail: options.serviceAccountEmail,
              audience: options.serviceUrl,
            },
          },
        },
      }),
    });
    if (response.status === 409) return { status: 'already_exists' };
    if (!response.ok) throw new Error(`Cloud Tasks create task failed: HTTP ${response.status}`);
    return { status: 'created' };
  };
}
