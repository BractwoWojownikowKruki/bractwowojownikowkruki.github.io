// KRKG-0102: shared "edit event" panel (Nazwa/Data/Opis + Odwołaj/Przywróć wyjazd) for the Lista
// Wyjazdowa pages. The event detail page (wyjazd.js) and the events list (lista-wyjazdowa.js) both
// offer the same edit affordance on an event, so the panel markup and the diff-only PUT body it
// builds live here instead of two copies that could drift apart - same pattern as
// shared/companion-add.js. Self-contained escaping, no other dependency.
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

  const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  /**
   * The small "Edytuj" toggle button. `withLabel: false` renders the icon-only variant used on the
   * events list, where every row needs its own compact trigger.
   *
   * @param {{eventId: string, expanded: boolean, withLabel: boolean}} attrs
   */
  function toggleButtonHtml({ eventId, expanded, withLabel }) {
    const iconOnlyClass = withLabel ? '' : ' lw-edit-toggle--icon';
    const label = withLabel ? '<span>Edytuj</span>' : '';
    const ariaLabel = withLabel ? '' : ' aria-label="Edytuj wyjazd" title="Edytuj wyjazd"';
    return `<button type="button" class="lw-edit-toggle lw-event-edit-toggle${iconOnlyClass}" data-event-id="${escapeHtml(eventId)}" aria-expanded="${expanded ? 'true' : 'false'}"${ariaLabel}>${PENCIL_ICON}${label}</button>`;
  }

  /**
   * The edit panel itself: Nazwa/Data/Opis fields, Zapisz/Anuluj, and a single Odwołaj/Przywróć
   * wyjazd button whose label and target status follow the event's current status. `idPrefix` keeps
   * multiple instances (one per list row, plus the detail page's own) from colliding on element ids.
   *
   * @param {{id: string, name: string, startDate: string, description?: string|null, status: string}} event
   * @param {{idPrefix: string}} opts
   */
  function panelHtml(event, { idPrefix }) {
    const isCancelled = event.status === 'cancelled';
    const description = event.description ?? '';
    return `
    <div class="lw-event-edit-form" data-event-id="${escapeHtml(event.id)}">
      <div class="field">
        <label for="${idPrefix}-name">Nazwa</label>
        <input type="text" id="${idPrefix}-name" value="${escapeHtml(event.name)}">
      </div>
      <div class="field">
        <label for="${idPrefix}-date">Data rozpoczęcia</label>
        <input type="date" id="${idPrefix}-date" value="${escapeHtml(event.startDate)}">
      </div>
      <div class="field">
        <label for="${idPrefix}-description">Opis</label>
        <textarea id="${idPrefix}-description" rows="4" placeholder="Informacje o wyjeździe: miejsce, linki, co zabrać...">${escapeHtml(description)}</textarea>
      </div>
      <p class="add-album-error" id="${idPrefix}-error" hidden></p>
      <div class="lw-event-edit-actions">
        <button type="button" class="add-album-submit lw-event-edit-save" data-id-prefix="${idPrefix}">Zapisz</button>
        <button type="button" class="btn-cancel lw-event-edit-cancel" data-id-prefix="${idPrefix}">Anuluj</button>
      </div>
      <div class="lw-event-edit-danger-row">
        <button type="button" class="btn-cancel lw-event-edit-toggle-status" data-id-prefix="${idPrefix}" data-next-status="${isCancelled ? 'active' : 'cancelled'}">${isCancelled ? 'Przywróć wyjazd' : 'Odwołaj wyjazd'}</button>
      </div>
    </div>`;
  }

  /**
   * Reads the panel's current field values by id prefix.
   * @param {string} idPrefix
   */
  function readForm(idPrefix) {
    return {
      name: document.getElementById(`${idPrefix}-name`).value,
      startDate: document.getElementById(`${idPrefix}-date`).value,
      description: document.getElementById(`${idPrefix}-description`).value,
    };
  }

  /**
   * Diff-only PUT body: only fields that actually changed from `event` are included, same
   * "send only what changed" contract as wyjazd.js's saveSkladkaFee. An empty description is sent
   * as null (clears it) rather than an empty string, matching the backend's optionalTrimmedString.
   *
   * @param {{name: string, startDate: string, description?: string|null}} event
   * @param {{name: string, startDate: string, description: string}} formValues
   */
  function buildUpdateBody(event, formValues) {
    const body = {};
    const name = formValues.name.trim();
    if (name && name !== event.name) body.name = name;
    if (formValues.startDate && formValues.startDate !== event.startDate) body.startDate = formValues.startDate;
    const description = formValues.description.trim();
    const currentDescription = event.description ?? '';
    if (description !== currentDescription) body.description = description || null;
    return body;
  }

  window.EventEditForm = { toggleButtonHtml, panelHtml, readForm, buildUpdateBody };
}());
