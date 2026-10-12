import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * Checks the current repository's mutation inventory against server.ts dispatch.
 * Every authenticated mutating route must have one documented classification;
 * removed routes and duplicate entries must be removed from the inventory.
 *
 * The inventory lives beside this test and evolves with the application. Completed
 * story documents remain historical records and are not test dependencies.
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
 * (the current repository contract). A table row looks like:
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
    `the Mutation inventory table lists a route no longer present in server.ts's dispatch - remove it from mutation-inventory.contract-table.md: ${staleClassifications.join(', ')}`,
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

test('the documented non-member exception is not silently absorbing an unrelated gap', () => {
  // Guards against someone "fixing" a future coverage failure by widening
  // DOCUMENTED_NON_MEMBER_EXCEPTIONS instead of updating the contract - it must stay exactly the
  // one route the contract names.
  assert.deepEqual([...DOCUMENTED_NON_MEMBER_EXCEPTIONS], ['POST /internal/audit/reconcile']);
});
