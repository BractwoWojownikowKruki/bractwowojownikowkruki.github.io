// KRKG-0087: one shared renderer for a person's name pill, so the "osoba bez konta" marker is
// identical everywhere a person is listed (the event roster now; Spis Ludności, Składki,
// Zarządzanie ludźmi and the profile drawer in later batches). The pill itself is the existing
// colored category pill (KRKG-0057); a person without an account additionally gets a small,
// meaningful person icon before their name - role="img" + aria-label, deliberately not
// aria-hidden, so assistive tech announces it.
//
// Self-contained escaping (own helper names) so the file does not depend on a page-local
// escapeHtml/escapeAttr being defined before it runs.
function personPillEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function personPillEscapeAttr(value) {
  return personPillEscapeHtml(value);
}

// KRKG-0089: the marker uses the same "child/companion" figure as the roster's add-companion
// button (.lw-add-companion-icon) - deliberately NOT the generic person icon the profile-open
// trigger uses, so a companion pill reads as a different kind of entry at a glance.
function personPillIconHtml() {
  return '<svg class="person-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="osoba bez konta"><circle cx="12" cy="5.5" r="2.6"/><path d="M12 8.5v6.5"/><path d="M8.2 11h7.6"/><path d="M9.2 22l2.8-7 2.8 7"/></svg>';
}

// Brokuł is semantic when it qualifies a person's name, but decorative beside the visible
// "Brokuł" category label; the explicit mode prevents duplicate screen-reader announcements.
function categoryPillBroccoliIconHtml(categoryId, mode = 'person') {
  if (categoryId !== 'brokul') return '';
  return mode === 'category-label'
    ? '<span class="brokul-pill-icon" aria-hidden="true">🥦</span>'
    : '<span class="brokul-pill-icon" role="img" aria-label="Brokuł">🥦</span>';
}

/**
 * Renders a person's name as the shared colored category pill.
 *
 * @param {{ name: string, categoryId?: string|null, categoryLabel?: string|null, accountless?: boolean, extraClass?: string, mode?: 'person'|'category-label' }} person
 *   `name` is the already-computed display name; `categoryLabel` is the resolved label (the caller
 *   owns the lookup-list map), defaulting to the raw id or "Brak statusu"; `extraClass` appends an
 *   extra class (e.g. a summary chip) without duplicating the class attribute.
 */
function personPillHtml(person) {
  const categoryId = person.categoryId ?? null;
  const label = person.categoryLabel ?? (categoryId || 'Brak statusu');
  const classes = person.extraClass ? `${person.extraClass} category-name-pill` : 'category-name-pill';
  const categoryAttrs = categoryId
    ? ` data-category="${personPillEscapeAttr(categoryId)}" title="${personPillEscapeAttr(label)}"`
    : ` title="${personPillEscapeAttr(label)}"`;
  const accountlessIcon = person.accountless ? personPillIconHtml() : '';
  const broccoliIcon = categoryPillBroccoliIconHtml(categoryId, person.mode);
  return `<span class="${classes}"${categoryAttrs}>${accountlessIcon}${broccoliIcon}${personPillEscapeHtml(person.name)}</span>`;
}
