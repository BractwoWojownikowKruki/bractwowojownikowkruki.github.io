// Web Push notifications (admin-facing "new application" / "new photos" alerts) sent via the
// `web-push` library with VAPID keys. Same fail-safe posture as mailer.ts: with VAPID_* unset the
// service boots normally, GET /profile/notifications reports push as unavailable, and every send
// reports "not_configured" instead of throwing. See scripts/generate-vapid-keys.ts for the
// one-time key setup.
import webpush from 'web-push';

export type PushSendStatus = 'sent' | 'gone' | 'failed' | 'not_configured';

// The browser's PushSubscription.toJSON() shape, minus expirationTime (never used here).
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  // Site-relative path the notification opens when clicked (service worker's notificationclick).
  url: string;
}

export interface Pusher {
  // Public VAPID key the browser needs for pushManager.subscribe; null when push is disabled.
  publicKey: string | null;
  // Never throws, same reasoning as Mailer.send. 'gone' means the push service reported the
  // subscription as expired or unsubscribed (HTTP 404/410).
  send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<PushSendStatus>;
}

export function createDisabledPusher(): Pusher {
  return { publicKey: null, send: async () => 'not_configured' };
}

export interface WebPushOptions {
  publicKey: string;
  privateKey: string;
  // VAPID "subject" - a mailto: or https: contact the push service can reach about abuse.
  subject: string;
  sendImpl?: typeof webpush.sendNotification;
}

// Hours a push service may hold an undelivered notification (device offline). A day-old "new
// application" alert is still useful; anything older the admin will see on the site anyway.
const TIME_TO_LIVE_SECONDS = 24 * 60 * 60;

export function createWebPusher(opts: WebPushOptions): Pusher {
  const sendImpl = opts.sendImpl ?? webpush.sendNotification.bind(webpush);
  const vapidDetails = { subject: opts.subject, publicKey: opts.publicKey, privateKey: opts.privateKey };
  return {
    publicKey: opts.publicKey,
    async send(subscription, message): Promise<PushSendStatus> {
      try {
        await sendImpl(subscription, JSON.stringify(message), { vapidDetails, TTL: TIME_TO_LIVE_SECONDS });
        return 'sent';
      } catch (err) {
        const statusCode = (err as { statusCode?: unknown }).statusCode;
        if (statusCode === 404 || statusCode === 410) return 'gone';
        console.error(`Wysłanie powiadomienia push nie powiodło się${typeof statusCode === 'number' ? `: HTTP ${statusCode}` : ''}:`, err);
        return 'failed';
      }
    },
  };
}

// Push endpoints are always HTTPS URLs on the browser vendor's push service; anything else is
// rejected before it is stored, so the server never POSTs to an arbitrary caller-chosen host
// scheme. Keys are base64url strings of a fixed-ish size (p256dh: 65-byte point, auth: 16 bytes).
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

export function parsePushSubscription(value: unknown): PushSubscriptionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!keys || typeof keys !== 'object') return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (p256dh.length < 80 || p256dh.length > 100 || !BASE64URL.test(p256dh)) return null;
  if (auth.length < 16 || auth.length > 32 || !BASE64URL.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}
