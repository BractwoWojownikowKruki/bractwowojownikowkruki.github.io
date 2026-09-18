/**
 * Event detail page (Plan B, KRKG-0037). Reads ?eventId= from the URL. Roster/summary come from
 * a client-side join of GET /lista-wyjazdowa/roster (every member + their equipment/companions)
 * against GET /lista-wyjazdowa/signups?eventId= (who's attending this event and with what) -
 * mirrors design.md §5's "summaries computed on read, not stored" principle.
 *
 * No "own profile required" gate here (unlike the events list page, Task 4): this page's
 * open-edit model lets any signed-in member toggle any other member's row, so the viewer's own
 * listaWyjazdowaProfile completeness is irrelevant to reaching this page.
 */

// Same escapeHtml/escapeAttr pair as profil.js/person-tile.js - the established pattern in this
// codebase for interpolating user-controlled strings into an innerHTML template. escapeAttr adds
// quote-escaping on top of escapeHtml, needed anywhere a value lands inside an attribute (e.g.
// data-email="...") rather than as text content.
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Weapon icons (KRKG-0054, art assets added later): keyed by lookupLists/weapons' fixed 3-item id
// set (see upload-service/scripts/seed-lookup-lists.ts) via its ASCII item-name (see
// WEAPON_ICON_KEYS below), pointing at the hand-drawn PNGs in /icons. A member holding two weapons
// gets the matching two-item combo PNG rather than two icons side by side - see
// weaponGroupIconFile below, which builds the same combo key weaponGroupLabel uses for its text.
const WEAPON_ICON_KEYS = {
  tarczownik: 'tarcza',
  wlocznik: 'wlocznia',
  dunczyk: 'topor',
};

function weaponGroupIconFile(weaponIds) {
  if (weaponIds.length === 0 || weaponIds.length > 2) return null;
  const keys = [...weaponIds]
    .sort((a, b) => WEAPON_DISPLAY_ORDER.indexOf(a) - WEAPON_DISPLAY_ORDER.indexOf(b))
    .map((id) => WEAPON_ICON_KEYS[id]);
  if (keys.some((key) => !key)) return null;
  return `/icons/bron-${keys.join('-')}.png`;
}

// Icon-and-label together, for spots with room to spare (the "Wg broni" summary chips) - a bare
// icon there would need a hover just to read what it means.
function weaponGroupIconHtml(weaponIds, label) {
  const iconFile = weaponGroupIconFile(weaponIds);
  const icon = iconFile ? `<img class="lw-weapon-icon" src="${iconFile}" alt="" width="20" height="20">` : '';
  return `<span class="lw-weapon-group">${icon}<span class="lw-weapon-group-label">${escapeHtml(label)}</span></span>`;
}

// Icon only, no visible caption - the roster table has no room to spare (especially on phones), so
// its Broń column shows just the icon(s), with the full label as a hover/a11y title instead. Falls
// back to one icon per weapon when the set has no matching combo PNG (weaponGroupIconFile only
// covers 1-2 weapons; nobody is expected to hold all three, but this still degrades sanely).
function weaponIconsOnlyHtml(weaponIds, title) {
  const groupFile = weaponGroupIconFile(weaponIds);
  if (groupFile) {
    return `<img class="lw-weapon-icon" src="${groupFile}" alt="${escapeAttr(title)}" title="${escapeAttr(title)}" width="20" height="20">`;
  }
  return weaponIds
    .map((id) => {
      const file = weaponGroupIconFile([id]);
      return file
        ? `<img class="lw-weapon-icon" src="${file}" alt="${escapeAttr(weaponLabelFor(id))}" title="${escapeAttr(weaponLabelFor(id))}" width="20" height="20">`
        : '';
    })
    .join('');
}

// 3-letter Sekcja abbreviations (KRKG-0063) for the compact, sticky first column - a display-only
// convenience, not a second source of truth: sections/seed-lookup-lists.ts's fixed 6-id set is
// still where a section's real label (sectionLabelById below) and member-area.css's colors (via
// --section-c) come from. Falls back to the id's own first 3 letters for anything not in this map
// (e.g. "nieznana"), same never-hide-an-unresolved-reference spirit as sectionLabelById's own.
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

// Typ (categoryId) shown by wrapping the name itself in a colored outline pill, instead of its
// own column or a second pill next to the name (KRKG-0057) - same never-a-color-value-in-JS
// convention as member-area.css's [data-section="..."] rules for Sekcja. This page never lets
// anyone edit Typ, so it's always read-only here - no sync-on-change counterpart needed.
// KRKG-0087: the pill (and the "osoba bez konta" marker) is rendered by shared/person-pill.js's
// personPillHtml instead of an inline attrs helper.

// displayName(member) itself now lives in shared/display-name.js (included via index.html) - see
// its own comment for the priority order and the email-typed-into-a-name-field edge case.

// startDate is a bare calendar date ("2027-05-01"), not a timestamp - plain string slicing avoids
// the UTC-vs-local skew a Date object would risk (see lista-wyjazdowa.js's todayIsoDate fix).
function formatDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function formatStatusChangedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}

function showReauth() {} // no reauth banner on this page yet - matches lista-wyjazdowa.js's placeholder scope
function hideReauth() {}

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

const eventId = new URLSearchParams(window.location.search).get('eventId');

// Every mutation on this page is a fire-and-forget click handler with no return value the user
// can inspect, so a rejected apiFetch has to be turned into something visible or the click just
// appears to do nothing (design.md §9). scrollIntoView because the save button that failed can
// sit far below the fold on a long roster, well away from this banner.
function showError(message) {
  const errorEl = document.getElementById('lw-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
  errorEl.scrollIntoView({ block: 'center' });
}

function clearError() {
  document.getElementById('lw-error').hidden = true;
}

function confirmedEventMutation(control, execute, apply, anchor = control, rollback) {
  return window.MutationFeedback.confirmed({
    control,
    anchor,
    execute,
    apply,
    rollback,
    viewRoot: document.getElementById('main-content'),
    refreshFragment: loadAll,
  });
}

// Fetched once per loadAll() alongside events/roster/signups (Task 2's GET /my-role). Read by
// renderSkladkaFee() and renderRoster() to decide whether to show edit/toggle controls or
// read-only text - the server re-checks the role on every mutation regardless, this only
// controls what the UI offers.
let canManageSkladki = false;
// KRKG-0087: staff (admin/moderator/accountant) may add a companion to any account row; everyone
// else only to their own. Same "server re-checks anyway" contract as canManageSkladki above.
let canManagePeople = false;
let cachedEvent = null;

// Tracks the dueDate last loaded/rendered into the edit input, so saveSkladkaFee can tell whether
// the organizer actually changed the date (vs. only the fee text) and skip sending dueDate in the
// PUT body when it's unchanged - the backend logs an audit row for any dueDate present in the
// body, `before === after` included (review finding: every fee-only edit was also logging a
// no-op dueDate change). Same pattern as skladki.js's lastLoadedYearFeeDueDate.
let lastLoadedSkladkaDueDate = null;

function normalizeSkladkaFee(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSkladkaDueDate(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// event.skladkaFee is a free-text field (e.g. "50 zł / 25 zł dzieci"); textContent is used below
// so no HTML-escaping is needed for the display span, same reasoning as event-title/event-meta
// above it in loadAll().
function renderSkladkaFee(event) {
  const display = document.getElementById('skladka-fee-display');
  const editPanel = document.getElementById('skladka-fee-edit');
  const fee = normalizeSkladkaFee(event.skladkaFee);
  const dueDate = normalizeSkladkaDueDate(event.dueDate);
  display.textContent = fee ? `Składka: ${fee}` : 'Składka: nie ustalono';
  // A due date only ever exists alongside a fee (see updateSkladkaFeeFormState), so it is never
  // shown on its own even for legacy data that still carries an orphaned date.
  if (fee && dueDate) display.textContent += ` (termin: ${formatDate(dueDate)})`;
  editPanel.hidden = !canManageSkladki;
  if (canManageSkladki) {
    document.getElementById('skladka-fee-input').value = fee;
    document.getElementById('skladka-fee-duedate-input').value = dueDate ?? '';
    lastLoadedSkladkaDueDate = dueDate;
    updateSkladkaFeeFormState();
  }
}

// The due-date field follows the fee field: it is only meaningful with a fee, so an empty fee
// clears and disables it, and "Usuń składkę" is only offered while there is a fee to remove.
// Reads the DOM directly, so it is correct both on render and on every keystroke.
function updateSkladkaFeeFormState() {
  const fee = normalizeSkladkaFee(document.getElementById('skladka-fee-input').value);
  const dueDateInput = document.getElementById('skladka-fee-duedate-input');
  if (!fee) dueDateInput.value = '';
  dueDateInput.disabled = !fee;
  document.getElementById('skladka-fee-remove').disabled = !fee;
}

document.getElementById('skladka-fee-input').addEventListener('input', updateSkladkaFeeFormState);

async function saveSkladkaFee(control = document.getElementById('skladka-fee-save'), rollback) {
  clearError();
  try {
    const value = normalizeSkladkaFee(document.getElementById('skladka-fee-input').value);
    // Guarded, not just disabled: a fee-less event can never carry a date, even if the input was
    // somehow populated (legacy render, scripted DOM).
    const dueDateValue = value ? normalizeSkladkaDueDate(document.getElementById('skladka-fee-duedate-input').value) : null;
    const body = {};
    if (value !== normalizeSkladkaFee(cachedEvent?.skladkaFee)) body.skladkaFee = value || null;
    if (dueDateValue !== lastLoadedSkladkaDueDate) body.dueDate = dueDateValue;
    if (Object.keys(body).length === 0) return;
    await confirmedEventMutation(control, () => apiFetch(
      `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      showReauth,
      hideReauth,
    ), (result) => {
      cachedEvent = result.event;
      renderSkladkaFee(cachedEvent);
      renderRoster(cachedRoster, cachedSignups);
    }, control, rollback);
  } catch (err) {
    showError(`Nie udało się zapisać składki: ${err.message}`);
  }
}

document.getElementById('skladka-fee-save').addEventListener('click', () => saveSkladkaFee());

// Removes the whole fee (amount and due date) by clearing both fields and reusing the differential
// save above, so the event ends up with no fee in one confirmed mutation - the same path that
// already hides the payment icons when the fee is empty. Clearing happens before the request, so a
// failed save restores the form from the last confirmed event (rollback) rather than leaving the
// fields blank while the summary still shows the old fee.
async function removeSkladkaFee() {
  document.getElementById('skladka-fee-input').value = '';
  document.getElementById('skladka-fee-duedate-input').value = '';
  updateSkladkaFeeFormState();
  await saveSkladkaFee(document.getElementById('skladka-fee-remove'), () => renderSkladkaFee(cachedEvent));
}

document.getElementById('skladka-fee-remove').addEventListener('click', removeSkladkaFee);

async function toggleSkladkaPaid(personId, nextPaid, control) {
  clearError();
  try {
    await confirmedEventMutation(control, () => apiFetch(
      `/lista-wyjazdowa/signups/skladka?eventId=${encodeURIComponent(eventId)}&personId=${encodeURIComponent(personId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    ), () => {
      const signup = cachedSignups.find(item => item.memberEmail === personId);
      if (signup) signup.skladkaPaid = nextPaid;
      renderRoster(cachedRoster, cachedSignups);
    }, document.getElementById('roster-panel'));
  } catch (err) {
    showError(`Nie udało się zaktualizować składki: ${err.message}`);
  }
}

// Both #summary-content (counts, near the top) and #equipment-companions-content (named lists,
// near the bottom, per feedback on section order) are derived from the same attending/roster
// join, so this computes both in one pass and writes each half to its own container.
//
// Wg broni counts each attendee exactly once, grouped by their *complete* weaponIds set (see
// weaponGroupLabel/weaponGroupKey above) - unlike weaponSortLabel's roster-sort grouping (which
// only looks at the first weaponId), someone able to use two weapons is its own distinct headcount
// here, not folded into either single-weapon group.
function renderSummary(roster, signups) {
  const attending = signups.filter((s) => s.attending);
  // KRKG-0087: the canonical row key is personId (a member's e-mail, an accountless person's UUID),
  // not e-mail - a signup's stored memberEmail is that same personId.
  const rosterByPersonId = new Map(roster.map((r) => [r.personId, r]));

  const bySection = new Map();
  const byWeaponGroup = new Map(); // weaponGroupKey -> { label, count }
  const byCategory = new Map();
  const equipmentBearers = [];
  for (const s of attending) {
    const member = rosterByPersonId.get(s.memberEmail);
    if (!member) continue;
    bySection.set(member.sectionId, (bySection.get(member.sectionId) ?? 0) + 1);
    const weaponKey = weaponGroupKey(member.weaponIds);
    const weaponGroup = byWeaponGroup.get(weaponKey);
    if (weaponGroup) weaponGroup.count += 1;
    else byWeaponGroup.set(weaponKey, { weaponIds: member.weaponIds, label: weaponGroupLabel(member.weaponIds), count: 1 });
    byCategory.set(member.categoryId, (byCategory.get(member.categoryId) ?? 0) + 1);
    for (const eqId of s.equipmentIds) {
      const item = member.equipment.find((e) => e.id === eqId);
      if (item) equipmentBearers.push(`${escapeHtml(item.name)} — ${escapeHtml(displayName(member))}`);
    }
  }

  const sortedKeys = (counts, labelFor) =>
    Array.from(counts.keys()).sort((a, b) =>
      labelFor(a).toLocaleLowerCase('pl').localeCompare(labelFor(b).toLocaleLowerCase('pl'), 'pl'),
    );

  // Chips (pill + count badge), not a line-per-group list - "Sekcja: N" per line took far more
  // room than the numbers actually need (KRKG-0047 follow-up).
  const sectionChips = sortedKeys(bySection, sectionLabelFor)
    .map((sectionId) => {
      const label = sectionLabelFor(sectionId);
      const badge = `<span class="lw-summary-badge">${bySection.get(sectionId)}</span>`;
      return sectionId === null
        ? `<span class="lw-summary-chip">${escapeHtml(label)}${badge}</span>`
        : `<span class="section-pill lw-summary-chip" data-section="${escapeAttr(sectionId)}">${escapeHtml(label)}${badge}</span>`;
    })
    .join('');

  const weaponChips = Array.from(byWeaponGroup.values())
    .sort((a, b) => a.label.toLocaleLowerCase('pl').localeCompare(b.label.toLocaleLowerCase('pl'), 'pl'))
    .map(({ weaponIds, label, count }) => `<span class="lw-summary-chip">${weaponGroupIconHtml(weaponIds, label)}<span class="lw-summary-badge">${count}</span></span>`)
    .join('');

  const categoryChips = sortedKeys(byCategory, categoryLabelFor)
    .map((categoryId) => {
      const label = categoryLabelFor(categoryId);
      const badge = `<span class="lw-summary-badge">${byCategory.get(categoryId)}</span>`;
      // A category chip, not a person pill - no "osoba bez konta" marker here (the marker is for
      // person pills only). Built inline rather than via personPillHtml because that escapes its
      // whole content, which would drop this count badge.
      return categoryId === null
        ? `<span class="lw-summary-chip">${escapeHtml(label)}${badge}</span>`
        : `<span class="category-name-pill lw-summary-chip" data-category="${escapeAttr(categoryId)}" title="${escapeAttr(label)}">${escapeHtml(label)}${badge}</span>`;
    })
    .join('');

  document.getElementById('summary-content').innerHTML = `
    <p>Łącznie: <strong>${attending.length}</strong> os.</p>
    <div class="lw-summary-columns">
      <div><h3>Wg sekcji</h3><div class="lw-summary-chips">${sectionChips}</div></div>
      <div><h3>Wg broni</h3><div class="lw-summary-chips">${weaponChips}</div></div>
      <div><h3>Wg statusu</h3><div class="lw-summary-chips">${categoryChips}</div></div>
    </div>
  `;

  document.getElementById('equipment-companions-content').innerHTML = `
    <h3>Sprzęt</h3>
    <ul>${equipmentBearers.map((l) => `<li>${l}</li>`).join('') || '<li>brak</li>'}</ul>
  `;
}

// The roster's sort is now click-a-header (shared/sortable-table.js, see the table's #roster-table
// initSortableTable call below) rather than a "Sortuj wg" dropdown - 'weapon' groups by the
// member's first weaponIds entry (a member can carry several, but the roster only ever has one row
// per member, so grouping uses just the first one rather than duplicating the row into every
// weapon's group). The two filter checkboxes are a separate concern (which members are shown at
// all, not what order): "Zgłoszeni + ja" (default on) shows every attending member plus the
// viewer's own row, so someone who hasn't signed up yet can still find themselves; "Niezgłoszeni"
// (default off) adds the members who haven't signed up. Both off means an empty list. Re-applied
// locally from the roster/signups already fetched by loadAll() - no network round-trip needed.
let showNotSignedUp = false;
let showSignedUpAndMe = true;
let cachedRoster = [];
let cachedSignups = [];
// KRKG-0087: which account row's inline "add companion" panel is open, or null when none is. Only
// one panel is open at a time, so its controls can carry fixed ids (lw-inline-*) - see
// renderAddPanel. Reset on every loadAll so a stale owner can't leave a panel rendered.
let openAddPanelOwnerPersonId = null;
// Set from initGoogleSignIn's onSignedIn identity (KRKG-0058) - the viewer's own row stays
// visible under the "Zgłoszeni + ja" filter even before they've signed up for this event, so they
// can always find themselves to toggle Jadę/Nie jadę rather than disappearing from their own view.
let viewerPersonId = null;

// Sections/categories/weapons don't change within one open page load - fetched once in loadAll()
// alongside everything else (see the lookupLists destructure there) and read from here. Same
// never-hide-an-unresolved-reference fallback as czlonkowie.js/zarzadzanie-ludzmi.js: an id with
// no matching lookup entry shows as its own raw id rather than vanishing.
let sectionLabelById = new Map();
let categoryLabelById = new Map();
let weaponLabelById = new Map();
// The raw categories lookup (id + label, in seed order) for the "new person" <select> in the
// inline add panel - a Map would lose the display order the endpoint already returns.
let categoryOptions = [];
// "Emeryt" -> "emeryt". Duplicated from dues.ts's EMERYT_CATEGORY_ID, same convention as
// skladki.js's own copy: a person created from the roster starts unpaid, except an Emeryt who
// owes nothing - mirrors the server's effectiveDuesStatus default for a person with no record.
const EMERYT_CATEGORY_ID = 'emeryt';

function sectionSortLabel(member) {
  return member.sectionId ? (sectionLabelById.get(member.sectionId) ?? member.sectionId) : '';
}

function weaponSortLabel(member) {
  const firstId = member.weaponIds[0];
  return firstId ? (weaponLabelById.get(firstId) ?? firstId) : '';
}

// Display-label variants of the three lookup maps for renderSummary's breakdown below - unlike the
// *SortLabel helpers above (empty string so an unset value sorts first), these need an actual
// user-facing label for "no X assigned" ("Bez sekcji"/"Brak broni"/"Brak statusu").
function sectionLabelFor(sectionId) {
  if (sectionId === null) return 'Bez sekcji';
  return sectionLabelById.get(sectionId) ?? sectionId;
}
function weaponLabelFor(weaponId) {
  if (weaponId === null) return 'Brak broni';
  return weaponLabelById.get(weaponId) ?? weaponId;
}
function categoryLabelFor(categoryId) {
  if (categoryId === null) return 'Brak statusu';
  return categoryLabelById.get(categoryId) ?? categoryId;
}

// Short item names (not the "-townik"/"-nik" person-role labels weaponLabelFor returns) - always
// used for weaponGroupLabel below, single weapon or not: "tarcza" rather than "Tarczownik", etc.
const WEAPON_ITEM_NAMES = {
  tarczownik: 'tarcza',
  wlocznik: 'włócznia',
  dunczyk: 'topór',
};
// Fixed display order for a multi-weapon label, independent of weaponIds' own array order - same
// order weaponGroupIconFile sorts by, so the same combination always prints the same way.
const WEAPON_DISPLAY_ORDER = ['tarczownik', 'wlocznik', 'dunczyk'];

// renderSummary's "Wg broni" groups by a member's *full* weaponIds set, not just the first one
// (unlike weaponSortLabel's roster grouping) - someone able to use two weapons is a genuinely
// distinct headcount from someone who can only use one, not a duplicate tallied under each. A
// member is always labelled by their short item name(s) ("tarcza", or "tarcza / włócznia" for two),
// never the "-townik"/"-nik" person-role name or a compound like "Dwie bronie". Nobody is labelled
// "Brak broni" here - a member with no weapon at all is "Niewalczące" (non-combatant), not
// "missing" one.
function weaponGroupKey(weaponIds) {
  return [...weaponIds].sort().join('+');
}
function weaponGroupLabel(weaponIds) {
  if (weaponIds.length === 0) return 'Niewalczące';
  return [...weaponIds]
    .sort((a, b) => WEAPON_DISPLAY_ORDER.indexOf(a) - WEAPON_DISPLAY_ORDER.indexOf(b))
    .map((id) => WEAPON_ITEM_NAMES[id] ?? weaponLabelFor(id))
    .join(' / ');
}

// EMPTY (KRKG-0052) mirrors czlonkowie.js's dense-table convention - flat rows sorted by the
// clicked header (Sekcja/Nazwa/Status/Broń, tie-broken alphabetically by name), grouped visually
// only by the left accent bar (this member's own sectionId), no more per-group <h3> headings - the
// whole roster is one .czl-table now, same shape as Spis Ludności's.
const EMPTY = '—';

// Click-to-sort wiring (shared/sortable-table.js) - see its own comment. onChange re-renders with
// whatever roster/signups this page fetched last (loadAll() keeps them in cachedRoster/
// cachedSignups precisely so a sort click doesn't need a fresh request).
const rosterSortState = initSortableTable(document.getElementById('roster-table'), {
  defaultKey: 'section',
  onChange: () => renderRoster(cachedRoster, cachedSignups),
});

// KRKG-0087: the roster endpoint's row shape for a freshly created person (see
// handleListaWyjazdowaGetRoster), so a quick-added person renders without a full reload. duesStatus
// mirrors effectiveDuesStatus's default for a person with no record: an Emeryt owes nothing,
// everyone else starts unpaid.
function rosterEntryFromPerson(person) {
  const fullName = [person.firstName, person.lastName].filter((part) => (part ?? '').trim()).join(' ') || null;
  return {
    personId: person.personId,
    accountless: true,
    ownerPersonId: person.ownerPersonId ?? null,
    email: null,
    fullName,
    nickname: person.ksywka || null,
    sectionId: person.sectionId ?? null,
    categoryId: person.categoryId ?? null,
    weaponIds: person.weaponIds ?? [],
    equipment: [],
    wpisowePaid: false,
    duesStatus: person.categoryId === EMERYT_CATEGORY_ID ? 'not_applicable' : 'unpaid',
  };
}

// The inline panel under one account row (design.md section A): an existing person attached to
// that member but not yet on this trip, or a brand-new one (ksywka + category, section inherited
// server-side from the owner). Fixed control ids are safe because only one panel is open at a
// time - see openAddPanelOwnerPersonId.
function renderAddPanel(member) {
  const ownerPersonId = member.personId.toLowerCase();
  // Only people currently attending are excluded - someone already marked "nie jadę" (a signup
  // exists with attending:false) must stay selectable so they can be added back, and quick-add is
  // idempotent on (eventId, personId) anyway.
  const attached = cachedRoster
    .filter((person) => person.accountless
      && (person.ownerPersonId ?? '').toLowerCase() === ownerPersonId
      && !cachedSignups.some((signup) => signup.memberEmail === person.personId && signup.attending))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), 'pl'));
  const hasAttached = attached.length > 0;
  const existingOptions = attached
    .map((person) => `<option value="${escapeAttr(person.personId)}">${escapeHtml(displayName(person))}</option>`)
    .join('');
  const categorySelectOptions = categoryOptions
    .map((category) => `<option value="${escapeAttr(category.id)}">${escapeHtml(category.label)}</option>`)
    .join('');
  return `
    <tr class="lw-inline-form">
      <td colspan="5">
        <div class="lw-inline-form-inner">
          <p class="lw-inline-title">Osoby towarzyszące: ${escapeHtml(displayName(member))}</p>
          <div class="lw-inline-row">
            <label class="lw-inline-label" for="lw-inline-existing-select">istniejąca:</label>
            <select id="lw-inline-existing-select" class="lw-inline-existing-select" ${hasAttached ? '' : 'disabled'}>
              <option value="">${hasAttached ? '— wybierz osobę —' : '— brak dostępnych osób —'}</option>
              ${existingOptions}
            </select>
            <button type="button" class="lw-inline-add-existing" ${hasAttached ? '' : 'disabled'}>Dodaj</button>
          </div>
          <div class="lw-inline-sep"></div>
          <div class="lw-inline-row">
            <label class="lw-inline-label" for="lw-inline-new-name">lub nowa:</label>
            <input type="text" id="lw-inline-new-name" class="lw-inline-new-name" placeholder="Ksywka" />
            <select id="lw-inline-new-category" class="lw-inline-new-category" aria-label="Kategoria nowej osoby">${categorySelectOptions}</select>
            <button type="button" class="lw-inline-add-new">Dodaj</button>
            <button type="button" class="lw-inline-cancel">Anuluj</button>
          </div>
        </div>
      </td>
    </tr>`;
}

// A confirmed quick-add's response is applied locally (same pattern as the add-event flow): an
// already-attached person is already on the roster, so only their signup is new; a freshly created
// person is appended as a roster row. Closing the panel here also removes the inline form on the
// re-render below.
function applyQuickAdd(result) {
  const person = result?.person;
  if (person?.personId && !cachedRoster.some((m) => m.personId === person.personId)) {
    cachedRoster.push(rosterEntryFromPerson(person));
  }
  const signup = result?.signup;
  if (signup) {
    const existing = cachedSignups.find((s) => s.memberEmail === signup.memberEmail);
    if (existing) Object.assign(existing, signup);
    else cachedSignups.push(signup);
  }
  openAddPanelOwnerPersonId = null;
  renderSummary(cachedRoster, cachedSignups);
  renderRoster(cachedRoster, cachedSignups);
}

function renderRoster(roster, signups) {
  const signupByPersonId = new Map(signups.map((s) => [s.memberEmail, s]));
  const visible = roster.filter((m) => {
    const attending = signupByPersonId.get(m.personId)?.attending ?? false;
    if (attending || m.personId === viewerPersonId) return showSignedUpAndMe;
    return showNotSignedUp;
  });

  const tbody = document.getElementById('roster-content');
  if (visible.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="czl-empty">Brak osób do wyświetlenia.</td></tr>';
    return;
  }

  const sortValue = (member) => {
    switch (rosterSortState.key) {
      case 'weapon': return weaponSortLabel(member);
      case 'name': return displayName(member);
      case 'status': return signupByPersonId.get(member.personId)?.attending ?? false;
      case 'statusChangedAt': return signupByPersonId.get(member.personId)?.statusChangedAt ?? '';
      default: return sectionSortLabel(member);
    }
  };
  const sorted = [...visible].sort((a, b) => {
    const cmp = rosterSortState.key === 'statusChangedAt'
      ? compareDateValues(sortValue(a), sortValue(b), rosterSortState.dir)
      : compareValues(sortValue(a), sortValue(b), rosterSortState.dir);
    if (cmp !== 0) return cmp;
    // Tie-break alphabetically by name, always ascending regardless of the primary column's own
    // direction - a stable, predictable order for ties rather than one that flips with every
    // direction toggle on an unrelated column.
    return compareValues(displayName(a), displayName(b), 'asc');
  });

  tbody.innerHTML = sorted
    .map((member) => {
      const signup = signupByPersonId.get(member.personId);
      const attending = signup?.attending ?? false;
      const personIdAttr = escapeAttr(member.personId);
      const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
      const weaponHtml = member.weaponIds.length
        ? weaponIconsOnlyHtml(member.weaponIds, weaponGroupLabel(member.weaponIds))
        : '';
      // KRKG-0074: the name cell splits into two rows - the name pill + person icon on top, and
      // (only while something is still owed club-wide) a second row of tiny red badges underneath:
      // the one-time Wpisowe (money bag + "wpisowe") first, then the current year's składka roczna
      // (money bag + "roczna") next to it. member.duesStatus comes from the roster endpoint, which
      // resolves the emeryt default server-side; not_applicable owes nothing, and a fully settled
      // member gets no second row at all.
      const duesBadgesHtml = member.duesStatus === 'unpaid' || !member.wpisowePaid
        ? `<span class="lw-dues-badges">${!member.wpisowePaid ? '<span class="lw-dues-badge lw-dues-badge--wpisowe" title="Wpisowe nieopłacone">💰<span>wpisowe</span></span>' : ''}${member.duesStatus === 'unpaid' ? '<span class="lw-dues-badge lw-dues-badge--roczna" title="Składka roczna nieopłacona">💰<span>roczna</span></span>' : ''}</span>`
        : '';
      // KRKG-0087: one shared pill renderer, with the "osoba bez konta" marker for an accountless
      // person. A member's name opens the shared profile drawer by e-mail; a person has no e-mail,
      // so their pill opens the same drawer through the person-keyed endpoint (data-person-id).
      const namePill = personPillHtml({ name: displayName(member), categoryId: member.categoryId, categoryLabel, accountless: member.accountless === true });
      const nameCellHtml = member.accountless
        ? `<button type="button" class="profile-trigger" data-profile-trigger data-person-id="${personIdAttr}">
          ${namePill}
        </button>`
        : `<button type="button" class="profile-trigger" data-profile-trigger data-email="${personIdAttr}">
          ${namePill}
        </button>
        <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${personIdAttr}" aria-label="Pokaż profil" title="Pokaż profil">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        </button>`;
      // KRKG-0087: a person without an account cannot own a companion, so the "+" is only ever on
      // an account row - the viewer's own row for everyone, any account row for staff.
      const canAddCompanion = !member.accountless && (canManagePeople || member.personId === viewerPersonId);
      const addCompanionHtml = canAddCompanion
        ? `<button type="button" class="lw-add-companion" data-owner-person-id="${personIdAttr}" aria-expanded="${member.personId === openAddPanelOwnerPersonId}" aria-label="Dodaj osobę towarzyszącą" title="Dodaj osobę towarzyszącą"><span class="lw-add-companion-plus" aria-hidden="true">+</span><svg class="lw-add-companion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5.5" r="2.6"/><path d="M12 8.5v6.5"/><path d="M8.2 11h7.6"/><path d="M9.2 22l2.8-7 2.8 7"/></svg><span class="lw-add-companion-label">osoba towarzysząca</span></button>`
        : '';
      return `
    <tr data-person-id="${personIdAttr}" data-section="${escapeAttr(member.sectionId ?? '')}">
      <td class="czl-section-cell" title="${escapeAttr(sectionSortLabel(member) || 'Brak sekcji')}">${member.sectionId ? escapeHtml(sectionAbbr(member.sectionId)) : EMPTY}</td>
      <td class="lw-roster-name-cell">
        ${nameCellHtml}
        ${addCompanionHtml}
        ${duesBadgesHtml}
      </td>
      <td>
        <button type="button" class="lw-attend-toggle" data-person-id="${personIdAttr}" data-attending="${attending}" aria-pressed="${attending}">
          <span class="lw-attend-toggle-track" aria-hidden="true"></span>
          ${attending ? 'Jadę' : 'Nie jadę'}
        </button>
        ${attending && normalizeSkladkaFee(cachedEvent?.skladkaFee) ? renderSkladkaIcon(personIdAttr, signup?.skladkaPaid ?? false) : ''}
      </td>
      <td class="${member.weaponIds.length ? '' : 'czl-empty'}">${member.weaponIds.length ? weaponHtml : EMPTY}</td>
      <td class="lw-status-changed-cell">${escapeHtml(formatStatusChangedAt(signup?.statusChangedAt))}</td>
    </tr>${canAddCompanion && member.personId === openAddPanelOwnerPersonId ? renderAddPanel(member) : ''}`;
    })
    .join('');
}

// A plain, uneditable coin for a member who can't manage składki - reading the row shouldn't
// suggest a button that would just 403; only canManageSkladki gets the clickable <button> below.
function renderSkladkaIcon(personIdAttr, paid) {
  const label = paid ? 'Składka opłacona' : 'Składka nieopłacona';
  if (!canManageSkladki) {
    return `<span class="lw-skladka-icon" data-paid="${paid}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">💰</span>`;
  }
  return `<button type="button" class="lw-skladka-icon" data-person-id="${personIdAttr}" data-paid="${paid}" title="${escapeAttr(label)} — kliknij, aby zmienić" aria-label="${escapeAttr(label)}">💰</button>`;
}

// The quick toggle has no equipment/companion picker of its own (dropped from this row - see
// lista-wyjazdowa.js's own attend toggle, which never had one either), so it round-trips whatever
// the existing signup already stored, filtered against the member's *current* profile the same
// way lista-wyjazdowa.js's stillValidIds does: deleting an equipment/companion row on /profil/
// drops its id entirely, and resubmitting a now-orphaned id verbatim would be rejected outright by
// the server's referential check.
function stillValidIds(ids, items) {
  const valid = new Set((items ?? []).map((item) => item.id));
  return (ids ?? []).filter((id) => valid.has(id));
}

async function toggleAttending(personId, nextAttending, control) {
  clearError();
  const member = cachedRoster.find((m) => m.personId === personId);
  const existing = cachedSignups.find((s) => s.memberEmail === personId);
  try {
    await confirmedEventMutation(control, () => apiFetch(
      `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}&personId=${encodeURIComponent(personId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attending: nextAttending,
          equipmentIds: stillValidIds(existing?.equipmentIds, member?.equipment),
        }),
      },
      showReauth,
      hideReauth,
    ), (result) => {
      const savedSignup = result.signup;
      const signup = cachedSignups.find(item => item.memberEmail === personId);
      if (signup) Object.assign(signup, savedSignup);
      else cachedSignups.push(savedSignup);
      renderSummary(cachedRoster, cachedSignups);
      renderRoster(cachedRoster, cachedSignups);
    }, document.getElementById('roster-panel'));
  } catch (err) {
    showError(`Nie udało się zapisać zgłoszenia: ${err.message}`);
  }
}

// KRKG-0087: adding a companion from the roster (design.md section A). Both paths POST
// /lista-wyjazdowa/signups/quick-add and apply the confirmed response locally; a failed call
// changes nothing (the panel stays open, the row is untouched) and reports via showError.
async function quickAddCompanion(body, control) {
  clearError();
  try {
    await confirmedEventMutation(control, () => apiFetch(
      '/lista-wyjazdowa/signups/quick-add',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      showReauth,
      hideReauth,
    ), (result) => applyQuickAdd(result), document.getElementById('roster-panel'));
  } catch (err) {
    showError(`Nie udało się dodać osoby: ${err.message}`);
  }
}

async function quickAddExisting(ownerPersonId, personId, control) {
  await quickAddCompanion({ eventId, ownerPersonId, mode: 'existing', personId }, control);
}

async function quickAddNew(ownerPersonId, ksywka, categoryId, control) {
  await quickAddCompanion({ eventId, ownerPersonId, mode: 'new', ksywka, categoryId }, control);
}

// The filter is purely local: both boxes are read straight from the DOM on every change, so the
// render always reflects exactly what the member sees ticked. No apiFetch, so a change can never
// fail or produce a network error banner.
function applyRosterFilter() {
  showNotSignedUp = document.getElementById('roster-filter-niezgloszeni').checked;
  showSignedUpAndMe = document.getElementById('roster-filter-zgloszeni').checked;
  renderRoster(cachedRoster, cachedSignups);
}

for (const id of ['roster-filter-niezgloszeni', 'roster-filter-zgloszeni']) {
  document.getElementById(id).addEventListener('change', applyRosterFilter);
}

document.getElementById('roster-content').addEventListener('click', (e) => {
  // Tapping a row highlights it gold (KRKG-0052) - touch devices have no hover state, so this is
  // the only way to see which row you're currently acting on on mobile.
  const clickedRow = e.target.closest('tr');
  if (clickedRow && !clickedRow.classList.contains('lw-inline-form')) {
    document.querySelectorAll('#roster-content tr.czl-row-active').forEach((r) => r.classList.remove('czl-row-active'));
    clickedRow.classList.add('czl-row-active');
  }

  // KRKG-0087: the inline "add companion" panel. Opening/closing re-renders the roster, which is
  // also what removes a panel after a successful add (applyQuickAdd clears openAddPanelOwnerPersonId).
  const addBtn = e.target.closest('.lw-add-companion');
  if (addBtn) {
    openAddPanelOwnerPersonId = addBtn.dataset.ownerPersonId;
    renderRoster(cachedRoster, cachedSignups);
    return;
  }
  if (e.target.closest('.lw-inline-cancel')) {
    openAddPanelOwnerPersonId = null;
    renderRoster(cachedRoster, cachedSignups);
    return;
  }
  const addExistingBtn = e.target.closest('.lw-inline-add-existing');
  if (addExistingBtn) {
    const personId = document.getElementById('lw-inline-existing-select')?.value;
    if (!personId) return;
    addExistingBtn.disabled = true;
    return quickAddExisting(openAddPanelOwnerPersonId, personId, addExistingBtn).finally(() => { addExistingBtn.disabled = false; });
  }
  const addNewBtn = e.target.closest('.lw-inline-add-new');
  if (addNewBtn) {
    const ksywka = document.getElementById('lw-inline-new-name')?.value.trim() ?? '';
    const categoryId = document.getElementById('lw-inline-new-category')?.value ?? '';
    if (!ksywka || !categoryId) {
      showError('Podaj ksywkę i kategorię nowej osoby.');
      return;
    }
    addNewBtn.disabled = true;
    return quickAddNew(openAddPanelOwnerPersonId, ksywka, categoryId, addNewBtn).finally(() => { addNewBtn.disabled = false; });
  }

  const attendBtn = e.target.closest('.lw-attend-toggle');
  if (attendBtn) {
    const nextAttending = attendBtn.dataset.attending !== 'true';
    attendBtn.disabled = true;
    toggleAttending(attendBtn.dataset.personId, nextAttending, attendBtn).finally(() => { attendBtn.disabled = false; });
    return;
  }
  const skladkaBtn = e.target.closest('.lw-skladka-icon');
  if (skladkaBtn && skladkaBtn.dataset.personId) {
    skladkaBtn.disabled = true;
    toggleSkladkaPaid(skladkaBtn.dataset.personId, skladkaBtn.dataset.paid !== 'true', skladkaBtn).finally(() => { skladkaBtn.disabled = false; });
  }
});

async function loadAll() {
  const [{ events }, { roster }, { signups }, { canManageSkladki: roleValue, canManagePeople: peopleValue }, lookupLists] = await Promise.all([
    apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/roster?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
  ]);
  canManageSkladki = roleValue;
  canManagePeople = peopleValue === true;
  sectionLabelById = new Map((lookupLists.sections ?? []).map((s) => [s.id, s.label]));
  categoryLabelById = new Map((lookupLists.categories ?? []).map((c) => [c.id, c.label]));
  weaponLabelById = new Map((lookupLists.weapons ?? []).map((w) => [w.id, w.label]));
  categoryOptions = lookupLists.categories ?? [];
  openAddPanelOwnerPersonId = null;
  const event = events.find((e) => e.id === eventId);
  if (!event) {
    document.getElementById('event-title').textContent = 'Nie znaleziono wyjazdu.';
    return;
  }
  cachedEvent = event;
  document.getElementById('event-title').textContent = event.name;
  document.getElementById('event-meta').textContent = `${formatDate(event.startDate)}${event.status === 'cancelled' ? ' — odwołany' : ''}`;
  document.getElementById('cancel-event-btn').hidden = event.status === 'cancelled';
  document.getElementById('restore-event-btn').hidden = event.status !== 'cancelled';
  // Historia deep links (KRKG-0050 batch 5/6, event-wide in KRKG-0086). The top clock opens the
  // whole trip history via the `eventId` selector - event metadata, the event fee, every member's
  // signup and per-member skladka payment all carry that eventId. Privileged viewers (admin/
  // accountant, i.e. canManageSkladki) go to /admin/audyt/ so the role-restricted dues rows are
  // visible too; a plain member stays on the member-zone /audyt/, which shows events + signups
  // without amounts. The fee clock stays a narrower view of just the eventFee resource. Never an
  // inline expansion/modal, always this same shared page.
  const auditBase = canManageSkladki ? '/admin/audyt/' : '/audyt/';
  document.getElementById('event-history-link').href = `${auditBase}?eventId=${encodeURIComponent(eventId)}`;
  const skladkaFeeHistoryLink = document.getElementById('skladka-fee-history-link');
  skladkaFeeHistoryLink.href = `/admin/audyt/?resourceKey=${encodeURIComponent(`eventFee:${eventId}`)}`;
  skladkaFeeHistoryLink.hidden = !canManageSkladki;
  renderSkladkaFee(event);

  cachedRoster = roster;
  cachedSignups = signups;
  renderSummary(roster, signups);
  renderRoster(roster, signups);
}

async function setEventStatus(status, failureMessage, control) {
  clearError();
  try {
    await confirmedEventMutation(control, () => apiFetch(
      `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) },
      showReauth,
      hideReauth,
    ), () => {
      const meta = document.getElementById('event-meta');
      meta.textContent = meta.textContent.replace(/ — odwołany$/, '') + (status === 'cancelled' ? ' — odwołany' : '');
      document.getElementById('cancel-event-btn').hidden = status === 'cancelled';
      document.getElementById('restore-event-btn').hidden = status !== 'cancelled';
    }, document.getElementById('event-meta'));
  } catch (err) {
    showError(`${failureMessage}: ${err.message}`);
  }
}

document.getElementById('cancel-event-btn').addEventListener('click', () => {
  if (!window.confirm('Czy na pewno odwołać ten wyjazd?')) return;
  setEventStatus('cancelled', 'Nie udało się odwołać wyjazdu', document.getElementById('cancel-event-btn'));
});

document.getElementById('restore-event-btn').addEventListener('click', () => {
  setEventStatus('active', 'Nie udało się przywrócić wyjazdu', document.getElementById('restore-event-btn'));
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  // auth.js routes only a failed whoami check to onForbidden, so a failure inside this body is
  // ours to report and must not be shown as "Brak uprawnień" (see initGoogleSignIn's comment).
  // showOnly(null) first because #lw-error lives inside #main-content, which is hidden until then.
  onSignedIn: async (identity) => {
    try {
      // The viewer's own personId is their lowercased e-mail (a member's canonical key).
      viewerPersonId = identity.email?.toLowerCase() ?? null;
      await loadAll();
      showOnly(null);
    } catch (err) {
      showOnly(null);
      showError(`Nie udało się wczytać wyjazdu: ${err.message}`);
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
