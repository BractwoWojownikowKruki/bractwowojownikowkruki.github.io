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

function showReauth() {} // no reauth banner on this page yet - matches lista-wyjazdowa.js's placeholder scope
function hideReauth() {}

const panels = {
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
  document.getElementById('main-content').hidden = panel !== null;
}

showOnly(panels.signedOut);

const eventId = new URLSearchParams(window.location.search).get('eventId');

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
      if (item) equipmentBearers.push(`${escapeHtml(item.name)} — ${escapeHtml(member.fullName)}`);
    }
    for (const compId of s.companionIds) {
      const companion = member.companions.find((c) => c.id === compId);
      if (companion) companionBearers.push(`${escapeHtml(companion.name)} (z: ${escapeHtml(member.fullName)})`);
    }
  }

  const sectionLines = Array.from(bySection.entries())
    .map(([sectionId, count]) => `<li>${escapeHtml(sectionId)}: ${count}</li>`)
    .join('');

  document.getElementById('summary-content').innerHTML = `
    <p>Łącznie: ${attending.length} os.</p>
    <ul>${sectionLines}</ul>
    <h3>Sprzęt</h3>
    <ul>${equipmentBearers.map((l) => `<li>${l}</li>`).join('') || '<li>brak</li>'}</ul>
    <h3>Osoby towarzyszące</h3>
    <ul>${companionBearers.map((l) => `<li>${l}</li>`).join('') || '<li>brak</li>'}</ul>
  `;
}

function renderRoster(roster, signups) {
  const signupByEmail = new Map(signups.map((s) => [s.memberEmail, s]));
  const bySection = new Map();
  for (const member of roster) {
    if (!bySection.has(member.sectionId)) bySection.set(member.sectionId, []);
    bySection.get(member.sectionId).push(member);
  }

  const container = document.getElementById('roster-content');
  container.innerHTML = '';
  for (const [sectionId, members] of bySection.entries()) {
    const sectionEl = document.createElement('div');
    sectionEl.innerHTML = `<h3>${escapeHtml(sectionId)}</h3>`;
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
          ${escapeHtml(member.fullName)} (${escapeHtml(member.categoryId ?? '—')}, ${member.weaponIds.map(escapeHtml).join(', ') || '—'})
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
}

document.getElementById('roster-content').addEventListener('change', (e) => {
  if (!e.target.classList.contains('lw-attend-checkbox')) return;
  const email = e.target.dataset.email;
  const picker = document.querySelector(`.lw-picker[data-email="${CSS.escape(email)}"]`);
  picker.hidden = !e.target.checked;
  if (!e.target.checked) saveSignupFor(email);
});

document.getElementById('roster-content').addEventListener('click', (e) => {
  const btn = e.target.closest('.lw-save-signup');
  if (btn) saveSignupFor(btn.dataset.email);
});

async function renderAuditLog() {
  const { entries } = await apiFetch(`/lista-wyjazdowa/signups/audit-log?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth);
  document.getElementById('audit-log-content').innerHTML = entries
    .slice()
    .reverse()
    .map((e) => `<li>${escapeHtml(e.changedAt)} — ${escapeHtml(e.changedBy)} → ${escapeHtml(e.targetMemberEmail)}: ${escapeHtml(e.changeSummary)}</li>`)
    .join('');
}

async function loadAll() {
  const [{ events }, { roster }, { signups }] = await Promise.all([
    apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth),
    apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }, showReauth, hideReauth),
    apiFetch(`/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth),
  ]);
  const event = events.find((e) => e.id === eventId);
  if (!event) {
    document.getElementById('event-title').textContent = 'Nie znaleziono wyjazdu.';
    return;
  }
  document.getElementById('event-title').textContent = event.name;
  document.getElementById('event-meta').textContent = `${event.startDate}${event.status === 'cancelled' ? ' — odwołany' : ''}`;
  document.getElementById('cancel-event-btn').hidden = event.status === 'cancelled';
  document.getElementById('restore-event-btn').hidden = event.status !== 'cancelled';

  renderSummary(roster, signups);
  renderRoster(roster, signups);
  await renderAuditLog();
}

document.getElementById('cancel-event-btn').addEventListener('click', async () => {
  await apiFetch(
    `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) },
    showReauth,
    hideReauth,
  );
  await loadAll();
});

document.getElementById('restore-event-btn').addEventListener('click', async () => {
  await apiFetch(
    `/lista-wyjazdowa/events?eventId=${encodeURIComponent(eventId)}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) },
    showReauth,
    hideReauth,
  );
  await loadAll();
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    await loadAll();
    showOnly(null);
  },
  onForbidden: () => showOnly(panels.forbidden),
});
