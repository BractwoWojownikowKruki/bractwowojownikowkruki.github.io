/**
 * Navigation Active State Handler
 * Sets active/highlighted nav item based on current page
 */
function updateNavigation() {
  const currentPath = window.location.pathname;
  const navItems = document.querySelectorAll('.nav-item');

  navItems.forEach(item => {
    const href = item.getAttribute('href');

    // Check if this is the current page
    const isActive = href === currentPath || (href === '/' && currentPath === '/');

    // Remove previous active states
    item.classList.remove('nav-item--active');
    item.classList.remove('nav-item--highlighted');

    if (isActive) {
      // Nabór gets highlighted style, others get active style
      if (href === '/nabor') {
        item.classList.add('nav-item--highlighted');
      } else {
        item.classList.add('nav-item--active');
      }
    }
  });
}

// Update navigation when DOM is ready
document.addEventListener('DOMContentLoaded', updateNavigation);

// Update navigation on popstate (browser back/forward)
window.addEventListener('popstate', updateNavigation);
