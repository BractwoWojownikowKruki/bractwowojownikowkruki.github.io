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

function personPillIconHtml() {
  return '<svg class="person-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="osoba bez konta"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
}

/**
 * Renders a person's name as the shared colored category pill.
 *
 * @param {{ name: string, categoryId?: string|null, categoryLabel?: string|null, accountless?: boolean, extraClass?: string }} person
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
  const icon = person.accountless ? personPillIconHtml() : '';
  return `<span class="${classes}"${categoryAttrs}>${icon}${personPillEscapeHtml(person.name)}</span>`;
}
