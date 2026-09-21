import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from '../src/firestore.ts';
import { migrateFullNameToLastName } from './migrate-fullname-to-lastname.ts';

test('migrateFullNameToLastName renames fullName to lastName and defaults firstName to empty', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala Kowalska', nickname: 'Alka', sectionId: 'krakow',
    categoryId: null, status: 'active',
  });

  const result = await migrateFullNameToLastName(client, { dryRun: false });
  assert.equal(result.renamed, 1);
  assert.equal(result.alreadyDone, 0);
  assert.equal(result.skippedNoFullName, 0);

  const doc = await client.getDoc<Record<string, unknown>>('members', 'ala@example.com');
  assert.equal(doc?.lastName, 'Ala Kowalska');
  assert.equal(doc?.firstName, '');
  assert.equal(doc?.fullName, null, 'fullName is cleared to null (setDoc cannot truly delete a field)');
  assert.equal(doc?.nickname, 'Alka', 'unrelated fields must survive untouched');
});

test('migrateFullNameToLastName is a dry run by default - it reports but does not write', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', {
    email: 'ala@example.com', fullName: 'Ala Kowalska', nickname: null, sectionId: 'krakow',
  });

  const result = await migrateFullNameToLastName(client, { dryRun: true });
  assert.equal(result.renamed, 1);

  const doc = await client.getDoc<Record<string, unknown>>('members', 'ala@example.com');
  assert.equal(doc?.fullName, 'Ala Kowalska', 'a dry run must not touch the stored document');
  assert.equal(doc?.lastName, undefined);
});

test('migrateFullNameToLastName skips a doc that already has lastName and no fullName', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'already@example.com', {
    email: 'already@example.com', lastName: 'Nowak', firstName: 'Jan', nickname: null, sectionId: 'krakow',
  });

  const result = await migrateFullNameToLastName(client, { dryRun: false });
  assert.equal(result.renamed, 0);
  assert.equal(result.alreadyDone, 1);

  const doc = await client.getDoc<Record<string, unknown>>('members', 'already@example.com');
  assert.equal(doc?.lastName, 'Nowak');
  assert.equal(doc?.firstName, 'Jan', 'an already-migrated doc must be left untouched');
});

test('migrateFullNameToLastName skips a doc with neither fullName nor lastName, without crashing', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'weird@example.com', { email: 'weird@example.com', nickname: null, sectionId: 'krakow' });

  const result = await migrateFullNameToLastName(client, { dryRun: false });
  assert.equal(result.renamed, 0);
  assert.equal(result.skippedNoFullName, 1);
});

test('migrateFullNameToLastName is idempotent - running it twice does nothing the second time', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('members', 'ala@example.com', { email: 'ala@example.com', fullName: 'Ala Kowalska', nickname: null, sectionId: 'krakow' });

  const first = await migrateFullNameToLastName(client, { dryRun: false });
  assert.equal(first.renamed, 1);

  const second = await migrateFullNameToLastName(client, { dryRun: false });
  assert.equal(second.renamed, 0);
  assert.equal(second.alreadyDone, 1);

  const doc = await client.getDoc<Record<string, unknown>>('members', 'ala@example.com');
  assert.equal(doc?.lastName, 'Ala Kowalska');
});

test('migrateFullNameToLastName does not touch the persons collection', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('persons', 'person-1', { personId: 'person-1', ksywka: 'Wilk', firstName: 'Jan', lastName: 'Kowalski' });
  client.seed('members', 'ala@example.com', { email: 'ala@example.com', fullName: 'Ala Kowalska', nickname: null, sectionId: 'krakow' });

  await migrateFullNameToLastName(client, { dryRun: false });

  const person = await client.getDoc<Record<string, unknown>>('persons', 'person-1');
  assert.equal(person?.firstName, 'Jan');
  assert.equal(person?.lastName, 'Kowalski');
});
