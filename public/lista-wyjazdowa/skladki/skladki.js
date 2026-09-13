/**
 * Składki page (Plan C, KRKG-0037): Wpisowe + Składka roczna (selectable year, KRKG-0047) for
 * every member, one line per person - a name pill (opens the shared profile drawer, same as
 * wyjazd.js's roster) plus a paid/unpaid check/cross for wpisowe, a paid/unpaid coin for składka
 * roczna, and one combined Historia button covering both (server.ts writes both to the same
 * `due:{email}` resource key). The per-year rate itself is a single free-text note set once at the
 * top of the page, not a per-member amount field. Read-only for every signed-in member; toggle/
 * edit controls and the Historia zmian panel only render when GET /lista-wyjazdowa/my-role reports
 * canManageSkladki (accountant/admin) - the server re-checks the role on every PUT/GET regardless,
 * this only controls what the UI offers (design.md §8, §9).
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

// Section/city color coding (KRKG-0051) - same helper as wyjazd.js, see its comment: the actual
// colors live in exactly one place, member-area.css's [data-section="..."] rules.
function sectionPillHtml(sectionId, label) {
  return `<span class="section-pill" data-section="${escapeAttr(sectionId ?? '')}">${escapeHtml(label)}</span>`;
}

// The classic person pill used everywhere else a member's name is listed (wyjazd.js's roster,
// Spis Ludności/Zarządzanie ludźmi) - one line per person instead of the old multi-line row.
function categoryNamePillAttrs(categoryId, label) {
  return `class="category-name-pill" data-category="${escapeAttr(categoryId ?? '')}" title="${escapeAttr(label || 'Brak typu')}"`;
}

// Same as wyjazd.js's displayName/formatDateTime - duplicated per this codebase's existing
// convention (escapeHtml/escapeAttr are already duplicated the same way across every Lista
// Wyjazdowa page) rather than introducing a shared module for two small functions.
//
// fullName falls back to email for the same reason as wyjazd.js's displayName: the roster now
// enumerates the whole club allowlist, including members with no "Mój profil" saved yet.
function displayName(member) {
  const name = member.fullName ?? member.email;
  return member.nickname ? `${name} (${member.nickname})` : name;
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

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
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

function confirmedDuesMutation(control, execute, apply) {
  return window.MutationFeedback.confirmed({
    control,
    anchor: control,
    execute,
    apply,
    viewRoot: document.getElementById('skladki-content'),
    refreshFragment: loadAndRender,
  });
}

const currentYear = new Date().getFullYear();

// Selected in the year <select> (KRKG-0047) - defaults to the current year, but the backend has
// always accepted any year 2000-2100 (see server.ts's requireYear), so this is purely a frontend
// gap being closed: someone paying składka roczna for next year (joining late) or checking a past
// year's records needs a way to pick a year other than "now".
let selectedYear = currentYear;
const YEAR_RANGE_PAST = 5;
const YEAR_RANGE_FUTURE = 1;
// The club only started tracking składki from 2026 onward - no point offering earlier years the
// backend would happily accept (server.ts's requireYear allows 2000-2100) but that never have data.
const MIN_DUES_YEAR = 2026;

function populateYearSelect() {
  const select = document.getElementById('skladki-year-select');
  const years = [];
  for (let y = Math.max(MIN_DUES_YEAR, currentYear - YEAR_RANGE_PAST); y <= currentYear + YEAR_RANGE_FUTURE; y++) years.push(y);
  select.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
  select.value = String(selectedYear);
}

document.getElementById('skladki-year-select').addEventListener('change', async (e) => {
  selectedYear = Number(e.target.value);
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

function renderTable(roster, duesByEmail) {
  const bySection = new Map();
  for (const member of roster) {
    if (!bySection.has(member.sectionId)) bySection.set(member.sectionId, []);
    bySection.get(member.sectionId).push(member);
  }

  const container = document.getElementById('skladki-content');
  container.innerHTML = '';
  for (const [sectionId, members] of bySection.entries()) {
    const sectionEl = document.createElement('div');
    sectionEl.innerHTML =
      sectionId === null ? `<h3>${escapeHtml(sectionLabel(sectionId))}</h3>` : `<h3>${sectionPillHtml(sectionId, sectionLabel(sectionId))}</h3>`;
    // Unpaid-składka-roczna members first within each section - the accountant's actual task on
    // this page is chasing down who still owes money, so that group should never be buried below
    // everyone who's already settled. Alphabetical by display name within each of the two groups.
    const sortedMembers = [...members].sort((a, b) => {
      const aPaid = duesByEmail.get(a.email)?.paid ?? false;
      const bPaid = duesByEmail.get(b.email)?.paid ?? false;
      if (aPaid !== bPaid) return aPaid ? 1 : -1;
      return displayName(a).toLocaleLowerCase('pl').localeCompare(displayName(b).toLocaleLowerCase('pl'), 'pl');
    });
    for (const member of sortedMembers) {
      const roczna = duesByEmail.get(member.email)?.paid ?? false;
      const emailAttr = escapeAttr(member.email);
      const categoryLabel = member.categoryId ? (categoryLabelById.get(member.categoryId) ?? member.categoryId) : null;
      const row = document.createElement('div');
      row.className = 'lw-skladki-row section-row-accent';
      row.dataset.section = sectionId ?? '';
      // Wpisowe is independent of "Mój profil" (setWpisowePaid upserts one with empty
      // weaponIds/equipment/companions if none exists yet, server.ts) - every member gets the same
      // icon regardless. One combined Historia deep link per member - server.ts's
      // handleListaWyjazdowaPutWpisowe/handleListaWyjazdowaPutDues both write to the same
      // `due:{memberEmail}` resource key (no :entry_fee/:{year} suffix), so this one link already
      // covers wpisowe and every year of składka roczna; the action label (visible in the audit
      // view) is what tells the two apart in that shared timeline. Point at /admin/audyt/, not the
      // member-zone /audyt/: dues.* actions carry audience 'adminOrAccountant' (ACTION_REGISTRY,
      // upload-service/src/audit.ts), which only the admin-scope viewer can see. Gated by
      // canManageSkladki like every other privileged control on this row - a plain member has no
      // page that can show them this history, so no point offering the icon.
      const dueHistoryHref = `/admin/audyt/?resourceKey=${encodeURIComponent(`due:${member.email}`)}`;
      const wpisoweLabel = member.wpisowePaid ? 'Wpisowe: opłacone' : 'Wpisowe: nieopłacone';
      const rocznaLabel = `Składka ${selectedYear}: ${roczna ? 'opłacona' : 'nieopłacona'}`;
      row.innerHTML = `
        <button type="button" class="profile-trigger" data-profile-trigger data-email="${emailAttr}">
          <span ${categoryNamePillAttrs(member.categoryId, categoryLabel)}>${escapeHtml(displayName(member))}</span>
        </button>
        <button type="button" class="profile-trigger profile-trigger--icon-inline" data-profile-trigger data-email="${emailAttr}" aria-label="Pokaż profil" title="Pokaż profil">${PERSON_ICON}</button>
        ${member.wpisowePaid ? '' : '<span class="lw-due-label">Wpisowe</span>'}
        ${paidIconHtml('wpisowe', emailAttr, member.wpisowePaid, wpisoweLabel)}
        <span class="lw-due-label">${selectedYear}</span>
        ${paidIconHtml('roczna', emailAttr, roczna, rocznaLabel)}
        ${canManageSkladki ? `<a class="audyt-history-btn" href="${escapeAttr(dueHistoryHref)}" title="Historia" aria-label="Historia składek">${HISTORY_ICON}</a>` : ''}
      `;
      sectionEl.appendChild(row);
    }
    container.appendChild(sectionEl);
  }
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
  renderTable(roster, duesByEmail);
  await renderDuesAuditLog();
}

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
      // The glyph (✓/✕) is kind-specific, unlike roczna's fixed 💰 coin - it must be repainted
      // here too, not just the background color, or a confirmed toggle leaves the old glyph
      // showing against the new color (e.g. a green ✕ right after marking something paid).
      control.textContent = nextPaid ? '✓' : '✕';
      const label = nextPaid ? 'Wpisowe: opłacone' : 'Wpisowe: nieopłacone';
      control.title = `${label} — kliknij, aby zmienić`;
      control.setAttribute('aria-label', label);
      // The "Wpisowe" caption only shows while unpaid (saves row width for the name once it's
      // settled, see renderTable) - add/remove it here too, or a confirmed toggle leaves a stale
      // caption sitting next to an icon that already reads as paid.
      const caption = control.previousElementSibling;
      const hasCaption = caption?.classList.contains('lw-due-label');
      if (nextPaid && hasCaption) {
        caption.remove();
      } else if (!nextPaid && !hasCaption) {
        const newCaption = document.createElement('span');
        newCaption.className = 'lw-due-label';
        newCaption.textContent = 'Wpisowe';
        control.before(newCaption);
      }
    });
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
  if (icon.dataset.kind === 'wpisowe') toggleWpisowe(email, nextPaid, icon);
  else toggleRoczna(email, nextPaid, icon);
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
