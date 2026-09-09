import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * KRKG-0050 batch 6/6: release-evidence coverage test for
 * implementation-contract.md's "Mutation inventory" table.
 *
 * The contract requires "Every current authenticated mutation is explicitly classified below as
 * either [businessWrite or transientNoBusinessWrite] ... Inventory coverage fails if a current
 * mutation is missing." This test is that failing check: it parses `server.ts`'s own dispatch
 * table (the same `req.method === '<M>' && url.pathname === '<path>'` chain a human reviewer
 * would read) and asserts, in both directions, that it matches exactly the route+classification
 * set found by ALSO parsing the "## Mutation inventory" markdown table - not a hand-maintained
 * TypeScript transcription of it.
 *
 * The table is parsed from `mutation-inventory.contract-table.md`, a checked-in copy of
 * implementation-contract.md's "## Mutation inventory" section, rather than from the istra tracker
 * document directly: that document lives at an absolute path on the author's machine
 * (`~/repos/istra/2-InProgress/KRKG-0050 - Centralny, czytelny audyt operacji zapisu/
 * implementation-contract.md`), which is outside this repo, not checked out in CI, and not at a
 * stable path on another developer's machine. Reading it directly would make this test silently
 * unable to run (or read nothing meaningful) everywhere except the original author's checkout -
 * the opposite of a real gate. The checked-in copy trades "always reads the live document" for
 * "actually runs as a real comparison in every environment, including CI" - see the maintenance
 * instructions inside `mutation-inventory.contract-table.md` for how the two are kept in sync.
 *
 * If `server.ts`'s dispatch gains a new authenticated mutating route, this test fails until that
 * route is added to the table in *both* implementation-contract.md and
 * `mutation-inventory.contract-table.md`. If a route is removed from dispatch, this test fails
 * until the corresponding table row is removed from both. If the two files' tables disagree with
 * each other, nothing here can detect that automatically (this test has no access to the istra
 * path) - the checked-in copy's header comment is the safeguard for that half of the problem.
 */

type Classification = 'businessWrite' | 'transientNoBusinessWrite';

interface ClassifiedRoute {
  method: string;
  path: string;
  classification: Classification;
}

/**
 * `POST /internal/audit/reconcile` is a real, authenticated, state-changing dispatch entry, but
 * implementation-contract.md's Mutation-inventory section explicitly excludes it from the table:
 * its caller is Cloud Scheduler's own OIDC service-account identity, never a member's Google
 * identity (the contract's own scope section excludes "machine-only sync" work), and it only
 * finalizes an already-registered action's pending intent rather than creating a new one - see the
 * contract's "External-operation contract" section. Named here explicitly, rather than left as a
 * silent gap, so it can never be confused with an unclassified route this test failed to catch.
 */
const DOCUMENTED_NON_MEMBER_EXCEPTIONS: ReadonlySet<string> = new Set(['POST /internal/audit/reconcile']);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function extractDispatchRoutes(): Promise<string[]> {
  const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
  const re = /req\.method === '(\w+)'\s*&&\s*url\.pathname === '([^']+)'/g;
  const routes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const [, method, path] = match;
    if (MUTATING_METHODS.has(method)) routes.push(`${method} ${path}`);
  }
  return routes;
}

/**
 * Parses the "## Mutation inventory" markdown table out of `mutation-inventory.contract-table.md`
 * (a checked-in copy of the same table in implementation-contract.md). A table row looks like:
 *
 *   | POST `/session/login` | businessWrite — `session.login.succeeded` | ... | ... |
 *   | POST/DELETE `/admin/redirects` | businessWrite — ... | ... | ... |
 *
 * Only columns 1 (method(s) + route) and 2 (classification) are parsed - columns 3/4 (resource and
 * execution shape) are not asserted on by this test, per the task's scope.
 */
async function extractContractRoutes(): Promise<ClassifiedRoute[]> {
  const source = await readFile(new URL('./mutation-inventory.contract-table.md', import.meta.url), 'utf8');
  const rowRe = /^\|\s*([A-Z/]+)\s+`([^`]+)`\s*\|\s*(businessWrite|transientNoBusinessWrite)\b/gm;
  const routes: ClassifiedRoute[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(source))) {
    const [, methods, path, classification] = match;
    for (const method of methods.split('/')) {
      routes.push({ method, path, classification: classification as Classification });
    }
  }
  return routes;
}

test('every authenticated mutating route in server.ts dispatch is classified in the Mutation inventory table', async () => {
  const dispatchRoutes = await extractDispatchRoutes();
  assert.ok(dispatchRoutes.length > 30, 'sanity check: route extraction regex should have matched dozens of routes, not a handful - the regex likely stopped matching server.ts\'s current dispatch shape');

  const contractRoutes = await extractContractRoutes();
  assert.ok(contractRoutes.length > 30, 'sanity check: contract-table parsing should have matched dozens of rows, not a handful - the regex likely stopped matching the table\'s current markdown shape');

  const classifiedKeys = new Set(contractRoutes.map(r => `${r.method} ${r.path}`));
  assert.equal(classifiedKeys.size, contractRoutes.length, 'mutation-inventory.contract-table.md has a duplicate method+path entry');

  const dispatchSet = new Set(dispatchRoutes);
  assert.equal(dispatchSet.size, dispatchRoutes.length, 'server.ts dispatch has a duplicate method+path branch');

  const uncoveredByTest = dispatchRoutes.filter(route => !classifiedKeys.has(route) && !DOCUMENTED_NON_MEMBER_EXCEPTIONS.has(route));
  assert.deepEqual(
    uncoveredByTest,
    [],
    `server.ts dispatch has a new authenticated mutating route not yet classified in the Mutation inventory table (or documented as a non-member exception): ${uncoveredByTest.join(', ')}`,
  );

  const staleClassifications = [...classifiedKeys].filter(route => !dispatchSet.has(route));
  assert.deepEqual(
    staleClassifications,
    [],
    `the Mutation inventory table lists a route no longer present in server.ts's dispatch - remove it from both implementation-contract.md and mutation-inventory.contract-table.md: ${staleClassifications.join(', ')}`,
  );

  const staleExceptions = [...DOCUMENTED_NON_MEMBER_EXCEPTIONS].filter(route => !dispatchSet.has(route));
  assert.deepEqual(staleExceptions, [], `documented non-member exception no longer present in dispatch, remove it: ${staleExceptions.join(', ')}`);

  const contractByRoute = new Map<string, Classification[]>();
  for (const route of contractRoutes) {
    const key = `${route.method} ${route.path}`;
    const list = contractByRoute.get(key) ?? [];
    list.push(route.classification);
    contractByRoute.set(key, list);
  }
  const inconsistentClassifications = [...contractByRoute.entries()].filter(([, classifications]) => new Set(classifications).size > 1);
  assert.deepEqual(
    inconsistentClassifications,
    [],
    `a route is classified inconsistently within the Mutation inventory table itself: ${inconsistentClassifications.map(([route]) => route).join(', ')}`,
  );
});

/**
 * Absolute path to the istra tracker's live copy of the contract this fixture was copied from (see
 * the file-level comment above and `mutation-inventory.contract-table.md`'s header). Present only on
 * checkouts that also have the istra tracker repo cloned next to this one (typically just the
 * author's machine) - never in CI, and not guaranteed on another developer's machine.
 */
const LIVE_CONTRACT_PATH =
  '/Users/bartosz/repos/istra/2-InProgress/KRKG-0050 - Centralny, czytelny audyt operacji zapisu/implementation-contract.md';

/** Returns the trimmed text of every markdown-table-row line (`| ... |`) in `source`, in order. */
function extractPipeTableLines(source: string): string {
  return source
    .split('\n')
    .filter(line => line.trim().startsWith('|'))
    .join('\n')
    .trim();
}

/** Extracts just the "## Mutation inventory" section's table rows out of a full contract document. */
function extractLiveMutationInventoryTable(source: string): string {
  const lines = source.split('\n');
  const headingIndex = lines.findIndex(line => line.trim() === '## Mutation inventory');
  if (headingIndex === -1) {
    throw new Error('live contract file: could not find a "## Mutation inventory" heading - has it changed?');
  }
  const afterHeading = lines.slice(headingIndex + 1);
  const nextHeadingOffset = afterHeading.findIndex(line => /^##\s/.test(line));
  const sectionLines = nextHeadingOffset === -1 ? afterHeading : afterHeading.slice(0, nextHeadingOffset);
  return extractPipeTableLines(sectionLines.join('\n'));
}

const liveContractExists = existsSync(LIVE_CONTRACT_PATH);

test(
  "the checked-in mutation-inventory fixture matches the live istra contract's Mutation inventory table",
  {
    skip: liveContractExists
      ? false
      : `live istra contract file not found at "${LIVE_CONTRACT_PATH}" - expected in CI and on ` +
        'checkouts without the istra tracker repo; this drift check only runs where that path exists ' +
        '(e.g. the contract author\'s machine). The fixture-vs-server.ts coverage test above still runs regardless.',
  },
  async () => {
    const liveSource = await readFile(LIVE_CONTRACT_PATH, 'utf8');
    const liveTable = extractLiveMutationInventoryTable(liveSource);

    const fixtureSource = await readFile(new URL('./mutation-inventory.contract-table.md', import.meta.url), 'utf8');
    const fixtureTable = extractPipeTableLines(fixtureSource);

    assert.equal(
      fixtureTable,
      liveTable,
      'mutation-inventory.contract-table.md has drifted from the live istra contract\'s "## Mutation inventory" ' +
        'table - re-copy the table from implementation-contract.md into the fixture (see the fixture\'s header ' +
        'comment for the sync instructions) and update its "Last synced" date.',
    );
  },
);

test('the documented non-member exception is not silently absorbing an unrelated gap', () => {
  // Guards against someone "fixing" a future coverage failure by widening
  // DOCUMENTED_NON_MEMBER_EXCEPTIONS instead of updating the contract - it must stay exactly the
  // one route the contract names.
  assert.deepEqual([...DOCUMENTED_NON_MEMBER_EXCEPTIONS], ['POST /internal/audit/reconcile']);
});
