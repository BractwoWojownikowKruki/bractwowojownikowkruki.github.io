import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './auth.ts';

export { AuthError };

export interface SubmissionClaims {
  folderId: string;
  sub: string;
  exp: number;
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

export function issueSubmissionToken(claims: SubmissionClaims, secret: string): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function verifySubmissionToken(token: string, secret: string, now: number = Date.now()): SubmissionClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new AuthError('Nieprawidłowy token zgłoszenia.', 401);
  }
  const [payloadB64, signature] = parts;
  const expectedSignature = sign(payloadB64, secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    throw new AuthError('Nieprawidłowy podpis tokenu zgłoszenia.', 401);
  }
  let claims: SubmissionClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64)) as SubmissionClaims;
  } catch {
    throw new AuthError('Nieprawidłowy token zgłoszenia.', 401);
  }
  if (claims.exp < now) {
    throw new AuthError('Token zgłoszenia wygasł. Rozpocznij przesyłanie ponownie.', 401);
  }
  return claims;
}

export function checkSubmissionOwnership(claims: SubmissionClaims, folderId: string, sub: string): void {
  if (claims.folderId !== folderId) {
    throw new AuthError('Token zgłoszenia nie pasuje do tego folderu.', 403);
  }
  if (claims.sub !== sub) {
    throw new AuthError('Ten użytkownik nie jest właścicielem tego zgłoszenia.', 403);
  }
}
