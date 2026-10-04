/**
 * Składki page (Plan C, KRKG-0037): Wpisowe + Składka roczna (selectable year, KRKG-0047) for
 * every member, one .czl-table row per person - same dense-table shape as every other member list
 * on the site (Spis Ludności, Zarządzanie ludźmi, Lista Wyjazdowa's roster): a colored, sticky,
 * vertical-text Sekcja cell first, then a name pill (opens the shared profile drawer). The per-year
 * rate itself is a single free-text note set once at the top of the page, not a per-member amount
 * field. Read-only for every signed-in member; toggle/edit controls and the Historia zmian panel
 * only render when GET /lista-wyjazdowa/my-role reports canManageSkladki (accountant/admin) - the
 * server re-checks the role on every PUT/GET regardless, this only controls what the UI offers
 * (design.md §8, §9).
 *
 * Składki are a list of buttons (renderChargeBar), alphabetical, one pressed at a time: the built-in
 * "Wpisowe", one per składka roczna year, and one per składka dodatkowa (any member can create
 * those with "Dodaj składkę"; their creator, accountants and admins set the statuses and edit the
 * details - extra statuses default to "nie dotyczy"). A "Jak płacić" text block at the top, written
 * by accountants/admins, is shown to everyone exactly as typed. Extra charges are ignored by the
 * reminder panel on the dashboard (app.js reads only the annual dues).
 *
 * The "Wpisowe" button (renderWpisoweList) swaps the whole page from
 * the year table (renderTable - Składka roczna as its own icon-only column, no visible year
 * number) to a flat list of every member who still owes wpisowe, with its own Dołączył column
 * instead of Składka, sorted by join date (members.ts's approvedAt) so the oldest unpaid debt
 * surfaces first. KRKG-0074: the year view no longer shows Wpisowe at all (no column, no summary
 * line) - the dedicated Wpisowe view covers that due, so repeating it in the year view was just
 * noise on an already dense table.
 *
 * Składka roczna is three-state, not a plain toggle (KRKG follow-up): unpaid/paid/not_applicable
 * (dues.ts's DuesStatus). 'not_applicable' - a grey coin - covers a member the club doesn't
 * require this year's due from at all, defaulting for the "Emeryt" category
 * (EMERYT_CATEGORY_ID/effectiveDuesStatus) but overridable by hand either way (an emeryt who
 * actually pays just gets flipped to 'paid'). Excluded from renderSummary's counts entirely so
 * they don't dilute "who's unpaid", and (KRKG-0074, criterion corrected in KRKG-0075) rendered in
 * their own "Emeryci" table below the main one instead of as ordinary rows in it. That table's
 * membership is the member's category ("Emeryt"), not their dues status - a non-emeryt hand-set
 * to not_applicable stays in the main table, and a paying emeryt stays in the Emeryci one.
 *
 * Wpisowe is three-state too (unpaid/paid/not_applicable, default not_applicable for "Bobo" -
 * dues.ts's effectiveWpisoweStatus, resolved by the server as roster.wpisoweStatus). The Wpisowe
 * view lists the unpaid ones in the main table and the not_applicable ones in a "Nie dotyczy"
 * table below it (the Emeryci section, retitled), and its summary skips not_applicable the same way.
 */

// Same escapeHtml/escapeAttr pair as wyjazd.js/profil.js/person-tile.js - the established pattern
// in this codebase for interpolating user-controlled strings into an innerHTML template.
// escapeAttr adds quote-escaping on top of escapeHtml, needed anywhere a value lands inside an
// attribute (e.g. data-email="...") rather than as text content.
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Icon-only Historia button (.audyt-history-btn, style.css) - same path everywhere it appears
// site-wide (nav.js's 'history' icon, zarzadzanie-ludzmi/index.html, galerie/app.js, ...).
const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';

// Same "show profile" person icon as wyjazd.js's roster (profile-trigger--icon-inline, shared
// profile-panel.css) - placed right after the name pill, which is itself wrapped in a
// profile-trigger button too (see renderTable below).
const PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';

// Same em-dash convention as czlonkowie.js/wyjazd.js's dense tables, for a cell with nothing to show.
const EMPTY = '—';

// 3-letter Sekcja abbreviations for the compact, sticky first column - same map as
// czlonkowie.js/wyjazd.js/zarzadzanie-ludzmi.js (duplicated per that established convention, see
// czlonkowie.js's own comment). Falls back to the id's own first 3 letters for anything not in
// this map, same never-hide-an-unresolved-reference spirit as sectionLabel's own fallback below.
const SECTION_ABBR = {
  bydgoszcz: 'BDG',
  czukcze: 'CZU',
  krakow: 'KRK',
  poznan: 'POZ',
  warszawa: 'WAW',
  wroclaw: 'WRO',
};
function sectionAbbr(sectionId) {
  return SECTION_ABBR[sectionId] ?? (sectionId ?? '').slice(0, 3).toUpperCase();
}

// The name cell shared by both tables below (year table and Wpisowe list). KRKG-0087: the pill is
// rendered by shared/person-pill.js, which adds the "osoba bez konta" marker. A member's pill opens
// the shared profile drawer by e-mail; an accountless person has no e-mail, so their pill opens the
// same drawer through the person-keyed endpoint (data-person-id).
function nameCellHtml(member, personIdAttr, categoryLabel) {
  const namePill = personPillHtml({
    name: displayName(member),
    categoryId: member.categoryId,
    categoryLabel,
    accountless: member.accountless === true,
    subline: personSubline(member),
  });
  if (member.accountless) {
    return `<button type="button" class="profile-trigger" data-profile-trigger data-person-id="${personIdAttr}">
            ${namePill}
          </button>`;
  }
  return `<button type="button" class="profile-trigger" data-profile-trigger data-email="${personIdAttr}"${profileFolderAttr(member)}>
            ${namePill}
          </button>
          <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${personIdAttr}"${profileFolderAttr(member)} aria-label="Pokaż profil" title="Pokaż profil">${PERSON_ICON}</button>`;
}

// displayName(member) itself now lives in shared/display-name.js (included via index.html) - see
// its own comment for the priority order and the email-typed-into-a-name-field edge case.

// Wpisowe's three-state check/cross/dash (member-area.css's .lw-skladka-icon, red/green/grey
// background from data-status) - a plain <span> for members who can't manage składki (nothing to
// click), an actual <button> otherwise. data-kind="wpisowe" is how the shared click handler below
// tells this apart from rocznaIconHtml's coin.
function wpisoweIconHtml(personIdAttr, status) {
  const label = wpisoweStatusLabel(status);
  const glyph = duesStatusGlyph(status);
  if (!canManageSkladki) {
    return `<span class="lw-skladka-icon" data-status="${status}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${glyph}</span>`;
  }
  return `<button type="button" class="lw-skladka-icon" data-kind="wpisowe" data-person-id="${personIdAttr}" data-status="${status}" title="${escapeAttr(label)} — kliknij, aby zmienić" aria-label="${escapeAttr(label)}">${glyph}</button>`;
}

function memberWpisoweStatus(member) {
  return member.wpisoweStatus ?? 'unpaid';
}

// Składka roczna's third state (KRKG follow-up) - a member the club doesn't require this year's
// due from at all: an Emeryt by default, or anyone else set this way by hand (e.g. someone who
// joined partway through the year). The default itself, the labels and EMERYT_CATEGORY_ID live in
// shared/dues-status.js (mirroring dues.ts) - this only looks up the stored record for the row.
function memberDuesStatus(member, duesByPersonId) {
  // A składka dodatkowa has no category defaults: whoever has no stored status is "nie dotyczy".
  if (extraMode) return duesByPersonId.get(member.personId)?.status ?? 'not_applicable';
  // KRKG-0087: dues are keyed by the canonical personId (a member's e-mail, an accountless
  // person's UUID), not by e-mail - a person row has email: null, so keying by e-mail both missed
  // their stored status and crashed on the null. For a member the value is identical.
  return effectiveDuesStatus(duesByPersonId.get(member.personId)?.status, member.categoryId);
}

function rocznaLabel(status) {
  return duesStatusLabel(chargeTitle(), status);
}

// Wpisowe and składka roczna: accountants/admins only. A składka dodatkowa: its creator too (the
// server's canEdit already says so for this viewer).
function canChangeStatuses() {
  return extraMode ? selectedCharge.canEdit === true : canManageSkladki;
}

// Click-to-cycle order for both badges (see the click handler below) is shared/dues-status.js's
// nextDuesStatus: unpaid -> paid -> not_applicable -> unpaid.

// Same badge shape as wpisoweIconHtml above, but three-coloured (green/red/grey via data-status,
// member-area.css) instead of a plain boolean - not_applicable renders the same 💰 glyph so the
// column stays visually uniform, only its background says "this member doesn't owe this at all".
function rocznaIconHtml(personIdAttr, status) {
  const label = rocznaLabel(status);
  if (!canChangeStatuses()) {
    return `<span class="lw-skladka-icon" data-status="${status}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">💰</span>`;
  }
  return `<button type="button" class="lw-skladka-icon" data-kind="roczna" data-person-id="${personIdAttr}" data-status="${status}" title="${escapeAttr(label)} — kliknij, aby zmienić" aria-label="${escapeAttr(label)}">💰</button>`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

// Plain DD.MM.YYYY string manipulation, not a Date object - see lista-wyjazdowa.js's identical
// formatDate() for why (avoids UTC/local skew on a bare calendar date with no time component).
// Named formatDueDate, not formatDate, because this file's existing formatDate is Date-based and
// used for timestamp fields (e.g. member.approvedAt) - do not touch or reuse that one here.
function formatDueDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

const panels = {
  checking: document.getElementById('lw-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
  document.getElementById('main-content').hidden = panel !== null;
}

showOnly(panels.checking);

function showReauth() {} // no reauth banner on this page yet - matches wyjazd.js/lista-wyjazdowa.js's placeholder scope
function hideReauth() {}

// Every mutation on this page is a fire-and-forget click handler with no return value the user
// can inspect, so a rejected apiFetch has to be turned into something visible or the click just
// appears to do nothing (design.md §9). scrollIntoView because the button that failed can sit far
// below the fold on a long roster. Same pattern as wyjazd.js's showError/clearError.
function showError(message) {
  const errorEl = document.getElementById('skladki-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
  errorEl.scrollIntoView({ block: 'center' });
}

function clearError() {
  document.getElementById('skladki-error').hidden = true;
}

// The checkmark goes right after control. A caller whose apply() removes control from the DOM
// passes fallbackAnchor 'toast' (or a still-connected element) for that case - MutationFeedback requires its feedback anchor to stay
// isConnected after apply(), same reasoning as zarzadzanie-ludzmi.js's postMembershipTransition
// anchoring to the table when apply() removes a row.
function confirmedDuesMutation(control, execute, apply, fallbackAnchor = null, rollback, toast = false) {
  return window.MutationFeedback.confirmed({
    control,
    toast,
    fallbackAnchor,
    execute,
    apply,
    rollback,
    viewRoot: document.getElementById('skladki-content'),
    refreshFragment: loadAndRender,
  });
}

const currentYear = new Date().getFullYear();

// The id of the built-in Wpisowe button (every other id comes from GET /lista-wyjazdowa/dues/charges).
const WPISOWE_ID = 'wpisowe';

// Selected charge button - defaults to the current year's składka roczna. selectedYear keeps its last
// numeric value while Wpisowe or an extra charge is selected, so switching back needs no re-picking.
let selectedYear = currentYear;
let selectedChargeId = null;
let selectedCharge = null; // null for Wpisowe
let wpisoweMode = false;
let extraMode = false;
let charges = [];
let paymentInfo = null;

function chargeLabel(charge) {
  return charge.kind === 'annual' ? String(charge.year) : charge.name;
}

// The title shown in per-row status labels and the summary: the year for a roczna, the name for an extra.
function chargeTitle() {
  return extraMode ? selectedCharge.name : selectedYear;
}

function chargeButtons() {
  const byLabel = (a, b) => a.label.localeCompare(b.label, 'pl', { numeric: true, sensitivity: 'base' });
  const toButton = (charge) => ({
    id: charge.id,
    label: chargeLabel(charge),
    title: charge.kind === 'annual' ? `Składka roczna ${charge.year}` : `Składka dodatkowa: ${charge.name}`,
  });
  return [
    { id: WPISOWE_ID, label: 'Wpisowe', title: 'Wpisowe', group: 'mandatory' },
    ...charges.filter((c) => c.kind === 'annual').map((c) => ({ ...toButton(c), group: 'mandatory' })).sort(byLabel),
    ...charges.filter((c) => c.kind !== 'annual').map((c) => ({ ...toButton(c), group: 'extra' })).sort(byLabel),
  ];
}

// Keeps the previous selection when it still exists; otherwise falls back to the current year's roczna,
// then to the first button alphabetically.
function resolveSelection() {
  const buttons = chargeButtons();
  if (!buttons.some((b) => b.id === selectedChargeId)) {
    const current = charges.find((c) => c.kind === 'annual' && c.year === currentYear);
    const firstAlphabetically = [...buttons].sort((a, b) => a.label.localeCompare(b.label, 'pl', { numeric: true, sensitivity: 'base' }))[0];
    selectedChargeId = current ? current.id : firstAlphabetically.id;
  }
  selectedCharge = charges.find((c) => c.id === selectedChargeId) ?? null;
  wpisoweMode = selectedChargeId === WPISOWE_ID;
  extraMode = selectedCharge?.kind === 'extra';
  if (selectedCharge?.kind === 'annual') selectedYear = selectedCharge.year;
}

function renderChargeBar() {
  const buttons = chargeButtons();
  const groupHtml = (title, group) => {
    const items = buttons.filter((b) => b.group === group);
    if (items.length === 0) return '';
    return `<div class="skladki-charge-group"><h2 class="skladki-charge-group-title">${title}</h2><div class="lw-summary-chips">${items.map((b) =>
      `<button type="button" class="lw-summary-chip lw-filter-chip skladki-charge-btn" data-charge-id="${escapeAttr(b.id)}" title="${escapeAttr(b.title)}" aria-pressed="${b.id === selectedChargeId}">${escapeHtml(b.label)}</button>`,
    ).join('')}</div></div>`;
  };
  document.getElementById('skladki-charge-buttons').innerHTML = groupHtml('Obowiązkowe', 'mandatory') + groupHtml('Dodatkowe', 'extra');
}

// Click-to-sort wiring (shared/sortable-table.js) for both of this page's tables - they share one
// persistent <table id="skladki-table"> (see index.html), only its thead/tbody content differs by
// mode, so one sortState covers both. onChange re-renders from the roster/dues loadAndRender
// already cached - no network round-trip for a sort click.
const skladkiSortState = initSortableTable(document.getElementById('skladki-table'), {
  defaultKey: 'section',
  onChange: renderCurrentView,
});

// KRKG-0074: the Emeryci table gets its own independent sort state - its headers are clickable
// like the main table's (same shared/sortable-table.js wiring, delegation per <table>), including
// its Składka column (KRKG-0075: the table holds members by category now, so an emeryt's status
// can be unpaid/paid/not_applicable and sorting by it is meaningful).
const emeryciSortState = initSortableTable(document.getElementById('skladki-emeryci-table'), {
  defaultKey: 'section',
  onChange: renderCurrentView,
});

let cachedRoster = [];
let cachedDuesByPersonId = new Map();

// The summary pills as filters (shared/summary-filter.js) - narrow both tables (main + Emeryci /
// Nie dotyczy) in both modes. renderSummary needs the year's dues, so a pill click re-renders it
// from the same cached roster/dues as the tables.
const skladkiFilter = createSummaryFilter(['section', 'category']);
wireSummaryFilter(document.getElementById('summary-panel'), skladkiFilter, () => {
  renderSummary(cachedRoster, cachedDuesByPersonId);
  renderCurrentView();
});

function skladkiFilterMatches(member) {
  return summaryFilterMatches(skladkiFilter, { section: member.sectionId, category: member.categoryId });
}

function renderCurrentView() {
  if (wpisoweMode) {
    renderWpisoweList(cachedRoster);
  } else {
    renderTable(cachedRoster, cachedDuesByPersonId);
  }
}

document.getElementById('skladki-charge-buttons').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-charge-id]');
  if (!button || button.dataset.chargeId === selectedChargeId) return;
  selectedChargeId = button.dataset.chargeId;
  // Each view's table has a different natural default sort - "Dołączył" for the Wpisowe-only list
  // (the whole point of that view), "Sekcja" otherwise - rather than carrying over whatever was
  // active in the other one, which may not even name a column that still exists.
  skladkiSortState.reset(selectedChargeId === WPISOWE_ID ? 'joined' : 'section');
  emeryciSortState.reset('section');
  clearError();
  try {
    await loadAndRender();
  } catch (err) {
    showError(`Nie udało się wczytać składek: ${err.message}`);
  }
});

// Fetched once per loadAndRender() alongside roster/dues (Task 2's GET /my-role). Read by
// renderTable() to decide whether to show toggle buttons or read-only text.
let canManageSkladki = false;

// sectionId -> label from lookupLists/sections, fetched alongside the roster. The roster carries
// raw section ids ("krakow"); without this map the section headings read as slugs instead of the
// names the rest of the site shows ("Kraków"). Retired sections are kept in the map on purpose -
// members already assigned to one still have to be grouped under a readable heading.
let sectionLabelById = new Map();

// categoryId -> label from lookupLists/categories, fetched alongside the roster - feeds the name
// pill's title/color the same way wyjazd.js's roster does (nameCellHtml above).
let categoryLabelById = new Map();

// sectionId is null for a member with no "Mój profil" saved yet (the roster now enumerates the
// whole club allowlist, not just members with a profile document) - grouped under one readable
// heading instead of crashing escapeHtml(null) downstream.
function sectionLabel(sectionId) {
  if (sectionId === null) return 'Bez sekcji';
  return sectionLabelById.get(sectionId) ?? sectionId;
}

// Same null-safe fallback as sectionLabel above, for the summary panel's "wg statusu" breakdown -
// named -For (not just categoryLabel) to avoid shadowing renderTable's own per-row local of that
// name.
function categoryLabelFor(categoryId) {
  if (categoryId === null) return 'Brak statusu';
  return categoryLabelById.get(categoryId) ?? categoryId;
}

// A small badge appended inside a pill - just the unpaid count, no "nieopłaconych"/"z N osób" text
// (the total isn't the point here, who still owes money is). A group with nobody left to chase
// gets a green checkmark instead of "0", so a fully-settled section/category/the whole club reads
// as done at a glance rather than one more zero in a row of numbers.
function unpaidBadgeHtml(unpaid, total) {
  return unpaid === 0
    ? `<span class="lw-summary-badge lw-summary-badge--ok" title="Wszyscy opłacili (${total} os.)">✓</span>`
    : `<span class="lw-summary-badge" title="${unpaid} z ${total} nieopłaconych">${unpaid}</span>`;
}

// How many members still owe the selected due - składka roczna for a chosen year, or wpisowe when
// wpisoweMode is on - overall and broken down by Sekcja and by Typ (kategoria), the two axes an
// accountant actually chases people down by. Purely a client-side tally over the same roster+dues
// loadAndRender already fetched for the table/list below - no extra request. Rendered as wrapped
// pill+badge chips rather than a line-per-group list - a vertical list of "Sekcja: N z M
// nieopłaconych" read as far more text than the numbers actually need.
//
// A roczna 'not_applicable' member (an Emeryt by default) is skipped entirely here, not just
// counted as "paid" - counting them in the denominator too would misleadingly dilute e.g. "3 z 20
// osób zalega" when 3 of those 20 were never asked to pay in the first place. Emeryci as a
// category show up below in their own "Emeryci" table (renderTable); a non-emeryt hand-set to
// not_applicable stays in the main table with a grey icon.
function renderSummary(roster, duesByPersonId) {
  const unpaidBySection = new Map();
  const totalBySection = new Map();
  const unpaidByCategory = new Map();
  const totalByCategory = new Map();
  let unpaidTotal = 0;
  let countedTotal = 0;
  let notApplicableCount = 0;

  for (const member of roster) {
    const status = wpisoweMode ? memberWpisoweStatus(member) : memberDuesStatus(member, duesByPersonId);
    if (status === 'not_applicable') {
      notApplicableCount += 1;
      continue;
    }
    const unpaid = status === 'unpaid';

    countedTotal += 1;
    totalBySection.set(member.sectionId, (totalBySection.get(member.sectionId) ?? 0) + 1);
    totalByCategory.set(member.categoryId, (totalByCategory.get(member.categoryId) ?? 0) + 1);
    if (unpaid) {
      unpaidTotal += 1;
      unpaidBySection.set(member.sectionId, (unpaidBySection.get(member.sectionId) ?? 0) + 1);
      unpaidByCategory.set(member.categoryId, (unpaidByCategory.get(member.categoryId) ?? 0) + 1);
    }
  }

  const sortedIds = (totals, labelFor) =>
    Array.from(totals.keys()).sort((a, b) =>
      labelFor(a).toLocaleLowerCase('pl').localeCompare(labelFor(b).toLocaleLowerCase('pl'), 'pl'),
    );

  // The pills double as filters for both tables below (shared/summary-filter.js) - drop a pressed
  // value whose pill is gone before rendering them.
  summaryFilterPrune(skladkiFilter, { section: totalBySection.keys(), category: totalByCategory.keys() });

  const sectionChips = sortedIds(totalBySection, sectionLabel)
    .map((sectionId) => {
      const label = sectionLabel(sectionId);
      const badge = unpaidBadgeHtml(unpaidBySection.get(sectionId) ?? 0, totalBySection.get(sectionId));
      return sectionId === null
        ? summaryFilterChipHtml(skladkiFilter, 'section', null, { content: `${escapeHtml(label)}${badge}` })
        : summaryFilterChipHtml(skladkiFilter, 'section', sectionId, { className: 'section-pill', attrs: `data-section="${escapeAttr(sectionId)}"`, content: `${escapeHtml(label)}${badge}` });
    })
    .join('');

  const categoryChips = sortedIds(totalByCategory, categoryLabelFor)
    .map((categoryId) => {
      const label = categoryLabelFor(categoryId);
      const badge = unpaidBadgeHtml(unpaidByCategory.get(categoryId) ?? 0, totalByCategory.get(categoryId));
      // Not personPillHtml() here - this is a category chip, not a person pill (no accountless
      // marker), and it appends lw-summary-chip plus its own count badge.
      return categoryId === null
        ? summaryFilterChipHtml(skladkiFilter, 'category', null, { content: `${escapeHtml(label)}${badge}` })
        : summaryFilterChipHtml(skladkiFilter, 'category', categoryId, { className: 'category-name-pill', attrs: `data-category="${escapeAttr(categoryId)}" title="${escapeAttr(label)}"`, content: `${categoryPillBroccoliIconHtml(categoryId, 'category-label')}${escapeHtml(label)}${badge}` });
    })
    .join('');

  const totalLine = wpisoweMode
    ? (unpaidTotal === 0
      ? `Wpisowe: wszyscy opłacili ${unpaidBadgeHtml(0, countedTotal)}`
      : `Nieopłacone wpisowe: <strong>${unpaidTotal}</strong> z ${countedTotal} osób.`)
    : (extraMode && countedTotal === 0
      ? `Składka ${escapeHtml(chargeTitle())}: nikt nie jest jeszcze oznaczony jako płacący (domyślnie „nie dotyczy”).`
      : unpaidTotal === 0
        ? `Składka ${escapeHtml(String(chargeTitle()))}: wszyscy opłacili ${unpaidBadgeHtml(0, countedTotal)}`
        : `Nieopłacona składka ${escapeHtml(String(chargeTitle()))}: <strong>${unpaidTotal}</strong> z ${countedTotal} osób.`);

  // Spelled out so the numbers above visibly add up (countedTotal + notApplicableCount ===
  // roster.length) rather than leaving an accountant to wonder why the total isn't the whole
  // roster. Same for both modes - wpisowe has a not_applicable state too (Bobo by default).
  const notApplicableLine = notApplicableCount === 0
    ? ''
    : `<p>Nie dotyczy: <strong>${notApplicableCount}</strong> z ${roster.length} osób.</p>`;

  document.getElementById('summary-content').innerHTML = `
    <p>${totalLine}</p>
    ${notApplicableLine}
    ${summaryFilterBlockHtml(skladkiFilter, [
      { heading: 'Filtruj wg sekcji', chipsHtml: sectionChips },
      { heading: 'Filtruj wg statusu', chipsHtml: categoryChips },
    ])}
  `;
}

// Same one-account-key comment as before applies to both tables below: server.ts's
// handleListaWyjazdowaPutWpisowe/handleListaWyjazdowaPutDues both write to the same
// `due:{personId}` resource key (no :entry_fee/:{year} suffix), so one Historia deep link per
// member already covers wpisowe and every year of składka roczna - the action label (visible in
// the audit view) is what tells the two apart in that shared timeline. Points at /admin/audyt/,
// not the member-zone /audyt/: dues.* actions carry audience 'adminOrAccountant'
// (ACTION_REGISTRY, upload-service/src/audit.ts), which only the admin-scope viewer can see.
function dueHistoryHref(personId) {
  return `/admin/audyt/?resourceKey=${encodeURIComponent(`due:${personId}`)}`;
}

// Same shape as czlonkowie.js/wyjazd.js's dense .czl-table roster (KRKG-0052) - Sekcja/Nazwa
// columns match those exactly (sectionAbbr's colored, sticky, vertical-text cell; the name pill +
// profile-icon pair) so this page reads consistently with the rest of Lista Wyjazdowa, not as an
// ad-hoc layout of its own. Sortable by any column (shared/sortable-table.js, skladkiSortState) -
// defaults to Sekcja then name, no more per-section <h3> headings or a baked-in unpaid-first
// sub-sort (the summary panel above already surfaces who's unpaid, and Składka is itself sortable
// now for anyone who wants that grouping back). No Wpisowe column (KRKG-0074) - that due has its
// own Wpisowe view, and the year table stays scoped to Składka roczna only.
//
// KRKG-0074/KRKG-0075: the "Emeryt" category gets its own "Emeryci" table below the main one -
// membership is the member's category, not their dues status (a non-emeryt hand-set to
// not_applicable stays in the main list, and a paying emeryt stays here). The whole section is
// hidden when nobody falls into it. Both tables share the same row template; the Emeryci one has
// its own sort state (emeryciSortState) and a sortable Składka column of its own, since an
// emeryt's status can be anything (not_applicable by default, unpaid/paid when set by hand).
function renderTable(roster, duesByPersonId) {
  cachedRoster = roster;
  cachedDuesByPersonId = duesByPersonId;

  const mainRoster = [];
  const emeryciRoster = [];
  for (const member of roster) {
    if (!skladkiFilterMatches(member)) continue;
    if (!extraMode && member.categoryId === EMERYT_CATEGORY_ID) emeryciRoster.push(member);
    else mainRoster.push(member);
  }

  // unpaid < not_applicable < paid, so ascending puts who-owes-money first and the settled/exempt
  // at the far end - the same "false (owed) sorts before true (settled)" spirit as every plain
  // boolean paid/unpaid column already on this site, just with a middle rung for not_applicable
  // (still reachable in the main table - a non-emeryt hand-set to not_applicable stays there).
  const ROCZNA_SORT_RANK = { unpaid: 0, not_applicable: 1, paid: 2 };
  const sortValue = (member) => {
    switch (skladkiSortState.key) {
      case 'name': return displayName(member);
      case 'roczna': return ROCZNA_SORT_RANK[memberDuesStatus(member, duesByPersonId)];
      default: return sectionLabel(member.sectionId);
    }
  };
  const sorted = [...mainRoster].sort((a, b) => {
    const cmp = compareValues(sortValue(a), sortValue(b), skladkiSortState.dir);
    if (cmp !== 0) return cmp;
    return compareValues(displayName(a), displayName(b), 'asc');
  });

  // The per-person Historia link points at the shared due:{personId} timeline (wpisowe + roczna),
  // which says nothing about an extra charge - that one has its own link in the details panel.
  const showHistory = canManageSkladki && !extraMode;
  const rowHtml = (member) => {
    const personIdAttr = escapeAttr(member.personId);
    const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
    return `
      <tr data-section="${escapeAttr(member.sectionId ?? '')}">
        <td class="czl-section-cell" title="${escapeAttr(sectionLabel(member.sectionId))}">${member.sectionId ? escapeHtml(sectionAbbr(member.sectionId)) : EMPTY}</td>
        <td class="lw-roster-name-cell">
          ${nameCellHtml(member, personIdAttr, categoryLabel)}
        </td>
        <td>${rocznaIconHtml(personIdAttr, memberDuesStatus(member, duesByPersonId))}</td>
        ${showHistory ? `<td><a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref(member.personId))}" title="Historia" aria-label="Historia składek">${HISTORY_ICON}</a></td>` : ''}
      </tr>`;
  };

  const table = document.getElementById('skladki-table');
  table.querySelector('thead').innerHTML = `
    <tr>
      <th scope="col" class="czl-section-cell" data-sort-key="section" aria-sort="none" title="Sekcja"><button type="button">S</button></th>
      <th scope="col" class="lw-roster-name-cell" data-sort-key="name" aria-sort="none"><button type="button">Nazwa</button></th>
      <th scope="col" class="lw-narrow-col" data-sort-key="roczna" aria-sort="none" title="Składka roczna"><button type="button"><span class="lw-col-icon" aria-hidden="true">💰</span><span class="lw-col-label">Składka</span></button></th>
      ${showHistory ? `<th scope="col" class="lw-narrow-col" title="Historia"><span class="lw-col-icon" aria-hidden="true">${HISTORY_ICON}</span><span class="lw-col-label">Historia</span></th>` : ''}
    </tr>
  `;
  table.querySelector('tbody').innerHTML = sorted.length
    ? sorted.map(rowHtml).join('')
    : `<tr><td colspan="${showHistory ? 4 : 3}" class="czl-empty">Brak osób dla wybranych filtrów.</td></tr>`;
  skladkiSortState.refresh();

  const emeryciSortValue = (member) => {
    switch (emeryciSortState.key) {
      case 'name': return displayName(member);
      case 'roczna': return ROCZNA_SORT_RANK[memberDuesStatus(member, duesByPersonId)];
      default: return sectionLabel(member.sectionId);
    }
  };
  const emeryciSorted = [...emeryciRoster].sort((a, b) => {
    const cmp = compareValues(emeryciSortValue(a), emeryciSortValue(b), emeryciSortState.dir);
    if (cmp !== 0) return cmp;
    return compareValues(displayName(a), displayName(b), 'asc');
  });

  const emeryciTable = document.getElementById('skladki-emeryci-table');
  emeryciTable.querySelector('thead').innerHTML = `
    <tr>
      <th scope="col" class="czl-section-cell" data-sort-key="section" aria-sort="none" title="Sekcja"><button type="button">S</button></th>
      <th scope="col" class="lw-roster-name-cell" data-sort-key="name" aria-sort="none"><button type="button">Nazwa</button></th>
      <th scope="col" class="lw-narrow-col" data-sort-key="roczna" aria-sort="none" title="Składka roczna"><button type="button"><span class="lw-col-icon" aria-hidden="true">💰</span><span class="lw-col-label">Składka</span></button></th>
      ${showHistory ? `<th scope="col" class="lw-narrow-col" title="Historia"><span class="lw-col-icon" aria-hidden="true">${HISTORY_ICON}</span><span class="lw-col-label">Historia</span></th>` : ''}
    </tr>
  `;
  emeryciTable.querySelector('tbody').innerHTML = emeryciSorted.map(rowHtml).join('');
  emeryciSortState.refresh();

  document.getElementById('skladki-emeryci-heading').textContent = 'Emeryci';
  document.getElementById('skladki-emeryci').hidden = emeryciRoster.length === 0;
}

// The "Wpisowe" button (see WPISOWE_ID) - a flat list of everyone who
// still owes wpisowe (plus, in the second table below, everyone it doesn't apply to), sorted by join date (members.ts's approvedAt, the closest thing this
// codebase has to one) so the accountant chases the longest-standing debt first. A member with no
// approvedAt yet (no members/{email} document, or one predating KRKG-0046) sorts to the end rather
// than crashing a string compare against null. No "Wpisowe" caption anywhere in this table (column
// header included) - the page itself is already scoped to wpisowe, so repeating the word on every
// row would only cost the Nazwa column width without telling the reader anything new.
function renderWpisoweList(roster) {
  cachedRoster = roster;

  // Rows are picked by the status at render time. Clicking a badge cycles it in place (same as the
  // roczna coin) without moving the row, so a misclick is undone with the next click; the row
  // lands in its new table on the next reload or view switch.
  const unpaidRoster = [];
  const notApplicableRoster = [];
  for (const member of roster) {
    if (!skladkiFilterMatches(member)) continue;
    const status = memberWpisoweStatus(member);
    if (status === 'unpaid') unpaidRoster.push(member);
    else if (status === 'not_applicable') notApplicableRoster.push(member);
  }

  // Every main-table row is unpaid by definition, so unlike the year table above there is no
  // meaningful "sort by paid status" column - the icon column carries no data-sort-key.
  const sortedBy = (list, sortState) => {
    const sortValue = (member) => {
      switch (sortState.key) {
        case 'name': return displayName(member);
        case 'joined': return member.approvedAt ?? '';
        default: return sectionLabel(member.sectionId);
      }
    };
    return [...list].sort((a, b) => {
      // approvedAt sorts ascending-by-default as empty-string-last regardless of dir (a member
      // with no join date on record shouldn't jump to the front just because the direction flipped)
      if (sortState.key === 'joined' && (!a.approvedAt || !b.approvedAt) && a.approvedAt !== b.approvedAt) {
        return a.approvedAt ? -1 : 1;
      }
      const cmp = compareValues(sortValue(a), sortValue(b), sortState.dir);
      if (cmp !== 0) return cmp;
      return compareValues(displayName(a), displayName(b), 'asc');
    });
  };

  const rowHtml = (member) => {
    const personIdAttr = escapeAttr(member.personId);
    const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
    return `
      <tr data-section="${escapeAttr(member.sectionId ?? '')}">
        <td class="czl-section-cell" title="${escapeAttr(sectionLabel(member.sectionId))}">${member.sectionId ? escapeHtml(sectionAbbr(member.sectionId)) : EMPTY}</td>
        <td class="lw-roster-name-cell">
          ${nameCellHtml(member, personIdAttr, categoryLabel)}
        </td>
        <td class="${member.approvedAt ? '' : 'czl-empty'}">${member.approvedAt ? escapeHtml(formatDate(member.approvedAt)) : EMPTY}</td>
        <td>${wpisoweIconHtml(personIdAttr, memberWpisoweStatus(member))}</td>
        ${canManageSkladki ? `<td><a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref(member.personId))}" title="Historia" aria-label="Historia wpisowego">${HISTORY_ICON}</a></td>` : ''}
      </tr>`;
  };

  const theadHtml = `
    <tr>
      <th scope="col" class="czl-section-cell" data-sort-key="section" aria-sort="none" title="Sekcja"><button type="button">S</button></th>
      <th scope="col" class="lw-roster-name-cell" data-sort-key="name" aria-sort="none"><button type="button">Nazwa</button></th>
      <th scope="col" data-sort-key="joined" aria-sort="none"><button type="button">Dołączył</button></th>
      <th scope="col" title="Wpisowe">✓</th>
      ${canManageSkladki ? '<th scope="col">Historia</th>' : ''}
    </tr>
  `;

  const colCount = canManageSkladki ? 5 : 4;
  const rows = unpaidRoster.length === 0
    ? `<tr><td colspan="${colCount}" class="czl-empty">${summaryFilterActive(skladkiFilter) ? 'Brak osób z nieopłaconym wpisowym dla wybranych filtrów.' : 'Wszyscy członkowie mają opłacone wpisowe.'}</td></tr>`
    : sortedBy(unpaidRoster, skladkiSortState).map(rowHtml).join('');

  const table = document.getElementById('skladki-table');
  table.querySelector('thead').innerHTML = theadHtml;
  table.querySelector('tbody').innerHTML = rows;
  skladkiSortState.refresh();

  // The year view's Emeryci section doubles as the "Nie dotyczy" table here - same layout under a
  // different heading (renderTable sets it back to "Emeryci").
  document.getElementById('skladki-emeryci-heading').textContent = 'Nie dotyczy';
  const notApplicableTable = document.getElementById('skladki-emeryci-table');
  notApplicableTable.querySelector('thead').innerHTML = theadHtml;
  notApplicableTable.querySelector('tbody').innerHTML = sortedBy(notApplicableRoster, emeryciSortState).map(rowHtml).join('');
  emeryciSortState.refresh();
  document.getElementById('skladki-emeryci').hidden = notApplicableRoster.length === 0;
}

// Tracks the dueDate last loaded/rendered into the edit input, so saveYearFee can tell whether the
// accountant actually changed the date (vs. only the note text) and skip sending dueDate in the PUT
// body when it's unchanged - the backend logs an audit row for any dueDate present in the body,
// `before === after` included (review finding: every note-only edit was also logging a no-op
// dueDate change).
let lastLoadedYearFeeDueDate = null;
// The last rendered year fee, normalized - the rollback target when a removal fails after the
// form has already been cleared (see removeYearFee).
let lastLoadedYearFee = { note: null, dueDate: null };

// The shared per-year rate note (e.g. "100 zł mężczyźni, 50 zł kobiety") - same
// display/edit-panel pattern as wyjazd.js's renderSkladkaFee/saveSkladkaFee for its per-event fee.
function renderYearFee(yearFee) {
  // Wpisowe has no per-year rate note - it's a one-off due, not a yearly one - and an extra charge
  // keeps its own details (renderExtraPanel), so this panel only shows for a składka roczna.
  const panel = document.getElementById('skladka-fee-panel');
  panel.hidden = wpisoweMode || extraMode;
  if (wpisoweMode || extraMode) return;
  const creatorEl = document.getElementById('skladki-year-creator');
  creatorEl.hidden = !selectedCharge?.createdBy;
  if (selectedCharge?.createdBy) creatorEl.innerHTML = `Założone przez: ${creatorHtml(selectedCharge.createdBy)}`;
  const display = document.getElementById('skladki-year-fee-display');
  const editPanel = document.getElementById('skladki-year-fee-edit');
  const historyLink = document.getElementById('skladki-year-fee-history-link');
  const note = yearFee?.note ?? null;
  const dueDate = yearFee?.dueDate ?? null;
  display.textContent = note ? `Składka ${selectedYear}: ${note}` : `Składka ${selectedYear}: nie ustalono`;
  // A due date only ever exists alongside a note (see updateYearFeeFormState), so it is never
  // shown on its own even for legacy data that still carries an orphaned date.
  if (note && dueDate) display.textContent += ` (termin: ${formatDueDate(dueDate)})`;
  lastLoadedYearFee = { note, dueDate };
  editPanel.hidden = !canManageSkladki;
  if (canManageSkladki) {
    document.getElementById('skladki-year-fee-input').value = note ?? '';
    document.getElementById('skladki-year-fee-duedate-input').value = dueDate ?? '';
    lastLoadedYearFeeDueDate = dueDate ?? null;
    updateYearFeeFormState();
  }
  historyLink.hidden = !canManageSkladki;
  historyLink.href = `/admin/audyt/?resourceKey=${encodeURIComponent(`due:year:${selectedYear}`)}`;
}

// Same invariant as wyjazd.js's updateSkladkaFeeFormState, for the per-year rate note: the due-date
// field is only meaningful with a note, so an empty note clears and disables it and "Usuń składkę"
// is only offered while there is something to remove.
function updateYearFeeFormState() {
  const note = document.getElementById('skladki-year-fee-input').value.trim();
  const dueDateInput = document.getElementById('skladki-year-fee-duedate-input');
  if (!note) dueDateInput.value = '';
  dueDateInput.disabled = !note;
  document.getElementById('skladki-year-fee-remove').disabled = !note;
}

document.getElementById('skladki-year-fee-input').addEventListener('input', updateYearFeeFormState);

async function saveYearFee(control = document.getElementById('skladki-year-fee-save'), rollback) {
  clearError();
  try {
    const value = document.getElementById('skladki-year-fee-input').value.trim();
    // Guarded, not just disabled: a note-less year can never carry a date, even if the input was
    // somehow populated (legacy render, scripted DOM).
    const dueDateValue = value ? (document.getElementById('skladki-year-fee-duedate-input').value || null) : null;
    const body = { note: value || null };
    if (dueDateValue !== lastLoadedYearFeeDueDate) body.dueDate = dueDateValue;
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/dues/year-fee?year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      showReauth,
      hideReauth,
    ), () => {
      lastLoadedYearFeeDueDate = dueDateValue;
      lastLoadedYearFee = { note: value || null, dueDate: dueDateValue };
      document.getElementById('skladki-year-fee-display').textContent = value
        ? `Składka ${selectedYear}: ${value}${dueDateValue ? ` (termin: ${formatDueDate(dueDateValue)})` : ''}`
        : `Składka ${selectedYear}: nie ustalono`;
      updateYearFeeFormState();
    }, control, rollback);
  } catch (err) {
    showError(`Nie udało się zapisać składki: ${err.message}`);
  }
}

document.getElementById('skladki-year-fee-save').addEventListener('click', () => saveYearFee());

// Removes the whole per-year rate note (amount and due date) by clearing both fields and reusing
// the save above, so the year ends up with no rate in one confirmed mutation. Clearing happens
// before the request, so a failed save restores the form from the last confirmed fee (rollback).
async function removeYearFee() {
  document.getElementById('skladki-year-fee-input').value = '';
  document.getElementById('skladki-year-fee-duedate-input').value = '';
  updateYearFeeFormState();
  await saveYearFee(document.getElementById('skladki-year-fee-remove'), () => renderYearFee(lastLoadedYearFee));
}

document.getElementById('skladki-year-fee-remove').addEventListener('click', removeYearFee);

// The roster entry's display name for an e-mail (a charge's creator), falling back to the e-mail
// itself for someone no longer on the roster.
let rosterForNames = [];
// "Założone przez": the standard person pill (avatar + profile drawer) when the creator is on the
// roster, else the bare e-mail.
function creatorHtml(email) {
  const member = rosterForNames.find((m) => m.personId === email);
  if (!member) return escapeHtml(email);
  const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
  return nameCellHtml(member, escapeAttr(member.personId), categoryLabel);
}

function personNameFor(email) {
  const member = rosterForNames.find((m) => m.personId === email);
  return member ? displayName(member) : email;
}

async function loadAndRender() {
  const [{ canManageSkladki: role }, { roster }, chargesResponse, lookupLists] = await Promise.all([
    apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/dues/charges', { method: 'GET' }, showReauth, hideReauth),
    // GET /lista-wyjazdowa/lookup-lists answers with the lists themselves ({ sections, categories,
    // weapons }), not wrapped in an envelope - see handleListaWyjazdowaLookupLists.
    apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
  ]);
  canManageSkladki = role;
  charges = chargesResponse.charges ?? [];
  paymentInfo = chargesResponse.paymentInfo ?? null;
  rosterForNames = roster;
  sectionLabelById = new Map((lookupLists.sections ?? []).map((s) => [s.id, s.label]));
  categoryLabelById = new Map((lookupLists.categories ?? []).map((c) => [c.id, c.label]));
  resolveSelection();

  // Only the selected charge's own per-person statuses are fetched; Wpisowe lives on the roster.
  let duesByPersonId = new Map();
  let yearFee = null;
  if (extraMode) {
    const { statuses } = await apiFetch(`/lista-wyjazdowa/dues/extra?id=${encodeURIComponent(selectedChargeId)}`, { method: 'GET' }, showReauth, hideReauth);
    duesByPersonId = new Map(statuses.map((d) => [d.personId, d]));
  } else if (!wpisoweMode) {
    const result = await apiFetch(`/lista-wyjazdowa/dues?year=${selectedYear}`, { method: 'GET' }, showReauth, hideReauth);
    yearFee = result.yearFee;
    duesByPersonId = new Map(result.dues.map((d) => [d.personId, d]));
  }

  renderChargeBar();
  renderPaymentInfo();
  renderYearFee(yearFee);
  renderExtraPanel();
  renderSummary(roster, duesByPersonId);
  if (wpisoweMode) {
    renderWpisoweList(roster);
  } else {
    renderTable(roster, duesByPersonId);
  }
}

// "Jak płacić": plain text shown with pre-wrap (textContent, never HTML), so line breaks and spacing
// stay exactly as typed. Everyone reads it; accountants/admins get the editor.
let paymentOpen = false;

function renderPaymentInfo() {
  const text = paymentInfo?.text ?? '';
  document.getElementById('skladki-payment-panel').hidden = !text && !canManageSkladki;
  document.getElementById('skladki-payment-text').textContent = text || 'Nie podano jeszcze informacji o płatności.';
  document.getElementById('skladki-payment-text').hidden = !paymentOpen;
  document.getElementById('skladki-payment-toggle').setAttribute('aria-expanded', String(paymentOpen));
  const form = document.getElementById('skladki-payment-form');
  if (form.hidden) document.getElementById('skladki-payment-edit-toggle').hidden = !canManageSkladki;
  document.getElementById('skladki-payment-box').hidden = !paymentOpen && form.hidden;
}

document.getElementById('skladki-payment-toggle').addEventListener('click', () => {
  paymentOpen = !paymentOpen;
  renderPaymentInfo();
});

function closePaymentForm() {
  document.getElementById('skladki-payment-form').hidden = true;
  document.getElementById('skladki-payment-edit-toggle').hidden = !canManageSkladki;
  renderPaymentInfo();
}

document.getElementById('skladki-payment-edit-toggle').addEventListener('click', () => {
  document.getElementById('skladki-payment-input').value = paymentInfo?.text ?? '';
  document.getElementById('skladki-payment-form').hidden = false;
  document.getElementById('skladki-payment-edit-toggle').hidden = true;
  renderPaymentInfo();
});

document.getElementById('skladki-payment-cancel').addEventListener('click', closePaymentForm);

document.getElementById('skladki-payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const control = document.getElementById('skladki-payment-save');
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      '/lista-wyjazdowa/dues/payment-info',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('skladki-payment-input').value }) },
      showReauth,
      hideReauth,
    ), (result) => {
      paymentInfo = result.paymentInfo;
      closePaymentForm();
      renderPaymentInfo();
    }, null, undefined, true);
  } catch (err) {
    showError(`Nie udało się zapisać informacji o płatności: ${err.message}`);
  }
});

// Details of a składka dodatkowa: creator, amount, description (line breaks kept), deadline. The
// edit form is offered to whoever may change it (creator, accountant, admin - charge.canEdit).
function renderExtraPanel() {
  const panel = document.getElementById('skladki-extra-panel');
  panel.hidden = !extraMode;
  if (!extraMode) return;
  const charge = selectedCharge;
  document.getElementById('skladki-extra-title').textContent = charge.name;
  document.getElementById('skladki-extra-creator').innerHTML = `Założone przez: ${creatorHtml(charge.createdBy)}`;
  document.getElementById('skladki-extra-details').innerHTML = `
    <p>Kwota: ${charge.amount ? escapeHtml(charge.amount) : 'nie ustalono'}</p>
    ${charge.description ? `<p class="skladki-pre">${escapeHtml(charge.description)}</p>` : ''}
    <p>Termin płatności: ${charge.dueDate ? escapeHtml(formatDueDate(charge.dueDate)) : 'nie ustalono'}</p>`;
  const historyLink = document.getElementById('skladki-extra-history-link');
  historyLink.hidden = !canManageSkladki;
  historyLink.href = `/admin/audyt/?resourceKey=${encodeURIComponent(`due:charge:${charge.id}`)}`;
  document.getElementById('skladki-extra-edit').hidden = charge.canEdit !== true;
  if (charge.canEdit === true) {
    document.getElementById('skladki-extra-name-input').value = charge.name;
    document.getElementById('skladki-extra-amount-input').value = charge.amount ?? '';
    document.getElementById('skladki-extra-description-input').value = charge.description ?? '';
    document.getElementById('skladki-extra-duedate-input').value = charge.dueDate ?? '';
  }
}

document.getElementById('skladki-extra-save').addEventListener('click', async () => {
  clearError();
  const control = document.getElementById('skladki-extra-save');
  const id = selectedChargeId;
  const body = {
    name: document.getElementById('skladki-extra-name-input').value,
    amount: document.getElementById('skladki-extra-amount-input').value.trim() || null,
    description: document.getElementById('skladki-extra-description-input').value.trim() || null,
    dueDate: document.getElementById('skladki-extra-duedate-input').value || null,
  };
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/dues/charges?id=${encodeURIComponent(id)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      showReauth,
      hideReauth,
    ), (result) => {
      charges = charges.map((c) => (c.id === id ? result.charge : c));
      resolveSelection();
      renderChargeBar();
      renderExtraPanel();
    });
  } catch (err) {
    showError(`Nie udało się zapisać składki: ${err.message}`);
  }
});

document.getElementById('skladki-extra-delete').addEventListener('click', async () => {
  clearError();
  const id = selectedChargeId;
  if (!window.confirm(`Usunąć składkę „${selectedCharge.name}”? Znikną też statusy opłacenia.`)) return;
  try {
    await confirmedDuesMutation(document.getElementById('skladki-extra-delete'), () => apiFetch(
      `/lista-wyjazdowa/dues/charges?id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      showReauth,
      hideReauth,
    ), async () => {
      selectedChargeId = null;
      skladkiSortState.reset('section');
      await loadAndRender();
    }, null, undefined, true);
  } catch (err) {
    showError(`Nie udało się usunąć składki: ${err.message}`);
  }
});

// "Dodaj składkę": a roczna (year only; accountants/admins) or a dodatkowa (anyone). The new charge
// becomes the selected one.
let addKind = 'extra';

function setAddKind(kind) {
  addKind = kind;
  document.getElementById('skladki-add-annual-fields').hidden = kind !== 'annual';
  document.getElementById('skladki-add-extra-fields').hidden = kind !== 'extra';
}

function closeAddForm() {
  document.getElementById('skladki-add-form').hidden = true;
  document.getElementById('skladki-add-error').hidden = true;
}

document.getElementById('skladki-add-toggle').addEventListener('click', () => {
  const form = document.getElementById('skladki-add-form');
  if (!form.hidden) return closeAddForm();
  // Only accountants/admins may create a składka roczna, so everyone else is never offered the choice.
  document.getElementById('skladki-add-kind').hidden = !canManageSkladki;
  document.getElementById('skladki-add-kind-annual').hidden = !canManageSkladki;
  setAddKind('extra');
  const takenYears = new Set(charges.filter((c) => c.kind === 'annual').map((c) => c.year));
  let year = currentYear;
  while (takenYears.has(year)) year += 1;
  document.getElementById('skladki-add-year').value = String(year);
  for (const id of ['skladki-add-name', 'skladki-add-amount', 'skladki-add-description', 'skladki-add-duedate']) {
    document.getElementById(id).value = '';
  }
  document.getElementById('skladki-add-error').hidden = true;
  form.hidden = false;
});

document.getElementById('skladki-add-cancel').addEventListener('click', closeAddForm);

document.getElementById('skladki-add-form').addEventListener('change', (e) => {
  if (e.target?.name === 'kind') setAddKind(e.target.value);
});

document.getElementById('skladki-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('skladki-add-error');
  errorEl.hidden = true;
  let body;
  if (addKind === 'annual') {
    const year = Number(document.getElementById('skladki-add-year').value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      errorEl.textContent = 'Podaj rok z zakresu 2000–2100.';
      errorEl.hidden = false;
      return;
    }
    body = { kind: 'annual', year };
  } else {
    const name = document.getElementById('skladki-add-name').value.trim();
    if (!name) {
      errorEl.textContent = 'Podaj nazwę składki.';
      errorEl.hidden = false;
      return;
    }
    body = {
      kind: 'extra',
      name,
      amount: document.getElementById('skladki-add-amount').value.trim() || null,
      description: document.getElementById('skladki-add-description').value.trim() || null,
      dueDate: document.getElementById('skladki-add-duedate').value || null,
    };
  }
  try {
    await confirmedDuesMutation(document.getElementById('skladki-add-submit'), () => apiFetch(
      '/lista-wyjazdowa/dues/charges',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      showReauth,
      hideReauth,
    ), async (result) => {
      selectedChargeId = result.charge.id;
      skladkiSortState.reset('section');
      emeryciSortState.reset('section');
      closeAddForm();
      await loadAndRender();
    }, null, undefined, true);
  } catch (err) {
    errorEl.textContent = `Nie udało się dodać składki: ${err.message}`;
    errorEl.hidden = false;
  }
});

// Same reversible three-stop click as toggleRoczna below. The row stays where it is (see
// renderWpisoweList), and the cached roster is updated so the next re-render (sorting, summary)
// already reflects the change.
async function toggleWpisowe(personId, nextStatus, control) {
  clearError();
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/wpisowe?personId=${encodeURIComponent(personId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) },
      showReauth,
      hideReauth,
    ), () => {
      control.dataset.status = nextStatus;
      control.textContent = duesStatusGlyph(nextStatus);
      const label = wpisoweStatusLabel(nextStatus);
      control.title = `${label} — kliknij, aby zmienić`;
      control.setAttribute('aria-label', label);
      const member = cachedRoster.find((m) => m.personId === personId);
      if (member) member.wpisoweStatus = nextStatus;
    });
  } catch (err) {
    showError(`Nie udało się zaktualizować wpisowego: ${err.message}`);
  }
}

// nextStatus cycles unpaid -> paid -> not_applicable -> unpaid (see DUES_STATUS_CYCLE) - a plain
// reversible click same as before, just three stops instead of two.
async function toggleRoczna(personId, nextStatus, control) {
  clearError();
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      extraMode
        ? `/lista-wyjazdowa/dues/extra?id=${encodeURIComponent(selectedChargeId)}&personId=${encodeURIComponent(personId)}`
        : `/lista-wyjazdowa/dues?personId=${encodeURIComponent(personId)}&year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) },
      showReauth,
      hideReauth,
    ), () => {
      control.dataset.status = nextStatus;
      // Keep the cached statuses in step so a later sort/filter re-render doesn't show the old one.
      cachedDuesByPersonId.set(personId, { ...(cachedDuesByPersonId.get(personId) ?? {}), personId, status: nextStatus });
      const label = rocznaLabel(nextStatus);
      control.title = `${label} — kliknij, aby zmienić`;
      control.setAttribute('aria-label', label);
    });
  } catch (err) {
    showError(`Nie udało się zaktualizować składki: ${err.message}`);
  }
}

document.getElementById('skladki-content').addEventListener('click', (e) => {
  const icon = e.target.closest('.lw-skladka-icon[data-kind]');
  if (!icon) return;
  const personId = icon.dataset.personId;
  if (icon.dataset.kind === 'wpisowe') {
    toggleWpisowe(personId, nextDuesStatus(icon.dataset.status), icon);
  } else {
    toggleRoczna(personId, nextDuesStatus(icon.dataset.status), icon);
  }
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  // auth.js only routes a failed whoami check to onForbidden - anything this body throws is ours
  // to report and must not be shown as "Brak uprawnień" (see initGoogleSignIn's comment in
  // auth.js). showOnly(null) first because #skladki-error lives inside #main-content, which is
  // hidden until then - same order as wyjazd.js's onSignedIn.
  onSignedIn: async () => {
    try {
      await loadAndRender();
      showOnly(null);
    } catch (err) {
      showOnly(null);
      showError(`Nie udało się wczytać składek: ${err.message}`);
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
