/**
 * Navigation Active State Handler
 * Marks the nav item matching the current page as active. Resolves each item's href
 * (which may be relative, e.g. "../galerie/") against the current location before
 * comparing, so this works regardless of whether the site is served from a domain root
 * or a GitHub Pages project subpath.
 *
 * Deliberately does not touch .nav-item--highlighted: that class is a static, always-on
 * style on the Nabór link (a permanent call-to-action), not a current-page indicator -
 * stripping and conditionally re-adding it here would only show it while literally on
 * /nabor, defeating its purpose.
 */
function updateNavigation() {
  const currentPath = window.location.pathname;
  const navItems = document.querySelectorAll('.nav-item');

  navItems.forEach(item => {
    const href = item.getAttribute('href');
    if (!href) return;
    const resolvedPath = new URL(href, window.location.href).pathname;
    // Exact match, or (for a directory link like ".../o-nas/") the current page is a
    // subpage of that section - so /o-nas/wojownicy/ still highlights "O nas".
    const isActive =
      currentPath === resolvedPath ||
      (resolvedPath.endsWith('/') && resolvedPath.length > 1 && currentPath.startsWith(resolvedPath));
    item.classList.toggle('nav-item--active', isActive);
  });
}

// Update navigation when DOM is ready
document.addEventListener('DOMContentLoaded', updateNavigation);

// Update navigation on popstate (browser back/forward)
window.addEventListener('popstate', updateNavigation);

/**
 * Mobile hamburger toggle. #nav-toggle/#main-nav only exist on pages that opted into the
 * collapsible mobile nav (the .is-open class it adds is a no-op above the 768px breakpoint,
 * where .main-nav is always visible via CSS) - harmless to wire up unconditionally here since
 * this script already loads on every page that has the shared header.
 */
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('main-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  // Closes the menu after following a link, so returning via the browser's back button (or
  // clicking straight back into this same page) doesn't leave it stuck open.
  nav.addEventListener('click', event => {
    if (event.target.closest('.nav-item')) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
});

/**
 * Site-wide sign-in status in the main nav: a "Zaloguj" button when signed out, the user's
 * Google avatar once signed in, and (only for the /admin/whoami allowlist) a "Panel admina"
 * link. Reuses initGoogleSignIn from auth.js, which is safe to call alongside a page's own
 * sign-in flow (e.g. wojownicy.js's group-membership check) - see the shared-listener comment
 * in auth.js. Only runs on pages that carry the #nav-auth-slot markup; the admin panel's own
 * page deliberately omits it since it already has a richer sign-in UI in its main content.
 */
document.addEventListener('DOMContentLoaded', () => {
  const slot = document.getElementById('nav-auth-slot');
  if (!slot || typeof initGoogleSignIn !== 'function') return;

  function renderNavAuth(payload, isAdmin) {
    if (!payload) {
      slot.innerHTML = '<div id="nav-google-signin-button"></div>';
      return;
    }
    const adminHref = slot.dataset.adminHref;
    const adminLink = isAdmin && adminHref ? `<a href="${adminHref}" class="nav-item">Panel admina</a>` : '';
    const email = payload.email ? payload.email.replace(/"/g, '&quot;') : '';
    const picture = payload.picture ? payload.picture.replace(/"/g, '&quot;') : '';
    slot.innerHTML = `${adminLink}<img src="${picture}" alt="${email}" title="${email}" class="nav-avatar" />`;
  }

  renderNavAuth(null);
  initGoogleSignIn({
    buttonIds: ['nav-google-signin-button'],
    whoamiPath: '/admin/whoami',
    buttonConfig: { theme: 'filled_black', size: 'medium', text: 'signin' },
    onSignedIn: payload => renderNavAuth(payload, true),
    onForbidden: payload => renderNavAuth(payload, false),
  });
});
