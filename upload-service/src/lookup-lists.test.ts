import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryFirestoreClient } from './firestore.ts';
import { getLookupList, getAllLookupLists } from './lookup-lists.ts';

test('getLookupList returns [] when the list doc does not exist', async () => {
  const client = createInMemoryFirestoreClient();
  assert.deepEqual(await getLookupList(client, 'sections'), []);
});

test('getLookupList returns the stored items array', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', {
    items: [{ id: 'krakow', label: 'Kraków', retired: false }],
  });
  assert.deepEqual(await getLookupList(client, 'sections'), [
    { id: 'krakow', label: 'Kraków', retired: false },
  ]);
});

test('getAllLookupLists fetches sections, categories and weapons together', async () => {
  const client = createInMemoryFirestoreClient();
  client.seed('lookupLists', 'sections', { items: [{ id: 'krakow', label: 'Kraków', retired: false }] });
  client.seed('lookupLists', 'categories', { items: [{ id: 'blacha', label: 'Blacha', retired: false }] });
  client.seed('lookupLists', 'weapons', { items: [{ id: 'tarcza', label: 'Tarcza', retired: false }] });

  const all = await getAllLookupLists(client);
  assert.equal(all.sections.length, 1);
  assert.equal(all.categories.length, 1);
  assert.equal(all.weapons.length, 1);
});
