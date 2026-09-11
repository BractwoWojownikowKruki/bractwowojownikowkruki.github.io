/**
 * Coverage commitments for user-visible mutation feedback.
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

export const mutationFeedbackCoverageRegistry: readonly MutationFeedbackCoverageEntry[] = [
  { route: 'POST /session/login', coverage: 'exception', callSite: 'public/auth.js', reason: 'Authentication changes the page session and navigation instead of leaving a stable fragment to confirm.' },
  { route: 'POST /session/logout', coverage: 'exception', callSite: 'public/auth.js', reason: 'Signing out changes the page session and navigation instead of leaving a stable fragment to confirm.' },
  { route: 'POST /application/pwa-installation', coverage: 'exception', callSite: 'public/pwa-install.js#appinstalled', reason: 'The browser installation lifecycle already supplies its own confirmation.' },
  { route: 'POST /membership/apply', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/social-media/refresh', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/members/transition', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/members/drive-folder', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/members/profile', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/members/synchronize', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/roles', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/redirects', coverage: 'check', wiring: 'planned' },
  { route: 'DELETE /admin/redirects', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/people', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/people/description', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/people/order', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/people/category', coverage: 'check', wiring: 'planned' },
  { route: 'DELETE /admin/people', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/people/photo', coverage: 'check', wiring: 'planned' },
  { route: 'DELETE /admin/people/photo', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/people/photo/main', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/people/photo/transfer', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /admin/people/in-memoriam', coverage: 'check', wiring: 'planned' },
  { route: 'POST /wojownicy-upload/submit', coverage: 'check', wiring: 'planned' },
  { route: 'POST /wojownicy-upload/photo', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/member', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/profile', coverage: 'check', wiring: 'planned' },
  { route: 'POST /lista-wyjazdowa/events', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/events', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/signups', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/signups/skladka', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/wpisowe', coverage: 'check', wiring: 'planned' },
  { route: 'PUT /lista-wyjazdowa/dues', coverage: 'check', wiring: 'planned' },
  { route: 'POST /admin/settings', coverage: 'check', wiring: 'planned' },
  { route: 'POST /delete-drive-gallery', coverage: 'check', wiring: 'planned' },
  { route: 'POST /start', coverage: 'check', wiring: 'planned' },
  { route: 'POST /register', coverage: 'check', wiring: 'planned' },
  { route: 'POST /unregister', coverage: 'check', wiring: 'planned' },
  { route: 'POST /upload', coverage: 'check', wiring: 'planned' },
  { route: 'POST /finalize', coverage: 'check', wiring: 'planned' },
  { route: 'POST /gallery-photos/start', coverage: 'exception', callSite: 'public/galerie/dodaj-zdjecia.js#submitPhotos', reason: 'This token-issuance request prepares the later finalized upload rather than confirming a persisted gallery mutation.' },
  { route: 'POST /gallery-photos/finalize', coverage: 'check', wiring: 'planned' },
  { lifecycle: 'controllerchange', coverage: 'exception', callSite: 'public/pwa-register.js#controllerchange', reason: 'A service-worker controller transition must reload to activate the new controlled page.' },
];
