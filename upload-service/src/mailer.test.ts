import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMessage, createDisabledMailer, createGmailMailer, isSendableAddress, resetGmailTokenCacheForTests } from './mailer.ts';

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

test('buildRawMessage encodes the subject and From name as UTF-8 words and the body as base64', () => {
  const raw = decodeRaw(buildRawMessage('Bractwo Wojowników Kruki <bractwo@example.com>', {
    to: 'jan@example.com',
    subject: 'Zgłoszenie: Łukasz\r\nBcc: evil@example.com',
    text: 'Zażółć gęślą jaźń',
  }));
  const [headers, body] = raw.split('\r\n\r\n');
  assert.match(headers, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <bractwo@example\.com>\r\n/);
  assert.match(headers, /\r\nTo: jan@example\.com\r\n/);
  assert.ok(!/\r\nBcc:/i.test(headers), 'a CR/LF in the subject must not open a new header');
  const subjectWord = /Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(headers)![1];
  assert.equal(Buffer.from(subjectWord, 'base64').toString('utf8'), 'Zgłoszenie: Łukasz\r\nBcc: evil@example.com');
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Zażółć gęślą jaźń');
});

test('isSendableAddress rejects anything that could break out of the To header', () => {
  assert.equal(isSendableAddress('jan.kowalski@example.com'), true);
  assert.equal(isSendableAddress('jan@example.com\r\nBcc: x@example.com'), false);
  assert.equal(isSendableAddress('a@example.com, b@example.com'), false);
  assert.equal(isSendableAddress('Jan <jan@example.com>'), false);
  assert.equal(isSendableAddress('no-at-sign'), false);
});

test('createDisabledMailer reports not_configured', async () => {
  assert.equal(await createDisabledMailer().send({ to: 'a@example.com', subject: 's', text: 't' }), 'not_configured');
});

test('createGmailMailer exchanges the refresh token once and posts the raw message to Gmail', async () => {
  resetGmailTokenCacheForTests();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    return new Response('{}');
  }) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r', from: 'X <x@example.com>', fetchImpl });
  assert.equal(await mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), 'sent');
  assert.equal(await mailer.send({ to: 'b@example.com', subject: 's', text: 't' }), 'sent');
  assert.equal(calls.filter(c => c.url.includes('oauth2')).length, 1);
  const send = calls.find(c => c.url.includes('gmail'))!;
  assert.equal(send.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal((send.init.headers as Record<string, string>).authorization, 'Bearer tok');
  assert.match(decodeRaw(JSON.parse(String(send.init.body)).raw), /\r\nTo: a@example\.com\r\n/);
});

test('createGmailMailer never throws: HTTP errors, token failures and bad addresses report failed', async () => {
  resetGmailTokenCacheForTests();
  let gmailStatus = 500;
  const fetchImpl = (async (url: string) => {
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    return new Response('{}', { status: gmailStatus });
  }) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r2', from: 'x@example.com', fetchImpl });
  assert.equal(await mailer.send({ to: 'a@example.com', subject: 's', text: 't' }), 'failed');
  gmailStatus = 200;
  assert.equal(await mailer.send({ to: 'bad address', subject: 's', text: 't' }), 'failed');

  resetGmailTokenCacheForTests();
  const brokenToken = createGmailMailer({
    clientId: 'c', clientSecret: 's', refreshToken: 'r3', from: 'x@example.com',
    fetchImpl: (async () => new Response('nope', { status: 400 })) as typeof fetch,
  });
  assert.equal(await brokenToken.send({ to: 'a@example.com', subject: 's', text: 't' }), 'failed');
});

test('createGmailMailer returns the Gmail message id for an accepted message', async () => {
  resetGmailTokenCacheForTests();
  const fetchImpl = (async (url: string) => url.includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
    : new Response(JSON.stringify({ id: 'gmail-message-123' }))) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r4', from: 'x@example.com', fetchImpl });

  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'sent',
    messageId: 'gmail-message-123',
    httpStatus: 200,
  });
});

test('createGmailMailer identifies retryable Gmail rate-limit 403 and 429 results', async () => {
  resetGmailTokenCacheForTests();
  let status = 403;
  let reason = 'userRateLimitExceeded';
  const fetchImpl = (async (url: string) => url.includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
    : new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status })) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r5', from: 'x@example.com', fetchImpl });

  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'failed', httpStatus: 403, reason: 'userRateLimitExceeded', retryable: true,
  });
  status = 429;
  reason = '';
  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'failed', httpStatus: 429, reason: null, retryable: true,
  });
});

test('createGmailMailer marks policy 403 as permanent and network errors retryable', async () => {
  resetGmailTokenCacheForTests();
  let failWithNetworkError = false;
  const fetchImpl = (async (url: string) => {
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (failWithNetworkError) throw new Error('network down');
    return new Response(JSON.stringify({ error: { errors: [{ reason: 'domainPolicy' }] } }), { status: 403 });
  }) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r6', from: 'x@example.com', fetchImpl });

  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'failed', httpStatus: 403, reason: 'domainPolicy', retryable: false,
  });
  failWithNetworkError = true;
  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'failed', httpStatus: null, reason: 'network_error', retryable: true,
  });
});

test('createGmailMailer refreshes an access token rejected with 401 before retrying the send', async () => {
  resetGmailTokenCacheForTests();
  let tokenRequests = 0;
  let sendRequests = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.includes('oauth2')) {
      tokenRequests++;
      return new Response(JSON.stringify({ access_token: `token-${tokenRequests}`, expires_in: 3600 }));
    }
    sendRequests++;
    const authorization = (init?.headers as Record<string, string>).authorization;
    if (authorization === 'Bearer token-1') return new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), { status: 401 });
    return new Response(JSON.stringify({ id: 'accepted-after-refresh' }));
  }) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r7', from: 'x@example.com', fetchImpl });
  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'sent', messageId: 'accepted-after-refresh', httpStatus: 200,
  });
  assert.equal(tokenRequests, 2);
  assert.equal(sendRequests, 2);
});

test('createGmailMailer treats a 401 from a freshly refreshed token as terminal', async () => {
  resetGmailTokenCacheForTests();
  let tokenRequests = 0;
  const fetchImpl = (async (url: string) => {
    if (url.includes('oauth2')) {
      tokenRequests++;
      return new Response(JSON.stringify({ access_token: `token-${tokenRequests}`, expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), { status: 401 });
  }) as typeof fetch;
  const mailer = createGmailMailer({ clientId: 'c', clientSecret: 's', refreshToken: 'r8', from: 'x@example.com', fetchImpl });
  assert.deepEqual(await mailer.sendDetailed!({ to: 'a@example.com', subject: 's', text: 't' }), {
    status: 'failed', httpStatus: 401, reason: 'UNAUTHENTICATED', retryable: false,
  });
  assert.equal(tokenRequests, 2);
});
