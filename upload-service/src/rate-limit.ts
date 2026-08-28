import type { IncomingMessage } from 'node:http';

// Guards the public, unauthenticated social-media endpoints (/facebook-posts, /instagram-posts,
// /youtube-videos) against request-volume abuse driving up Cloud Run cost - each request is
// cheap (served from social-media.ts's 6h in-memory cache), but at high enough volume that adds
// up. Deliberately in-memory, no new dependency - same style as the cache Map in social-media.ts.
// Cloud Run scales this service to zero when idle (no min-instances set), which periodically
// resets this state too, bounding how large the Map can grow in practice.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const hits = new Map<string, { count: number; windowStart: number }>();

export function isRateLimited(ip: string, now: number = Date.now()): boolean {
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

export function resetRateLimitForTests(): void {
  hits.clear();
}

// Cloud Run's front-end proxy sets X-Forwarded-For to "<client>, <proxy1>, ...";  the first
// entry is the original client. Falls back to the raw socket address (e.g. for local/dev runs
// not sitting behind that proxy).
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) return value.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}
