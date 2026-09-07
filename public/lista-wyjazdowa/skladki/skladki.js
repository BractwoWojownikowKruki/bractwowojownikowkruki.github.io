/**
 * Składki page (Plan C, KRKG-0037): Wpisowe + Składka roczna (current year) for every member,
 * grouped by section. Read-only for every signed-in member; toggle buttons only render when
 * GET /lista-wyjazdowa/my-role reports canManageSkladki (accountant/admin) - the server
 * re-checks the role on every PUT regardless, this only controls what the UI offers
 * (design.md §8, §9).
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
    sectionEl.innerHTML = `<h3>${escapeHtml(sectionLabel(sectionId))}</h3>`;
    for (const member of members) {
      const roczna = duesByEmail.get(member.email)?.paid ?? false;
      const emailAttr = escapeAttr(member.email);
      const row = document.createElement('div');
      row.className = 'lw-skladki-row';
      // Wpisowe lives on the member's listaWyjazdowaProfile document, so a member who has not
      // filled that profile in yet has nowhere to record it: PUT /lista-wyjazdowa/wpisowe answers
      // 404 for them by design (it must not create a profile document with only the wpisowePaid
      // field). Showing them as a plain "nieopłacone" with a working-looking toggle meant every
      // click on that toggle failed with an error banner, so they get an explicit "brak profilu"
      // and no button at all - the status is reported honestly and nothing unusable is offered.
      // Składka roczna is unaffected: it is stored per member+year and needs no profile.
      row.innerHTML = `
        <span>${escapeHtml(displayName(member))}</span>
        <span>Wpisowe: ${member.hasProfile ? (member.wpisowePaid ? 'opłacone' : 'nieopłacone') : 'brak profilu'}</span>
        ${
          canManageSkladki && member.hasProfile
            ? `<button type="button" class="lw-wpisowe-toggle" data-email="${emailAttr}" data-paid="${member.wpisowePaid ? 'true' : 'false'}">${member.wpisowePaid ? 'Oznacz jako nieopłacone' : 'Oznacz jako opłacone'}</button>`
            : ''
        }
        <span>Składka ${currentYear}: ${roczna ? 'opłacona' : 'nieopłacona'}</span>
        ${
          canManageSkladki
            ? `<button type="button" class="lw-roczna-toggle" data-email="${emailAttr}" data-paid="${roczna ? 'true' : 'false'}">${roczna ? 'Oznacz jako nieopłaconą' : 'Oznacz jako opłaconą'}</button>`
            : ''
        }
      `;
      sectionEl.appendChild(row);
    }
    container.appendChild(sectionEl);
  }
}

async function renderDuesAuditLog() {
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
  const [{ canManageSkladki: role }, { roster }, { dues }, lookupLists] = await Promise.all([
    apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/dues?year=${currentYear}`, { method: 'GET' }, showReauth, hideReauth),
    // GET /lista-wyjazdowa/lookup-lists answers with the lists themselves ({ sections, categories,
    // weapons }), not wrapped in an envelope - see handleListaWyjazdowaLookupLists.
    apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }, showReauth, hideReauth),
  ]);
  canManageSkladki = role;
  sectionLabelById = new Map((lookupLists.sections ?? []).map((s) => [s.id, s.label]));
  document.getElementById('skladki-year-label').textContent = `Rok: ${currentYear}`;
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
      `/lista-wyjazdowa/dues?memberEmail=${encodeURIComponent(email)}&year=${currentYear}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    );
    await loadAndRender();
  } catch (err) {
    showError(`Nie udało się zaktualizować składki: ${err.message}`);
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
