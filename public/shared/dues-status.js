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
