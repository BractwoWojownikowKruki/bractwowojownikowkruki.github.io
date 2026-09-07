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

// A member's Ksywa (nickname) matters more here than in most places on the site: this roster is
// exactly the context the sheet's "Nazwisko, Imię" + Ksywa columns existed for - people who know
// each other by nickname need to find their own row and each other's.
//
// fullName falls back to email because the roster now enumerates the whole club allowlist (see
// server.ts's handleListaWyjazdowaGetRoster), not just members who filled in "Mój profil" - such
// a member has no fullName/nickname to show yet, but still needs a findable row so their
// attendance can be set.
function displayName(member) {
  const name = member.fullName ?? member.email;
  return member.nickname ? `${name} (${member.nickname})` : name;
}

// startDate is a bare calendar date ("2027-05-01"), not a timestamp - plain string slicing avoids
// the UTC-vs-local skew a Date object would risk (see lista-wyjazdowa.js's todayIsoDate fix).
function formatDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

// changedAt IS a real instant (Date.toISOString()), so converting it through Date and reading
// local getters back out is the right move here, unlike formatDate() above - the audit log should
// show *when this happened in the viewer's own timezone*, not the stored UTC instant verbatim.
function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
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

// Fetched once per loadAll() alongside events/roster/signups (Task 2's GET /my-role). Read by
// renderSkladkaFee() and renderRoster() to decide whether to show edit/toggle controls or
// read-only text - the server re-checks the role on every mutation regardless, this only
// controls what the UI offers.
let canManageSkladki = false;

// event.skladkaFee is a free-text field (e.g. "50 zł / 25 zł dzieci"); textContent is used below
// so no HTML-escaping is needed for the display span, same reasoning as event-title/event-meta
// above it in loadAll().
function renderSkladkaFee(event) {
  const display = document.getElementById('skladka-fee-display');
  const editPanel = document.getElementById('skladka-fee-edit');
  display.textContent = event.skladkaFee ? `Składka: ${event.skladkaFee}` : 'Składka: nie ustalono';
  editPanel.hidden = !canManageSkladki;
  if (canManageSkladki) document.getElementById('skladka-fee-input').value = event.skladkaFee ?? '';
}

async function saveSkladkaFee() {
  clearError();
  try {
    const value = document.getElementById('skladka-fee-input').value.trim();
    await apiFetch(
      `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skladkaFee: value || null }) },
      showReauth,
      hideReauth,
    );
    await loadAll();
  } catch (err) {
    showError(`Nie udało się zapisać składki: ${err.message}`);
  }
}

document.getElementById('skladka-fee-save').addEventListener('click', saveSkladkaFee);

async function toggleSkladkaPaid(email, nextPaid) {
  clearError();
  try {
    await apiFetch(
      `/lista-wyjazdowa/signups/skladka?eventId=${encodeURIComponent(eventId)}&memberEmail=${encodeURIComponent(email)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: nextPaid }) },
      showReauth,
      hideReauth,
    );
    await loadAll();
  } catch (err) {
    showError(`Nie udało się zaktualizować składki: ${err.message}`);
  }
}

// Both #summary-content (counts, near the top) and #equipment-companions-content (named lists,
// near the bottom, per feedback on section order) are derived from the same attending/roster
// join, so this computes both in one pass and writes each half to its own container.
function renderSummary(roster, signups) {
  const attending = signups.filter((s) => s.attending);
  const rosterByEmail = new Map(roster.map((r) => [r.email, r]));

  const bySection = new Map();
  const equipmentBearers = [];
  const companionBearers = [];
  for (const s of attending) {
    const member = rosterByEmail.get(s.memberEmail);
    if (!member) continue;
    bySection.set(member.sectionId, (bySection.get(member.sectionId) ?? 0) + 1);
    for (const eqId of s.equipmentIds) {
      const item = member.equipment.find((e) => e.id === eqId);
      if (item) equipmentBearers.push(`${escapeHtml(item.name)} — ${escapeHtml(displayName(member))}`);
    }
    for (const compId of s.companionIds) {
      const companion = member.companions.find((c) => c.id === compId);
      if (companion) companionBearers.push(`${escapeHtml(companion.name)} (z: ${escapeHtml(displayName(member))})`);
    }
  }

  const sectionLines = Array.from(bySection.entries())
    .map(([sectionId, count]) => `<li>${escapeHtml(sectionId ?? 'Bez sekcji')}: ${count}</li>`)
    .join('');

  document.getElementById('summary-content').innerHTML = `
    <p>Łącznie: ${attending.length} os.</p>
    <ul>${sectionLines}</ul>
  `;

  document.getElementById('equipment-companions-content').innerHTML = `
    <h3>Sprzęt</h3>
    <ul>${equipmentBearers.map((l) => `<li>${l}</li>`).join('') || '<li>brak</li>'}</ul>
    <h3>Osoby towarzyszące</h3>
    <ul>${companionBearers.map((l) => `<li>${l}</li>`).join('') || '<li>brak</li>'}</ul>
  `;
}

// rosterSortBy picks the grouping axis for #roster-content ('section' groups by member.sectionId,
// the pre-existing behaviour; 'weapon' groups by the member's first weaponIds entry - a member can
// carry several weapons, but the roster only ever has one row per member, so grouping uses just
// the first one rather than duplicating the row into every weapon's group). rosterFilter picks
// which members are shown at all: 'attending' (the default) hides every member who hasn't signed
// up for this event yet, keeping the list short; 'all' reveals the full club allowlist so someone
// who hasn't been asked yet can be ticked as attending for the first time. Both are re-applied
// locally from the roster/signups already fetched by loadAll() - no network round-trip needed.
let rosterSortBy = 'section';
let rosterFilter = 'attending';
let cachedRoster = [];
let cachedSignups = [];

function rosterGroupKey(member) {
  return rosterSortBy === 'weapon' ? (member.weaponIds[0] ?? null) : member.sectionId;
}

function rosterGroupLabel(key) {
  if (key !== null) return key;
  return rosterSortBy === 'weapon' ? 'Bez broni' : 'Bez sekcji';
}

function renderRoster(roster, signups) {
  const signupByEmail = new Map(signups.map((s) => [s.memberEmail, s]));
  const visible = rosterFilter === 'all' ? roster : roster.filter((m) => signupByEmail.get(m.email)?.attending);

  const container = document.getElementById('roster-content');
  container.innerHTML = '';
  if (visible.length === 0) {
    container.innerHTML = '<p>Brak osób do wyświetlenia.</p>';
    return;
  }

  const groups = new Map();
  for (const member of visible) {
    const key = rosterGroupKey(member);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(member);
  }

  for (const [key, members] of groups.entries()) {
    const sectionEl = document.createElement('div');
    sectionEl.innerHTML = `<h3>${escapeHtml(rosterGroupLabel(key))}</h3>`;
    const sorted = [...members].sort((a, b) => {
      const aAttending = signupByEmail.get(a.email)?.attending ? 0 : 1;
      const bAttending = signupByEmail.get(b.email)?.attending ? 0 : 1;
      return aAttending - bAttending;
    });
    for (const member of sorted) {
      const signup = signupByEmail.get(member.email);
      const emailAttr = escapeAttr(member.email);
      const row = document.createElement('div');
      row.className = 'lw-roster-row';
      row.innerHTML = `
        <label>
          <input type="checkbox" class="lw-attend-checkbox" data-email="${emailAttr}" ${signup?.attending ? 'checked' : ''} />
          ${escapeHtml(displayName(member))} (${escapeHtml(member.categoryId ?? '—')}, ${member.weaponIds.map(escapeHtml).join(', ') || '—'})
        </label>
        <div class="lw-picker" data-email="${emailAttr}" ${signup?.attending ? '' : 'hidden'}>
          ${member.equipment
            .map(
              (eq) =>
                `<label><input type="checkbox" class="lw-eq-checkbox" value="${escapeAttr(eq.id)}" ${signup?.equipmentIds.includes(eq.id) ? 'checked' : ''} /> ${escapeHtml(eq.name)}</label>`,
            )
            .join('')}
          ${member.companions
            .map(
              (c) =>
                `<label><input type="checkbox" class="lw-comp-checkbox" value="${escapeAttr(c.id)}" ${signup?.companionIds.includes(c.id) ? 'checked' : ''} /> ${escapeHtml(c.name)}</label>`,
            )
            .join('')}
          <button type="button" class="lw-save-signup" data-email="${emailAttr}">Zapisz</button>
        </div>
        <div class="lw-skladka" data-email="${emailAttr}" ${signup?.attending ? '' : 'hidden'}>
          Składka: ${signup?.skladkaPaid ? 'opłacona' : 'nieopłacona'}
          ${
            canManageSkladki
              ? `<button type="button" class="lw-skladka-toggle" data-email="${emailAttr}" data-paid="${signup?.skladkaPaid ? 'true' : 'false'}">${signup?.skladkaPaid ? 'Oznacz jako nieopłaconą' : 'Oznacz jako opłaconą'}</button>`
              : ''
          }
        </div>
      `;
      sectionEl.appendChild(row);
    }
    container.appendChild(sectionEl);
  }
}

async function saveSignupFor(email) {
  const picker = document.querySelector(`.lw-picker[data-email="${CSS.escape(email)}"]`);
  const attending = document.querySelector(`.lw-attend-checkbox[data-email="${CSS.escape(email)}"]`).checked;
  const equipmentIds = Array.from(picker.querySelectorAll('.lw-eq-checkbox:checked')).map((cb) => cb.value);
  const companionIds = Array.from(picker.querySelectorAll('.lw-comp-checkbox:checked')).map((cb) => cb.value);
  clearError();
  try {
    await apiFetch(
      `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}&memberEmail=${encodeURIComponent(email)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attending, equipmentIds, companionIds }),
      },
      showReauth,
      hideReauth,
    );
    await loadAll();
  } catch (err) {
    // The checkbox the member just clicked keeps its new state even though nothing was saved (no
    // loadAll() ran to re-render it from the server), so the message has to say the displayed
    // state is not the stored one - otherwise a silent failure reads as a successful save.
    showError(`Nie udało się zapisać zgłoszenia: ${err.message}. Odśwież stronę, aby zobaczyć zapisany stan.`);
  }
}

document.getElementById('roster-sort-select').addEventListener('change', (e) => {
  rosterSortBy = e.target.value;
  renderRoster(cachedRoster, cachedSignups);
});

document.getElementById('roster-filter-select').addEventListener('change', (e) => {
  rosterFilter = e.target.value;
  renderRoster(cachedRoster, cachedSignups);
});

document.getElementById('roster-content').addEventListener('change', (e) => {
  if (!e.target.classList.contains('lw-attend-checkbox')) return;
  const email = e.target.dataset.email;
  const picker = document.querySelector(`.lw-picker[data-email="${CSS.escape(email)}"]`);
  picker.hidden = !e.target.checked;
  const skladkaEl = document.querySelector(`.lw-skladka[data-email="${CSS.escape(email)}"]`);
  if (skladkaEl) skladkaEl.hidden = !e.target.checked;
  if (!e.target.checked) saveSignupFor(email);
});

document.getElementById('roster-content').addEventListener('click', (e) => {
  const saveBtn = e.target.closest('.lw-save-signup');
  if (saveBtn) {
    saveSignupFor(saveBtn.dataset.email);
    return;
  }
  const skladkaBtn = e.target.closest('.lw-skladka-toggle');
  if (skladkaBtn) toggleSkladkaPaid(skladkaBtn.dataset.email, skladkaBtn.dataset.paid !== 'true');
});

async function renderAuditLog() {
  const { entries } = await apiFetch(`/lista-wyjazdowa/signups/audit-log?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth);
  document.getElementById('audit-log-content').innerHTML = entries
    .slice()
    .reverse()
    .map((e) => `<li>${escapeHtml(formatDateTime(e.changedAt))} — ${escapeHtml(e.changedBy)} → ${escapeHtml(e.targetMemberEmail)}: ${escapeHtml(e.changeSummary)}</li>`)
    .join('');
}

async function loadAll() {
  const [{ events }, { roster }, { signups }, { canManageSkladki: roleValue }] = await Promise.all([
    apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/my-role', { method: 'GET' }, showReauth, hideReauth),
  ]);
  canManageSkladki = roleValue;
  const event = events.find((e) => e.id === eventId);
  if (!event) {
    document.getElementById('event-title').textContent = 'Nie znaleziono wyjazdu.';
    return;
  }
  document.getElementById('event-title').textContent = event.name;
  document.getElementById('event-meta').textContent = `${formatDate(event.startDate)}${event.status === 'cancelled' ? ' — odwołany' : ''}`;
  document.getElementById('cancel-event-btn').hidden = event.status === 'cancelled';
  document.getElementById('restore-event-btn').hidden = event.status !== 'cancelled';
  renderSkladkaFee(event);

  cachedRoster = roster;
  cachedSignups = signups;
  renderSummary(roster, signups);
  renderRoster(roster, signups);
  await renderAuditLog();
}

async function setEventStatus(status, failureMessage) {
  clearError();
  try {
    await apiFetch(
      `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) },
      showReauth,
      hideReauth,
    );
    await loadAll();
  } catch (err) {
    showError(`${failureMessage}: ${err.message}`);
  }
}

document.getElementById('cancel-event-btn').addEventListener('click', () => {
  if (!window.confirm('Czy na pewno odwołać ten wyjazd?')) return;
  setEventStatus('cancelled', 'Nie udało się odwołać wyjazdu');
});

document.getElementById('restore-event-btn').addEventListener('click', () => {
  setEventStatus('active', 'Nie udało się przywrócić wyjazdu');
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  // auth.js routes only a failed whoami check to onForbidden, so a failure inside this body is
  // ours to report and must not be shown as "Brak uprawnień" (see initGoogleSignIn's comment).
  // showOnly(null) first because #lw-error lives inside #main-content, which is hidden until then.
  onSignedIn: async () => {
    try {
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
