import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthError } from './auth.ts';

export { AuthError };

// Stateless, HMAC-signed first-party session, replacing the raw Google ID token in
// localStorage (see KRKG-0036 design-v2.md). `iat`/`reauthAt` are frozen at the moment of a
// real Google credential exchange and never touched by sliding renewal - `iat` bounds the
// session's absolute lifetime, `reauthAt` is what step-up freshness checks read, kept as a
// distinct field so a future change to one doesn't silently move the other. `jti` stays stable
// across renewals of one continuous session (not reissued each renewal) so a future revocation
// list, if ever added, can kill a whole session rather than just its current cookie instance.
export interface SessionClaims {
  v: string;
  sub: string;
  email: string;
  // Captured once at login from the verified Google ID token (auth.ts's VerifiedIdentity
  // already carries these) and frozen across renewals, same as sub/email - used only for the
  // upload-attribution "Dodane przez" display, so a slightly stale name/photo across a long
  // sliding session is an acceptable trade against re-deriving them from Google on every call.
  name?: string;
  picture?: string;
  iat: number;
  reauthAt: number;
  exp: number;
  jti: string;
}

export interface SessionSigningKey {
  v: string;
  secret: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function signClaims(claims: SessionClaims, secret: string): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function issueSessionToken(
  identity: { sub: string; email: string; name?: string; picture?: string },
  key: SessionSigningKey,
  now: number,
  slidingWindowMs: number,
): string {
  const claims: SessionClaims = {
    v: key.v,
    sub: identity.sub,
    email: identity.email,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.picture ? { picture: identity.picture } : {}),
    iat: now,
    reauthAt: now,
    exp: now + slidingWindowMs,
    jti: randomUUID(),
  };
  return signClaims(claims, key.secret);
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.v === 'string' &&
    typeof c.sub === 'string' &&
    c.sub.length > 0 &&
    typeof c.email === 'string' &&
    c.email.length > 0 &&
    (c.name === undefined || typeof c.name === 'string') &&
    (c.picture === undefined || typeof c.picture === 'string') &&
    typeof c.iat === 'number' &&
    typeof c.reauthAt === 'number' &&
    typeof c.exp === 'number' &&
    typeof c.jti === 'string' &&
    c.jti.length > 0
  );
}

// `keys` accepts any of a short list of {v, secret} pairs so a rotated-out secret can still
// verify tokens it issued during a bounded overlap window - `issueSessionToken`/
// `maybeRenewSessionToken` take a single key (the current one) since only rotation *reads* need
// the whole list.
export function verifySessionToken(token: string, keys: SessionSigningKey[], now: number, maxLifetimeMs: number): SessionClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new AuthError('Nieprawidłowy token sesji.', 401);
  }
  const [payloadB64, signature] = parts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new AuthError('Nieprawidłowy token sesji.', 401);
  }
  if (!isSessionClaims(parsed)) {
    throw new AuthError('Nieprawidłowy token sesji.', 401);
  }
  const claims = parsed;
  const key = keys.find(k => k.v === claims.v);
  if (!key) {
    throw new AuthError('Token sesji podpisany nieznanym kluczem.', 401);
  }
  const expectedSignature = sign(payloadB64, key.secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    throw new AuthError('Nieprawidłowy podpis tokenu sesji.', 401);
  }
  if (claims.exp < now) {
    throw new AuthError('Sesja wygasła. Zaloguj się ponownie.', 401);
  }
  // Defense in depth, independent of trusting the issuing code path: even though exp can't be
  // forged without invalidating the signature, this enforces the absolute-lifetime invariant
  // unconditionally rather than relying solely on issueSessionToken/maybeRenewSessionToken
  // never producing a longer-lived token.
  if (claims.exp - claims.iat > maxLifetimeMs) {
    throw new AuthError('Sesja przekracza maksymalny dozwolony czas życia.', 401);
  }
  return claims;
}

// Sliding renewal: call after a successful verifySessionToken to decide whether to reissue with
// a fresh expiry. Renews once past the halfway point of the current validity window, never past
// `iat + maxLifetimeMs` - see design-v2.md "Sliding renewal" (14-day window, 30-day cap).
// Returns null when no renewal is due (including once the absolute cap has been reached, at
// which point the session is left to expire naturally rather than kept alive indefinitely).
// Returns `exp` alongside the token so an HTTP-level caller can compute the cookie's Max-Age
// without duplicating this function's cap-computation formula or re-verifying the token it just
// issued.
export function maybeRenewSessionToken(
  claims: SessionClaims,
  key: SessionSigningKey,
  now: number,
  slidingWindowMs: number,
  maxLifetimeMs: number,
): { token: string; exp: number } | null {
  const windowStart = claims.exp - slidingWindowMs;
  const halfway = windowStart + slidingWindowMs / 2;
  if (now < halfway) {
    return null;
  }
  const cappedExp = Math.min(now + slidingWindowMs, claims.iat + maxLifetimeMs);
  if (cappedExp <= claims.exp) {
    return null;
  }
  const renewed: SessionClaims = { ...claims, v: key.v, exp: cappedExp };
  return { token: signClaims(renewed, key.secret), exp: cappedExp };
}

// Step-up freshness for privileged routes (authenticateAdmin/authenticateModerator, and the
// member "upload to a gallery I don't own" action) - see design-v2.md Phase 1 point 9. This is
// deliberately NOT the same check as session validity: it proves a *recent real Google sign-in*
// (reauthAt), not just recent activity, since sliding renewal alone would let a stolen cookie
// stay "fresh" indefinitely purely by being used for ordinary calls.
export function checkReauthFreshness(claims: SessionClaims, now: number, freshnessWindowMs: number): void {
  if (now - claims.reauthAt > freshnessWindowMs) {
    throw new AuthError('Ta czynność wymaga ponownego zalogowania - sesja nie jest wystarczająco świeża.', 401);
  }
}
