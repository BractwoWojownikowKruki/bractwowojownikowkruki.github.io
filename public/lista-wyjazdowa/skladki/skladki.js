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
 * the year table (renderTable - Wpisowe and Składka roczna as their own icon-only columns, no
 * visible year number) to a flat list of every member who still owes wpisowe, with its own
 * Dołączył column instead of Składka, sorted by join date (members.ts's approvedAt) so the oldest
 * unpaid debt surfaces first. Neither table repeats the word "Wpisowe" as row text next to the
 * icon - the page is already scoped to whichever due is selected, so that word would only cost the
 * Nazwa column the width it needs for long names.
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

// Same priority as wyjazd.js's displayName - duplicated per this codebase's existing convention
// (escapeHtml/escapeAttr are already duplicated the same way across every Lista Wyjazdowa page)
// rather than introducing a shared module for one small function.
//
// email.split('@')[0] (not the raw email) is the fallback for the same reason as wyjazd.js's
// displayName: the roster now enumerates the whole club allowlist, including members with no "Mój
// profil" saved yet, and "jan.kowalski" reads far better in a name column than the full
// "jan.kowalski@gmail.com".
function displayName(member) {
  if (member.nickname) return member.nickname;
  if (member.fullName) return member.fullName;
  return member.email.split('@')[0];
}

// Same badge shape as wyjazd.js's renderSkladkaIcon (member-area.css's .lw-skladka-icon,
// red/green background from data-paid) - a plain <span> for members who can't manage składki
// (nothing to click), an actual <button> otherwise. data-kind distinguishes wpisowe from składka
// roczna for the shared click handler below. Wpisowe is a plain paid/unpaid fact (no rate to
// speak of, see the year-fee panel above), shown as a check/cross; roczna keeps the coin - it's
// the one with money actually changing hands against a rate.
function paidIconHtml(kind, emailAttr, paid, label) {
  const glyph = kind === 'wpisowe' ? (paid ? '✓' : '✕') : '💰';
  if (!canManageSkladki) {
    return `<span class="lw-skladka-icon" data-paid="${paid}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${glyph}</span>`;
  }
  return `<button type="button" class="lw-skladka-icon" data-kind="${kind}" data-email="${emailAttr}" data-paid="${paid}" title="${escapeAttr(label)} — kliknij, aby zmienić" aria-label="${escapeAttr(label)}">${glyph}</button>`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${formatDate(iso)} ${time}`;
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

// anchor defaults to control, but a caller whose apply() removes control from the DOM (the
// Wpisowe-list view's toggleWpisoweInList, which drops the whole row once it's paid) must pass a
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

document.getElementById('skladki-year-select').addEventListener('change', async (e) => {
  wpisoweMode = e.target.value === WPISOWE_OPTION;
  if (!wpisoweMode) selectedYear = Number(e.target.value);
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
function renderSummary(roster, duesByEmail) {
  const paidFor = (member) => (wpisoweMode ? member.wpisowePaid : (duesByEmail.get(member.email)?.paid ?? false));
  const unpaidBySection = new Map();
  const totalBySection = new Map();
  const unpaidByCategory = new Map();
  const totalByCategory = new Map();
  let unpaidTotal = 0;
  let unpaidWpisowe = 0;

  for (const member of roster) {
    const paid = paidFor(member);
    if (!member.wpisowePaid) unpaidWpisowe += 1;
    totalBySection.set(member.sectionId, (totalBySection.get(member.sectionId) ?? 0) + 1);
    totalByCategory.set(member.categoryId, (totalByCategory.get(member.categoryId) ?? 0) + 1);
    if (!paid) {
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
      ? `Składka ${selectedYear}: wszyscy opłacili ${unpaidBadgeHtml(0, roster.length)}`
      : `Nieopłacona składka ${selectedYear}: <strong>${unpaidTotal}</strong> z ${roster.length} osób.`);

  // Always shown regardless of the selected due, even when the breakdown above is already about
  // wpisowe - an accountant looking at a year's składka roczna still wants to know at a glance
  // whether anyone owes wpisowe too, without switching the dropdown.
  const wpisoweLine = wpisoweMode ? '' : `<p>Nieopłacone wpisowe: <strong>${unpaidWpisowe}</strong> z ${roster.length} osób.</p>`;

  document.getElementById('summary-content').innerHTML = `
    <p>${totalLine}</p>
    ${wpisoweLine}
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
// ad-hoc layout of its own. Sorted by Sekcja then name, same convention as those tables' default
// sort - no more per-section <h3> headings or an unpaid-first sub-sort (the summary panel above
// already surfaces who's unpaid; a plain member scanning for themselves benefits more from a
// stable, predictable order).
function renderTable(roster, duesByEmail) {
  const container = document.getElementById('skladki-content');

  const sorted = [...roster].sort((a, b) => {
    const cmp = sectionLabel(a.sectionId).toLocaleLowerCase('pl').localeCompare(sectionLabel(b.sectionId).toLocaleLowerCase('pl'), 'pl');
    if (cmp !== 0) return cmp;
    return displayName(a).toLocaleLowerCase('pl').localeCompare(displayName(b).toLocaleLowerCase('pl'), 'pl');
  });

  const rows = sorted
    .map((member) => {
      const roczna = duesByEmail.get(member.email)?.paid ?? false;
      const emailAttr = escapeAttr(member.email);
      const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
      const wpisoweLabel = `Wpisowe: ${member.wpisowePaid ? 'opłacone' : 'nieopłacone'}`;
      // The year only appears in this tooltip, never as visible row text - the icon alone (💰) is
      // the cell's whole content, same as every other paid/unpaid glyph on this page.
      const rocznaLabel = `Składka ${selectedYear}: ${roczna ? 'opłacona' : 'nieopłacona'}`;
      return `
      <tr data-section="${escapeAttr(member.sectionId ?? '')}">
        <td class="czl-section-cell" title="${escapeAttr(sectionLabel(member.sectionId))}">${member.sectionId ? escapeHtml(sectionAbbr(member.sectionId)) : EMPTY}</td>
        <td class="lw-roster-name-cell">
          <button type="button" class="profile-trigger" data-profile-trigger data-email="${emailAttr}">
            <span ${categoryNamePillAttrs(member.categoryId, categoryLabel)}>${escapeHtml(displayName(member))}</span>
          </button>
          <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${emailAttr}" aria-label="Pokaż profil" title="Pokaż profil">${PERSON_ICON}</button>
        </td>
        <td>${paidIconHtml('wpisowe', emailAttr, member.wpisowePaid, wpisoweLabel)}</td>
        <td>${paidIconHtml('roczna', emailAttr, roczna, rocznaLabel)}</td>
        ${canManageSkladki ? `<td><a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref(member.email))}" title="Historia" aria-label="Historia składek">${HISTORY_ICON}</a></td>` : ''}
      </tr>`;
    })
    .join('');

  container.innerHTML = `
    <div class="czl-table-wrap">
      <table class="czl-table">
        <thead>
          <tr>
            <th scope="col" class="czl-section-cell" title="Sekcja">S</th>
            <th scope="col" class="lw-roster-name-cell">Nazwa</th>
            <th scope="col">Wpisowe</th>
            <th scope="col" title="Składka roczna">Składka</th>
            ${canManageSkladki ? '<th scope="col">Historia</th>' : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// The "Wpisowe" option in the Składka: select (see WPISOWE_OPTION) - a flat list of everyone who
// still owes wpisowe, sorted by join date (members.ts's approvedAt, the closest thing this
// codebase has to one) so the accountant chases the longest-standing debt first. A member with no
// approvedAt yet (no members/{email} document, or one predating KRKG-0046) sorts to the end rather
// than crashing a string compare against null. No "Wpisowe" caption anywhere in this table (column
// header included) - the page itself is already scoped to wpisowe, so repeating the word on every
// row would only cost the Nazwa column width without telling the reader anything new.
function renderWpisoweList(roster) {
  const container = document.getElementById('skladki-content');

  const unpaid = roster
    .filter((member) => !member.wpisowePaid)
    .sort((a, b) => {
      if (a.approvedAt !== b.approvedAt) {
        if (!a.approvedAt) return 1;
        if (!b.approvedAt) return -1;
        return a.approvedAt.localeCompare(b.approvedAt);
      }
      return displayName(a).toLocaleLowerCase('pl').localeCompare(displayName(b).toLocaleLowerCase('pl'), 'pl');
    });

  if (unpaid.length === 0) {
    container.innerHTML = '<p>Wszyscy członkowie mają opłacone wpisowe.</p>';
    return;
  }

  const rows = unpaid
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
        <td>${paidIconHtml('wpisowe', emailAttr, false, 'Wpisowe: nieopłacone')}</td>
        ${canManageSkladki ? `<td><a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref(member.email))}" title="Historia" aria-label="Historia wpisowego">${HISTORY_ICON}</a></td>` : ''}
      </tr>`;
    })
    .join('');

  container.innerHTML = `
    <div class="czl-table-wrap">
      <table class="czl-table">
        <thead>
          <tr>
            <th scope="col" class="czl-section-cell" title="Sekcja">S</th>
            <th scope="col" class="lw-roster-name-cell">Nazwa</th>
            <th scope="col">Dołączył</th>
            <th scope="col" title="Wpisowe">✓</th>
            ${canManageSkladki ? '<th scope="col">Historia</th>' : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Accountant/admin-only (KRKG-0047): GET /lista-wyjazdowa/dues/audit-log now 403s for a plain
// member, so the panel is hidden entirely for them rather than fetched and left to error.
async function renderDuesAuditLog() {
  const panel = document.getElementById('dues-audit-log-panel');
  panel.hidden = !canManageSkladki;
  if (!canManageSkladki) return;
  const { entries } = await apiFetch('/lista-wyjazdowa/dues/audit-log', { method: 'GET' }, showReauth, hideReauth);
  // targetMemberEmail is null for an eventFee entry (the event's name is already baked into its
  // changeSummary text server-side, see server.ts's handleListaWyjazdowaPutEvent) - the arrow only
  // makes sense for wpisowe/roczna entries, which name a member but not in the summary text.
  document.getElementById('dues-audit-log-content').innerHTML = entries
    .slice()
    .reverse()
    .map((e) => {
      const target = e.targetMemberEmail ? ` → ${escapeHtml(e.targetMemberEmail)}` : '';
      return `<li>${escapeHtml(formatDateTime(e.changedAt))} — ${escapeHtml(e.changedBy)}${target}: ${escapeHtml(e.changeSummary)}</li>`;
    })
    .join('');
}

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
  display.textContent = note ? `Składka ${selectedYear}: ${note}` : `Składka ${selectedYear}: nie ustalono`;
  editPanel.hidden = !canManageSkladki;
  if (canManageSkladki) document.getElementById('skladki-year-fee-input').value = note ?? '';
  historyLink.hidden = !canManageSkladki;
  historyLink.href = `/admin/audyt/?resourceKey=${encodeURIComponent(`due:year:${selectedYear}`)}`;
}

async function saveYearFee() {
  clearError();
  try {
    const value = document.getElementById('skladki-year-fee-input').value.trim();
    await confirmedDuesMutation(document.getElementById('skladki-year-fee-save'), () => apiFetch(
      `/lista-wyjazdowa/dues/year-fee?year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: value || null }) },
      showReauth,
      hideReauth,
    ), () => {
      document.getElementById('skladki-year-fee-display').textContent = value ? `Składka ${selectedYear}: ${value}` : `Składka ${selectedYear}: nie ustalono`;
    });
  } catch (err) {
    showError(`Nie udało się zapisać składki: ${err.message}`);
  }
}

document.getElementById('skladki-year-fee-save').addEventListener('click', saveYearFee);

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
  await renderDuesAuditLog();
}

// Used from the year table (renderTable), where Wpisowe is a stable column - marking it paid just
// flips the icon in place (✕ -> ✓) rather than removing anything, so it stays a plain reversible
// toggle same as toggleRoczna below.
async function toggleWpisowe(email, nextPaid, control) {
  clearError();
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/wpisowe?memberEmail=${encodeURIComponent(email)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    ), () => {
      control.dataset.paid = String(nextPaid);
      control.textContent = nextPaid ? '✓' : '✕';
      const label = `Wpisowe: ${nextPaid ? 'opłacone' : 'nieopłacone'}`;
      control.title = `${label} — kliknij, aby zmienić`;
      control.setAttribute('aria-label', label);
    });
  } catch (err) {
    showError(`Nie udało się zaktualizować wpisowego: ${err.message}`);
  }
}

// Same PUT as toggleWpisowe above, but for the "Wpisowe" list view (renderWpisoweList): every row
// there exists only because it's unpaid, so marking it paid removes the whole row instead of
// flipping its icon - the member simply drops off this list. Undoing that afterward means going to
// Zarządzanie ludźmi's own Wpisowe column - there's no toggle left in this view once the row is gone.
async function toggleWpisoweInList(email, control) {
  clearError();
  const row = control.closest('tr');
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/wpisowe?memberEmail=${encodeURIComponent(email)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true }) },
      showReauth,
      hideReauth,
    ), () => {
      row.remove();
    }, row);
  } catch (err) {
    showError(`Nie udało się zaktualizować wpisowego: ${err.message}`);
  }
}

async function toggleRoczna(email, nextPaid, control) {
  clearError();
  try {
    await confirmedDuesMutation(control, () => apiFetch(
      `/lista-wyjazdowa/dues?memberEmail=${encodeURIComponent(email)}&year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    ), () => {
      control.dataset.paid = String(nextPaid);
      const label = `Składka ${selectedYear}: ${nextPaid ? 'opłacona' : 'nieopłacona'}`;
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
  const nextPaid = icon.dataset.paid !== 'true';
  if (icon.dataset.kind === 'wpisowe') {
    if (wpisoweMode) {
      // Marking paid removes this row from the unpaid-only list entirely (see
      // toggleWpisoweInList) - from that point on, undoing a mistake means going to Zarządzanie
      // ludźmi's Wpisowe column, so this one confirms first.
      if (!window.confirm('Czy na pewno chcesz zaznaczyć, że wpisowe zostało opłacone?')) return;
      toggleWpisoweInList(email, icon);
    } else {
      // A plain reversible toggle in the year table (see toggleWpisowe) - no confirmation needed,
      // same as toggleRoczna's icon right next to it.
      toggleWpisowe(email, nextPaid, icon);
    }
  } else {
    toggleRoczna(email, nextPaid, icon);
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
