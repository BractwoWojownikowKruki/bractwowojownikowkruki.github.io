/**
 * Navigation Active State Handler
 * Marks the nav item matching the current page as active. Resolves each item's href
 * (which may be relative, e.g. "../galerie/") against the current location before
 * comparing, so this works regardless of whether the site is served from a domain root
 * or a GitHub Pages project subpath.
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
  // Same path as the inline "Historia" link icon on zarzadzanie-ludzmi/index.html and admin/index.html.
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path>',
  chevron: '<polyline points="9 6 15 12 9 18"></polyline>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>',
};

/**
 * Single source of truth for the "Strefa Członków" link list - every place the menu appears
 * (top-nav dropdown, mobile panel, desktop sidebar box, each duplicated again on the Galerie
 * page's variant header) renders from this same array via buildMountContent()/reconcileAllMounts()
 * below, instead of each carrying its own hand-copied HTML that could drift out of sync.
 * "Do przeczytania" is a non-clickable group heading with nested links, same order everywhere.
 */
const MEMBERS_ZONE_MENU = [
  { href: '/profil/', label: 'Mój profil', icon: 'user' },
  { href: '/czlonkowie/', label: 'Spis Ludności', icon: 'users' },
  { href: '/galerie/', label: 'Galerie', icon: 'image' },
  { href: '/lista-wyjazdowa/', label: 'Lista wyjazdowa', icon: 'map' },
  { href: '/lista-wyjazdowa/skladki/', label: 'Składki', icon: 'coins' },
  { href: '/pliki/', label: 'Pliki', icon: 'paperclip' },
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
// KRKG-0049 split the single /admin/ page into 4, so "Zarządzanie" (né "Panel admina" -
// KRKG-0073 renamed it because a moderator, who only ever sees 2 of its 5 items, legitimately
// belongs in this group too - "Panel admina" wrongly implied it was admin-exclusive) becomes a
// collapsible group (same mechanism as "Do przeczytania" below) instead of one flat link.
// KRKG-0073: each item's `gate` says which zoneState flag (below) must be `true` before that
// item exists in the DOM at all - "Zarządzanie ludźmi" and "Audyt" are reachable by a
// Firestore-role moderator too (gated server-side via /admin/members/whoami ->
// isAdminOrModerator), the other three stay admin-allowlist-only (isAdmin). The toggle itself
// gates on the broader `isAdminOrModerator` (see reconcileAdminSection below) so it reveals for
// either audience - never the OR of two independently-resolved flags, which would let one
// resolve while the other is still unknown and either flash the toggle briefly for a plain
// member (before the narrower check catches up) or hide it a moment too long for a moderator.
const ADMIN_ZONE_MENU = {
  label: 'Zarządzanie',
  icon: 'tool',
  items: [
    { href: '/admin/', label: 'Ogólne', icon: 'tool', gate: 'isAdmin' },
    { href: '/admin/zgloszenia/', label: 'Zgłoszenia', icon: 'scroll', gate: 'isAdmin' },
    { href: '/admin/zarzadzanie-ludzmi/', label: 'Zarządzanie ludźmi', icon: 'users', gate: 'isAdminOrModerator' },
    { href: '/admin/publiczne-wizytowki/', label: 'Publiczne wizytówki', icon: 'user', gate: 'isAdmin' },
    { href: '/admin/audyt/', label: 'Audyt', icon: 'history', gate: 'isAdminOrModerator' },
  ],
};

// KRKG-0073: `null` means "not yet known" (no whoami has answered for this browsing session /
// verification round yet) - reconcile*Section below treats that identically to a confirmed
// `false`, i.e. nothing gated renders. Shared, page-wide state: the whole point of this refactor
// is that DOM presence for every member/admin-only nav element is driven from here, never from
// `hidden`/CSS.
const zoneState = { isMember: null, isAdmin: null, isAdminOrModerator: null };

// KRKG-0073: which verification round the state above currently reflects (see
// verificationGeneration in auth.js). Every onSignedIn/onSignedOut/onForbidden callback below
// carries the generation its underlying request actually started from; one that doesn't match
// this is a response to a round that a later, fresh sign-in has since superseded (onIdentity,
// below, is what advances this) and must be ignored outright - otherwise a slow response from an
// identity nobody is signed in as any more could resurrect that identity's old privileges.
let acceptedGeneration = 0;

// Built once per mount (on DOMContentLoaded, see the listener right after buildMountContent
// below) and never rebuilt afterwards - only ever inserted into / removed from the DOM by
// reconcile*Section, never destroyed, so toggle expand/collapse state and event listeners
// survive a hide-then-show cycle. Keyed by the mount element itself since there can be up to 3
// per page (top-nav dropdown, mobile panel, desktop sidebar - see reconcileAllMounts's doc
// comment further down).
const mountBuilds = new WeakMap();

/**
 * Builds (but does not insert anywhere) every element `renderMembersZoneMenus` used to build
 * eagerly. `data-members-zone-flavor` picks the link classes for this mount ("nav" for the
 * top-nav dropdown and mobile panel, which share identical markup/classes; "sidebar" for the
 * desktop sidebar box) and `data-members-zone-exclude` (used on the Galerie page's header
 * variant, which has no reason to link back to the page it's already on) drops one href from
 * this mount only.
 */
function buildMountContent(mount) {
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

  // No `hidden`/visibility class of any kind any more - whether this element ever reaches the
  // DOM at all is decided purely by whether reconcile*Section ever inserts it (see below).
  function makeLink(item, extraClass) {
    if (exclude && item.href === exclude) return null;
    const a = document.createElement('a');
    a.href = item.href;
    a.className = `${linkClass}${extraClass ? ` ${extraClass}` : ''}`;
    if (item.external) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.append(makeIcon(item.icon), ` ${item.label}`);
    return a;
  }

  // Collapses/expands its nested links - starts collapsed so the menu stays compact. A
  // <button>, not a plain non-interactive label, so it's independently toggleable in each of
  // the three flavors.
  function makeGroupToggleAndSublist(item) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `${groupLabelClass} mz-group-toggle`;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.append(makeIcon(item.icon), ` ${item.label}`, makeIcon('chevron', 'mz-chevron'));

    const sublist = document.createElement('div');
    sublist.className = 'mz-group-items';
    sublist.hidden = true;

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      sublist.hidden = expanded;
    });

    return { toggle, sublist };
  }

  // Member section: flat links + "Do przeczytania" group, gated as a single all-or-nothing
  // unit on zoneState.isMember (see reconcileMemberSection) - one gate, so no ordering concerns.
  const memberNodes = [];
  MEMBERS_ZONE_MENU.forEach(item => {
    if (item.items) {
      const { toggle, sublist } = makeGroupToggleAndSublist(item);
      item.items.forEach(sub => {
        const link = makeLink(sub, nestedClass);
        if (link) sublist.append(link);
      });
      memberNodes.push(toggle, sublist);
      return;
    }
    const link = makeLink(item);
    if (link) memberNodes.push(link);
  });

  // "Zarządzanie" section: toggle gated on isAdminOrModerator (broadest - see ADMIN_ZONE_MENU's
  // comment above), each item gated independently on its OWN `gate` - reconcileAdminSection
  // inserts/removes each of these on its own, in ADMIN_ZONE_MENU.items order, regardless of
  // which of isAdmin/isAdminOrModerator resolves first or how much later than the other.
  const { toggle: adminToggle, sublist: adminSublist } = makeGroupToggleAndSublist(ADMIN_ZONE_MENU);
  const adminItems = ADMIN_ZONE_MENU.items
    .map(item => ({ el: makeLink(item, nestedClass), gate: item.gate }))
    .filter(entry => entry.el);

  return { memberNodes, adminToggle, adminSublist, adminItems };
}

// Single gate (zoneState.isMember) -> the whole fragment is all-or-nothing, so plain presence
// (`some(el => el.isConnected)`) is enough to know the current state without a separate marker.
function reconcileMemberSection(mount) {
  const build = mountBuilds.get(mount);
  if (!build) return;
  const shouldShow = zoneState.isMember === true;
  const isShown = build.memberNodes.some(el => el.isConnected);
  if (shouldShow && !isShown) {
    mount.prepend(...build.memberNodes);
  } else if (!shouldShow && isShown) {
    build.memberNodes.forEach(el => el.remove());
  }
}

// Toggle and each sublist item reconcile independently, each against its own gate - see
// ADMIN_ZONE_MENU's comment. Safe to call any number of times, in any order, for a state that has
// gone true -> false -> true again (e.g. across a reset - see onIdentity further down), always
// converging the DOM to match zoneState exactly.
//
// Deliberately `el.parentNode === adminSublist`, NOT `el.isConnected`, for each item's own
// presence check - these answer different questions and only one of them is right here:
// `isConnected` is "is this attached to the live document", which depends on whether adminSublist
// ITSELF is currently attached to `mount` (the toggle-level gate below) - using it per-item would
// make an item's own insertBefore ordering (which sibling counts as "already placed") depend on
// the WHOLE section's visibility, not just on which other items are its current siblings. That
// broke exactly this way during manual testing: hide the whole section (toggle-level gate closes,
// item elements stay right where they were as children of the now-detached adminSublist, never
// individually removed) then show a *different* subset later - an item asking `.isConnected`
// about a sibling gets `false` for those untouched leftover children (their ANCESTOR is detached,
// even though their relative order among each other is still perfectly intact) and inserts itself
// at the end instead of before them, garbling the order. `parentNode` tracks "is this a child of
// adminSublist right now" independent of whether adminSublist is itself in the document, so
// relative order among items survives a hide/show cycle exactly like the toggle's own expand/
// collapse state does. Security is untouched by this distinction: the toggle-level `isConnected`
// check is what decides whether ANYTHING in the group can be part of the live document at all.
function reconcileAdminSection(mount) {
  const build = mountBuilds.get(mount);
  if (!build) return;
  const { adminToggle, adminSublist, adminItems } = build;

  const toggleShouldShow = zoneState.isAdminOrModerator === true;
  if (toggleShouldShow && !adminToggle.isConnected) {
    mount.append(adminToggle, adminSublist);
  } else if (!toggleShouldShow && adminToggle.isConnected) {
    adminToggle.remove();
    adminSublist.remove();
  }

  adminItems.forEach(({ el, gate }, idx) => {
    const shouldShow = zoneState[gate] === true;
    const isPresent = el.parentNode === adminSublist;
    if (shouldShow && !isPresent) {
      const nextPresent = adminItems.slice(idx + 1).find(entry => entry.el.parentNode === adminSublist);
      adminSublist.insertBefore(el, nextPresent ? nextPresent.el : null);
    } else if (!shouldShow && isPresent) {
      el.remove();
    }
  });
}

/**
 * Brings every `.members-zone-links` mount's DOM in line with the current `zoneState` - the
 * single entry point called after any accepted (see acceptedGeneration) whoami result changes
 * that state. "Strefa Członków" exists in the DOM up to three times per page - the desktop
 * sidebar box (#members-zone-sidebar, see social_sidebar.html), the mobile header trigger/panel
 * (#members-zone-mobile, see nav.html) and the desktop top-nav dropdown (#members-zone-nav) -
 * shown/hidden by CSS media query rather than JS, so only one is ever visible at a time, but all
 * three are kept in sync regardless.
 */
function reconcileAllMounts() {
  document.querySelectorAll('.members-zone-links').forEach(mount => {
    reconcileMemberSection(mount);
    reconcileAdminSection(mount);
  });
  updateMembersZoneVisibility();
  // Freshly inserted <a> elements haven't had a chance to pick up nav-item--active yet.
  // updateNavigation is declared with `function`, so it's hoisted and safe to call here
  // regardless of listener/call order.
  updateNavigation();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.members-zone-links').forEach(mount => {
    mount.replaceChildren();
    mountBuilds.set(mount, buildMountContent(mount));
  });
  // zoneState is still all-null at this point (no whoami has answered yet) - this call is a
  // no-op for DOM content, but still runs updateMembersZoneVisibility/updateNavigation once so
  // every container starts correctly hidden rather than however it happened to be left in HTML.
  reconcileAllMounts();
});

/**
 * Shows/hides each Strefa Członków container based on whether its own mount currently has any
 * content - which, since KRKG-0073, means "any content at all" rather than "any non-hidden
 * link", because nothing ungated ever reaches the mount in the first place.
 */
function updateMembersZoneVisibility() {
  document.querySelectorAll('.members-zone-links').forEach(mount => {
    const zone = mount.closest('.members-zone-container');
    if (zone) zone.hidden = mount.children.length === 0;
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
 * does (#nav-logout-link), and the "Zarządzanie" links (in both Strefa Członków containers) only
 * once the separate /admin/whoami or /admin/members/whoami check passes - see
 * reconcileAdminSection above. Keeping the login/logout controls and admin links out of the top
 * bar avoids crowding it (logo + avatar + hamburger/trigger already fill it on mobile) - they
 * only need to be reachable, not always visible. The actual Google sign-in button itself is no
 * longer rendered in the nav - it lives on /logowanie/ (see logowanie.js) - #nav-login-link is a
 * plain link there, same as any other nav item.
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

  // KRKG-0073: every onSignedIn/onSignedOut/onForbidden below is wrapped in this - `generation`
  // is each call's own verification round (see auth.js), and a call whose round doesn't match
  // the round our last onIdentity reset accepted is a stale response from an identity that a
  // later, fresher sign-in has already superseded. Ignoring it outright (not just "don't grant",
  // but "don't do anything at all") is what makes onIdentity's reset below actually stick until
  // the CURRENT round's real answer comes in.
  function ifCurrentRound(generation, apply) {
    if (generation !== acceptedGeneration) return;
    apply();
  }

  // The one and only reset path (registered on a single initGoogleSignIn call below - this is a
  // whole-page reset, not a per-gate one). Fires synchronously on every fresh sign-in, before any
  // of that round's whoami requests can possibly have resolved yet (see onIdentity's contract in
  // auth.js) - so whatever was on screen for the PREVIOUS identity is torn down immediately, and
  // only that same round's own (later) onSignedIn/onForbidden/onSignedOut calls - now guaranteed
  // to pass the ifCurrentRound check above - can put anything back.
  function resetForNewSignInRound(_payload, generation) {
    acceptedGeneration = generation;
    zoneState.isMember = null;
    zoneState.isAdmin = null;
    zoneState.isAdminOrModerator = null;
    renderAvatar(null);
    reconcileAllMounts();
  }

  if (logoutLink && typeof logout === 'function') {
    logoutLink.addEventListener('click', () => logout());
  }

  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/wojownicy-upload/whoami',
    onIdentity: resetForNewSignInRound,
    onSignedIn: (identity, generation) => ifCurrentRound(generation, () => {
      zoneState.isMember = true;
      renderAvatar(identity);
      reconcileAllMounts();
    }),
    onSignedOut: generation => ifCurrentRound(generation, () => {
      zoneState.isMember = false;
      renderAvatar(null);
      reconcileAllMounts();
    }),
    onForbidden: generation => ifCurrentRound(generation, () => {
      zoneState.isMember = false;
      renderAvatar(null);
      reconcileAllMounts();
    }),
  });

  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/admin/whoami',
    onSignedIn: (_identity, generation) => ifCurrentRound(generation, () => {
      zoneState.isAdmin = true;
      reconcileAllMounts();
    }),
    onSignedOut: generation => ifCurrentRound(generation, () => {
      zoneState.isAdmin = false;
      reconcileAllMounts();
    }),
    onForbidden: generation => ifCurrentRound(generation, () => {
      zoneState.isAdmin = false;
      reconcileAllMounts();
    }),
  });

  // KRKG-0049: separate from the /admin/whoami listener above - a Firestore-role moderator
  // passes /admin/members/whoami but not /admin/whoami, and vice versa isn't true (an admin
  // passes both). Each listener only ever sets its OWN zoneState flag, never the other one, so
  // the two checks can't race against each other - see ADMIN_ZONE_MENU's and
  // reconcileAdminSection's comments for how each item/toggle picks which flag it depends on.
  initGoogleSignIn({
    buttonIds: [],
    whoamiPath: '/admin/members/whoami',
    onSignedIn: (_identity, generation) => ifCurrentRound(generation, () => {
      zoneState.isAdminOrModerator = true;
      reconcileAllMounts();
    }),
    onSignedOut: generation => ifCurrentRound(generation, () => {
      zoneState.isAdminOrModerator = false;
      reconcileAllMounts();
    }),
    onForbidden: generation => ifCurrentRound(generation, () => {
      zoneState.isAdminOrModerator = false;
      reconcileAllMounts();
    }),
  });
});
