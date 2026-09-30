// E-mail notifications (new member application, membership decision, photo decision) sent via
// the Gmail API as bractwo.wojownikow.kruki@gmail.com. Same manual refresh-token exchange as
// drive.ts/sheets.ts - no googleapis/nodemailer dependency - and the same fail-safe posture as
// sheets.ts: with GMAIL_* unset the service boots normally and every send reports
// "not_configured" instead of throwing. See scripts/get-gmail-refresh-token.ts for the one-time
// OAuth setup (gmail.send scope only).

export type MailSendStatus = 'sent' | 'failed' | 'not_configured';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  // Never throws: a notification is always a side effect of an already-committed business write,
  // so a Gmail outage must not turn that write's response into an error.
  send(message: MailMessage): Promise<MailSendStatus>;
}

export function createDisabledMailer(): Mailer {
  return { send: async () => 'not_configured' };
}

export interface GmailMailerOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  // The From header. Gmail always sends as the authorized account; this only sets the display
  // name shown next to it.
  from: string;
  fetchImpl?: typeof fetch;
}

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getGmailAccessToken(opts: GmailMailerOptions, now: () => number = Date.now): Promise<string> {
  const cached = tokenCache.get(opts.refreshToken);
  if (cached && cached.expiresAt > now() + 60_000) return cached.accessToken;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) throw new Error(`Odświeżenie tokenu Gmail nie powiodło się: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(opts.refreshToken, { accessToken: body.access_token, expiresAt: now() + body.expires_in * 1000 });
  return body.access_token;
}

export function resetGmailTokenCacheForTests(): void {
  tokenCache.clear();
}

// RFC 2047 encoded-word: subjects carry user-supplied names (Polish diacritics) and, more
// importantly, can never smuggle a CR/LF into the header block once base64-encoded.
function encodeHeaderWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// Deliberately strict: the address goes into a raw header line, so anything outside a plain
// local@domain shape (whitespace, CR/LF, angle brackets, commas) is rejected outright.
const PLAIN_ADDRESS = /^[^\s<>,;"@]+@[^\s<>,;"@]+\.[^\s<>,;"@]+$/;

export function isSendableAddress(address: string): boolean {
  return PLAIN_ADDRESS.test(address);
}

function encodeFrom(from: string): string {
  const match = /^(.*)<([^<>]+)>$/.exec(from.trim());
  if (!match) return from.trim();
  const name = match[1].trim();
  return name ? `${encodeHeaderWord(name)} <${match[2]}>` : `<${match[2]}>`;
}

/** Builds the RFC 5322 message Gmail's `messages.send` expects, base64url-encoded. */
export function buildRawMessage(from: string, message: MailMessage): string {
  const bodyBase64 = Buffer.from(message.text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const mime = [
    `From: ${encodeFrom(from)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderWord(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyBase64,
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export function createGmailMailer(opts: GmailMailerOptions): Mailer {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async send(message): Promise<MailSendStatus> {
      if (!isSendableAddress(message.to)) {
        console.error(`Pominięto powiadomienie e-mail - nieprawidłowy adres odbiorcy: ${JSON.stringify(message.to)}`);
        return 'failed';
      }
      try {
        const token = await getGmailAccessToken(opts);
        const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ raw: buildRawMessage(opts.from, message) }),
        });
        if (!res.ok) {
          console.error(`Wysłanie powiadomienia e-mail nie powiodło się: HTTP ${res.status}`);
          return 'failed';
        }
        return 'sent';
      } catch (err) {
        console.error('Wysłanie powiadomienia e-mail nie powiodło się:', err);
        return 'failed';
      }
    },
  };
}
