import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { AuthError } from './auth.ts';
import {
  getGrantedRoles,
  satisfiesRole,
  requireRole,
  setGrantedRoles,
  listAllGrantedRoles,
  appendRoleAuditEntry,
  listRoleAuditLog,
} from './roles.ts';

test('getGrantedRoles returns [] when no userRoles doc exists', async () => {
  const client = createInMemoryFirestoreClient();
  const roles = await getGrantedRoles(client, 'plain@example.test');
  assert.deepEqual(roles, []);
});

test('getGrantedRoles returns the stored roles array', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'acc@example.test', { roles: ['accountant'] });
  const roles = await getGrantedRoles(client, 'acc@example.test');
  assert.deepEqual(roles, ['accountant']);
});

test('satisfiesRole: member requirement is always satisfied', () => {
  assert.equal(satisfiesRole([], 'member'), true);
  assert.equal(satisfiesRole(['accountant'], 'member'), true);
});

test('satisfiesRole: accountant requirement needs accountant or admin', () => {
  assert.equal(satisfiesRole([], 'accountant'), false);
  assert.equal(satisfiesRole(['accountant'], 'accountant'), true);
  assert.equal(satisfiesRole(['admin'], 'accountant'), true);
  assert.equal(satisfiesRole(['moderator'], 'accountant'), false);
});

test('satisfiesRole: admin requirement needs admin specifically', () => {
  assert.equal(satisfiesRole(['accountant'], 'admin'), false);
  assert.equal(satisfiesRole(['admin'], 'admin'), true);
});

test('requireRole resolves silently when satisfied', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'admin@example.test', { roles: ['admin'] });
  await requireRole(client, 'admin@example.test', 'accountant');
});

test('requireRole throws 403 AuthError when not satisfied', async () => {
  const client = createInMemoryFirestoreClient();
  await assert.rejects(
    () => requireRole(client, 'plain@example.test', 'accountant'),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('setGrantedRoles writes a new userRoles doc lowercasing the email', async () => {
  const client = createInMemoryFirestoreClient();
  await setGrantedRoles(client, 'Ala@Example.test', ['accountant']);
  const roles = await getGrantedRoles(client, 'ala@example.test');
  assert.deepEqual(roles, ['accountant']);
});

test('setGrantedRoles overwrites an existing doc, including clearing it to []', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'ala@example.test', { roles: ['admin'] });
  await setGrantedRoles(client, 'ala@example.test', []);
  const roles = await getGrantedRoles(client, 'ala@example.test');
  assert.deepEqual(roles, []);
});

test('listAllGrantedRoles returns every userRoles doc', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'ala@example.test', { roles: ['accountant'] });
  client.seed('userRoles', 'bob@example.test', { roles: ['admin'] });
  const all = await listAllGrantedRoles(client);
  assert.deepEqual(
    all.sort((a, b) => a.email.localeCompare(b.email)),
    [
      { email: 'ala@example.test', roles: ['accountant'] },
      { email: 'bob@example.test', roles: ['admin'] },
    ],
  );
});

test('appendRoleAuditEntry stores an entry with a generated changedAt', async () => {
  const client = createInMemoryFirestoreClient();
  await appendRoleAuditEntry(client, {
    targetEmail: 'ala@example.test',
    previousRoles: [],
    newRoles: ['admin'],
    changedBy: 'boss@example.test',
    changeSummary: 'Zmieniono rolę: Brak → Admin',
  });
  const entries = await listRoleAuditLog(client);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].targetEmail, 'ala@example.test');
  assert.deepEqual(entries[0].previousRoles, []);
  assert.deepEqual(entries[0].newRoles, ['admin']);
  assert.equal(entries[0].changedBy, 'boss@example.test');
  assert.equal(entries[0].changeSummary, 'Zmieniono rolę: Brak → Admin');
  assert.equal(typeof entries[0].changedAt, 'string');
});

test('listRoleAuditLog returns entries sorted oldest first', async () => {
  const client = createInMemoryFirestoreClient();
  await appendRoleAuditEntry(client, {
    targetEmail: 'ala@example.test',
    previousRoles: [],
    newRoles: ['accountant'],
    changedBy: 'boss@example.test',
    changeSummary: 'first',
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await appendRoleAuditEntry(client, {
    targetEmail: 'ala@example.test',
    previousRoles: ['accountant'],
    newRoles: ['admin'],
    changedBy: 'boss@example.test',
    changeSummary: 'second',
  });
  const entries = await listRoleAuditLog(client);
  assert.deepEqual(entries.map((e) => e.changeSummary), ['first', 'second']);
});
