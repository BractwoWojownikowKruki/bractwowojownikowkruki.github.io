/**
 * Feedback coverage entry derived from the canonical Mutation inventory table.
 *
 * `coverage` records the required end-state for each contract route, while `wiring` records
 * whether its page handler has already adopted MutationFeedback. Keeping these separate lets the
 * registry remain a complete contract gate while the page integrations are delivered in batches.
 */
export interface MutationFeedbackCoverageEntry {
  route?: string;
  lifecycle?: string;
  coverage: 'check' | 'exception';
  wiring?: 'planned' | 'wired';
  callSite?: string;
  reason?: string;
}

interface MutationFeedbackRouteException extends MutationFeedbackCoverageEntry {
  route: string;
  coverage: 'exception';
  callSite: string;
  reason: string;
}

/**
 * The only hand-maintained route entries: narrowly scoped exceptions to the default check.
 * Every other route is generated from the canonical Mutation inventory table.
 */
export const mutationFeedbackCoverageOverrides: readonly MutationFeedbackRouteException[] = [
  { route: 'POST /session/login', coverage: 'exception', callSite: 'public/auth.js#exchangeForSession', reason: 'Authentication changes the page session and navigation instead of leaving a stable fragment to confirm.' },
  { route: 'POST /session/logout', coverage: 'exception', callSite: 'public/auth.js#logout', reason: 'Signing out changes the page session and navigation instead of leaving a stable fragment to confirm.' },
  { route: 'POST /application/pwa-installation', coverage: 'exception', callSite: 'public/pwa-install.js#appinstalled', reason: 'The browser installation lifecycle already supplies its own confirmation.' },
  { route: 'POST /gallery-photos/start', coverage: 'exception', callSite: 'public/galerie/dodaj-zdjecia.js#submitPhotos', reason: 'This token-issuance request prepares the later finalized upload rather than confirming a persisted gallery mutation.' },
];

const mutationFeedbackLifecycleExceptions: readonly MutationFeedbackCoverageEntry[] = [
  { lifecycle: 'controllerchange', coverage: 'exception', callSite: 'public/pwa-register.js#controllerchange', reason: 'A service-worker controller transition must reload to activate the new controlled page.' },
];

const mutationFeedbackWiredRoutes = new Set([
  'POST /admin/social-media/refresh',
  'POST /admin/members/transition',
  'PUT /admin/members/drive-folder',
  'PUT /admin/members/profile',
  'POST /admin/members/synchronize',
  'PUT /admin/roles',
  'POST /admin/redirects',
  'DELETE /admin/redirects',
  'POST /admin/settings',
  'POST /admin/people',
  'PUT /admin/people/description',
  'PUT /admin/people/order',
  'PUT /admin/people/category',
  'DELETE /admin/people',
  'POST /admin/people/photo',
  'DELETE /admin/people/photo',
  'PUT /admin/people/photo/main',
  'PUT /admin/people/photo/transfer',
  'PUT /admin/people/in-memoriam',
  'POST /membership/apply',
  'POST /wojownicy-upload/submit',
  'POST /wojownicy-upload/photo',
  'PUT /lista-wyjazdowa/member',
  'PUT /lista-wyjazdowa/profile',
  'POST /delete-drive-gallery',
  'POST /start',
  'POST /register',
  'POST /unregister',
  'POST /upload',
  'POST /finalize',
  'POST /gallery-photos/finalize',
  'POST /lista-wyjazdowa/events',
  'PUT /lista-wyjazdowa/events',
  'PUT /lista-wyjazdowa/signups',
  'PUT /lista-wyjazdowa/signups/skladka',
  'PUT /lista-wyjazdowa/wpisowe',
  'PUT /lista-wyjazdowa/dues',
]);

/** Parses and expands method-and-route rows from the checked-in canonical Mutation inventory table. */
export function parseMutationInventoryRoutes(source: string): string[] {
  const rowRe = /^\|\s*([A-Z/]+)\s+`([^`]+)`\s*\|/gm;
  const routes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(source))) {
    const [, methods, path] = match;
    for (const method of methods.split('/')) routes.push(`${method} ${path}`);
  }
  return routes;
}

/**
 * Generates the full route coverage registry from the canonical table, defaulting every new route
 * to a planned check unless it has one of the explicit endpoint-and-call-site exceptions above.
 */
export function deriveMutationFeedbackCoverageRegistry(
  contractRoutes: readonly string[],
): readonly MutationFeedbackCoverageEntry[] {
  const overridesByRoute = new Map(mutationFeedbackCoverageOverrides.map(entry => [entry.route, entry]));
  return [
    ...contractRoutes.map(route => overridesByRoute.get(route) ?? {
      route,
      coverage: 'check' as const,
      wiring: mutationFeedbackWiredRoutes.has(route) ? 'wired' as const : 'planned' as const,
    }),
    ...mutationFeedbackLifecycleExceptions,
  ];
}
