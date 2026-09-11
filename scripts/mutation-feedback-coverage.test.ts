import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  deriveMutationFeedbackCoverageRegistry,
  mutationFeedbackCoverageOverrides,
  parseMutationInventoryRoutes,
} from './mutation-feedback-coverage.registry.ts';

async function readContractTable(): Promise<string> {
  return readFile(new URL('../upload-service/src/mutation-inventory.contract-table.md', import.meta.url), 'utf8');
}

test('every Mutation inventory route has an explicit check commitment or a call-site exception', async () => {
  const contractRoutes = parseMutationInventoryRoutes(await readContractTable());
  assert.ok(contractRoutes.length > 30, 'contract-table parsing must expand every method-and-route row');

  const registry = deriveMutationFeedbackCoverageRegistry(contractRoutes);
  const routeEntries = registry.filter(entry => entry.route);
  const entriesByRoute = new Map(routeEntries.map(entry => [entry.route!, entry]));
  assert.equal(entriesByRoute.size, routeEntries.length, 'feedback registry has duplicate route entries');

  const overrideRoutes = mutationFeedbackCoverageOverrides.map(entry => entry.route);
  assert.equal(new Set(overrideRoutes).size, overrideRoutes.length, 'feedback coverage overrides have duplicate route entries');
  const staleOverrides = overrideRoutes.filter(route => !contractRoutes.includes(route));
  assert.deepEqual(staleOverrides, [], `feedback exception no longer belongs to a canonical route: ${staleOverrides.join(', ')}`);

  const missing = contractRoutes.filter(route => !entriesByRoute.has(route));
  assert.deepEqual(missing, [], `Mutation inventory route lacks feedback coverage: ${missing.join(', ')}`);

  const stale = [...entriesByRoute.keys()].filter(route => !contractRoutes.includes(route));
  assert.deepEqual(stale, [], `feedback registry names a route absent from the Mutation inventory: ${stale.join(', ')}`);

  for (const route of contractRoutes) {
    const entry = entriesByRoute.get(route)!;
    assert.ok(entry.coverage === 'check' || entry.coverage === 'exception');
    if (entry.coverage === 'check') {
      assert.ok(entry.wiring === 'planned' || entry.wiring === 'wired', `${route} must state whether page wiring is complete`);
    } else {
      assert.ok(entry.callSite, `${route} exception must name its specific call site`);
      assert.ok(entry.reason, `${route} exception must explain why it has no check`);
    }
  }
});

test('the deliberately excluded call sites are narrow route-level exceptions', async () => {
  const registry = deriveMutationFeedbackCoverageRegistry(parseMutationInventoryRoutes(await readContractTable()));
  const exceptions = registry
    .filter(entry => entry.coverage === 'exception')
    .map(entry => ({ route: entry.route, lifecycle: entry.lifecycle, callSite: entry.callSite }));

  assert.deepEqual(exceptions, [
    { route: 'POST /session/login', lifecycle: undefined, callSite: 'public/auth.js#exchangeForSession' },
    { route: 'POST /session/logout', lifecycle: undefined, callSite: 'public/auth.js#logout' },
    { route: 'POST /application/pwa-installation', lifecycle: undefined, callSite: 'public/pwa-install.js#appinstalled' },
    { route: 'POST /gallery-photos/start', lifecycle: undefined, callSite: 'public/galerie/dodaj-zdjecia.js#submitPhotos' },
    { route: undefined, lifecycle: 'controllerchange', callSite: 'public/pwa-register.js#controllerchange' },
  ]);
  assert.equal(
    registry.find(entry => entry.route === 'POST /gallery-photos/finalize')?.coverage,
    'check',
    'the same submitPhotos handler still needs a check after gallery-photos/finalize',
  );
});

test('a new canonical table route receives the default planned check without a second route list', async () => {
  const source = await readContractTable();
  const routes = parseMutationInventoryRoutes(`${source}\n| PATCH \`/future/member-write\` | businessWrite | member | requestAwaited |`);
  const registry = deriveMutationFeedbackCoverageRegistry(routes);

  assert.deepEqual(
    registry.find(entry => entry.route === 'PATCH /future/member-write'),
    { route: 'PATCH /future/member-write', coverage: 'check', wiring: 'planned' },
  );
  assert.ok(
    !mutationFeedbackCoverageOverrides.some(entry => entry.route === 'PATCH /future/member-write'),
    'new table routes must not require a second hand-maintained registry row',
  );
});
