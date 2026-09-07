import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsClient, createDisabledSheetsClient } from './sheets.ts';

function fakeMember(overrides: Partial<{ email: string; fullName: string; nickname: string | null; sectionId: string; status: string }> = {}) {
  return {
    email: 'a@example.com',
    fullName: 'A',
    nickname: null,
    sectionId: 's1',
    status: 'active',
    ...overrides,
  } as never;
}

test('createDisabledSheetsClient.syncAllMembers resolves without making any network call and reports not_configured', async () => {
  const client = createDisabledSheetsClient();
  const status = await client.syncAllMembers([]);
  assert.equal(status, 'not_configured');
});

test('createSheetsClient.syncAllMembers sends a single batchUpdate request covering a fixed-size range', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  const client = createSheetsClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r-1', sheetId: 'sheet-1', fetchImpl });
  const status = await client.syncAllMembers([fakeMember()]);
  assert.equal(status, 'ok');
  const sheetsCall = calls.find(c => c.url.includes(':batchUpdate'));
  assert.ok(sheetsCall, 'expected exactly one batchUpdate call');
  assert.equal(sheetsCall!.url, 'https://sheets.googleapis.com/v4/spreadsheets/sheet-1:batchUpdate');
  const payload = JSON.parse(sheetsCall!.body);
  assert.ok(Array.isArray(payload.requests) && payload.requests.length === 1, 'batchUpdate must be a single atomic request');
});

test('createSheetsClient.syncAllMembers includes every member passed to it, not just one', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  const client = createSheetsClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r-2', sheetId: 'sheet-1', fetchImpl });
  await client.syncAllMembers([
    fakeMember({ email: 'a@example.com', status: 'suspended' }),
    fakeMember({ email: 'b@example.com', status: 'active' }),
  ]);
  const sheetsCall = calls.find(c => c.url.includes(':batchUpdate'))!;
  const payload = JSON.parse(sheetsCall.body);
  const rows = payload.requests[0].updateCells.rows;
  const emailCells = rows.map((r: { values: Array<{ userEnteredValue: { stringValue: string } }> }) => r.values[0].userEnteredValue.stringValue);
  assert.ok(emailCells.includes('a@example.com'), 'the suspended member must still be present');
  assert.ok(emailCells.includes('b@example.com'), 'the active member must still be present');
});

test('createSheetsClient.syncAllMembers pads unused rows with blank cells so a shrinking list clears stale rows', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  const client = createSheetsClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r-3', sheetId: 'sheet-1', fetchImpl });
  await client.syncAllMembers([fakeMember()]);
  const sheetsCall = calls.find(c => c.url.includes(':batchUpdate'))!;
  const payload = JSON.parse(sheetsCall.body);
  const rows = payload.requests[0].updateCells.rows;
  assert.equal(rows.length, 500, 'the request must always cover the full fixed range');
  const lastRowCells = rows[499].values.map((v: { userEnteredValue: { stringValue: string } }) => v.userEnteredValue.stringValue);
  assert.deepEqual(lastRowCells, ['', '', '', '', '']);
});

test('createSheetsClient.syncAllMembers returns failed without throwing when the batchUpdate call errors', async () => {
  const fetchImpl = (async (url: string) => {
    if (url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
  }) as typeof fetch;
  const client = createSheetsClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r-4', sheetId: 'sheet-1', fetchImpl });
  const status = await client.syncAllMembers([]);
  assert.equal(status, 'failed');
});

test('createSheetsClient.syncAllMembers returns failed without throwing when the token exchange fails', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  const client = createSheetsClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r-5', sheetId: 'sheet-1', fetchImpl });
  const status = await client.syncAllMembers([]);
  assert.equal(status, 'failed');
});
