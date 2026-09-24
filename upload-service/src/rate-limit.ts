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

// KRKG-0108: this is a client-controlled header - the FIRST entry is whatever the caller sends
// and never a rate-limit boundary on its own (a caller can send a fresh, distinct first entry on
// every request and never get counted twice). The LAST entry is the one Google's own frontend
// (GFE) appends from its own view of the TCP connection, which the caller cannot influence -
// confirmed for this exact deployment (api.kruki.org is a plain Cloud Run domain mapping to the
// same GFE the *.run.app URL uses, with no separate external HTTPS Load Balancer in front - the
// project has Compute Engine/load-balancer APIs disabled) by sending a request with a forged,
// multi-entry X-Forwarded-For and reading it back from Cloud Run's own auto-generated request log
// (`httpRequest.remoteIp`, which Google's infrastructure computes independently of the header):
// it showed the real caller IP regardless of the forged header, matching Google Cloud's
// documented behavior of appending the resolved client IP after whatever the incoming header
// already contained. Falls back to the raw socket address when there is no header at all (local/
// dev runs not sitting behind that proxy), or when the header's last entry is empty (a malformed
// header GFE would never actually send, e.g. a trailing comma) - never an empty string, which
// would otherwise silently pool every such caller into one shared rate-limit bucket.
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  if (value) {
    const parts = value.split(',');
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
