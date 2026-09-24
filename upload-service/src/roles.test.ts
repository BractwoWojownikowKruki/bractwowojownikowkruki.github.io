import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { AuthError } from './auth.ts';
import {
  getGrantedRoles,
  getEffectiveRoles,
  satisfiesRole,
  requireRole,
  setGrantedRoles,
  listAllGrantedRoles,
  createRoleAuthorizer,
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
  assert.equal(satisfiesRole(['hovding'], 'accountant'), false);
});

test('satisfiesRole: admin requirement needs admin specifically', () => {
  assert.equal(satisfiesRole(['accountant'], 'admin'), false);
  assert.equal(satisfiesRole(['admin'], 'admin'), true);
});

test('satisfiesRole: hovding requirement needs hovding or admin', () => {
  assert.equal(satisfiesRole([], 'hovding'), false);
  assert.equal(satisfiesRole(['hovding'], 'hovding'), true);
  assert.equal(satisfiesRole(['admin'], 'hovding'), true);
  assert.equal(satisfiesRole(['accountant'], 'hovding'), false);
});

test('createRoleAuthorizer resolves silently when the identity has the required role', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'mod@example.test', { roles: ['hovding'] });
  client.seed('members', 'mod@example.test', { email: 'mod@example.test', status: 'active' });
  const authorizer = createRoleAuthorizer(client, 'hovding');
  await authorizer.authorize({ sub: 's1', email: 'mod@example.test' });
});

test('createRoleAuthorizer throws 403 AuthError when the identity lacks the required role', async () => {
  const client = createInMemoryFirestoreClient();
  const authorizer = createRoleAuthorizer(client, 'hovding');
  await assert.rejects(
    () => authorizer.authorize({ sub: 's1', email: 'plain@example.test' }),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test('requireRole resolves silently when satisfied', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'admin@example.test', { roles: ['admin'] });
  client.seed('members', 'admin@example.test', { email: 'admin@example.test', status: 'active' });
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

// KRKG-0108: a stored grant only confers powers while its holder is an active member.
for (const status of ['pending', 'suspended', 'removed', 'rejected']) {
  test(`getEffectiveRoles returns [] for a ${status} member even though roles are granted`, async () => {
    const client = createInMemoryFirestoreClient();
    client.seed('userRoles', 'mod@example.test', { roles: ['hovding', 'admin'] });
    client.seed('members', 'mod@example.test', { email: 'mod@example.test', status });
    assert.deepEqual(await getEffectiveRoles(client, 'mod@example.test'), []);
    assert.deepEqual(await getGrantedRoles(client, 'mod@example.test'), ['hovding', 'admin'], 'the stored grant is untouched');
  });
}

test('getEffectiveRoles returns [] when there is no member doc at all', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'ghost@example.test', { roles: ['accountant'] });
  assert.deepEqual(await getEffectiveRoles(client, 'ghost@example.test'), []);
});

test('getEffectiveRoles returns the granted roles for an active member (case-insensitive email)', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'acc@example.test', { roles: ['accountant'] });
  client.seed('members', 'acc@example.test', { email: 'acc@example.test', status: 'active' });
  assert.deepEqual(await getEffectiveRoles(client, 'Acc@Example.test'), ['accountant']);
});

test('createRoleAuthorizer and requireRole reject a suspended role holder with 403', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('userRoles', 'mod@example.test', { roles: ['admin'] });
  client.seed('members', 'mod@example.test', { email: 'mod@example.test', status: 'suspended' });
  const isForbidden = (err: unknown) => err instanceof AuthError && err.status === 403;
  await assert.rejects(() => createRoleAuthorizer(client, 'hovding').authorize({ sub: 's1', email: 'mod@example.test' }), isForbidden);
  await assert.rejects(() => requireRole(client, 'mod@example.test', 'accountant'), isForbidden);
});
