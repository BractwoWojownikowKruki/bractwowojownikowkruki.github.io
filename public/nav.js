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
 * Monochrome line-icon paths (Feather Icons, MIT-licensed - github.com/feathericons/feather),
 * one per MEMBERS_ZONE_MENU entry below. Inline SVG rather than emoji glyphs: emoji render as
 * fixed-color bitmaps on every platform (Apple/Noto/Segoe color emoji fonts) and ignore CSS
 * `color`, so they can't be made to match the site's gold/text palette - these use
 * stroke="currentColor" instead, same technique already used by the hamburger icon in
 * nav.html, so they always render in the surrounding text color.
 */
const MZ_ICON_PATHS = {
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>',
  map: '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line>',
  coins: '<line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>',
  scroll: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line>',
  swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"></path><path d="M9.5 6.5 13 3h3v3l-3.5 3.5"></path><path d="M3 21l6.5-6.5"></path><path d="M21 21l-6.5-6.5"></path>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
  chevron: '<polyline points="9 6 15 12 9 18"></polyline>',
};

/**
 * Single source of truth for the "Strefa Członków" link list - every place the menu appears
 * (top-nav dropdown, mobile panel, desktop sidebar box, each duplicated again on the Galerie
 * page's variant header) renders from this same array via renderMembersZoneMenus() below,
 * instead of each carrying its own hand-copied HTML that could drift out of sync.
 * "Do przeczytania" is a non-clickable group heading with nested links, same order everywhere.
 */
const MEMBERS_ZONE_MENU = [
  { href: '/profil/', label: 'Mój profil', icon: 'user' },
  { href: '/czlonkowie/', label: 'Lista Członków', icon: 'users' },
  { href: '/galerie/', label: 'Galerie', icon: 'image' },
  { href: '/lista-wyjazdowa/', label: 'Lista wyjazdowa', icon: 'map' },
  { href: '/lista-wyjazdowa/skladki/', label: 'Składki', icon: 'coins' },
  {
    label: 'Do przeczytania',
    icon: 'book',
    items: [
      { href: '/zasady-bractwa/', label: 'Zasady Bractwa', icon: 'scroll' },
      { href: '/poradnik-walki/', label: 'Poradnik walki w linii', icon: 'swords' },
    ],
  },
  { href: '/discord', label: 'Forum/Discord', icon: 'chat', external: true },
];
// KRKG-0049 split the single /admin/ page into 4, so "Panel admina" becomes a collapsible group
// (same mechanism as "Do przeczytania" below) instead of one flat link. Unlike "Do przeczytania",
// this group's toggle itself must stay admin-gated (not just its sub-links) - a plain member must
// never see a "Panel admina" heading revealing the panel exists, even collapsed/empty. See
// makeGroup's gateToggle param below.
const ADMIN_ZONE_MENU = {
  label: 'Panel admina',
  icon: 'tool',
  items: [
    { href: '/admin/', label: 'Ogólne', icon: 'tool' },
    { href: '/admin/zgloszenia/', label: 'Zgłoszenia', icon: 'scroll' },
    { href: '/admin/zarzadzanie-ludzmi/', label: 'Spis Ludności', icon: 'users' },
    { href: '/admin/publiczne-wizytowki/', label: 'Publiczne wizytówki', icon: 'user' },
  ],
};

/**
 * Renders MEMBERS_ZONE_MENU into every `.members-zone-links` mount point found in the DOM.
 * `data-members-zone-flavor` picks the link classes for that mount ("nav" for the top-nav
 * dropdown and mobile panel, which share identical markup/classes; "sidebar" for the desktop
 * sidebar box) and `data-members-zone-exclude` (used on the Galerie page's header variant, which
 * has no reason to link back to the page it's already on) drops one href from that mount only.
 * Links start `hidden` - the membership/admin gates below reveal them, exactly as when they were
 * static HTML - and Panel admina is appended last as a group carrying `.admin-zone-link` on both
 * its toggle and its sub-links, so its own separate gate keeps working unchanged.
 */
function renderMembersZoneMenus() {
  document.querySelectorAll('.members-zone-links').forEach(mount => {
    const flavor = mount.dataset.membersZoneFlavor || 'nav';
    const exclude = mount.dataset.membersZoneExclude;
    const linkClass = flavor === 'sidebar' ? 'members-zone-sidebar-link' : 'nav-item nav-subitem';
    const groupLabelClass = flavor === 'sidebar' ? 'members-zone-sidebar-label members-zone-group-label' : 'nav-item nav-subitem members-zone-group-label';
    const nestedClass = flavor === 'sidebar' ? 'members-zone-sidebar-link--nested' : 'nav-subitem--nested';

    function makeIcon(icon, extraClass) {
      const span = document.createElement('span');
      span.className = extraClass ? `mz-icon ${extraClass}` : 'mz-icon';
      span.setAttribute('aria-hidden', 'true');
      span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MZ_ICON_PATHS[icon]}</svg>`;
      return span;
    }

    function makeLink(item, extraClass, visibilityClass = 'member-zone-link') {
      if (exclude && item.href === exclude) return null;
      const a = document.createElement('a');
      a.href = item.href;
      a.className = `${linkClass} ${visibilityClass}${extraClass ? ` ${extraClass}` : ''}`;
      a.hidden = true;
      if (item.external) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.append(makeIcon(item.icon), ` ${item.label}`);
      return a;
    }

    // Collapses/expands its nested links - starts collapsed so the menu stays compact. A
    // <button>, not a plain non-interactive label, so it's independently toggleable in each of
    // the three flavors. `gateToggle` adds `visibilityClass` to the toggle itself too (see
    // ADMIN_ZONE_MENU's comment above) - "Do przeczytania" doesn't need this since reaching this
    // function at all already implies membership, so its toggle is fine always-visible.
    function makeGroup(item, visibilityClass, gateToggle) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `${groupLabelClass} mz-group-toggle${gateToggle ? ` ${visibilityClass}` : ''}`;
      if (gateToggle) toggle.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.append(makeIcon(item.icon), ` ${item.label}`, makeIcon('chevron', 'mz-chevron'));

      const sublist = document.createElement('div');
      sublist.className = 'mz-group-items';
      sublist.hidden = true;
      item.items.forEach(sub => {
        const link = makeLink(sub, nestedClass, visibilityClass);
        if (link) sublist.append(link);
      });

      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        sublist.hidden = expanded;
      });

      return { toggle, sublist };
    }

    mount.replaceChildren();
    MEMBERS_ZONE_MENU.forEach(item => {
      if (item.items) {
        const { toggle, sublist } = makeGroup(item, 'member-zone-link', false);
        mount.append(toggle, sublist);
        return;
      }
      const link = makeLink(item);
      if (link) mount.append(link);
    });

    const { toggle: adminToggle, sublist: adminSublist } = makeGroup(ADMIN_ZONE_MENU, 'admin-zone-link', true);
    mount.append(adminToggle, adminSublist);
  });

  // The menu's own links didn't exist yet when updateNavigation() ran on DOMContentLoaded
  // (that listener is registered above this one), so the freshly-minted ones never got their
  // current-page state. updateNavigation is declared with `function`, so it's hoisted and safe
  // to call here regardless of listener order.
  updateNavigation();
}

document.addEventListener('DOMContentLoaded', renderMembersZoneMenus);

/**
 * "Strefa Członków" exists in the DOM up to three times per page - the desktop sidebar box
 * (#members-zone-sidebar, see social_sidebar.html), the mobile header trigger/panel
 * (#members-zone-mobile, see nav.html) and the desktop top-nav dropdown (#members-zone-nav) -
 * each rendered from the same MEMBERS_ZONE_MENU above via renderMembersZoneMenus(), shown/hidden
 * by CSS media query rather than JS, so only one is ever visible at a time. Both gates below are
 * independent - Panel admina (admin allowlist) alongside the membership-only links (kruki group
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
  const applyLink = document.getElementById('nav-apply-link');
  const logoutLink = document.getElementById('nav-logout-link');
  const checking = document.getElementById('nav-auth-checking');
  if (!avatarSlot || typeof initGoogleSignIn !== 'function') return;

  function renderAvatar(identity) {
    if (checking) checking.hidden = true;
    if (!identity) {
      avatarSlot.innerHTML = '';
      if (loginLink) loginLink.hidden = false;
      if (applyLink) applyLink.hidden = false;
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
    if (applyLink) applyLink.hidden = true;
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
