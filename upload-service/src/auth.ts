import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { SheetAllowlist } from './allowlist.ts';

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

function base64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

export interface DecodedJwt {
  header: { kid?: string; alg?: string };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError('Nieprawidłowy format tokenu.', 401);
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  return {
    header: JSON.parse(base64UrlToBuffer(headerB64).toString('utf8')),
    payload: JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8')),
    signingInput: `${headerB64}.${payloadB64}`,
    signature: base64UrlToBuffer(signatureB64),
  };
}

export function verifyJwtSignature(decoded: DecodedJwt, jwk: Jwk): boolean {
  const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  return cryptoVerify('RSA-SHA256', Buffer.from(decoded.signingInput), key, decoded.signature);
}

export interface VerifiedIdentity {
  sub: string;
  email: string;
  // Standard Google OIDC claims, present on every ID token from the default Sign In With
  // Google flow (no extra scope needed) - optional here only because a hand-issued test token
  // might omit them, not because Google ever does. Used to attribute an uploaded photo to the
  // person who added it (see the gallery-photos upload-attribution log in server.ts).
  name?: string;
  picture?: string;
}

export function checkClaims(
  payload: Record<string, unknown>,
  expectedAudience: string,
  now: number = Date.now() / 1000,
): VerifiedIdentity {
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new AuthError('Token wystawiony przez nieznanego wystawcę.', 401);
  }
  if (payload.aud !== expectedAudience) {
    throw new AuthError('Token wystawiony dla innej aplikacji.', 401);
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new AuthError('Token wygasł.', 401);
  }
  if (payload.email_verified !== true) {
    throw new AuthError('Adres e-mail nie jest zweryfikowany.', 401);
  }
  const sub = payload.sub;
  const email = ((payload.email as string) ?? '').toLowerCase();
  if (typeof sub !== 'string' || !sub || !email) {
    throw new AuthError('Token nie zawiera wymaganych danych.', 401);
  }
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const picture = typeof payload.picture === 'string' ? payload.picture : undefined;
  return { sub, email, ...(name ? { name } : {}), ...(picture ? { picture } : {}) };
}

export function checkAllowlist(identity: VerifiedIdentity, allowedEmails: string[]): VerifiedIdentity {
  if (!allowedEmails.includes(identity.email)) {
    throw new AuthError('Ten adres e-mail nie ma uprawnień do przesyłania zdjęć.', 403);
  }
  return identity;
}

export type JwksProvider = () => Promise<Jwk[]>;

let cachedJwks: { keys: Jwk[]; expiresAt: number } | null = null;

export async function fetchGoogleJwks(): Promise<Jwk[]> {
  if (cachedJwks && cachedJwks.expiresAt > Date.now()) {
    return cachedJwks.keys;
  }
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) {
    throw new AuthError('Nie udało się pobrać kluczy Google do weryfikacji tokenu.', 503);
  }
  const data = (await res.json()) as { keys: Jwk[] };
  cachedJwks = { keys: data.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return data.keys;
}

export async function verifyGoogleIdToken(
  token: string,
  expectedAudience: string,
  jwksProvider: JwksProvider = fetchGoogleJwks,
): Promise<VerifiedIdentity> {
  const decoded = decodeJwt(token);
  const jwks = await jwksProvider();
  const jwk = jwks.find(k => k.kid === decoded.header.kid);
  if (!jwk) {
    throw new AuthError('Nie znaleziono klucza podpisującego token.', 401);
  }
  if (!verifyJwtSignature(decoded, jwk)) {
    throw new AuthError('Nieprawidłowy podpis tokenu.', 401);
  }
  return checkClaims(decoded.payload, expectedAudience);
}

export async function verifyUploader(
  req: IncomingMessage,
  expectedAudience: string,
  allowlist: SheetAllowlist,
  jwksProvider: JwksProvider = fetchGoogleJwks,
): Promise<VerifiedIdentity> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    throw new AuthError('Brak nagłówka Authorization: Bearer <token>.', 401);
  }
  const identity = await verifyGoogleIdToken(token, expectedAudience, jwksProvider);
  const allowedEmails = await allowlist.getEmails();
  return checkAllowlist(identity, allowedEmails);
}
