// Summary pills that double as filters ("Filtruj wg sekcji/statusu/broni") - shared by every page
// with a pill summary above a table (Lista wyjazdowa's event page and Składki, Spis Ludności,
// Zarządzanie ludźmi). Same rules and look as the equipment page's section filter
// (sprzet-obozowy.js's renderSectionFilter): several pills pressed within one group widen the
// result (OR), pills pressed in different groups narrow it (AND - Poznań + Niewiasta shows only
// Poznań's niewiasty), a pressed pill gets a checkmark and a ring, the others dim, and one
// "Wyczyść filtr" clears every group at once. Counts on the pills never change with the filter.
// Not persisted - every visit starts unfiltered.
//
// The page owns its rendering: it builds each pill with summaryFilterChipHtml, wraps the groups with
// summaryFilterBlockHtml, calls wireSummaryFilter once on a container that outlives re-renders, and
// checks rows with summaryFilterMatches. A null value (no section / no status) is its own pill,
// keyed as ''.

function summaryFilterEscape(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function summaryFilterKey(value) {
  return value ?? '';
}

function createSummaryFilter(groupKeys) {
  const selected = {};
  for (const key of groupKeys) selected[key] = new Set();
  return { selected };
}

function summaryFilterActive(filter) {
  return Object.values(filter.selected).some((set) => set.size > 0);
}

// Only the groups present in `values` are checked, so a table that has no such column (the event
// page's equipment table has a section but no status or weapon) is narrowed by the groups it has.
function summaryFilterMatches(filter, values) {
  return Object.entries(filter.selected).every(([group, set]) =>
    set.size === 0 || !(group in values) || set.has(summaryFilterKey(values[group])),
  );
}

// Drops pressed values that no longer have a pill (e.g. the last attendee from a section signed
// off), so the filter can never be stuck on a pill that is not rendered. `availableByGroup` maps a
// group to the values its pills are rendered for.
function summaryFilterPrune(filter, availableByGroup) {
  for (const [group, values] of Object.entries(availableByGroup)) {
    const available = new Set([...values].map(summaryFilterKey));
    for (const key of filter.selected[group]) {
      if (!available.has(key)) filter.selected[group].delete(key);
    }
  }
}

// `content` is already-escaped HTML (label, icon, count badge); `className`/`attrs` carry the pill's
// own look (section-pill + data-section, category-name-pill + data-category, or nothing for a
// neutral pill).
function summaryFilterChipHtml(filter, group, value, { className = '', attrs = '', content }) {
  const key = summaryFilterKey(value);
  const pressed = filter.selected[group].has(key);
  return `<button type="button" class="${className ? `${className} ` : ''}lw-summary-chip lw-filter-chip"${attrs ? ` ${attrs}` : ''} data-filter-group="${summaryFilterEscape(group)}" data-filter-value="${summaryFilterEscape(key)}" aria-pressed="${pressed}">${content}</button>`;
}

// columns: [{ heading, chipsHtml }] - heading is plain text ("Filtruj wg sekcji").
function summaryFilterBlockHtml(filter, columns) {
  const active = summaryFilterActive(filter);
  const clear = `<button type="button" class="equipment-filter-clear lw-filter-clear" data-filter-clear${active ? '' : ' disabled'}>Wyczyść filtr</button>`;
  const groups = columns.map(({ heading, chipsHtml }) => `
      <div role="group" aria-label="${summaryFilterEscape(heading)}"><h3>${summaryFilterEscape(heading)}</h3><div class="lw-summary-chips">${chipsHtml}</div></div>`).join('');
  return `<div class="lw-summary-filter" data-filter-active="${active}">
    <div class="lw-summary-columns">${groups}
    </div>
    ${clear}
  </div>`;
}

// One delegated listener on `container` (must survive the page's re-renders). onChange re-renders
// both the pills and the table(s); focus then goes back to the button just pressed.
function wireSummaryFilter(container, filter, onChange) {
  container.addEventListener('click', (e) => {
    const isClear = Boolean(e.target.closest('[data-filter-clear]'));
    const chip = e.target.closest('[data-filter-group]');
    if (!isClear && !chip) return;
    const group = chip?.dataset.filterGroup;
    const key = chip?.dataset.filterValue;
    if (isClear) {
      for (const set of Object.values(filter.selected)) set.clear();
    } else if (filter.selected[group]?.has(key)) {
      filter.selected[group].delete(key);
    } else {
      filter.selected[group]?.add(key);
    }
    onChange();
    const buttons = [...container.querySelectorAll('[data-filter-clear], [data-filter-group]')];
    const again = isClear
      ? buttons.find((b) => 'filterClear' in b.dataset)
      : buttons.find((b) => b.dataset.filterGroup === group && b.dataset.filterValue === key);
    // The clear button is disabled right after clearing, so it cannot take focus - fall back to the
    // first pill then.
    (again && !again.disabled ? again : buttons.find((b) => 'filterGroup' in b.dataset))?.focus();
  });
}
