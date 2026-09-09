/**
 * Składki page (Plan C, KRKG-0037): Wpisowe + Składka roczna (selectable year, KRKG-0047) for
 * every member, grouped by section. Read-only for every signed-in member; toggle/kwota-edit
 * controls and the Historia zmian panel only render when GET /lista-wyjazdowa/my-role reports
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

// Section/city color coding (KRKG-0051) - same helper as wyjazd.js, see its comment: the actual
// colors live in exactly one place, style.css's [data-section="..."] rules.
function sectionPillHtml(sectionId, label) {
  return `<span class="section-pill" data-section="${escapeAttr(sectionId ?? '')}">${escapeHtml(label)}</span>`;
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

const currentYear = new Date().getFullYear();

// Selected in the year <select> (KRKG-0047) - defaults to the current year, but the backend has
// always accepted any year 2000-2100 (see server.ts's requireYear), so this is purely a frontend
// gap being closed: someone paying składka roczna for next year (joining late) or checking a past
// year's records needs a way to pick a year other than "now".
let selectedYear = currentYear;
const YEAR_RANGE_PAST = 5;
const YEAR_RANGE_FUTURE = 1;

function populateYearSelect() {
  const select = document.getElementById('skladki-year-select');
  const years = [];
  for (let y = currentYear - YEAR_RANGE_PAST; y <= currentYear + YEAR_RANGE_FUTURE; y++) years.push(y);
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
    for (const member of members) {
      const roczna = duesByEmail.get(member.email)?.paid ?? false;
      const emailAttr = escapeAttr(member.email);
      const row = document.createElement('div');
      row.className = 'lw-skladki-row section-row-accent';
      row.dataset.section = sectionId ?? '';
      // Wpisowe lives on the member's listaWyjazdowaProfile document, so a member who has not
      // filled that profile in yet has nowhere to record it: PUT /lista-wyjazdowa/wpisowe answers
      // 404 for them by design (it must not create a profile document with only the wpisowePaid
      // field). Showing them as a plain "nieopłacone" with a working-looking toggle meant every
      // click on that toggle failed with an error banner, so they get an explicit "brak profilu"
      // and no button at all - the status is reported honestly and nothing unusable is offered.
      // Składka roczna is unaffected: it is stored per member+year and needs no profile.
      // Kwota (amount) is roczna-only (KRKG-0047) - wpisowe stays a plain toggle, per the design
      // decision that wpisowe has no per-member rate to record. Free-text like skladkaFee on the
      // wyjazd page, same input+Zapisz pattern (#skladka-fee-input/-save there).
      const amount = duesByEmail.get(member.email)?.amount ?? null;
      row.innerHTML = `
        <span>${escapeHtml(displayName(member))}</span>
        <span>Wpisowe: ${member.hasProfile ? (member.wpisowePaid ? 'opłacone' : 'nieopłacone') : 'brak profilu'}</span>
        ${
          canManageSkladki && member.hasProfile
            ? `<button type="button" class="lw-wpisowe-toggle" data-email="${emailAttr}" data-paid="${member.wpisowePaid ? 'true' : 'false'}">${member.wpisowePaid ? 'Oznacz jako nieopłacone' : 'Oznacz jako opłacone'}</button>`
            : ''
        }
        <span>Składka ${selectedYear}: ${roczna ? 'opłacona' : 'nieopłacona'}</span>
        ${
          canManageSkladki
            ? `<button type="button" class="lw-roczna-toggle" data-email="${emailAttr}" data-paid="${roczna ? 'true' : 'false'}">${roczna ? 'Oznacz jako nieopłaconą' : 'Oznacz jako opłaconą'}</button>`
            : ''
        }
        ${
          canManageSkladki
            ? `<span class="lw-roczna-amount-edit">
                 Kwota:
                 <input type="text" class="lw-roczna-amount-input" data-email="${emailAttr}" value="${escapeAttr(amount ?? '')}" placeholder="np. 100 zł" />
                 <button type="button" class="lw-roczna-amount-save" data-email="${emailAttr}">Zapisz</button>
               </span>`
            : `<span>Kwota: ${amount ? escapeHtml(amount) : 'nie ustalono'}</span>`
        }
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

async function loadAndRender() {
  populateYearSelect();
  const [{ canManageSkladki: role }, { roster }, { dues }, lookupLists] = await Promise.all([
    apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/dues?year=${selectedYear}`, { method: 'GET' }, showReauth, hideReauth),
    // GET /lista-wyjazdowa/lookup-lists answers with the lists themselves ({ sections, categories,
    // weapons }), not wrapped in an envelope - see handleListaWyjazdowaLookupLists.
    apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
  ]);
  canManageSkladki = role;
  sectionLabelById = new Map((lookupLists.sections ?? []).map((s) => [s.id, s.label]));
  const duesByEmail = new Map(dues.map((d) => [d.email, d]));
  renderTable(roster, duesByEmail);
  await renderDuesAuditLog();
}

async function toggleWpisowe(email, nextPaid) {
  clearError();
  try {
    await apiFetch(
      `/lista-wyjazdowa/wpisowe?memberEmail=${encodeURIComponent(email)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    );
    await loadAndRender();
  } catch (err) {
    showError(`Nie udało się zaktualizować wpisowego: ${err.message}`);
  }
}

async function toggleRoczna(email, nextPaid) {
  clearError();
  try {
    await apiFetch(
      `/lista-wyjazdowa/dues?memberEmail=${encodeURIComponent(email)}&year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    );
    await loadAndRender();
  } catch (err) {
    showError(`Nie udało się zaktualizować składki: ${err.message}`);
  }
}

async function saveRocznaAmount(email, amount) {
  clearError();
  try {
    await apiFetch(
      `/lista-wyjazdowa/dues?memberEmail=${encodeURIComponent(email)}&year=${selectedYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amount || null }) },
      showReauth,
      hideReauth,
    );
    await loadAndRender();
  } catch (err) {
    showError(`Nie udało się zapisać kwoty składki: ${err.message}`);
  }
}

document.getElementById('skladki-content').addEventListener('click', (e) => {
  const wpisoweBtn = e.target.closest('.lw-wpisowe-toggle');
  if (wpisoweBtn) {
    toggleWpisowe(wpisoweBtn.dataset.email, wpisoweBtn.dataset.paid !== 'true');
    return;
  }
  const rocznaBtn = e.target.closest('.lw-roczna-toggle');
  if (rocznaBtn) {
    toggleRoczna(rocznaBtn.dataset.email, rocznaBtn.dataset.paid !== 'true');
    return;
  }
  const amountBtn = e.target.closest('.lw-roczna-amount-save');
  if (amountBtn) {
    const input = amountBtn.closest('.lw-roczna-amount-edit').querySelector('.lw-roczna-amount-input');
    saveRocznaAmount(amountBtn.dataset.email, input.value.trim());
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
