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

function extractBlock(source: string, declarationStart: number): string {
  const bodyStart = source.indexOf('{', declarationStart);
  assert.ok(bodyStart >= 0, 'expected declaration body to start with "{"');
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error('declaration body is not closed');
}

function extractNamedFunction(source: string, name: string): string {
  const declaration = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(declaration >= 0, `could not find function ${name}`);
  return extractBlock(source, declaration);
}

function extractEventListener(source: string, eventName: string): string {
  const declaration = source.indexOf(`addEventListener('${eventName}',`);
  assert.ok(declaration >= 0, `could not find ${eventName} listener`);
  return extractBlock(source, declaration);
}

function extractListenerForElement(source: string, elementId: string, eventName: string): string {
  const declaration = source.indexOf(`document.getElementById('${elementId}').addEventListener('${eventName}',`);
  assert.ok(declaration >= 0, `could not find ${eventName} listener for #${elementId}`);
  return extractBlock(source, declaration);
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

test('narrow exceptions remain inside their declared source functions and lifecycle listeners', async () => {
  const [auth, photos, pwaInstall, pwaRegister] = await Promise.all([
    readFile(new URL('../public/auth.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/galerie/dodaj-zdjecia.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/pwa-install.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/pwa-register.js', import.meta.url), 'utf8'),
  ]);

  const exchangeForSession = extractNamedFunction(auth, 'exchangeForSession');
  assert.match(exchangeForSession, /\/session\/login/);
  assert.match(exchangeForSession, /method:\s*'POST'/);

  const logout = extractNamedFunction(auth, 'logout');
  assert.match(logout, /\/session\/logout/);
  assert.match(logout, /method:\s*'POST'/);

  const submitPhotos = extractNamedFunction(photos, 'submitPhotos');
  assert.match(submitPhotos, /\/gallery-photos\/start/);
  assert.match(submitPhotos, /\/gallery-photos\/finalize/);
  assert.equal((submitPhotos.match(/method:\s*'POST'/g) ?? []).length >= 2, true);

  const appInstalled = extractEventListener(pwaInstall, 'appinstalled');
  assert.match(appInstalled, /\/application\/pwa-installation/);
  assert.match(appInstalled, /method:\s*'POST'/);

  const controllerChange = extractEventListener(pwaRegister, 'controllerchange');
  assert.match(controllerChange, /window\.location\.reload\(\)/);
  assert.equal((pwaRegister.match(/window\.location\.reload\(\)/g) ?? []).length, 1);
});

test('function extraction rejects an endpoint text moved outside its named call site', () => {
  const source = "async function exchangeForSession() { return fetch('/other'); }\nfetch('/session/login', { method: 'POST' });";
  assert.doesNotMatch(extractNamedFunction(source, 'exchangeForSession'), /\/session\/login/);
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

test('batch two routes are marked wired while later routes remain planned', async () => {
  const registry = deriveMutationFeedbackCoverageRegistry(parseMutationInventoryRoutes(await readContractTable()));
  const expectedWiredRoutes = [
    'POST /admin/social-media/refresh',
    'POST /admin/members/transition',
    'PUT /admin/members/drive-folder',
    'PUT /admin/members/profile',
    'POST /admin/members/synchronize',
    'PUT /admin/roles',
    'POST /admin/redirects',
    'DELETE /admin/redirects',
    'POST /admin/settings',
  ];

  for (const route of expectedWiredRoutes) {
    assert.equal(registry.find(entry => entry.route === route)?.wiring, 'wired', `${route} must be wired in batch two`);
  }
  assert.equal(registry.find(entry => entry.route === 'POST /gallery-photos/finalize')?.wiring, 'planned');
});

test('batch two admin mutations use confirmed local feedback without full-list success reloads', async () => {
  const [applications, members, general] = await Promise.all([
    readFile(new URL('../public/admin/zgloszenia/zgloszenia.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8'),
  ]);

  const applicationTransition = extractNamedFunction(applications, 'postMembershipTransition');
  assert.match(applicationTransition, /\/admin\/members\/transition/);
  assert.match(applicationTransition, /MutationFeedback\.confirmed\(/);
  assert.match(applicationTransition, /execute:\s*\(\)\s*=>\s*apiFetch/);
  assert.match(applicationTransition, /apply:/);
  assert.match(applicationTransition, /shouldShowCheck:\s*result\s*=>\s*!sheetSyncStatusMessage\(result\.sheetSyncStatus\)/);
  assert.match(applicationTransition, /refreshFragment:/);
  assert.doesNotMatch(applicationTransition, /loadMembershipApplications\(\);/);

  const memberTransition = extractNamedFunction(members, 'postMembershipTransition');
  assert.match(memberTransition, /\/admin\/members\/transition/);
  assert.match(memberTransition, /MutationFeedback\.confirmed\(/);
  assert.match(memberTransition, /apply:/);
  assert.match(memberTransition, /shouldShowCheck:\s*result\s*=>\s*!sheetSyncStatusMessage\(result\.sheetSyncStatus\)/);
  assert.match(memberTransition, /anchor:\s*row\.closest\('table'\)/);
  assert.doesNotMatch(memberTransition, /loadMembershipMembers\(\);/);

  const synchronize = extractListenerForElement(members, 'membership-synchronize', 'click');
  assert.match(synchronize, /\/admin\/members\/synchronize/);
  assert.match(synchronize, /MutationFeedback\.confirmed\(/);
  assert.match(synchronize, /sheetSyncStatusMessage/);

  for (const functionName of ['saveMemberProfileField', 'saveMemberHidden']) {
    const profileSave = extractNamedFunction(members, functionName);
    assert.match(profileSave, /\/admin\/members\/profile/);
    assert.match(profileSave, /MutationFeedback\.confirmed\(/);
    assert.match(profileSave, /refreshFragment:/);
  }

  const memberChange = extractListenerForElement(members, 'membership-members-list', 'change');
  assert.match(memberChange, /\/admin\/roles/);
  assert.match(memberChange, /\/admin\/members\/drive-folder/);
  assert.equal((memberChange.match(/MutationFeedback\.confirmed\(/g) ?? []).length >= 2, true);
  assert.match(memberChange, /await renderRolesAuditLog\(\);/);

  for (const route of ['/admin/social-media/refresh', '/admin/settings', '/admin/redirects']) {
    assert.match(general, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.equal((general.match(/MutationFeedback\.confirmed\(/g) ?? []).length >= 4, true);
  assert.doesNotMatch(extractListenerForElement(general, 'add-redirect-form', 'submit'), /loadRedirects\(\);/);
  assert.doesNotMatch(extractListenerForElement(general, 'redirects-list', 'click'), /loadRedirects\(\);/);
});
