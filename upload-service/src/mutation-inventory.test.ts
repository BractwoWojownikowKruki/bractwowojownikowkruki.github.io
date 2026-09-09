import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * KRKG-0050 batch 6/6: release-evidence coverage test for
 * implementation-contract.md's "Mutation inventory" table.
 *
 * The contract requires "Every current authenticated mutation is explicitly classified below as
 * either [businessWrite or transientNoBusinessWrite] ... Inventory coverage fails if a current
 * mutation is missing." This test is that failing check: it parses `server.ts`'s own dispatch
 * table (the same `req.method === '<M>' && url.pathname === '<path>'` chain a human reviewer
 * would read) and asserts, in both directions, that it matches exactly the classified route list
 * below - transcribed from implementation-contract.md's "Mutation inventory" table plus its two
 * documented exceptions/notes (the reconciliation route exclusion, and the
 * `/application/pwa-installation` row batch 6 added after finding it missing from the table).
 *
 * If `server.ts`'s dispatch gains a new authenticated mutating route, this test fails until that
 * route is added to CLASSIFIED_ROUTES below *and* to implementation-contract.md's Mutation
 * inventory table - the two must never drift apart. If a route is removed from dispatch, this
 * test fails until the corresponding entry below (and in the contract) is removed too.
 */

type Classification = 'businessWrite' | 'transientNoBusinessWrite';

interface ClassifiedRoute {
  method: string;
  path: string;
  classification: Classification;
  /** The registered action(s) for businessWrite, or the no-business-mutation reason for
   * transientNoBusinessWrite - purely documentation inside this test, not asserted against the
   * registry (audit.test.ts already covers the registry itself). */
  note: string;
}

// Transcribed from implementation-contract.md, "## Mutation inventory"
// (`~/repos/istra/2-InProgress/KRKG-0050 - Centralny, czytelny audyt operacji zapisu/
// implementation-contract.md`) as of batch 6. Keep this list and that table in lockstep.
const CLASSIFIED_ROUTES: ClassifiedRoute[] = [
  { method: 'POST', path: '/session/login', classification: 'businessWrite', note: 'session.login.succeeded' },
  { method: 'POST', path: '/session/logout', classification: 'transientNoBusinessWrite', note: 'clears only the session response/cookie' },
  { method: 'POST', path: '/application/pwa-installation', classification: 'businessWrite', note: 'application.pwa.installation_reported (added to the contract table by batch 6 - see its "Known discrepancy" note on this route\'s resource-key shape)' },
  { method: 'POST', path: '/membership/apply', classification: 'businessWrite', note: 'membership.application.submitted' },
  { method: 'POST', path: '/admin/social-media/refresh', classification: 'businessWrite', note: 'site.social_cache.refreshed' },
  { method: 'POST', path: '/admin/members/transition', classification: 'businessWrite', note: 'data-resolved membership status action, optional membership.sheet_backup.synchronized' },
  { method: 'PUT', path: '/admin/members/drive-folder', classification: 'businessWrite', note: 'profile.drive_folder.changed' },
  { method: 'PUT', path: '/admin/members/profile', classification: 'businessWrite', note: 'profile.member.updated' },
  { method: 'POST', path: '/admin/members/synchronize', classification: 'businessWrite', note: 'membership.sheet_backup.synchronized' },
  { method: 'PUT', path: '/admin/roles', classification: 'businessWrite', note: 'role.granted / role.revoked / role.replaced' },
  { method: 'POST', path: '/admin/redirects', classification: 'businessWrite', note: 'site.redirect.created' },
  { method: 'DELETE', path: '/admin/redirects', classification: 'businessWrite', note: 'site.redirect.deleted' },
  { method: 'POST', path: '/admin/people', classification: 'businessWrite', note: 'profile.person.created' },
  { method: 'PUT', path: '/admin/people/description', classification: 'businessWrite', note: 'profile.person.description.updated' },
  { method: 'PUT', path: '/admin/people/order', classification: 'businessWrite', note: 'profile.person.order.updated' },
  { method: 'PUT', path: '/admin/people/category', classification: 'businessWrite', note: 'profile.person.category.changed' },
  { method: 'DELETE', path: '/admin/people', classification: 'businessWrite', note: 'profile.person.deleted' },
  { method: 'POST', path: '/admin/people/photo', classification: 'businessWrite', note: 'profile.person.photo.added' },
  { method: 'DELETE', path: '/admin/people/photo', classification: 'businessWrite', note: 'profile.person.photo.deleted' },
  { method: 'PUT', path: '/admin/people/photo/main', classification: 'businessWrite', note: 'profile.person.photo.main.changed' },
  { method: 'PUT', path: '/admin/people/photo/transfer', classification: 'businessWrite', note: 'profile.person.photo.transferred' },
  { method: 'PUT', path: '/admin/people/in-memoriam', classification: 'businessWrite', note: 'profile.person.in_memoriam.changed' },
  { method: 'POST', path: '/wojownicy-upload/submit', classification: 'businessWrite', note: 'profile.photo_submission.created' },
  { method: 'POST', path: '/wojownicy-upload/photo', classification: 'businessWrite', note: 'profile.photo_submission.photo_added' },
  { method: 'PUT', path: '/lista-wyjazdowa/member', classification: 'businessWrite', note: 'profile.member.updated' },
  { method: 'PUT', path: '/lista-wyjazdowa/profile', classification: 'businessWrite', note: 'profile.member.updated' },
  { method: 'POST', path: '/lista-wyjazdowa/events', classification: 'businessWrite', note: 'event.created' },
  { method: 'PUT', path: '/lista-wyjazdowa/events', classification: 'businessWrite', note: 'event.updated / event.cancelled, plus dues.event_fee.changed only when its fee changes' },
  { method: 'PUT', path: '/lista-wyjazdowa/signups', classification: 'businessWrite', note: 'data-resolved signup.created / signup.updated' },
  { method: 'PUT', path: '/lista-wyjazdowa/signups/skladka', classification: 'businessWrite', note: 'dues.event_fee.changed' },
  { method: 'PUT', path: '/lista-wyjazdowa/wpisowe', classification: 'businessWrite', note: 'dues.entry_fee.changed' },
  { method: 'PUT', path: '/lista-wyjazdowa/dues', classification: 'businessWrite', note: 'dues.annual.changed' },
  { method: 'POST', path: '/admin/settings', classification: 'businessWrite', note: 'site.settings.updated' },
  { method: 'POST', path: '/delete-drive-gallery', classification: 'businessWrite', note: 'gallery.deleted' },
  { method: 'POST', path: '/start', classification: 'businessWrite', note: 'gallery.created' },
  { method: 'POST', path: '/register', classification: 'businessWrite', note: 'gallery.registered' },
  { method: 'POST', path: '/unregister', classification: 'businessWrite', note: 'gallery.unregistered' },
  { method: 'POST', path: '/upload', classification: 'businessWrite', note: 'gallery.photo.added' },
  { method: 'POST', path: '/finalize', classification: 'businessWrite', note: 'gallery.finalized' },
  { method: 'POST', path: '/gallery-photos/start', classification: 'transientNoBusinessWrite', note: 'verifies an existing gallery, issues only an expiring submission token' },
  { method: 'POST', path: '/gallery-photos/finalize', classification: 'businessWrite', note: 'gallery.photo.contribution.finalized' },
];

/**
 * `POST /internal/audit/reconcile` is a real, authenticated, state-changing dispatch entry, but
 * implementation-contract.md's Mutation-inventory section explicitly excludes it: its caller is
 * Cloud Scheduler's own OIDC service-account identity, never a member's Google identity (the
 * contract's own scope section excludes "machine-only sync" work), and it only finalizes an
 * already-registered action's pending intent rather than creating a new one - see the contract's
 * "External-operation contract" section. Named here explicitly, rather than left as a silent gap,
 * so it can never be confused with an unclassified route this test failed to catch.
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

test('every authenticated mutating route in server.ts dispatch is classified in implementation-contract.md\'s Mutation inventory', async () => {
  const dispatchRoutes = await extractDispatchRoutes();
  assert.ok(dispatchRoutes.length > 30, 'sanity check: route extraction regex should have matched dozens of routes, not a handful - the regex likely stopped matching server.ts\'s current dispatch shape');

  const classifiedKeys = new Set(CLASSIFIED_ROUTES.map(r => `${r.method} ${r.path}`));
  assert.equal(classifiedKeys.size, CLASSIFIED_ROUTES.length, 'CLASSIFIED_ROUTES has a duplicate method+path entry');

  const dispatchSet = new Set(dispatchRoutes);
  assert.equal(dispatchSet.size, dispatchRoutes.length, 'server.ts dispatch has a duplicate method+path branch');

  const uncoveredByTest = dispatchRoutes.filter(route => !classifiedKeys.has(route) && !DOCUMENTED_NON_MEMBER_EXCEPTIONS.has(route));
  assert.deepEqual(
    uncoveredByTest,
    [],
    `server.ts dispatch has a new authenticated mutating route not yet classified in implementation-contract.md's Mutation inventory (or documented as a non-member exception): ${uncoveredByTest.join(', ')}`,
  );

  const staleClassifications = [...classifiedKeys].filter(route => !dispatchSet.has(route));
  assert.deepEqual(
    staleClassifications,
    [],
    `implementation-contract.md's Mutation inventory (as transcribed here) lists a route no longer present in server.ts's dispatch - remove it from both: ${staleClassifications.join(', ')}`,
  );

  const staleExceptions = [...DOCUMENTED_NON_MEMBER_EXCEPTIONS].filter(route => !dispatchSet.has(route));
  assert.deepEqual(staleExceptions, [], `documented non-member exception no longer present in dispatch, remove it: ${staleExceptions.join(', ')}`);
});

test('the documented non-member exception is not silently absorbing an unrelated gap', () => {
  // Guards against someone "fixing" a future coverage failure by widening
  // DOCUMENTED_NON_MEMBER_EXCEPTIONS instead of updating the contract - it must stay exactly the
  // one route the contract names.
  assert.deepEqual([...DOCUMENTED_NON_MEMBER_EXCEPTIONS], ['POST /internal/audit/reconcile']);
});
