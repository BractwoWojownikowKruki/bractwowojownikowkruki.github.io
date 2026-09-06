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
 * "Strefa Członków" exists twice in the DOM - the desktop sidebar box (#members-zone-sidebar,
 * see social_sidebar.html) and the mobile header trigger/panel (#members-zone-mobile, see
 * nav.html) - each holding its own copy of the same links (.member-zone-link/.admin-zone-link),
 * shown/hidden by CSS media query rather than JS, so only one is ever visible at a time. Both
 * are gated by two different, independent checks - Panel admina (admin allowlist) alongside
 * Galerie/Zasady Bractwa/Poradnik Walki/Wrzucam swoje zdjęcie/Forum/Discord (kruki group
 * membership) - so neither container has a single gate of its own; each shows whenever at least
 * one of ITS OWN links does. Called after either gate below changes any link's hidden state.
 */
function updateMembersZoneVisibility() {
  document.querySelectorAll('.members-zone-container').forEach(zone => {
    const anyLinkVisible = Array.from(zone.querySelectorAll('.member-zone-link, .admin-zone-link')).some(link => !link.hidden);
    zone.hidden = !anyLinkVisible;
  });
}

/**
 * The mobile trigger (#members-zone-trigger) opens/closes its own panel independently of the
 * main hamburger menu - tapping it never touches #main-nav's own open/closed state, and vice
 * versa. No-ops on pages without the trigger (desktop-only pages, or pages missing the partial).
 */
document.addEventListener('DOMContentLoaded', () => {
  const trigger = document.getElementById('members-zone-trigger');
  const panel = document.getElementById('members-zone-panel');
  if (!trigger || !panel) return;

  function setOpen(isOpen) {
    panel.hidden = !isOpen;
    trigger.setAttribute('aria-expanded', String(isOpen));
  }

  trigger.addEventListener('click', () => setOpen(panel.hidden));

  // Closes after following a link, same as the main hamburger menu does.
  panel.addEventListener('click', event => {
    if (event.target.closest('a')) setOpen(false);
  });

  // Closes on an outside tap/click - trigger's own click is handled above and never reaches
  // here as an "outside" click, since contains() is true for the trigger itself.
  document.addEventListener('click', event => {
    if (!panel.hidden && !trigger.contains(event.target) && !panel.contains(event.target)) {
      setOpen(false);
    }
  });
});

/**
 * Site-wide sign-in status: the user's Google avatar in the always-visible top bar next to the
 * hamburger (#nav-auth-slot) once a member session is verified, plus a "Zaloguj się" link (to
 * /logowanie/) when no member session exists (#nav-login-link), a "Wyloguj się" button when one
 * does (#nav-logout-link), and the "Panel admina" links (.admin-zone-link, in both Strefa
 * Członków containers) only once the separate /admin/whoami check passes. Keeping the
 * login/logout controls and admin links out of the top bar avoids crowding it (logo + avatar +
 * hamburger/trigger already fill it on mobile) - they only need to be reachable, not always
 * visible. The actual Google sign-in button itself is no longer rendered in the nav - it lives on
 * /logowanie/ (see logowanie.js) - #nav-login-link is a plain link there, same as any other nav
 * item.
 *
 * Reuses initGoogleSignIn from auth.js, which is safe to call alongside a page's own sign-in
 * flow - see the shared-listener comment in auth.js. Only runs on pages that carry this markup.
 *
 * No "restored session" fast path exists anymore (see auth.js's top comment - the session cookie
 * is HttpOnly, unreadable by JS by design). The initial state is therefore a neutral status
 * indicator, not a misleading login link, until the real member check resolves.
 */
document.addEventListener('DOMContentLoaded', () => {
  const avatarSlot = document.getElementById('nav-auth-slot');
  const loginLink = document.getElementById('nav-login-link');
  const logoutLink = document.getElementById('nav-logout-link');
  const checking = document.getElementById('nav-auth-checking');
  if (!avatarSlot || typeof initGoogleSignIn !== 'function') return;

  function renderAvatar(identity) {
    if (checking) checking.hidden = true;
    if (!identity) {
      avatarSlot.innerHTML = '';
      if (loginLink) loginLink.hidden = false;
      if (logoutLink) logoutLink.hidden = true;
      return;
    }
    const email = identity.email ?? '';
    if (identity.picture) {
      const avatar = document.createElement('img');
      avatar.src = identity.picture;
      avatar.alt = email;
      avatar.title = email;
      avatar.className = 'nav-avatar';
      avatarSlot.replaceChildren(avatar);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'nav-avatar nav-avatar--fallback';
      fallback.title = email;
      fallback.setAttribute('aria-label', email);
      fallback.textContent = email.slice(0, 1).toUpperCase() || '?';
      avatarSlot.replaceChildren(fallback);
    }
    if (loginLink) loginLink.hidden = true;
    if (logoutLink) logoutLink.hidden = false;
  }

  function renderAdminLink(isAdmin) {
    document.querySelectorAll('.admin-zone-link').forEach(link => { link.hidden = !isAdmin; });
    updateMembersZoneVisibility();
  }

  function renderMemberLinks(isMember) {
    document.querySelectorAll('.member-zone-link').forEach(link => { link.hidden = !isMember; });
    updateMembersZoneVisibility();
  }

  if (logoutLink && typeof logout === 'function') {
    logoutLink.addEventListener('click', () => logout());
  }

  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/wojownicy-upload/whoami',
    onSignedIn: identity => {
      renderAvatar(identity);
      renderMemberLinks(true);
    },
    onSignedOut: () => {
      renderAvatar(null);
      renderMemberLinks(false);
    },
    onForbidden: () => {
      renderAvatar(null);
      renderMemberLinks(false);
    },
  });

  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/admin/whoami',
    onSignedIn: () => renderAdminLink(true),
    onSignedOut: () => renderAdminLink(false),
    onForbidden: () => renderAdminLink(false),
  });
});
