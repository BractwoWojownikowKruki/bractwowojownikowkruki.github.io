/**
 * Lista wyjazdowa - events list (Plan B, KRKG-0037). Replaces the "coming soon" placeholder
 * shipped in Plan A. A member without a listaWyjazdowaProfile yet is routed to /profil/ instead
 * of the list - signing up needs equipment/companion choices that come from that profile
 * (design.md §8).
 *
 * The caller's own email (needed for the PUT /lista-wyjazdowa/signups?memberEmail= query param
 * below) comes from the `identity` argument auth.js's initGoogleSignIn already passes into
 * onSignedIn - the parsed JSON body of whoamiPath (/wojownicy-upload/whoami), which always
 * includes `email` (see identityResponseBody in upload-service/src/server.ts). No extra fetch is
 * needed for it, and MemberDoc (GET /lista-wyjazdowa/member's `member`) has no email field at all
 * - that would be the wrong place to look for it.
 */

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const panels = {
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
  noProfile: document.getElementById('no-profile-panel'),
  events: document.getElementById('events-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

showOnly(panels.signedOut);

function showReauth() {} // no reauth banner on this page yet - matches the placeholder's scope; add one if apiFetch calls start failing with 401 in practice
function hideReauth() {}

let showAll = false;
let cachedEvents = [];
let viewerEmail = null;

function todayIsoDate() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function visibleEvents() {
  if (showAll) return [...cachedEvents].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return cachedEvents
    .filter((e) => e.status === 'active' && e.startDate >= todayIsoDate())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function renderEvents() {
  const container = document.getElementById('events-list');
  const events = visibleEvents();
  if (events.length === 0) {
    container.innerHTML = '<p>Brak wyjazdów do wyświetlenia.</p>';
    return;
  }
  container.innerHTML = events
    .map((e) => {
      const statusLabel = e.status === 'cancelled' ? ' (odwołany)' : '';
      return `
        <div class="lw-event-row">
          <a href="wyjazd/?eventId=${encodeURIComponent(e.id)}">${escapeHtml(e.name)}${statusLabel}</a>
          <span>${escapeHtml(e.startDate)}</span>
          <span>${e.attendingCount} os.</span>
          <button type="button" class="lw-attend-toggle" data-event-id="${e.id}" data-attending="${e.viewerAttending}">
            ${e.viewerAttending ? 'Nie jadę' : 'Jadę'}
          </button>
        </div>
      `;
    })
    .join('');
}

async function loadEvents() {
  const { events } = await apiFetch('/lista-wyjazdowa/events', { method: 'GET' }, showReauth, hideReauth);
  cachedEvents = events;
  renderEvents();
}

// The quick toggle has no equipment/companion picker of its own (that's the event detail page's
// job), so it round-trips whatever the existing signup already stored - but it must filter that
// list against the member's *current* profile first. Deleting an equipment or companion row on
// /profil/ drops its id entirely, leaving any signup that referenced it holding an orphaned id;
// resubmitting it verbatim is then rejected outright by the server's referential check
// ("Wybrany sprzęt nie należy do tego członka."), which would break this button permanently for
// that member. Filtering here preserves the selections that are still real and quietly drops the
// ones that aren't, so a normal profile edit self-heals instead of jamming the toggle.
function stillValidIds(ids, items) {
  const valid = new Set((items ?? []).map((item) => item.id));
  return (ids ?? []).filter((id) => valid.has(id));
}

document.getElementById('events-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.lw-attend-toggle');
  if (!btn) return;
  const eventId = btn.dataset.eventId;
  const nextAttending = btn.dataset.attending !== 'true';
  const errorEl = document.getElementById('events-error');
  errorEl.hidden = true;
  btn.disabled = true;
  try {
    const [{ signup: mine }, { profile }] = await Promise.all([
      apiFetch(`/lista-wyjazdowa/signups/mine?eventId=${encodeURIComponent(eventId)}`, { method: 'GET' }, showReauth, hideReauth),
      apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
    ]);
    await apiFetch(
      `/lista-wyjazdowa/signups?eventId=${encodeURIComponent(eventId)}&memberEmail=${encodeURIComponent(viewerEmail)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attending: nextAttending,
          equipmentIds: stillValidIds(mine?.equipmentIds, profile?.equipment),
          companionIds: stillValidIds(mine?.companionIds, profile?.companions),
        }),
      },
      showReauth,
      hideReauth,
    );
    await loadEvents();
  } catch (err) {
    // Without this the click just silently did nothing: the button re-enabled itself and the row
    // stayed as it was, with no way for the member to tell the change hadn't been saved.
    errorEl.textContent = `Nie udało się zapisać zmiany: ${err.message}`;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('toggle-add-event').addEventListener('click', () => {
  const form = document.getElementById('add-event-form');
  form.hidden = !form.hidden;
});

document.getElementById('toggle-past-events').addEventListener('click', (e) => {
  showAll = !showAll;
  e.target.textContent = showAll ? 'Pokaż tylko nadchodzące' : 'Pokaż wszystkie (w tym odwołane i przeszłe)';
  renderEvents();
});

document.getElementById('add-event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('add-event-error');
  errorEl.hidden = true;
  try {
    const { event: created } = await apiFetch(
      '/lista-wyjazdowa/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.value, startDate: form.startDate.value }),
      },
      showReauth,
      hideReauth,
    );
    window.location.href = `wyjazd/?eventId=${encodeURIComponent(created.id)}`;
  } catch (err) {
    errorEl.textContent = `Błąd: ${err.message}`;
    errorEl.hidden = false;
  }
});

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  // auth.js only routes a failed whoami check to onForbidden - anything this body throws is ours
  // to report, and must not be mistaken for "not a member" (see initGoogleSignIn's comment). The
  // events panel is shown alongside the error so the member sees *why* the list is empty rather
  // than being left staring at the "please sign in" panel they just signed in from.
  onSignedIn: async (identity) => {
    viewerEmail = identity.email;
    try {
      const [{ member }, { profile }] = await Promise.all([
        apiFetch('/lista-wyjazdowa/member', { method: 'GET' }, showReauth, hideReauth),
        apiFetch('/lista-wyjazdowa/profile', { method: 'GET' }, showReauth, hideReauth),
      ]);
      if (!member || !profile) {
        showOnly(panels.noProfile);
        return;
      }
      await loadEvents();
      showOnly(panels.events);
    } catch (err) {
      showOnly(panels.events);
      const errorEl = document.getElementById('events-error');
      errorEl.textContent = `Nie udało się wczytać listy wyjazdów: ${err.message}`;
      errorEl.hidden = false;
    }
  },
  onForbidden: () => showOnly(panels.forbidden),
});
