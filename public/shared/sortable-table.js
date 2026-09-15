// Click-to-sort wiring shared by every dense .czl-table on the site (Spis Ludności, Zarządzanie
// ludźmi, Lista Wyjazdowa's roster, Składki) - previously only Spis Ludności (czlonkowie.js) had
// this, hand-rolled, and every other table had no sorting at all. One implementation now, so
// "click a sortable header" behaves identically everywhere instead of drifting per page.
//
// Usage: mark each sortable <th> with `data-sort-key="..."` and put a <button> inside it (native
// focus/Enter-activation, same convention this codebase already used for Spis Ludności's headers).
// Call initSortableTable(table, { defaultKey, onChange }) once the table exists - it does not
// render anything itself, only tracks which key/dir is active and fires onChange(key, dir) on every
// header click, so the caller's own render function (already invoked once after its initial fetch,
// same as every page on this site) reads .key/.dir off the returned state. Works even when a
// table's whole <thead> is rebuilt on each render (Składki's two tables, whose column set depends
// on canManageSkladki/mode) - the listener lives on the outer `table` element via delegation, so it
// survives an innerHTML replacement; call `.refresh()` after such a replacement to stamp the fresh
// header cells with the current aria-sort.
function initSortableTable(table, { defaultKey, defaultDir = 'asc', onChange }) {
  const state = { key: defaultKey, dir: defaultDir };

  function applyAriaSort() {
    table.querySelectorAll('thead th[data-sort-key]').forEach((th) => {
      const active = th.dataset.sortKey === state.key;
      th.setAttribute('aria-sort', active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  table.addEventListener('click', (e) => {
    const btn = e.target.closest('thead th[data-sort-key] button');
    if (!btn) return;
    const key = btn.closest('th').dataset.sortKey;
    if (state.key === key) {
      state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.key = key;
      state.dir = 'asc';
    }
    applyAriaSort();
    onChange(state.key, state.dir);
  });

  applyAriaSort();
  return {
    get key() { return state.key; },
    get dir() { return state.dir; },
    refresh: applyAriaSort,
    // For a page whose table can switch between genuinely different column sets (Składki's year
    // table vs. its Wpisowe-only list) and wants a different natural default sort per set - e.g.
    // "Dołączył" for the Wpisowe list, "Sekcja" for the year table - rather than leaving whatever
    // key/dir was active in the other set (which may not even name a column that still exists).
    reset(key, dir = 'asc') {
      state.key = key;
      state.dir = dir;
      applyAriaSort();
    },
  };
}

// A generic (a, b, dir) comparator covering the three value shapes these tables actually sort by -
// strings (Polish locale-aware, case-insensitive), numbers/dates-as-ISO-strings compare fine as
// strings too), and booleans (false before true, so "unpaid" naturally sorts before "paid"
// ascending - the common case a chaser actually wants). null/undefined sort as the empty string,
// last under 'pl' collation. Column-specific tie-breaks (e.g. "same section, then by name") stay
// the caller's own business logic, layered on top of this.
function compareValues(a, b, dir) {
  let cmp;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    cmp = (a === b) ? 0 : (a ? 1 : -1);
  } else if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else {
    cmp = String(a ?? '').toLocaleLowerCase('pl').localeCompare(String(b ?? '').toLocaleLowerCase('pl'), 'pl');
  }
  return dir === 'desc' ? -cmp : cmp;
}

// Date/timestamp comparator for optional values - missing dates always remain after real dates,
// even when the user switches from ascending to descending order. ISO timestamps sort
// lexicographically, so no Date parsing or timezone conversion is needed here.
function compareDateValues(a, b, dir) {
  const aMissing = a == null || a === '';
  const bMissing = b == null || b === '';
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }
  const cmp = String(a).localeCompare(String(b));
  return dir === 'desc' ? -cmp : cmp;
}
