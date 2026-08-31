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
 * Site-wide sign-in status: the user's Google avatar in the always-visible top bar next to the
 * hamburger (#nav-auth-slot) once signed in, plus - inside the collapsible menu itself, not the
 * top bar - a "Zaloguj się" link (to /logowanie/) when signed out (#nav-login-link) or a "Panel
 * admina" link when the /admin/whoami check passes (#nav-admin-link). Keeping the login link and
 * admin link out of the top bar avoids crowding it (logo + avatar + hamburger already fill it
 * on mobile) - they only need to be reachable, not always visible. The actual Google sign-in
 * button itself is no longer rendered in the nav - it lives on /logowanie/ (see logowanie.js) -
 * #nav-login-link is a plain link there, same as any other nav item.
 *
 * Reuses initGoogleSignIn from auth.js, which is safe to call alongside a page's own sign-in
 * flow (e.g. the Wojownicy group-membership check below) - see the shared-listener comment in
 * auth.js. Only runs on pages that carry this markup; the admin panel's own page deliberately
 * omits it since it already has a richer sign-in UI in its main content.
 */
document.addEventListener('DOMContentLoaded', () => {
  const avatarSlot = document.getElementById('nav-auth-slot');
  const loginLink = document.getElementById('nav-login-link');
  const adminLink = document.getElementById('nav-admin-link');
  if (!avatarSlot || typeof initGoogleSignIn !== 'function') return;

  // Split in two so the avatar can update the instant a restored token is found - locally,
  // from the token's own payload, no network wait - while the admin link still only ever
  // reflects the real, server-verified /admin/whoami result (see onRestoredIdentity's comment
  // in auth.js for why that split is safe).
  function renderAvatar(payload) {
    if (!payload) {
      avatarSlot.innerHTML = '';
      if (loginLink) loginLink.hidden = false;
      return;
    }
    const email = payload.email ? payload.email.replace(/"/g, '&quot;') : '';
    const picture = payload.picture ? payload.picture.replace(/"/g, '&quot;') : '';
    avatarSlot.innerHTML = `<img src="${picture}" alt="${email}" title="${email}" class="nav-avatar" />`;
    if (loginLink) loginLink.hidden = true;
  }

  function renderAdminLink(isAdmin) {
    if (adminLink) adminLink.hidden = !isAdmin;
  }

  // Only show the "Zaloguj się" link right away if there's definitely no restorable session to
  // check first (see the equivalent comment further below) - otherwise leave everything as-is
  // for onRestoredIdentity below to resolve immediately instead of flashing a misleading
  // "you're signed out" link for an already-signed-in visitor.
  if (typeof isIdTokenValid !== 'function' || !isIdTokenValid()) {
    renderAvatar(null);
  }
  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/admin/whoami',
    onRestoredIdentity: payload => renderAvatar(payload),
    onSignedIn: payload => {
      renderAvatar(payload);
      renderAdminLink(true);
    },
    onForbidden: payload => {
      renderAvatar(payload);
      renderAdminLink(false);
    },
  });
});

/**
 * Gates every plain-member-only nav link (Wrzucam swoje zdjęcie, Zasady Bractwa, Poradnik Walki)
 * the same way #nav-admin-link is gated above, just against a different allowlist (kruki Google
 * Group membership, GET /wojownicy-upload/whoami, checked server-side - see
 * upload-service/src/allowlist.ts's createAppsScriptAllowlist) rather than the admin allowlist.
 * One shared check for all of them since they're the same membership gate - lives in the shared
 * nav partial, so they show up from any page once a member signs in, not just from /wojownicy/.
 *
 * Remembers the last confirmed membership result per email, so a returning member sees these
 * links immediately (onRestoredIdentity, below) instead of waiting out the Apps Script check
 * again on every single page load. Purely a perceived-speed optimization: the real endpoints
 * behind each link still re-verify group membership server-side regardless of what this cache
 * says, so a stale "true" here can't grant anything - onSignedIn/onForbidden always correct it
 * once the real check resolves, a moment later.
 */
document.addEventListener('DOMContentLoaded', () => {
  const memberOnlyLinks = ['wrzuc-link', 'nav-zasady-bractwa-link', 'nav-poradnik-walki-link']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if (!memberOnlyLinks.length || typeof initGoogleSignIn !== 'function') return;

  const MEMBER_CACHE_KEY = 'kruki_wojownicy_member';

  function loadCachedMembership(email) {
    try {
      const cached = JSON.parse(localStorage.getItem(MEMBER_CACHE_KEY));
      return cached?.email === email ? cached.isMember : null;
    } catch {
      return null;
    }
  }

  function saveCachedMembership(email, isMember) {
    try {
      localStorage.setItem(MEMBER_CACHE_KEY, JSON.stringify({ email, isMember }));
    } catch {
      // Storage can be unavailable (private browsing) - just means no optimistic guess next time.
    }
  }

  function setHidden(hidden) {
    memberOnlyLinks.forEach(link => { link.hidden = hidden; });
  }

  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/wojownicy-upload/whoami',
    onRestoredIdentity: payload => {
      if (loadCachedMembership(payload.email) === true) {
        setHidden(false);
      }
    },
    onSignedIn: payload => {
      saveCachedMembership(payload.email, true);
      setHidden(false);
    },
    onForbidden: payload => {
      if (payload?.email) saveCachedMembership(payload.email, false);
      setHidden(true);
    },
  });
});
