// KRKG: keeps .lw-topbar (the sticky bar holding the shared trip-picker dropdown and "Dodaj
// wyjazd") pinned directly under the site's own sticky header instead of overlapping it. Two
// independently `position: sticky; top: 0` bars stack on top of each other unless the second one's
// `top` is offset by the first one's actual rendered height - the header's height isn't fixed
// (it wraps on narrow viewports, and .main-nav can grow), so this measures it and republishes it
// as the --lw-header-h custom property .lw-topbar's `top` reads (member-area.css).
//
// Deliberately separate from shared/lw-nav.js: that module is a pure HTML-string generator with
// no DOM access of its own (see its own header comment) - this is a page-layout concern, not part
// of the dropdown component itself.
(function () {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;

  function syncHeaderOffset() {
    const header = document.querySelector('.site-header--main') || document.querySelector('.site-header');
    const height = header ? header.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--lw-header-h', `${height}px`);
  }

  syncHeaderOffset();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', syncHeaderOffset);
    window.addEventListener('load', syncHeaderOffset);
  }
}());
