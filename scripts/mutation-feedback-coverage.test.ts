import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mutationFeedbackCoverageRegistry } from './mutation-feedback-coverage.registry.ts';

async function extractContractRoutes(): Promise<string[]> {
  const source = await readFile(new URL('../upload-service/src/mutation-inventory.contract-table.md', import.meta.url), 'utf8');
  const rowRe = /^\|\s*([A-Z/]+)\s+`([^`]+)`\s*\|/gm;
  const routes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(source))) {
    const [, methods, path] = match;
    for (const method of methods.split('/')) routes.push(`${method} ${path}`);
  }
  return routes;
}

test('every Mutation inventory route has an explicit check commitment or a call-site exception', async () => {
  const contractRoutes = await extractContractRoutes();
  assert.ok(contractRoutes.length > 30, 'contract-table parsing must expand every method-and-route row');

  const routeEntries = mutationFeedbackCoverageRegistry.filter(entry => entry.route);
  const entriesByRoute = new Map(routeEntries.map(entry => [entry.route!, entry]));
  assert.equal(entriesByRoute.size, routeEntries.length, 'feedback registry has duplicate route entries');

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

test('the deliberately excluded call sites are narrow route-level exceptions', () => {
  const exceptions = mutationFeedbackCoverageRegistry
    .filter(entry => entry.coverage === 'exception')
    .map(entry => ({ route: entry.route, lifecycle: entry.lifecycle, callSite: entry.callSite }));

  assert.deepEqual(exceptions, [
    { route: 'POST /session/login', lifecycle: undefined, callSite: 'public/auth.js' },
    { route: 'POST /session/logout', lifecycle: undefined, callSite: 'public/auth.js' },
    { route: 'POST /application/pwa-installation', lifecycle: undefined, callSite: 'public/pwa-install.js#appinstalled' },
    { route: 'POST /gallery-photos/start', lifecycle: undefined, callSite: 'public/galerie/dodaj-zdjecia.js#submitPhotos' },
    { route: undefined, lifecycle: 'controllerchange', callSite: 'public/pwa-register.js#controllerchange' },
  ]);
  assert.equal(
    mutationFeedbackCoverageRegistry.find(entry => entry.route === 'POST /gallery-photos/finalize')?.coverage,
    'check',
    'the same submitPhotos handler still needs a check after gallery-photos/finalize',
  );
});
