// Single source of truth on the client for składka roczna status - its three values, their
// labels and the default for a member+year with no stored record. Previously each page kept its
// own copy (skladki.js, wyjazd.js, app.js, profile-panel.js, profil.js), and Mój profil drifted:
// it still read the legacy `paid` boolean after the stored shape became `status`, so every paid
// member saw "nieopłacona" there while every other page showed "opłacona".
//
// Wherever the server already hands over a resolved `duesStatus` (GET /member-profile, the
// roster, GET /lista-wyjazdowa/dues/mine) a page must use that value as-is. effectiveDuesStatus
// below is only for pages that build the status themselves from a raw dues list (skladki.js's
// per-year table) or optimistically before a reload (wyjazd.js's quick-add) - it mirrors
// upload-service/src/dues.ts's effectiveDuesStatus exactly (scripts/dues-status.test.ts checks
// both against each other).

// categories' fixed id set is seeded by upload-service/scripts/seed-lookup-lists.ts's slugify -
// "Emeryt" -> "emeryt", same id as dues.ts's EMERYT_CATEGORY_ID.
const EMERYT_CATEGORY_ID = 'emeryt';

const DUES_STATUS_LABELS = { unpaid: 'nieopłacona', paid: 'opłacona', not_applicable: 'nie dotyczy' };

// storedStatus is the stored record's status (undefined/null when no record exists for that
// member+year) - an explicit record always wins, the category default applies only without one.
function effectiveDuesStatus(storedStatus, categoryId) {
  if (storedStatus) return storedStatus;
  return categoryId === EMERYT_CATEGORY_ID ? 'not_applicable' : 'unpaid';
}

function duesStatusLabel(year, status) {
  return `Składka ${year}: ${DUES_STATUS_LABELS[status] ?? DUES_STATUS_LABELS.unpaid}`;
}

// Wpisowe and a trip's składka have the same three states (upload-service/src/dues.ts's
// effectiveWpisoweStatus/normalizeSkladkaStatus). The server hands over the resolved
// wpisoweStatus/skladkaStatus, and pages use it as-is; effectiveWpisoweStatus below is only for
// wyjazd.js's optimistic quick-add row (mirrors dues.ts, checked by scripts/dues-status.test.ts).
// Labels: wpisowe is neuter ("opłacone"), składka feminine ("opłacona").
const BOBO_CATEGORY_ID = 'bobo';

function effectiveWpisoweStatus(storedStatus, categoryId) {
  if (storedStatus) return storedStatus;
  return categoryId === BOBO_CATEGORY_ID ? 'not_applicable' : 'unpaid';
}

const WPISOWE_STATUS_LABELS = { unpaid: 'nieopłacone', paid: 'opłacone', not_applicable: 'nie dotyczy' };

function wpisoweStatusLabel(status) {
  return `Wpisowe: ${WPISOWE_STATUS_LABELS[status] ?? WPISOWE_STATUS_LABELS.unpaid}`;
}

function skladkaStatusLabel(status) {
  return `Składka: ${DUES_STATUS_LABELS[status] ?? DUES_STATUS_LABELS.unpaid}`;
}

// Glyph for the check/cross badges (.lw-skladka-icon[data-status], member-area.css) - a dash for
// "nie dotyczy", next to the grey background.
const DUES_STATUS_GLYPHS = { unpaid: '✕', paid: '✓', not_applicable: '–' };

function duesStatusGlyph(status) {
  return DUES_STATUS_GLYPHS[status] ?? DUES_STATUS_GLYPHS.unpaid;
}

// Click-to-cycle order shared by every three-state badge (Składki page, event page) - unpaid ->
// paid keeps the common single-click "mark as paid"; reaching not_applicable takes one more click.
const DUES_STATUS_CYCLE = ['unpaid', 'paid', 'not_applicable'];

function nextDuesStatus(current) {
  return DUES_STATUS_CYCLE[(DUES_STATUS_CYCLE.indexOf(current) + 1) % DUES_STATUS_CYCLE.length];
}
