/**
 * KRKG-0050 batch 5/6: the one mountable audit-history module. `public/admin/audyt/index.html`
 * and `public/audyt/{index.html,audyt.js}` both call `AuditView.mount(...)` against this same
 * file - only `apiBase` ('/admin/audyt' vs '/audyt') and `scope` ('admin' vs 'member') differ
 * between the two shells (plan.md's file map: "two shells, one shared module"). It renders the
 * required four-column table (Timestamp | User | Event type | Value - implementation-contract.md,
 * binding, never prose narration), the "zero-or-one primary selector" filter UI, cursor
 * "load more" pagination, and a non-modal detail drawer.
 *
 * Classic script (no <script type="module">, matching every other public/*.js on this site - see
 * wyjazd.js/zarzadzanie-ludzmi.js) that expects `apiFetch` (auth.js) to already be loaded on the
 * page. Exposes `window.AuditView`. The `module.exports` block at the bottom only runs under
 * Node's CommonJS loader (Node tests use `createRequire` to reach the pure functions below,
 * per the task brief's "extract the shared module's pure logic ... and unit-test those") - in a
 * browser, plain <script> tags never define a `module` global, so `typeof module` is safely
 * 'undefined' and that block never executes there.
 */
(function (global) {
  'use strict';

  // Same escapeHtml/escapeAttr pair as every other page on this site (wyjazd.js, person-tile.js,
  // zarzadzanie-ludzmi.js, ...) - duplicated here rather than factored out, matching this
  // codebase's established convention of small per-file copies over a shared util module.
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${date} ${time}`;
  }

  /** Thrown by buildQueryParams/validateSingleSelector for anything the query contract
   * (implementation-contract.md "Query and Firestore-index contract") forbids - callers must
   * never let this escape to a network request; the UI only ever constructs one selector at a
   * time in the first place (see buildFilterControlsHtml below), so this is a defensive check,
   * not the primary enforcement mechanism. */
  class AuditFilterError extends Error {}

  // Polish labels for every action in upload-service/src/audit.ts's ACTION_REGISTRY
  // (implementation-contract.md "Action registry" - ~40 entries, read verbatim from there). No
  // existing Polish label map for these action codes was found anywhere else in the codebase
  // (zarzadzanie-ludzmi.js/wyjazd.js/skladki.js's own legacy audit widgets render a free-text
  // `changeSummary` string computed server-side, not a code->label lookup) - this is therefore a
  // fresh scheme, written in the same short-imperative-noun-phrase tone as this site's other
  // Polish admin UI copy ("Zawieś", "Dodaj przekierowanie", "Synchronizuj").
  const ACTION_LABELS = {
    'role.granted': 'Nadanie roli',
    'role.revoked': 'Odebranie roli',
    'role.replaced': 'Zmiana roli',
    'membership.application.submitted': 'Zgłoszenie członkostwa',
    'membership.status.approved': 'Zatwierdzenie członkostwa',
    'membership.status.rejected': 'Odrzucenie zgłoszenia',
    'membership.status.suspended': 'Zawieszenie członkostwa',
    'membership.status.reactivated': 'Przywrócenie członkostwa',
    'membership.status.removed': 'Usunięcie członkostwa',
    'membership.sheet_backup.synchronized': 'Synchronizacja z arkuszem',
    'event.created': 'Utworzenie wyjazdu',
    'event.updated': 'Aktualizacja wyjazdu',
    'event.cancelled': 'Odwołanie wyjazdu',
    'signup.created': 'Zgłoszenie na wyjazd',
    'signup.updated': 'Aktualizacja zgłoszenia',
    'dues.annual.changed': 'Zmiana składki rocznej',
    'dues.entry_fee.changed': 'Zmiana wpisowego',
    'dues.event_fee.changed': 'Zmiana składki wyjazdowej',
    'profile.member.updated': 'Aktualizacja profilu członka',
    'profile.drive_folder.changed': 'Zmiana folderu na Dysku',
    'profile.person.created': 'Dodanie osoby',
    'profile.person.description.updated': 'Zmiana opisu osoby',
    'profile.person.order.updated': 'Zmiana kolejności osoby',
    'profile.person.category.changed': 'Zmiana kategorii osoby',
    'profile.person.deleted': 'Usunięcie osoby',
    'profile.person.photo.added': 'Dodanie zdjęcia osoby',
    'profile.person.photo.deleted': 'Usunięcie zdjęcia osoby',
    'profile.person.photo.main.changed': 'Zmiana zdjęcia głównego',
    'profile.person.photo.transferred': 'Przeniesienie zdjęcia',
    'profile.person.in_memoriam.changed': 'Zmiana statusu in memoriam',
    'profile.photo_submission.created': 'Zgłoszenie zdjęć',
    'profile.photo_submission.photo_added': 'Dodanie zdjęcia do zgłoszenia',
    'session.login.succeeded': 'Logowanie',
    'application.pwa.installation_reported': 'Instalacja aplikacji PWA',
    'gallery.created': 'Utworzenie galerii',
    'gallery.registered': 'Zarejestrowanie galerii',
    'gallery.unregistered': 'Wyrejestrowanie galerii',
    'gallery.deleted': 'Usunięcie galerii',
    'gallery.photo.added': 'Dodanie zdjęcia do galerii',
    'gallery.finalized': 'Zakończenie galerii',
    'gallery.photo.contribution.finalized': 'Zakończenie zgłoszenia zdjęć',
    'site.redirect.created': 'Dodanie przekierowania',
    'site.redirect.deleted': 'Usunięcie przekierowania',
    'site.settings.updated': 'Zmiana ustawień',
    'site.social_cache.refreshed': 'Odświeżenie cache',
  };

  const CATEGORY_LABELS = {
    permissions: 'Uprawnienia',
    membership: 'Członkostwo',
    events: 'Wyjazdy',
    signups: 'Zgłoszenia',
    dues: 'Składki',
    profile: 'Profile',
    session: 'Sesje',
    application: 'Aplikacja',
    gallery: 'Galerie',
    site: 'Strona',
  };

  // Every category whose audience is 'members' in ACTION_REGISTRY (implementation-contract.md's
  // Action registry table: events/signups/gallery are "all signed-in members"; every other
  // category's audience is admin/adminOrAccountant/adminOrModerator, so projectAuditEvent() on the
  // server always returns null for a member-scope query against them - offering them in the
  // member shell's category filter would just be a filter that structurally never returns a row).
  const MEMBER_VISIBLE_CATEGORIES = ['events', 'signups', 'gallery'];

  // action -> category, derived from ACTION_LABELS' keys against implementation-contract.md's
  // registry table, used to populate the category/action two-step filter control.
  const ACTIONS_BY_CATEGORY = {
    permissions: ['role.granted', 'role.revoked', 'role.replaced'],
    membership: [
      'membership.application.submitted',
      'membership.status.approved',
      'membership.status.rejected',
      'membership.status.suspended',
      'membership.status.reactivated',
      'membership.status.removed',
      'membership.sheet_backup.synchronized',
    ],
    events: ['event.created', 'event.updated', 'event.cancelled'],
    signups: ['signup.created', 'signup.updated'],
    dues: ['dues.annual.changed', 'dues.entry_fee.changed', 'dues.event_fee.changed'],
    profile: [
      'profile.member.updated',
      'profile.drive_folder.changed',
      'profile.person.created',
      'profile.person.description.updated',
      'profile.person.order.updated',
      'profile.person.category.changed',
      'profile.person.deleted',
      'profile.person.photo.added',
      'profile.person.photo.deleted',
      'profile.person.photo.main.changed',
      'profile.person.photo.transferred',
      'profile.person.in_memoriam.changed',
      'profile.photo_submission.created',
      'profile.photo_submission.photo_added',
    ],
    session: ['session.login.succeeded'],
    application: ['application.pwa.installation_reported'],
    gallery: [
      'gallery.created',
      'gallery.registered',
      'gallery.unregistered',
      'gallery.deleted',
      'gallery.photo.added',
      'gallery.finalized',
      'gallery.photo.contribution.finalized',
    ],
    site: ['site.redirect.created', 'site.redirect.deleted', 'site.settings.updated', 'site.social_cache.refreshed'],
  };

  function actionLabel(action) {
    return ACTION_LABELS[action] ?? action;
  }

  function categoryLabel(category) {
    return CATEGORY_LABELS[category] ?? category;
  }

  /** Parses a date control's YYYY-MM-DD value numerically in the browser's local time zone.
   * Date-only values must never be passed to `new Date(value)`: that form is specified as UTC
   * and would shift the selected calendar day for Polish users around normal and DST offsets. */
  function parseLocalDateOnly(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match) throw new AuditFilterError('Nieprawidłowa data filtra.');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw new AuditFilterError('Nieprawidłowa data filtra.');
    }
    return date;
  }

  function formatLocalDateOnly(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  /** Converts optional date-control values to inclusive ISO timestamps for the API. */
  function serializeDateOnlyRange(fromDate, toDate) {
    let from;
    let to;
    if (fromDate) {
      const start = parseLocalDateOnly(fromDate);
      start.setHours(0, 0, 0, 0);
      from = start.toISOString();
    }
    if (toDate) {
      const end = parseLocalDateOnly(toDate);
      end.setDate(end.getDate() + 1);
      end.setHours(0, 0, 0, 0);
      end.setMilliseconds(-1);
      to = end.toISOString();
    }
    return { from, to };
  }

  /** Returns the initial UI state for a global audit or a Historia resource deep link. */
  function defaultAuditState(initialFilters, now) {
    if (initialFilters && initialFilters.resourceKey) {
      return { selector: { kind: 'resourceKey', key: initialFilters.resourceKey }, fromDate: '', toDate: '' };
    }
    const today = now ? new Date(now.getTime()) : new Date();
    const targetMonth = today.getMonth() - 1;
    const targetYear = targetMonth < 0 ? today.getFullYear() - 1 : today.getFullYear();
    const normalizedTargetMonth = targetMonth < 0 ? 11 : targetMonth;
    const lastDay = new Date(targetYear, normalizedTargetMonth + 1, 0).getDate();
    const from = new Date(targetYear, normalizedTargetMonth, Math.min(today.getDate(), lastDay));
    return {
      selector: { kind: 'none' },
      fromDate: formatLocalDateOnly(from),
      toDate: formatLocalDateOnly(today),
    };
  }

  /**
   * Builds the URLSearchParams for GET {apiBase}/events from one filter-state object:
   * `{ selector: { kind, category?, action?, email?, key?, term? }, from?, to?, cursor?, limit? }`.
   * `selector.kind` is one of 'none' | 'categoryAction' | 'actorEmail' | 'resourceKey' | 'search' -
   * exactly the "zero-or-one primary selector" contract (implementation-contract.md), mirrored
   * from `AuditPrimarySelector` in upload-service/src/audit.ts. The UI never constructs more than
   * one selector at once (buildFilterControlsHtml renders a single <select> that picks which one
   * is active), so the AuditFilterError branches here are a defensive backstop, exercised directly
   * by this module's unit tests rather than reachable through the rendered UI.
   */
  function buildQueryParams(filters) {
    const { selector, from, to, cursor, limit } = filters || {};
    const params = new URLSearchParams();
    const kind = selector ? selector.kind : 'none';
    switch (kind) {
      case undefined:
      case 'none':
        break;
      case 'categoryAction':
        if (!selector.category) throw new AuditFilterError('Selektor category/action wymaga podania category.');
        params.set('category', selector.category);
        if (selector.action) params.set('action', selector.action);
        break;
      case 'actorEmail':
        if (!selector.email) throw new AuditFilterError('Podaj adres e-mail użytkownika.');
        params.set('actorEmail', selector.email);
        break;
      case 'resourceKey':
        if (!selector.key) throw new AuditFilterError('Podaj identyfikator zasobu.');
        params.set('resourceKey', selector.key);
        break;
      case 'search':
        if (!selector.term) throw new AuditFilterError('Podaj szukane słowo.');
        params.set('q', selector.term);
        break;
      default:
        throw new AuditFilterError(`Nieobsługiwany selektor filtra: ${kind}`);
    }
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    return params;
  }

  // Per-action memberVisible identity-ish fields that can stand in for "User" on a member-scope
  // row, in priority order - implementation-contract.md's "Per-action stored-field allowlists"
  // table lists `memberEmail` (signups) and `contributorEmail` (gallery) as memberVisible; `events`
  // has no memberVisible identity field at all (its allowlist is name/startDate/endDate/status), so
  // an events-category member row always falls through to the em-dash below. This is a documented
  // judgment call (see task-6-report.md), not something implementation-contract.md states outright.
  const MEMBER_IDENTITY_FIELDS = ['memberEmail', 'contributorEmail'];

  /**
   * The "User" column value for one row. Admin-scope rows always carry `actor` (per
   * implementation-contract.md, even for accountant/moderator-only viewers) and use it directly.
   * Member-scope rows never carry `actor` at all (deliberately withheld - see this module's file
   * header and implementation-contract.md's role-visibility rules), so this looks for the best
   * available identity-shaped field inside `changes` instead, falling back to an em dash when the
   * action genuinely carries none (e.g. `gallery.created`, `event.*`).
   */
  function resolveUserColumn(row) {
    if (row.actor) return row.actor.name || row.actor.email;
    for (const field of MEMBER_IDENTITY_FIELDS) {
      const change = row.changes.find(c => c.field === field && (c.after !== undefined || c.before !== undefined));
      if (change) return change.after !== undefined ? String(change.after) : String(change.before);
    }
    return '—';
  }

  /** One `changes` entry as `field: before → after`, omitting `before`/`after` individually when
   * absent (implementation-contract.md's detail-drawer requirement, e.g. a creation has no
   * `before`). `null` is rendered as the literal text "null" (matches formatTechnicalValue's own
   * `displayValue` convention on the server, upload-service/src/audit.ts), not treated as absent -
   * only an actually-omitted key (`undefined` after JSON parsing) counts as absent here. */
  function formatChangeLine(change) {
    const hasBefore = change.before !== undefined;
    const hasAfter = change.after !== undefined;
    const fmt = v => (v === null ? 'null' : String(v));
    let value = '';
    if (hasBefore && hasAfter) value = `${fmt(change.before)} → ${fmt(change.after)}`;
    else if (hasAfter) value = fmt(change.after);
    else if (hasBefore) value = fmt(change.before);
    return `${change.field}: ${value}`;
  }

  // ---------------------------------------------------------------------------------------------
  // DOM mounting - everything below this line touches the document and is not unit-tested
  // directly (no DOM test harness exists in this repo's scripts/*.test.ts suite); it is covered by
  // manual/browser verification instead (see task-6-report.md). Every pure function above it *is*
  // exercised by scripts/audit-view-logic.test.ts.
  // ---------------------------------------------------------------------------------------------

  function categoriesForScope(scope) {
    return scope === 'member' ? MEMBER_VISIBLE_CATEGORIES : Object.keys(CATEGORY_LABELS);
  }

  function shellHtml(scope) {
    const categories = categoriesForScope(scope);
    const categoryOptions = categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(categoryLabel(c))}</option>`).join('');
    return `
      <div class="audyt-filters">
        <label class="audyt-filter-field">Filtruj wg
          <select class="audyt-selector-kind">
            <option value="none">Brak</option>
            <option value="categoryAction">Kategoria / rodzaj zdarzenia</option>
            ${scope === 'admin' ? '<option value="actorEmail">Użytkownik</option>' : ''}
            <option value="resourceKey">Zasób</option>
            <option value="search">Szukaj od początku słowa</option>
          </select>
        </label>
        <span class="audyt-selector-value" data-kind="categoryAction" hidden>
          <label class="audyt-filter-field">Kategoria
            <select class="audyt-category-select"><option value="">-</option>${categoryOptions}</select>
          </label>
          <label class="audyt-filter-field">Rodzaj zdarzenia
            <select class="audyt-action-select"><option value="">Wszystkie</option></select>
          </label>
        </span>
        ${
          scope === 'admin'
            ? `<span class="audyt-selector-value" data-kind="actorEmail" hidden>
          <label class="audyt-filter-field">Użytkownik
            <input type="email" class="audyt-actor-input" placeholder="email@kruki.org" autocomplete="off" />
          </label>
        </span>`
            : ''
        }
        <span class="audyt-selector-value" data-kind="resourceKey" hidden>
          <label class="audyt-filter-field">Zasób
            <input type="text" class="audyt-resource-input" placeholder="np. event:abc123" autocomplete="off" />
          </label>
        </span>
        <span class="audyt-selector-value" data-kind="search" hidden>
          <label class="audyt-filter-field">Szukaj od początku słowa
            <input type="search" class="audyt-search-input" placeholder="np. Wolin" autocomplete="off" />
          </label>
        </span>
        <label class="audyt-filter-field">Od
          <input type="date" class="audyt-from-input" />
        </label>
        <label class="audyt-filter-field">Do
          <input type="date" class="audyt-to-input" />
        </label>
        <button type="button" class="audyt-apply-btn btn-add-album">Filtruj</button>
      </div>
      <p class="audyt-error add-album-error" hidden></p>
      <div class="czl-table-wrap">
        <table class="czl-table audyt-table">
          <thead>
            <tr>
              <th scope="col">Data i godzina</th>
              <th scope="col">Użytkownik</th>
              <th scope="col">Rodzaj zdarzenia</th>
              <th scope="col">Wartość</th>
            </tr>
          </thead>
          <tbody class="audyt-rows"></tbody>
        </table>
      </div>
      <button type="button" class="audyt-load-more btn-add-album" hidden>Załaduj więcej</button>
      <div class="audyt-drawer" hidden>
        <div class="audyt-drawer-backdrop"></div>
        <div class="audyt-drawer-panel" role="dialog" aria-label="Szczegóły zdarzenia">
          <button type="button" class="audyt-drawer-close" aria-label="Zamknij">✕</button>
          <div class="audyt-drawer-content"></div>
        </div>
      </div>
    `;
  }

  /**
   * Mounts the shared audit view into `container`. `options`:
   * - `apiBase` ('/admin/audyt' or '/audyt', required)
   * - `scope` ('admin' or 'member', required)
   * - `initialFilters` (optional) - `{ resourceKey }` today, used by every Historia deep link
   * - `showReauth`/`hideReauth` (optional, default no-ops - most Lista Wyjazdowa pages have no
   *   reauth banner of their own either, see wyjazd.js/skladki.js)
   */
  function mount(container, options) {
    const opts = options || {};
    const apiBase = opts.apiBase;
    const scope = opts.scope;
    if (!apiBase || (scope !== 'admin' && scope !== 'member')) {
      throw new AuditFilterError('mount() wymaga apiBase i poprawnego scope ("admin" albo "member").');
    }
    const showReauth = opts.showReauth || function () {};
    const hideReauth = opts.hideReauth || function () {};

    container.innerHTML = shellHtml(scope);

    const els = {
      selectorKind: container.querySelector('.audyt-selector-kind'),
      categorySelect: container.querySelector('.audyt-category-select'),
      actionSelect: container.querySelector('.audyt-action-select'),
      actorInput: container.querySelector('.audyt-actor-input'),
      resourceInput: container.querySelector('.audyt-resource-input'),
      searchInput: container.querySelector('.audyt-search-input'),
      fromInput: container.querySelector('.audyt-from-input'),
      toInput: container.querySelector('.audyt-to-input'),
      applyBtn: container.querySelector('.audyt-apply-btn'),
      error: container.querySelector('.audyt-error'),
      rows: container.querySelector('.audyt-rows'),
      loadMoreBtn: container.querySelector('.audyt-load-more'),
      drawer: container.querySelector('.audyt-drawer'),
      drawerContent: container.querySelector('.audyt-drawer-content'),
      drawerClose: container.querySelector('.audyt-drawer-close'),
      drawerBackdrop: container.querySelector('.audyt-drawer-backdrop'),
    };

    function showSelectorValue(kind) {
      container.querySelectorAll('.audyt-selector-value').forEach(el => {
        el.hidden = el.dataset.kind !== kind;
      });
    }

    els.selectorKind.addEventListener('change', () => showSelectorValue(els.selectorKind.value));

    if (els.categorySelect) {
      els.categorySelect.addEventListener('change', () => {
        const actions = ACTIONS_BY_CATEGORY[els.categorySelect.value] || [];
        els.actionSelect.innerHTML =
          '<option value="">Wszystkie</option>' + actions.map(a => `<option value="${escapeAttr(a)}">${escapeHtml(actionLabel(a))}</option>`).join('');
      });
    }

    function currentSelector() {
      const kind = els.selectorKind.value;
      if (kind === 'categoryAction') return { kind, category: els.categorySelect.value || undefined, action: els.actionSelect.value || undefined };
      if (kind === 'actorEmail') return { kind, email: els.actorInput ? els.actorInput.value.trim() : '' };
      if (kind === 'resourceKey') return { kind, key: els.resourceInput.value.trim() };
      if (kind === 'search') return { kind, term: els.searchInput.value.trim() };
      return { kind: 'none' };
    }

    function showError(message) {
      els.error.textContent = message;
      els.error.hidden = false;
    }
    function clearError() {
      els.error.hidden = true;
    }

    function renderRow(row) {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;
      tr.className = 'audyt-row';
      tr.innerHTML = `
        <td>${escapeHtml(formatDateTime(row.timestamp))}</td>
        <td>${escapeHtml(resolveUserColumn(row))}</td>
        <td>${escapeHtml(actionLabel(row.action))}</td>
        <td class="audyt-value">${escapeHtml(row.value)}</td>
      `;
      return tr;
    }

    async function openDetail(id) {
      try {
        const row = await apiFetch(`${apiBase}/event?id=${encodeURIComponent(id)}`, { method: 'GET' }, showReauth, hideReauth);
        const changesHtml = row.changes.length
          ? `<ul class="audyt-drawer-changes">${row.changes.map(c => `<li>${escapeHtml(formatChangeLine(c))}</li>`).join('')}</ul>`
          : '<p>Brak zarejestrowanych zmian.</p>';
        els.drawerContent.innerHTML = `
          <h3>${escapeHtml(actionLabel(row.action))}</h3>
          <dl class="audyt-drawer-meta">
            <dt>Data i godzina</dt><dd>${escapeHtml(formatDateTime(row.timestamp))}</dd>
            <dt>Kategoria</dt><dd>${escapeHtml(categoryLabel(row.category))}</dd>
            <dt>Zasób</dt><dd>${escapeHtml(row.resource.kind)}: ${escapeHtml(row.resource.display)}</dd>
            ${row.actor ? `<dt>Użytkownik</dt><dd>${escapeHtml(row.actor.name || row.actor.email)}</dd>` : ''}
            <dt>Wartość</dt><dd class="audyt-value">${escapeHtml(row.value)}</dd>
          </dl>
          <h4>Zmiany</h4>
          ${changesHtml}
        `;
        els.drawer.hidden = false;
      } catch (err) {
        showError(`Nie udało się wczytać szczegółów: ${err.message}`);
      }
    }

    function closeDrawer() {
      els.drawer.hidden = true;
    }
    els.drawerClose.addEventListener('click', closeDrawer);
    els.drawerBackdrop.addEventListener('click', closeDrawer);

    els.rows.addEventListener('click', e => {
      const tr = e.target.closest('.audyt-row');
      if (tr) openDetail(tr.dataset.id);
    });

    let lastSelector = { kind: 'none' };
    let lastCursor;

    async function fetchPage(cursor) {
      const selector = currentSelector();
      let params;
      try {
        const dateRange = serializeDateOnlyRange(els.fromInput.value, els.toInput.value);
        params = buildQueryParams({ selector, from: dateRange.from, to: dateRange.to, cursor });
      } catch (err) {
        showError(err.message);
        return;
      }
      clearError();
      try {
        const page = await apiFetch(`${apiBase}/events?${params.toString()}`, { method: 'GET' }, showReauth, hideReauth);
        if (!cursor) els.rows.innerHTML = '';
        for (const row of page.rows) els.rows.appendChild(renderRow(row));
        lastSelector = selector;
        lastCursor = page.nextCursor;
        els.loadMoreBtn.hidden = !page.nextCursor;
        if (!cursor && page.rows.length === 0) {
          els.rows.innerHTML = '<tr><td colspan="4" class="czl-empty">Brak zdarzeń.</td></tr>';
        }
      } catch (err) {
        showError(`Nie udało się wczytać historii: ${err.message}`);
      }
    }

    els.applyBtn.addEventListener('click', () => fetchPage(undefined));
    els.loadMoreBtn.addEventListener('click', () => fetchPage(lastCursor));

    // Historia deep links (resourceKey) pre-set the filter and load immediately - never an inline
    // expansion/modal, always this same shared page (implementation-contract.md "Historia and UI
    // scope").
    const initialState = defaultAuditState(opts.initialFilters);
    els.fromInput.value = initialState.fromDate;
    els.toInput.value = initialState.toDate;
    if (initialState.selector.kind === 'resourceKey') {
      els.selectorKind.value = 'resourceKey';
      showSelectorValue('resourceKey');
      els.resourceInput.value = initialState.selector.key;
    } else {
      showSelectorValue('none');
    }
    fetchPage(undefined);

    return { reload: () => fetchPage(undefined) };
  }

  const AuditView = {
    mount,
    ACTION_LABELS,
    CATEGORY_LABELS,
    ACTIONS_BY_CATEGORY,
    MEMBER_VISIBLE_CATEGORIES,
    actionLabel,
    categoryLabel,
    parseLocalDateOnly,
    serializeDateOnlyRange,
    defaultAuditState,
    buildQueryParams,
    resolveUserColumn,
    formatChangeLine,
    AuditFilterError,
  };

  global.AuditView = AuditView;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AuditView;
  }
})(typeof window !== 'undefined' ? window : globalThis);
