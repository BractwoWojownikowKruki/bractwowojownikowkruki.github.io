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
