// KRKG-0094: shared "add companion" panel for the Lista Wyjazdowa pages. The event detail page
// (wyjazd.js) and the events list (lista-wyjazdowa.js) offer the exact same control, so the panel
// markup and the "which attached people may still be added" rule live here instead of in two
// copies that could drift apart. Self-contained escaping (own helper names) like
// shared/person-pill.js, so this file only depends on the global displayName() from
// shared/display-name.js, which every page that includes this script must load first.
(function () {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  /**
   * People without an account attached to the owner who may still be added to the trip.
   *
   * Already-attending companions are filtered out; someone marked "nie jadę" (a signup with
   * attending:false) stays selectable so they can be added back, and quick-add is idempotent on
   * (eventId, personId) anyway. The owner comparison is case-insensitive because a member's
   * personId is their lowercased e-mail.
   *
   * @param {Array<{accountless?: boolean, ownerPersonId?: string|null, personId: string}>} roster
   * @param {Array<{memberEmail: string, attending: boolean}>} signups
   * @param {string} ownerPersonId
   */
  function candidates(roster, signups, ownerPersonId) {
    const owner = String(ownerPersonId ?? '').toLowerCase();
    return roster
      .filter((person) => person.accountless
        && String(person.ownerPersonId ?? '').toLowerCase() === owner
        && !(signups ?? []).some((signup) => signup.memberEmail === person.personId && signup.attending))
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'pl'));
  }

  /**
   * The panel body (the .lw-inline-form-inner block). Fixed control ids are safe because only one
   * panel is open at a time on either page.
   *
   * @param {{personId: string, nickname?: string|null, lastName?: string|null, firstName?: string|null, email?: string|null}} member
   * @param {{roster: unknown[], signups: unknown[], categories: Array<{id: string, label: string}>}} context
   */
  function panelHtml(member, { roster, signups, categories }) {
    const attached = candidates(roster, signups, member.personId);
    const hasAttached = attached.length > 0;
    const existingOptions = attached
      .map((person) => `<option value="${escapeHtml(person.personId)}">${escapeHtml(displayName(person))}</option>`)
      .join('');
    const categorySelectOptions = (categories ?? [])
      .map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`)
      .join('');
    return `
    <div class="lw-inline-form-inner">
      <p class="lw-inline-title">Osoby towarzyszące: ${escapeHtml(displayName(member))}</p>
      <div class="lw-inline-row">
        <label class="lw-inline-label" for="lw-inline-existing-select">istniejąca:</label>
        <select id="lw-inline-existing-select" class="lw-inline-existing-select" ${hasAttached ? '' : 'disabled'}>
          <option value="">${hasAttached ? '— wybierz osobę —' : '— brak dostępnych osób —'}</option>
          ${existingOptions}
        </select>
      </div>
      <div class="lw-inline-row">
        <button type="button" class="lw-inline-add-existing" ${hasAttached ? '' : 'disabled'}>Dodaj</button>
      </div>
      <div class="lw-inline-sep"></div>
      <div class="lw-inline-row">
        <label class="lw-inline-label" for="lw-inline-new-name">lub nowa:</label>
        <input type="text" id="lw-inline-new-name" class="lw-inline-new-name" placeholder="Ksywka" />
        <select id="lw-inline-new-category" class="lw-inline-new-category" aria-label="Kategoria nowej osoby">${categorySelectOptions}</select>
      </div>
      <div class="lw-inline-row">
        <button type="button" class="lw-inline-add-new">Dodaj</button>
        <button type="button" class="lw-inline-cancel">Anuluj</button>
      </div>
    </div>`;
  }

  /**
   * The "+ osoba towarzysząca" control. Shared so the roster and the events list render the exact
   * same button; `eventId` is only supplied by the events list, where a row is a trip rather than a
   * member (so the click handler needs to know which event's panel to open).
   *
   * @param {{ownerPersonId: string, expanded: boolean, eventId?: string}} attrs
   */
  function buttonHtml({ ownerPersonId, expanded, eventId }) {
    const eventAttr = eventId ? ` data-event-id="${escapeHtml(eventId)}"` : '';
    return `<button type="button" class="lw-add-companion" data-owner-person-id="${escapeHtml(ownerPersonId)}"${eventAttr} aria-expanded="${expanded ? 'true' : 'false'}" aria-label="Dodaj osobę towarzyszącą" title="Dodaj osobę towarzyszącą"><span class="lw-add-companion-plus" aria-hidden="true">+</span><svg class="lw-add-companion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5.5" r="2.6"/><path d="M12 8.5v6.5"/><path d="M8.2 11h7.6"/><path d="M9.2 22l2.8-7 2.8 7"/></svg><span class="lw-add-companion-label">osoba towarzysząca</span></button>`;
  }

  window.CompanionAdd = { candidates, panelHtml, buttonHtml };
}());
