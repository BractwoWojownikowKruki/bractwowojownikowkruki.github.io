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
 * The "Składka:" select's first option, "Wpisowe" (renderWpisoweList), swaps the whole page from
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

// The classic person pill used everywhere else a member's name is listed (wyjazd.js's roster,
// Spis Ludności/Zarządzanie ludźmi) - one line per person instead of the old multi-line row.
function categoryNamePillAttrs(categoryId, label) {
  return `class="category-name-pill" data-category="${escapeAttr(categoryId ?? '')}" title="${escapeAttr(label || 'Brak statusu')}"`;
}

// displayName(member) itself now lives in shared/display-name.js (included via index.html) - see
// its own comment for the priority order and the email-typed-into-a-name-field edge case.

// Wpisowe's plain paid/unpaid check/cross (member-area.css's .lw-skladka-icon, red/green
// background from data-paid) - a plain <span> for members who can't manage składki (nothing to
// click), an actual <button> otherwise. data-kind="wpisowe" is how the shared click handler below
// tells this apart from rocznaIconHtml's three-state coin.
function paidIconHtml(emailAttr, paid, label) {
  const glyph = paid ? '✓' : '✕';
  if (!canManageSkladki) {
    return `<span class="lw-skladka-icon" data-paid="${paid}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${glyph}</span>`;
  }
  return `<button type="button" class="lw-skladka-icon" data-kind="wpisowe" data-email="${emailAttr}" data-paid="${paid}" title="${escapeAttr(label)} — kliknij, aby zmienić" aria-label="${escapeAttr(label)}">${glyph}</button>`;
}

// categories' fixed id set is seeded by upload-service/scripts/seed-lookup-lists.ts's slugify -
// "Emeryt" -> "emeryt". Duplicated from dues.ts's own EMERYT_CATEGORY_ID (same convention as
// SECTION_ABBR above) so this page can compute the same default client-side, without a request.
const EMERYT_CATEGORY_ID = 'emeryt';

// Składka roczna's third state (KRKG follow-up) - a member the club doesn't require this year's
// due from at all: an Emeryt by default, or anyone else set this way by hand (e.g. someone who
// joined partway through the year). Mirrors dues.ts's effectiveDuesStatus exactly: an explicit
// stored record always wins (an emeryt who actually pays voluntarily just gets flipped to 'paid'
// and stays there), this default only applies when no DuesDoc exists yet for that member+year.
function effectiveDuesStatus(member, duesByEmail) {
  const stored = duesByEmail.get(member.email)?.status;
  if (stored) return stored;
  return member.categoryId === EMERYT_CATEGORY_ID ? 'not_applicable' : 'unpaid';
}

const DUES_STATUS_LABELS = { unpaid: 'nieopłacona', paid: 'opłacona', not_applicable: 'nie dotyczy' };
function rocznaLabel(status) {
  return `Składka ${selectedYear}: ${DUES_STATUS_LABELS[status]}`;
}

// Click-to-cycle order for the roczna coin (see the click handler below) - unpaid -> paid keeps
// today's single-click "mark as paid" for the overwhelming common case unchanged; reaching
// not_applicable by hand (or getting an emeryt from their default not_applicable to an actual
// voluntary payment) takes one extra click either way, which is the much rarer path.
const DUES_STATUS_CYCLE = ['unpaid', 'paid', 'not_applicable'];
function nextDuesStatus(current) {
  return DUES_STATUS_CYCLE[(DUES_STATUS_CYCLE.indexOf(current) + 1) % DUES_STATUS_CYCLE.length];
}

// Same badge shape as paidIconHtml above, but three-coloured (green/red/grey via data-status,
// member-area.css) instead of a plain boolean - not_applicable renders the same 💰 glyph so the
// column stays visually uniform, only its background says "this member doesn't owe this at all".
function rocznaIconHtml(emailAttr, status) {
  const label = rocznaLabel(status);
  if (!canManageSkladki) {
    return `<span class="lw-skladka-icon" data-status="${status}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">💰</span>`;
  }
  return `<button type="button" class="lw-skladka-icon" data-kind="roczna" data-email="${emailAttr}" data-status="${status}" title="${escapeAttr(label)} — kliknij, aby zmienić" aria-label="${escapeAttr(label)}">💰</button>`;
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

// anchor defaults to control, but a caller whose apply() removes control from the DOM
// (markWpisowePaid, whenever toRemove is control itself or an ancestor of it) must pass a
// still-connected anchor instead - MutationFeedback requires its feedback anchor to stay
// isConnected after apply(), same reasoning as zarzadzanie-ludzmi.js's postMembershipTransition
// anchoring to the table when apply() removes a row.
function confirmedDuesMutation(control, execute, apply, anchor = control) {
  return window.MutationFeedback.confirmed({
    control,
    anchor,
    execute,
    apply,
    viewRoot: document.getElementById('skladki-content'),
    refreshFragment: loadAndRender,
  });
}

const currentYear = new Date().getFullYear();

// The <select>'s special first option (above every year) - picks the unpaid-wpisowe list view
// instead of a year's składka roczna table, see renderWpisoweList below.
const WPISOWE_OPTION = 'wpisowe';

// Selected in the "Składka:" <select> - defaults to the current year, but the backend has
// always accepted any year 2000-2100 (see server.ts's requireYear), so this is purely a frontend
// gap being closed: someone paying składka roczna for next year (joining late) or checking a past
// year's records needs a way to pick a year other than "now". selectedYear keeps its last numeric
// value even while wpisoweMode is true, so switching back to a year doesn't need re-picking one.
let selectedYear = currentYear;
let wpisoweMode = false;
const YEAR_RANGE_PAST = 5;
const YEAR_RANGE_FUTURE = 1;
// The club only started tracking składki from 2026 onward - no point offering earlier years the
// backend would happily accept (server.ts's requireYear allows 2000-2100) but that never have data.
const MIN_DUES_YEAR = 2026;

function populateYearSelect() {
  const select = document.getElementById('skladki-year-select');
  const years = [];
  for (let y = Math.max(MIN_DUES_YEAR, currentYear - YEAR_RANGE_PAST); y <= currentYear + YEAR_RANGE_FUTURE; y++) years.push(y);
  const yearOptions = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  select.innerHTML = `<option value="${WPISOWE_OPTION}">Wpisowe</option>${yearOptions}`;
  select.value = wpisoweMode ? WPISOWE_OPTION : String(selectedYear);
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
let cachedDuesByEmail = new Map();

function renderCurrentView() {
  if (wpisoweMode) {
    renderWpisoweList(cachedRoster);
  } else {
    renderTable(cachedRoster, cachedDuesByEmail);
  }
}

document.getElementById('skladki-year-select').addEventListener('change', async (e) => {
  wpisoweMode = e.target.value === WPISOWE_OPTION;
  if (!wpisoweMode) selectedYear = Number(e.target.value);
  // Each mode's table has a different natural default sort - "Dołączył" for the Wpisowe-only list
  // (the whole point of that view), "Sekcja" for the year table - rather than carrying over
  // whatever was active in the other one, which may not even name a column that still exists.
  skladkiSortState.reset(wpisoweMode ? 'joined' : 'section');
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
// pill's title/color the same way wyjazd.js's roster does (categoryNamePillAttrs above).
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
function renderSummary(roster, duesByEmail) {
  const unpaidBySection = new Map();
  const totalBySection = new Map();
  const unpaidByCategory = new Map();
  const totalByCategory = new Map();
  let unpaidTotal = 0;
  let countedTotal = 0;
  let notApplicableCount = 0;

  for (const member of roster) {
    let unpaid;
    if (wpisoweMode) {
      unpaid = !member.wpisowePaid;
    } else {
      const status = effectiveDuesStatus(member, duesByEmail);
      if (status === 'not_applicable') {
        notApplicableCount += 1;
        continue;
      }
      unpaid = status === 'unpaid';
    }

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

  const sectionChips = sortedIds(totalBySection, sectionLabel)
    .map((sectionId) => {
      const label = sectionLabel(sectionId);
      const badge = unpaidBadgeHtml(unpaidBySection.get(sectionId) ?? 0, totalBySection.get(sectionId));
      return sectionId === null
        ? `<span class="lw-summary-chip">${escapeHtml(label)}${badge}</span>`
        : `<span class="section-pill lw-summary-chip" data-section="${escapeAttr(sectionId)}">${escapeHtml(label)}${badge}</span>`;
    })
    .join('');

  const categoryChips = sortedIds(totalByCategory, categoryLabelFor)
    .map((categoryId) => {
      const label = categoryLabelFor(categoryId);
      const badge = unpaidBadgeHtml(unpaidByCategory.get(categoryId) ?? 0, totalByCategory.get(categoryId));
      // Not categoryNamePillAttrs() here - it bakes in its own class="category-name-pill", and
      // appending lw-summary-chip as a second class attribute would just be dropped as a duplicate.
      return categoryId === null
        ? `<span class="lw-summary-chip">${escapeHtml(label)}${badge}</span>`
        : `<span class="category-name-pill lw-summary-chip" data-category="${escapeAttr(categoryId)}" title="${escapeAttr(label)}">${escapeHtml(label)}${badge}</span>`;
    })
    .join('');

  const totalLine = wpisoweMode
    ? (unpaidTotal === 0
      ? `Wpisowe: wszyscy opłacili ${unpaidBadgeHtml(0, roster.length)}`
      : `Nieopłacone wpisowe: <strong>${unpaidTotal}</strong> z ${roster.length} osób.`)
    : (unpaidTotal === 0
      ? `Składka ${selectedYear}: wszyscy opłacili ${unpaidBadgeHtml(0, countedTotal)}`
      : `Nieopłacona składka ${selectedYear}: <strong>${unpaidTotal}</strong> z ${countedTotal} osób.`);

  // Only in roczna mode - wpisowe has no not_applicable state. Spelled out so the numbers above
  // visibly add up (countedTotal + notApplicableCount === roster.length) rather than leaving an
  // accountant to wonder why the total isn't the whole roster. Wpisowe deliberately absent from
  // the year view entirely (KRKG-0074) - it has its own Wpisowe option in the select above.
  const notApplicableLine = wpisoweMode || notApplicableCount === 0
    ? ''
    : `<p>Nie dotyczy: <strong>${notApplicableCount}</strong> z ${roster.length} osób.</p>`;

  document.getElementById('summary-content').innerHTML = `
    <p>${totalLine}</p>
    ${notApplicableLine}
    <div class="lw-summary-columns">
      <div>
        <h3>Wg sekcji</h3>
        <div class="lw-summary-chips">${sectionChips}</div>
      </div>
      <div>
        <h3>Wg statusu</h3>
        <div class="lw-summary-chips">${categoryChips}</div>
      </div>
    </div>
  `;
}

// Same one-account-key comment as before applies to both tables below: server.ts's
// handleListaWyjazdowaPutWpisowe/handleListaWyjazdowaPutDues both write to the same
// `due:{memberEmail}` resource key (no :entry_fee/:{year} suffix), so one Historia deep link per
// member already covers wpisowe and every year of składka roczna - the action label (visible in
// the audit view) is what tells the two apart in that shared timeline. Points at /admin/audyt/,
// not the member-zone /audyt/: dues.* actions carry audience 'adminOrAccountant'
// (ACTION_REGISTRY, upload-service/src/audit.ts), which only the admin-scope viewer can see.
function dueHistoryHref(email) {
  return `/admin/audyt/?resourceKey=${encodeURIComponent(`due:${email}`)}`;
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
function renderTable(roster, duesByEmail) {
  cachedRoster = roster;
  cachedDuesByEmail = duesByEmail;

  const mainRoster = [];
  const emeryciRoster = [];
  for (const member of roster) {
    if (member.categoryId === EMERYT_CATEGORY_ID) emeryciRoster.push(member);
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
      case 'roczna': return ROCZNA_SORT_RANK[effectiveDuesStatus(member, duesByEmail)];
      default: return sectionLabel(member.sectionId);
    }
  };
  const sorted = [...mainRoster].sort((a, b) => {
    const cmp = compareValues(sortValue(a), sortValue(b), skladkiSortState.dir);
    if (cmp !== 0) return cmp;
    return compareValues(displayName(a), displayName(b), 'asc');
  });

  const rowHtml = (member) => {
    const emailAttr = escapeAttr(member.email);
    const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
    return `
      <tr data-section="${escapeAttr(member.sectionId ?? '')}">
        <td class="czl-section-cell" title="${escapeAttr(sectionLabel(member.sectionId))}">${member.sectionId ? escapeHtml(sectionAbbr(member.sectionId)) : EMPTY}</td>
        <td class="lw-roster-name-cell">
          <button type="button" class="profile-trigger" data-profile-trigger data-email="${emailAttr}">
            <span ${categoryNamePillAttrs(member.categoryId, categoryLabel)}>${escapeHtml(displayName(member))}</span>
          </button>
          <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${emailAttr}" aria-label="Pokaż profil" title="Pokaż profil">${PERSON_ICON}</button>
        </td>
        <td>${rocznaIconHtml(emailAttr, effectiveDuesStatus(member, duesByEmail))}</td>
        ${canManageSkladki ? `<td><a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref(member.email))}" title="Historia" aria-label="Historia składek">${HISTORY_ICON}</a></td>` : ''}
      </tr>`;
  };

  const table = document.getElementById('skladki-table');
  table.querySelector('thead').innerHTML = `
    <tr>
      <th scope="col" class="czl-section-cell" data-sort-key="section" aria-sort="none" title="Sekcja"><button type="button">S</button></th>
      <th scope="col" class="lw-roster-name-cell" data-sort-key="name" aria-sort="none"><button type="button">Nazwa</button></th>
      <th scope="col" class="lw-narrow-col" data-sort-key="roczna" aria-sort="none" title="Składka roczna"><button type="button"><span class="lw-col-icon" aria-hidden="true">💰</span><span class="lw-col-label">Składka</span></button></th>
      ${canManageSkladki ? `<th scope="col" class="lw-narrow-col" title="Historia"><span class="lw-col-icon" aria-hidden="true">${HISTORY_ICON}</span><span class="lw-col-label">Historia</span></th>` : ''}
    </tr>
  `;
  table.querySelector('tbody').innerHTML = sorted.map(rowHtml).join('');
  skladkiSortState.refresh();

  const emeryciSortValue = (member) => {
    switch (emeryciSortState.key) {
      case 'name': return displayName(member);
      case 'roczna': return ROCZNA_SORT_RANK[effectiveDuesStatus(member, duesByEmail)];
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
      ${canManageSkladki ? `<th scope="col" class="lw-narrow-col" title="Historia"><span class="lw-col-icon" aria-hidden="true">${HISTORY_ICON}</span><span class="lw-col-label">Historia</span></th>` : ''}
    </tr>
  `;
  emeryciTable.querySelector('tbody').innerHTML = emeryciSorted.map(rowHtml).join('');
  emeryciSortState.refresh();

  document.getElementById('skladki-emeryci').hidden = emeryciRoster.length === 0;
}

// The "Wpisowe" option in the Składka: select (see WPISOWE_OPTION) - a flat list of everyone who
// still owes wpisowe, sorted by join date (members.ts's approvedAt, the closest thing this
// codebase has to one) so the accountant chases the longest-standing debt first. A member with no
// approvedAt yet (no members/{email} document, or one predating KRKG-0046) sorts to the end rather
// than crashing a string compare against null. No "Wpisowe" caption anywhere in this table (column
// header included) - the page itself is already scoped to wpisowe, so repeating the word on every
// row would only cost the Nazwa column width without telling the reader anything new.
function renderWpisoweList(roster) {
  cachedRoster = roster;
  // Wpisowe has no not_applicable state, so the Emeryci table (KRKG-0074) never applies here -
  // hide it in case the user switched over from a year view that had it visible.
  document.getElementById('skladki-emeryci').hidden = true;

  // Every row here is unpaid by definition (see the filter below), so unlike the year table above,
  // there is no meaningful "sort by paid status" column - the icon column carries no data-sort-key.
  const sortValue = (member) => {
    switch (skladkiSortState.key) {
      case 'name': return displayName(member);
      case 'joined': return member.approvedAt ?? '';
      default: return sectionLabel(member.sectionId);
    }
  };
  const unpaid = roster
    .filter((member) => !member.wpisowePaid)
    .sort((a, b) => {
      // approvedAt sorts ascending-by-default as empty-string-last regardless of dir (a member
      // with no join date on record shouldn't jump to the front just because the direction flipped)
      if (skladkiSortState.key === 'joined' && (!a.approvedAt || !b.approvedAt) && a.approvedAt !== b.approvedAt) {
        return a.approvedAt ? -1 : 1;
      }
      const cmp = compareValues(sortValue(a), sortValue(b), skladkiSortState.dir);
      if (cmp !== 0) return cmp;
      return compareValues(displayName(a), displayName(b), 'asc');
    });

  const colCount = canManageSkladki ? 5 : 4;
  const rows = unpaid.length === 0
    ? `<tr><td colspan="${colCount}" class="czl-empty">Wszyscy członkowie mają opłacone wpisowe.</td></tr>`
    : unpaid
      .map((member) => {
        const emailAttr = escapeAttr(member.email);
        const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
        return `
      <tr data-section="${escapeAttr(member.sectionId ?? '')}">
        <td class="czl-section-cell" title="${escapeAttr(sectionLabel(member.sectionId))}">${member.sectionId ? escapeHtml(sectionAbbr(member.sectionId)) : EMPTY}</td>
        <td class="lw-roster-name-cell">
          <button type="button" class="profile-trigger" data-profile-trigger data-email="${emailAttr}">
            <span ${categoryNamePillAttrs(member.categoryId, categoryLabel)}>${escapeHtml(displayName(member))}</span>
          </button>
          <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${emailAttr}" aria-label="Pokaż profil" title="Pokaż profil">${PERSON_ICON}</button>
        </td>
        <td class="${member.approvedAt ? '' : 'czl-empty'}">${member.approvedAt ? escapeHtml(formatDate(member.approvedAt)) : EMPTY}</td>
        <td>${paidIconHtml(emailAttr, false, 'Wpisowe: nieopłacone')}</td>
        ${canManageSkladki ? `<td><a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref(member.email))}" title="Historia" aria-label="Historia wpisowego">${HISTORY_ICON}</a></td>` : ''}
      </tr>`;
      })
      .join('');

  const table = document.getElementById('skladki-table');
  table.querySelector('thead').innerHTML = `
    <tr>
      <th scope="col" class="czl-section-cell" data-sort-key="section" aria-sort="none" title="Sekcja"><button type="button">S</button></th>
      <th scope="col" class="lw-roster-name-cell" data-sort-key="name" aria-sort="none"><button type="button">Nazwa</button></th>
      <th scope="col" data-sort-key="joined" aria-sort="none"><button type="button">Dołączył</button></th>
      <th scope="col" title="Wpisowe">✓</th>
      ${canManageSkladki ? '<th scope="col">Historia</th>' : ''}
    </tr>
  `;
  table.querySelector('tbody').innerHTML = rows;
  skladkiSortState.refresh();
}

// Tracks the dueDate last loaded/rendered into the edit input, so saveYearFee can tell whether the
// accountant actually changed the date (vs. only the note text) and skip sending dueDate in the PUT
// body when it's unchanged - the backend logs an audit row for any dueDate present in the body,
// `before === after` included (review finding: every note-only edit was also logging a no-op
// dueDate change).
let lastLoadedYearFeeDueDate = null;

// The shared per-year rate note (e.g. "100 zł mężczyźni, 50 zł kobiety") - same
// display/edit-panel pattern as wyjazd.js's renderSkladkaFee/saveSkladkaFee for its per-event fee.
function renderYearFee(yearFee) {
  // Wpisowe has no per-year rate note - it's a plain paid/unpaid fact (see paidIconHtml's comment)
  // - so this whole panel has nothing to show while the "Wpisowe" option is selected.
  const panel = document.getElementById('skladka-fee-panel');
  panel.hidden = wpisoweMode;
  if (wpisoweMode) return;
  const display = document.getElementById('skladki-year-fee-display');
  const editPanel = document.getElementById('skladki-year-fee-edit');
  const historyLink = document.getElementById('skladki-year-fee-history-link');
  const note = yearFee?.note ?? null;
  const dueDate = yearFee?.dueDate ?? null;
  display.textContent = note ? `Składka ${selectedYear}: ${note}` : `Składka ${selectedYear}: nie ustalono`;
  // A due date only ever exists alongside a note (see updateYearFeeFormState), so it is never
  // shown on its own even for legacy data that still carries an orphaned date.
  if (note && dueDate) display.textContent += ` (termin: ${formatDueDate(dueDate)})`;
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

async function saveYearFee(control = document.getElementById('skladki-year-fee-save')) {
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
      document.getElementById('skladki-year-fee-display').textContent = value
        ? `Składka ${selectedYear}: ${value}${dueDateValue ? ` (termin: ${formatDueDate(dueDateValue)})` : ''}`
        : `Składka ${selectedYear}: nie ustalono`;
      updateYearFeeFormState();
    });
  } catch (err) {
    showError(`Nie udało się zapisać składki: ${err.message}`);
  }
}

document.getElementById('skladki-year-fee-save').addEventListener('click', () => saveYearFee());

// Removes the whole per-year rate note (amount and due date) by clearing both fields and reusing
// the save above, so the year ends up with no rate in one confirmed mutation.
async function removeYearFee() {
  document.getElementById('skladki-year-fee-input').value = '';
  document.getElementById('skladki-year-fee-duedate-input').value = '';
  updateYearFeeFormState();
  await saveYearFee(document.getElementById('skladki-year-fee-remove'));
}

document.getElementById('skladki-year-fee-remove').addEventListener('click', removeYearFee);

async function loadAndRender() {
  populateYearSelect();
  const [{ canManageSkladki: role }, { roster }, { dues, yearFee }, lookupLists] = await Promise.all([
    apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/dues?year=${selectedYear}`, { method: 'GET' }, showReauth, hideReauth),
    // GET /lista-wyjazdowa/lookup-lists answers with the lists themselves ({ sections, categories,
    // weapons }), not wrapped in an envelope - see handleListaWyjazdowaLookupLists.
    apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
  ]);
  canManageSkladki = role;
  sectionLabelById = new Map((lookupLists.sections ?? []).map((s) => [s.id, s.label]));
  categoryLabelById = new Map((lookupLists.categories ?? []).map((c) => [c.id, c.label]));
  renderYearFee(yearFee);
  const duesByEmail = new Map(dues.map((d) => [d.email, d]));
  renderSummary(roster, duesByEmail);
  if (wpisoweMode) {
    renderWpisoweList(roster);
  } else {
    renderTable(roster, duesByEmail);
  }
}

// Wpisowe's icon only ever appears for an unpaid member in the Wpisowe-only list (renderTable
// dropped its Wpisowe column entirely in KRKG-0074), so marking it paid is a one-way action,
// never a toggle back - undoing a mistake afterward means going to Zarządzanie ludźmi's own
// Wpisowe column instead. toRemove is the element that should disappear from the DOM on success:
// the whole <tr> in the Wpisowe-only list (every row there exists only because it's unpaid, so
// the member simply drops off the list).
async function markWpisowePaid(email, control, toRemove) {
  clearError();
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/wpisowe?memberEmail=${encodeURIComponent(email)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true }) },
      showReauth,
      hideReauth,
    ), () => {
      toRemove.remove();
    }, toRemove);
  } catch (err) {
    showError(`Nie udało się zaktualizować wpisowego: ${err.message}`);
  }
}

// nextStatus cycles unpaid -> paid -> not_applicable -> unpaid (see DUES_STATUS_CYCLE) - a plain
// reversible click same as before, just three stops instead of two.
async function toggleRoczna(email, nextStatus, control) {
  clearError();
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/dues?memberEmail=${encodeURIComponent(email)}&year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) },
      showReauth,
      hideReauth,
    ), () => {
      control.dataset.status = nextStatus;
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
  const email = icon.dataset.email;
  if (icon.dataset.kind === 'wpisowe') {
    // See markWpisowePaid's comment - always a one-way "mark paid" from either table, never a
    // toggle back, so this confirms first regardless of which table is showing.
    if (!window.confirm('Czy na pewno chcesz zaznaczyć, że wpisowe zostało opłacone?')) return;
    markWpisowePaid(email, icon, wpisoweMode ? icon.closest('tr') : icon);
  } else {
    toggleRoczna(email, nextDuesStatus(icon.dataset.status), icon);
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
