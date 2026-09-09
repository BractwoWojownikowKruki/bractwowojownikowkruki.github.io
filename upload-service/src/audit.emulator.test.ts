import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { createFirestoreClient, type FirestoreLikeClient } from './firestore.ts';
import { createCanonicalAuditEvent, queryAuditEvents, type AuditViewer, type CanonicalAuditEvent } from './audit.ts';

/**
 * Real-Firestore-emulator coverage for the audit query path (GPT-5 external-review finding #3 on
 * KRKG-0050's plan.md Task 7: "Run Firestore emulator/index validation and test all
 * supported/rejected query matrix cases"). Every other test in this suite
 * (`audit.test.ts`/`mutation-inventory.test.ts`) exercises `queryAuditEvents` against
 * `createInMemoryFirestoreClient()` - a hand-written fake whose filter/sort/pagination logic could
 * itself have bugs a real query engine wouldn't reproduce, and which can never reject a query the
 * way real Firestore rejects one that needs a composite index it doesn't have.
 *
 * INVESTIGATED AND DISPROVEN: this file does NOT validate `firestore.indexes.json` against a real
 * index-enforcement gate, because no such gate is reachable from this codebase's Firestore usage.
 * Findings, from running the actual emulator during this investigation:
 *
 *   1. `gcloud emulators firestore start` (the Cloud Firestore Emulator - same binary whether
 *      launched via `gcloud` or `firebase emulators:start`) accepts unindexed composite queries
 *      silently by default. A `.where('category', '==', 'x').orderBy('timestamp', 'desc')` query
 *      against a fresh emulator - with `firestore.indexes.json` never loaded anywhere - returned
 *      results without error, where real production Firestore would reject it with a
 *      "the query requires an index" FAILED_PRECONDITION error.
 *   2. The emulator DOES have an index-enforcement mode (`--require-indexes` + `--index-file`),
 *      but `gcloud emulators firestore start --help` documents both flags as "Only supported in
 *      Datastore Mode in conjunction with --require-indexes" - i.e. only for the legacy Datastore
 *      API, never for Firestore Native mode, which is what `createFirestoreClient` here uses
 *      (`new Firestore({ projectId })`, the standard `@google-cloud/firestore` client). Passing
 *      both flags without `--database-mode=datastore-mode` is a hard `ERROR`, confirmed by running
 *      it. `gcloud beta emulators firestore start --help` documents the identical restriction.
 *   3. Conclusion: for a Firestore-Native project (this one), there is no local emulator mode that
 *      enforces composite-index requirements at all. Verifying that `firestore.indexes.json`
 *      itself is sufficient for the supported selector matrix is only possible against a real GCP
 *      project (`firebase deploy --only firestore:indexes` or the Firebase console, then running
 *      the same queries for real) - this is a genuine gap this test cannot close, not something
 *      papered over by writing an emulator assertion that looks like it proves index sufficiency.
 *
 * What this file DOES prove, which is still strictly more than existed before: `queryAuditEvents`
 * (through `createFirestoreClient`'s real `queryDocs`, the same production code path
 * `server.ts` calls) returns the right documents, in the right order, for each of the 5 supported
 * primary-selector shapes, when run against a real `@google-cloud/firestore` query engine instead
 * of the hand-written in-memory fake. That is a genuine additional layer of proof: the fake's
 * filter/sort/cursor logic in `firestore.ts`'s `createInMemoryFirestoreClient` is itself
 * hand-maintained and could drift from real Firestore's actual filter/order/tie-break semantics
 * without any existing test noticing - this file would.
 *
 * The two-selector-combination case from Task 7's "rejected query matrix" is deliberately NOT
 * exercised against real Firestore here: `AuditPrimarySelector` (audit.ts) is a discriminated
 * union with one variant per supported selector and no variant that combines two, and the actual
 * "more than one selector" rejection happens earlier, in `parseAuditQueryOptions` (server.ts) -
 * before `queryAuditEvents` is ever called and long before any Firestore query is built. There is
 * no code path by which two primary selectors could reach `queryDocs` in the first place, so there
 * is nothing for a real-Firestore test to add on top of the existing `parseAuditQueryOptions`/
 * `queryAuditEvents` unit coverage for that case.
 *
 * How to run this file: it is skipped by default (see below) because it needs a Firestore
 * emulator already running. To run it:
 *
 *   gcloud emulators firestore start --host-port=localhost:8298
 *   FIRESTORE_EMULATOR_HOST=localhost:8298 npx tsx --test src/audit.emulator.test.ts
 *
 * This file is intentionally NOT started/stopped automatically (spawning and polling a real Java
 * process from inside a `node:test` file was judged too slow/fragile for a file that already has
 * to run inside the default `npm test` glob - `src/*.test.ts` - on every invocation, including
 * machines with no emulator installed at all) - instead it looks for `FIRESTORE_EMULATOR_HOST`
 * and skips with a clear, actionable message when it isn't set. `npm test`'s default run is
 * unaffected either way: this test is present in the glob but always skips (never errors) when
 * the env var is absent, matching the precedent already set by `mutation-inventory.test.ts`'s
 * live-istra-contract check (`LIVE_CONTRACT_PATH`/`existsSync`) for the same "machine-dependent
 * prerequisite, skip visibly rather than silently or by failing" situation.
 */

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const AUDIT_EVENTS_COLLECTION = 'auditEvents';

const ADMIN_VIEWER: AuditViewer = { scope: 'admin', isAdmin: true, isAccountant: true, isModerator: true };

/** Deletes every document in `auditEvents` - the emulator persists state across test files/runs
 * within one running instance, so each run of this file must start from a clean collection. */
async function clearAuditEvents(db: Firestore): Promise<void> {
  const snap = await db.collection(AUDIT_EVENTS_COLLECTION).get();
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  if (snap.docs.length > 0) await batch.commit();
}

/**
 * Builds one seed event entirely through `createCanonicalAuditEvent` (the real production
 * constructor - `resource.display`/`actor.email`/`changes` drive `searchTokens` and `value`, so
 * building the event with the actual field values it needs, rather than constructing a default
 * event and patching fields on afterwards, is what keeps `searchTokens`/`value` internally
 * consistent with the rest of the document).
 */
function seedEvent(
  id: string,
  now: Date,
  overrides: {
    action?: CanonicalAuditEvent['action'];
    actorEmail?: string;
    resourceKey?: string;
    resourceDisplay?: string;
    field?: string;
  } = {},
): CanonicalAuditEvent {
  const action = overrides.action ?? 'profile.member.updated';
  const field = overrides.field ?? 'nickname';
  return createCanonicalAuditEvent(
    {
      action,
      actor: { email: overrides.actorEmail ?? 'admin@example.com' },
      resource: { kind: 'member', key: overrides.resourceKey ?? `member:${id}`, display: overrides.resourceDisplay ?? `Testowy Członek ${id}` },
      changes: [{ field, before: 'Stary', after: 'Nowy' }],
    },
    { createId: () => id, now: () => now },
  );
}

test(
  "real Firestore emulator: queryAuditEvents' supported selector matrix, via the production query path",
  { skip: EMULATOR_HOST ? false : `FIRESTORE_EMULATOR_HOST is not set - this test needs a real Firestore emulator running. See the file's header comment for the exact command. Skipping (not failing): this is a machine-dependent, manually-started prerequisite, same as mutation-inventory.test.ts's live-istra-contract check.` },
  async (t) => {
    const projectId = 'krkg-0050-audit-emulator-test';
    const db = new Firestore({ projectId });
    const client: FirestoreLikeClient = createFirestoreClient(projectId);
    // createFirestoreClient constructs its own internal `Firestore` instance; both it and `db`
    // here talk to the same emulator (via FIRESTORE_EMULATOR_HOST), so writes through the raw
    // `db` handle (used only for seeding/cleanup) are visible to `client.queryDocs`.

    await clearAuditEvents(db);
    t.after(async () => {
      await clearAuditEvents(db);
      await db.terminate();
    });

    const t0 = new Date('2026-01-01T10:00:00.000Z');
    const events: CanonicalAuditEvent[] = [
      seedEvent('evt-1', t0, { resourceKey: 'member:alice', resourceDisplay: 'Alicja Kowalska' }),
      seedEvent('evt-2', new Date('2026-01-01T11:00:00.000Z'), {
        action: 'membership.status.approved',
        field: 'status',
        resourceKey: 'member:bob',
        resourceDisplay: 'Bob Nowak',
      }),
      seedEvent('evt-3', new Date('2026-01-01T12:00:00.000Z'), {
        actorEmail: 'zosia@example.com',
        resourceKey: 'member:carol',
        resourceDisplay: 'Carol Wiśniewska',
      }),
      seedEvent('evt-4', new Date('2026-01-01T13:00:00.000Z'), { resourceKey: 'member:wolin-trip', resourceDisplay: 'Wolin Trip' }),
    ];

    for (const event of events) {
      await client.createDoc(AUDIT_EVENTS_COLLECTION, event.id, event);
    }

    await t.test('selector kind "none" (timestamp-only): returns all events, newest first', async () => {
      const page = await queryAuditEvents(client, { selector: { kind: 'none' } }, ADMIN_VIEWER);
      assert.deepEqual(
        page.rows.map(r => r.id),
        ['evt-4', 'evt-3', 'evt-2', 'evt-1'],
      );
    });

    await t.test('selector kind "categoryAction" (category only): filters to the matching category', async () => {
      const page = await queryAuditEvents(client, { selector: { kind: 'categoryAction', category: 'membership' } }, ADMIN_VIEWER);
      assert.deepEqual(page.rows.map(r => r.id), ['evt-2']);
    });

    await t.test('selector kind "categoryAction" (category+action): filters to the matching action', async () => {
      const page = await queryAuditEvents(
        client,
        { selector: { kind: 'categoryAction', category: 'profile', action: 'profile.member.updated' } },
        ADMIN_VIEWER,
      );
      assert.deepEqual(
        page.rows.map(r => r.id).sort(),
        ['evt-1', 'evt-3', 'evt-4'].sort(),
      );
    });

    await t.test('selector kind "actor": filters to the matching actor.email', async () => {
      const page = await queryAuditEvents(client, { selector: { kind: 'actor', email: 'zosia@example.com' } }, ADMIN_VIEWER);
      assert.deepEqual(page.rows.map(r => r.id), ['evt-3']);
    });

    await t.test('selector kind "resourceKey": filters to the matching resource.key', async () => {
      const page = await queryAuditEvents(client, { selector: { kind: 'resourceKey', key: 'member:wolin-trip' } }, ADMIN_VIEWER);
      assert.deepEqual(page.rows.map(r => r.id), ['evt-4']);
    });

    await t.test('selector kind "search" (searchTokens array-contains): prefix-matches resource.display', async () => {
      const page = await queryAuditEvents(client, { selector: { kind: 'search', term: 'wol' } }, ADMIN_VIEWER);
      assert.deepEqual(page.rows.map(r => r.id), ['evt-4']);
    });

    await t.test('pagination: cursor over the real Firestore engine returns the remaining rows once, in order', async () => {
      const firstPage = await queryAuditEvents(client, { selector: { kind: 'none' }, limit: 2 }, ADMIN_VIEWER);
      assert.deepEqual(firstPage.rows.map(r => r.id), ['evt-4', 'evt-3']);
      assert.ok(firstPage.nextCursor);
      const secondPage = await queryAuditEvents(client, { selector: { kind: 'none' }, limit: 2, cursor: firstPage.nextCursor }, ADMIN_VIEWER);
      assert.deepEqual(secondPage.rows.map(r => r.id), ['evt-2', 'evt-1']);
      assert.equal(secondPage.nextCursor, undefined);
    });
  },
);
