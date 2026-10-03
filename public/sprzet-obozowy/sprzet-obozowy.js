/**
 * Protected member-zone Sprzęt obozowy page (KRKG-0096 batch 2/5). Same panel-swap pattern as
 * pliki.js: lists the club's camp equipment (budowle, meble, kuchnia - each category carries a group) split into a drużynowy (team-owned,
 * belongsToPersonId === null) and a prywatny (belongsToPersonId is a personId) table, lets any
 * signed-in member add/edit/delete any item against the /equipment HTTP contract (Batch 1), and
 * confirms every mutation with the shared MutationFeedback toast ("Zapisano").
 */
const panels = {
  checking: document.getElementById('sprzet-checking'),
  signedOut: document.getElementById('signed-out-panel'),
  forbidden: document.getElementById('forbidden-panel'),
};

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
  document.getElementById('main-content').hidden = panel !== null;
}

showOnly(panels.checking);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

// 3-letter Sekcja abbreviations for the compact first column - same fixed map as czlonkowie.js/
// wyjazd.js/zarzadzanie-ludzmi.js, duplicated per this codebase's own per-file-utility convention
// (see pliki.js's DIACRITICS comment for the precedent).
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

// A retired lookup item is withdrawn from *new* use but must keep resolving for equipment that
// already references it - same rule and same helper name as profil.js's selectableLookupItems,
// duplicated per this codebase's per-file convention (see profil.js's own comment on why).
function selectableLookupItems(items, selectedIds) {
  return items.filter(item => !item.retired || selectedIds.includes(item.id));
}

/**
 * Splits the flat /equipment list into the two tables this page renders - a pure function so it
 * can be unit-tested without a DOM. belongsToPersonId is null for drużyna/team-owned equipment,
 * a personId string for prywatny/private equipment (Task 1's contract).
 *
 * @param {Array<{belongsToPersonId: string|null}>} items
 */
function splitEquipmentByOwnership(items) {
  return {
    team: items.filter(item => item.belongsToPersonId === null),
    private: items.filter(item => item.belongsToPersonId !== null),
  };
}

/**
 * Candidates for the owner `<input list>` datalist, given what the member has typed so far. A
 * pure function (no DOM) so the matching rule can be unit-tested directly - Polish-locale-aware
 * substring match, same convention as the rest of this site's filters (see czlonkowie.js's
 * renderTable filter). Matches against displayName() (ksywka/imię) AND personSubline()
 * (nazwisko, imię) together - KRKG-0103: displayName() alone only shows the first name once a
 * person has no ksywka, so matching on it exclusively would silently stop finding someone by
 * their surname. An empty/whitespace-only query matches nothing, same as the datalist has
 * nothing useful to suggest until the member starts typing.
 *
 * @param {Array<{nickname?: string|null, firstName?: string|null, lastName?: string|null, email?: string|null}>} roster
 * @param {string} query
 */
function filterOwnerCandidates(roster, query) {
  const needle = String(query ?? '').trim().toLocaleLowerCase('pl');
  if (!needle) return [];
  return roster.filter(person => {
    const haystack = [displayName(person), personSubline(person)].filter(Boolean).join(' ');
    return haystack.toLocaleLowerCase('pl').includes(needle);
  });
}

/**
 * Keeps only the items whose section is one of the selected ones - an empty selection means "no
 * filter" and returns every item. A pure function (no DOM) so the rule can be unit-tested directly.
 * `sectionOf` decides which section an item counts as: its own sectionId for drużynowy equipment,
 * the owner's *current* section for prywatny equipment (see itemFilterSectionId).
 *
 * @param {Array<object>} items
 * @param {Set<string>} selectedSectionIds
 * @param {(item: object) => (string|null|undefined)} sectionOf
 */
function filterEquipmentBySections(items, selectedSectionIds, sectionOf) {
  if (selectedSectionIds.size === 0) return items;
  return items.filter(item => selectedSectionIds.has(sectionOf(item)));
}

let equipment = [];
// Sekcja ids picked in the "Filtry" row. Not persisted - every visit starts unfiltered.
let selectedSectionIds = new Set();
let equipmentCategories = [];
let sections = [];
let categoryLabelById = new Map();
let equipmentGroups = [];
// categoryId -> group label (empty string when the category has no group).
let categoryGroupById = new Map();
let sectionLabelById = new Map();
// personId -> { personId, accountless, email, lastName, firstName, nickname, sectionId, categoryId } -
// covers both members (personId === lowercased e-mail) and accountless persons, mirroring
// czlonkowie.js's own member+roster union. Resolves belongsToPersonId to a display name/section
// for the private table and for auto-filling Sekcja when an owner is picked in the add form.
let personById = new Map();
// Flat array (same objects as personById's values) for the owner datalist / filterOwnerCandidates.
let rosterList = [];

function ownerCellHtml(personId) {
  const person = personById.get(personId);
  if (!person) {
    // Unresolved reference (e.g. a person since permanently purged) - show the raw id rather
    // than hiding it, same never-hide-an-unresolved-reference convention as czlonkowie.js's
    // section-id fallback.
    return escapeHtml(personId);
  }
  const pill = personPillHtml({
    name: displayName(person),
    categoryId: person.categoryId,
    categoryLabel: categoryLabelById.get(person.categoryId) ?? person.categoryId,
    accountless: person.accountless === true,
    subline: personSubline(person),
  });
  const triggerAttr = person.accountless
    ? `data-person-id="${escapeAttr(person.personId)}"`
    : `data-email="${escapeAttr(person.email)}"`;
  return `<button type="button" class="profile-trigger" data-profile-trigger ${triggerAttr}>${pill}</button>`;
}

function equipmentActionsHtml(item) {
  const editButton = item.canEdit
    ? `<button type="button" class="member-action" data-edit-id="${escapeAttr(item.id)}">Edytuj</button>`
    : '';
  const deleteButton = item.canDelete
    ? `<button type="button" class="member-action" data-delete-id="${escapeAttr(item.id)}">Usuń</button>`
    : '';
  return `${editButton}${deleteButton}`;
}

function equipmentRowHtml(item, { includeOwner }) {
  const categoryLabel = categoryLabelById.get(item.categoryId) ?? item.categoryId;
  const sectionLabel = sectionLabelById.get(item.sectionId) ?? item.sectionId;
  const groupLabel = categoryGroupById.get(item.categoryId) ?? '';
  const ownerCell = includeOwner ? `<td>${ownerCellHtml(item.belongsToPersonId)}</td>` : '';
  return `
    <tr data-equipment-id="${escapeAttr(item.id)}" data-section="${escapeAttr(item.sectionId ?? '')}">
      <td class="czl-section-cell" title="${escapeAttr(sectionLabel ?? '')}">${item.sectionId ? escapeHtml(sectionAbbr(item.sectionId)) : ''}</td>
      <td class="equipment-meta-cell">${groupLabel ? escapeHtml(groupLabel) : '<span class="czl-empty">—</span>'}</td>
      <td class="equipment-meta-cell">${escapeHtml(categoryLabel)}</td>
      ${ownerCell}
      <td>${item.description ? escapeHtml(item.description) : '<span class="czl-empty">—</span>'}</td>
      <td>${equipmentActionsHtml(item)}</td>
    </tr>
  `;
}

function sortItems(items, sortState) {
  return [...items].sort((a, b) => compareValues(a[sortState.key], b[sortState.key], sortState.dir));
}

// Two independent sortable-table instances (per the design's resolved ambiguity: two separate
// tables, not one filtered table) - each tracks its own key/dir and re-renders only its own body.
const teamSortState = initSortableTable(document.getElementById('equipment-team-table'), {
  defaultKey: 'categoryLabel',
  onChange: renderTeamTable,
});
const privateSortState = initSortableTable(document.getElementById('equipment-private-table'), {
  defaultKey: 'categoryLabel',
  onChange: renderPrivateTable,
});

// Private equipment follows its owner: an item's stored sectionId is a snapshot taken when it was
// saved, so a person who has since changed section would otherwise leave their equipment behind
// under the old one. Falls back to the stored sectionId when the owner cannot be resolved.
function itemFilterSectionId(item) {
  if (item.belongsToPersonId === null) return item.sectionId;
  return personById.get(item.belongsToPersonId)?.sectionId ?? item.sectionId;
}

function renderTeamTable() {
  const { team } = splitEquipmentByOwnership(equipment);
  const filtered = filterEquipmentBySections(team, selectedSectionIds, itemFilterSectionId);
  const enriched = filtered.map(item => ({
    ...item,
    groupLabel: categoryGroupById.get(item.categoryId) ?? '',
    categoryLabel: categoryLabelById.get(item.categoryId) ?? item.categoryId,
    sectionLabel: sectionLabelById.get(item.sectionId) ?? item.sectionId,
  }));
  const sorted = sortItems(enriched, teamSortState);
  const tbody = document.getElementById('equipment-team-table-body');
  tbody.innerHTML = sorted.length
    ? sorted.map(item => equipmentRowHtml(item, { includeOwner: false })).join('')
    : `<tr><td colspan="5" class="czl-empty">${selectedSectionIds.size ? 'Brak sprzętu drużynowego w wybranych sekcjach.' : 'Brak sprzętu drużynowego.'}</td></tr>`;
}

function renderPrivateTable() {
  const { private: privateItems } = splitEquipmentByOwnership(equipment);
  const filtered = filterEquipmentBySections(privateItems, selectedSectionIds, itemFilterSectionId);
  const enriched = filtered.map(item => {
    const owner = personById.get(item.belongsToPersonId);
    return {
      ...item,
      groupLabel: categoryGroupById.get(item.categoryId) ?? '',
      categoryLabel: categoryLabelById.get(item.categoryId) ?? item.categoryId,
      sectionLabel: sectionLabelById.get(item.sectionId) ?? item.sectionId,
      ownerName: owner ? displayName(owner) : item.belongsToPersonId,
    };
  });
  const sorted = sortItems(enriched, privateSortState);
  const tbody = document.getElementById('equipment-private-table-body');
  tbody.innerHTML = sorted.length
    ? sorted.map(item => equipmentRowHtml(item, { includeOwner: true })).join('')
    : `<tr><td colspan="6" class="czl-empty">${selectedSectionIds.size ? 'Brak sprzętu prywatnego w wybranych sekcjach.' : 'Brak sprzętu prywatnego.'}</td></tr>`;
}

function renderBothTables() {
  renderSectionFilter();
  renderTeamTable();
  renderPrivateTable();
}

/**
 * The "Filtry" row: a "Wyczyść filtr" button, then one toggle per Sekcja styled as a larger
 * .section-pill. Several sections can be pressed at once (aria-pressed); none pressed = no filter.
 * A retired section stays listed only while something still references it, same rule as the
 * add form's select.
 */
function renderSectionFilter() {
  const usedIds = [...new Set(equipment.map(itemFilterSectionId).filter(Boolean))];
  // Drop selections whose section has disappeared from the lookup lists, so the filter can never
  // be stuck on a button that is no longer rendered.
  for (const id of selectedSectionIds) {
    if (!sections.some(s => s.id === id)) selectedSectionIds.delete(id);
  }
  const visible = selectableLookupItems(sections, [...usedIds, ...selectedSectionIds]);
  const clearButton = `<button type="button" class="member-action equipment-filter-clear" data-filter-clear${selectedSectionIds.size ? '' : ' disabled'}>Wyczyść filtr</button>`;
  const sectionButtons = visible.map(s => {
    const pressed = selectedSectionIds.has(s.id);
    return `<button type="button" class="section-pill equipment-filter-pill" data-section="${escapeAttr(s.id)}" data-filter-section="${escapeAttr(s.id)}" aria-pressed="${pressed}">${escapeHtml(s.label)}</button>`;
  }).join('');
  const container = document.getElementById('equipment-section-filter-buttons');
  container.innerHTML = clearButton + sectionButtons;
  // Lets the CSS dim the unpressed pills only while a filter is actually on.
  document.getElementById('equipment-section-filter').dataset.active = String(selectedSectionIds.size > 0);
}

function wireSectionFilter() {
  const container = document.getElementById('equipment-section-filter-buttons');
  container.addEventListener('click', e => {
    const isClear = Boolean(e.target.closest('[data-filter-clear]'));
    const sectionButton = e.target.closest('[data-filter-section]');
    if (!isClear && !sectionButton) return;
    const id = sectionButton?.dataset.filterSection;
    if (isClear) selectedSectionIds.clear();
    else if (selectedSectionIds.has(id)) selectedSectionIds.delete(id);
    else selectedSectionIds.add(id);
    renderBothTables();
    // renderBothTables rebuilds the buttons - put keyboard focus back on the one just pressed.
    [...container.querySelectorAll('button')]
      .find(b => (isClear ? 'filterClear' in b.dataset : b.dataset.filterSection === id))
      ?.focus();
  });
}

// Takes a /lista-wyjazdowa/lookup-lists response and rebuilds every lookup-derived map. Shared by
// the initial page load and by the taxonomy editor, which re-reads the lists after each change.
function applyLookupLists(lookupLists) {
  equipmentCategories = lookupLists.equipmentCategories ?? [];
  equipmentGroups = lookupLists.equipmentGroups ?? [];
  sections = lookupLists.sections ?? [];
  categoryLabelById = new Map(equipmentCategories.map(c => [c.id, c.label]));
  const groupLabelById = new Map(equipmentGroups.map(g => [g.id, g.label]));
  categoryGroupById = new Map(equipmentCategories.map(c => [c.id, groupLabelById.get(c.groupId) ?? '']));
  sectionLabelById = new Map(sections.map(s => [s.id, s.label]));
}

async function reloadLookupLists() {
  applyLookupLists(await apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }));
  populateCategorySelect(null);
  renderTaxonomyEditor();
  renderBothTables();
}

/**
 * Editor for the equipmentGroups / equipmentCategories lookup lists ("Edytuj grupy i kategorie").
 * Referential integrity (no deleting a category still used by equipment, nor a group still used
 * by a category) is enforced by the server, which answers 409 with a message shown verbatim in an
 * alert - the page itself only renders and wires the controls.
 */
function renderTaxonomyEditor() {
  const byLabel = (a, b) => a.label.localeCompare(b.label, 'pl');
  const usageByCategory = new Map();
  for (const item of equipment) usageByCategory.set(item.categoryId, (usageByCategory.get(item.categoryId) ?? 0) + 1);
  // "Inne" is the catch-all group. When it exists as a real group, a category without a group is
  // shown (and defaults) as that one; otherwise an empty-value "Inne" option stands in for "no group".
  const catchAllGroup = equipmentGroups.find(g => g.label.trim().toLocaleLowerCase('pl') === 'inne');
  const defaultGroupId = catchAllGroup ? catchAllGroup.id : '';
  const groupOptions = selected => (catchAllGroup ? [] : ['<option value="">Inne</option>'])
    .concat([...equipmentGroups].sort(byLabel).map(g =>
      `<option value="${escapeAttr(g.id)}"${g.id === selected ? ' selected' : ''}>${escapeHtml(g.label)}</option>`))
    .join('');
  const groupLabelOf = c => equipmentGroups.find(g => g.id === (c.groupId ?? defaultGroupId))?.label ?? 'Inne';
  // Alphabetical by group first, then by category name within the group.
  const byGroupThenLabel = (a, b) => groupLabelOf(a).localeCompare(groupLabelOf(b), 'pl') || byLabel(a, b);

  const groupRows = [...equipmentGroups].sort(byLabel).map(g => `
    <div class="equipment-taxonomy-row" data-group-id="${escapeAttr(g.id)}">
      <input type="text" maxlength="60" value="${escapeAttr(g.label)}" aria-label="Nazwa grupy" data-field="label" />
      <button type="button" class="member-action" data-taxonomy-action="save-group">Zapisz</button>
      <button type="button" class="member-action" data-taxonomy-action="delete-group">Usuń</button>
    </div>`).join('');

  const categoryRows = [...equipmentCategories].sort(byGroupThenLabel).map(c => `
    <div class="equipment-taxonomy-row" data-category-id="${escapeAttr(c.id)}">
      <select aria-label="Grupa kategorii" data-field="groupId">${groupOptions(c.groupId ?? defaultGroupId)}</select>
      <input type="text" maxlength="60" value="${escapeAttr(c.label)}" aria-label="Nazwa kategorii" data-field="label" />
      <span class="equipment-count-pill" title="Liczba sprzętów w tej kategorii">${usageByCategory.get(c.id) ?? 0}</span>
      <button type="button" class="member-action" data-taxonomy-action="save-category">Zapisz</button>
      <button type="button" class="member-action" data-taxonomy-action="delete-category">Usuń</button>
    </div>`).join('');

  document.getElementById('equipment-taxonomy-body').innerHTML = `
    <h3>Grupy</h3>
    ${groupRows || '<p class="czl-empty">Brak grup.</p>'}
    <div class="equipment-taxonomy-row" data-new="group">
      <input type="text" maxlength="60" placeholder="Nowa grupa" aria-label="Nazwa nowej grupy" data-field="label" />
      <button type="button" class="member-action" data-taxonomy-action="add-group">Dodaj grupę</button>
    </div>
    <h3>Kategorie</h3>
    ${categoryRows || '<p class="czl-empty">Brak kategorii.</p>'}
    <div class="equipment-taxonomy-row" data-new="category">
      <select aria-label="Grupa nowej kategorii" data-field="groupId">${groupOptions(defaultGroupId)}</select>
      <input type="text" maxlength="60" placeholder="Nowa kategoria" aria-label="Nazwa nowej kategorii" data-field="label" />
      <button type="button" class="member-action" data-taxonomy-action="add-category">Dodaj kategorię</button>
    </div>`;
}

// Every mutation on this page confirms with the "Zapisano" toast (toast: true) rather than an inline
// checkmark: apply() re-renders the tables/editor wholesale, so there is no stable control to anchor a
// check on. `control` only anchors the refresh-error message, hence the always-present toggle.
async function runTaxonomyMutation(request, { confirmDelete } = {}) {
  if (confirmDelete && !window.confirm(confirmDelete)) return;
  try {
    await window.MutationFeedback.confirmed({
      execute: () => apiFetch(request.path, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: request.body ? JSON.stringify(request.body) : undefined,
      }),
      apply: reloadLookupLists,
      refreshFragment: reloadLookupLists,
      toast: true,
      control: document.getElementById('equipment-taxonomy-toggle'),
      viewRoot: document.getElementById('equipment-taxonomy'),
    });
  } catch (err) {
    // Includes the server's 409 "still in use" explanation - shown as a popup, as the page does
    // for a failed equipment delete.
    window.alert(err.message);
  }
}

function wireTaxonomyEditor() {
  const toggle = document.getElementById('equipment-taxonomy-toggle');
  const panel = document.getElementById('equipment-taxonomy');
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) renderTaxonomyEditor();
  });

  panel.addEventListener('click', async e => {
    const button = e.target.closest('[data-taxonomy-action]');
    if (!button) return;
    const row = button.closest('.equipment-taxonomy-row');
    const label = row.querySelector('[data-field="label"]').value.trim();
    const groupField = row.querySelector('[data-field="groupId"]');
    const groupId = groupField ? (groupField.value || null) : null;
    const groupLabel = row.dataset.groupId ? equipmentGroups.find(g => g.id === row.dataset.groupId)?.label : null;
    const categoryLabel = row.dataset.categoryId ? categoryLabelById.get(row.dataset.categoryId) : null;
    switch (button.dataset.taxonomyAction) {
      case 'add-group':
        return runTaxonomyMutation({ method: 'POST', path: '/equipment/groups', body: { label } });
      case 'save-group':
        return runTaxonomyMutation({ method: 'PUT', path: `/equipment/groups?id=${encodeURIComponent(row.dataset.groupId)}`, body: { label } });
      case 'delete-group':
        return runTaxonomyMutation({ method: 'DELETE', path: `/equipment/groups?id=${encodeURIComponent(row.dataset.groupId)}` },
          { confirmDelete: `Usunąć grupę „${groupLabel}”?` });
      case 'add-category':
        return runTaxonomyMutation({ method: 'POST', path: '/equipment/categories', body: { label, groupId } });
      case 'save-category':
        return runTaxonomyMutation({ method: 'PUT', path: `/equipment/categories?id=${encodeURIComponent(row.dataset.categoryId)}`, body: { label, groupId } });
      case 'delete-category':
        return runTaxonomyMutation({ method: 'DELETE', path: `/equipment/categories?id=${encodeURIComponent(row.dataset.categoryId)}` },
          { confirmDelete: `Usunąć kategorię „${categoryLabel}”?` });
    }
  });
}

function populateCategorySelect(currentId) {
  const select = document.getElementById('equipment-add-category');
  select.innerHTML = selectableLookupItems(equipmentCategories, currentId ? [currentId] : [])
    .map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.label)}</option>`)
    .join('');
}

function populateSectionSelect(currentId) {
  const select = document.getElementById('equipment-add-section');
  const options = selectableLookupItems(sections, currentId ? [currentId] : [])
    .map(s => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.label)}</option>`);
  if (currentId && !sections.some(s => s.id === currentId)) {
    options.unshift(`<option value="${escapeAttr(currentId)}">${escapeHtml(currentId)}</option>`);
  }
  select.innerHTML = options.join('');
}

// Renders the datalist's <option> set from an explicit candidate list, so both the initial
// full-roster population and the narrowed-on-typing population (wireOwnerModeToggle's 'input'
// listener) share one rendering path.
function renderOwnerDatalistOptions(candidates) {
  document.getElementById('equipment-owner-datalist').innerHTML = candidates
    .map(person => `<option value="${escapeAttr(displayName(person))}"></option>`)
    .join('');
}

// The datalist starts out listing every known person (member + accountless) - wireOwnerModeToggle's
// 'input' listener then narrows this to filterOwnerCandidates(rosterList, value) as the member
// types (tested separately), giving the przeszukiwalne pole z osobami (searchable field) the
// design calls for instead of relying on the browser's own full-roster substring matching.
function populateOwnerDatalist() {
  renderOwnerDatalistOptions(rosterList);
}

// Resolves the free-text owner input back to a personId by exact displayName match - same
// label-is-the-value convention as zarzadzanie-ludzmi.js's drive-folder datalist (first match
// wins on a name collision, a known and accepted imprecision of that same pattern).
function resolveOwnerInput(value) {
  const needle = String(value ?? '').trim();
  if (!needle) return null;
  const match = rosterList.find(person => displayName(person) === needle);
  return match ? match.personId : null;
}

function wireOwnerModeToggle() {
  const teamRadio = document.getElementById('equipment-owner-mode-team');
  const privateRadio = document.getElementById('equipment-owner-mode-private');
  const ownerWrap = document.getElementById('equipment-add-owner-wrap');
  const ownerInput = document.getElementById('equipment-add-owner');
  const sectionSelect = document.getElementById('equipment-add-section');

  function applyMode() {
    ownerWrap.hidden = !privateRadio.checked;
    if (teamRadio.checked) {
      ownerInput.value = '';
      sectionSelect.disabled = false;
    }
  }

  teamRadio.addEventListener('change', applyMode);
  privateRadio.addEventListener('change', applyMode);

  ownerInput.addEventListener('input', () => {
    // filterOwnerCandidates deliberately returns [] for an empty query (nothing to suggest until
    // the member starts typing) - but that means clearing the field back to '' (e.g. backspacing
    // to start over) would otherwise blank the datalist instead of restoring the browsable full
    // roster it started with. Falls back to the full list here so the datalist never goes empty
    // except when a genuine non-empty query has zero matches.
    const query = ownerInput.value;
    renderOwnerDatalistOptions(query.trim() ? filterOwnerCandidates(rosterList, query) : rosterList);

    const personId = resolveOwnerInput(ownerInput.value);
    const owner = personId ? personById.get(personId) : null;
    if (owner) {
      populateSectionSelect(owner.sectionId);
      if (owner.sectionId) sectionSelect.value = owner.sectionId;
      sectionSelect.disabled = true;
    } else {
      sectionSelect.disabled = false;
    }
  });
}

function resetAddForm() {
  const form = document.getElementById('equipment-add-form');
  form.reset();
  document.getElementById('equipment-add-editing-id').value = '';
  document.getElementById('equipment-add-owner-wrap').hidden = true;
  document.getElementById('equipment-add-section').disabled = false;
  populateCategorySelect(null);
  populateSectionSelect(null);
  populateOwnerDatalist();
  document.getElementById('equipment-add-submit').textContent = 'Dodaj';
}

function openAddFormForEdit(item) {
  const form = document.getElementById('equipment-add-form');
  form.hidden = false;
  document.getElementById('equipment-add-editing-id').value = item.id;
  populateOwnerDatalist();
  populateCategorySelect(item.categoryId);
  document.getElementById('equipment-add-category').value = item.categoryId;
  const isPrivate = item.belongsToPersonId !== null;
  document.getElementById('equipment-owner-mode-team').checked = !isPrivate;
  document.getElementById('equipment-owner-mode-private').checked = isPrivate;
  document.getElementById('equipment-add-owner-wrap').hidden = !isPrivate;
  const ownerInput = document.getElementById('equipment-add-owner');
  if (isPrivate) {
    const owner = personById.get(item.belongsToPersonId);
    ownerInput.value = owner ? displayName(owner) : item.belongsToPersonId;
    populateSectionSelect(item.sectionId);
    document.getElementById('equipment-add-section').value = item.sectionId;
    document.getElementById('equipment-add-section').disabled = true;
  } else {
    ownerInput.value = '';
    populateSectionSelect(item.sectionId);
    document.getElementById('equipment-add-section').value = item.sectionId;
    document.getElementById('equipment-add-section').disabled = false;
  }
  document.getElementById('equipment-add-description').value = item.description ?? '';
  document.getElementById('equipment-add-submit').textContent = 'Zapisz zmiany';
  document.getElementById('equipment-add-category').focus();
}

function wireAddForm() {
  const toggle = document.getElementById('equipment-add-toggle');
  const cancel = document.getElementById('equipment-add-cancel');
  const form = document.getElementById('equipment-add-form');
  const errorEl = document.getElementById('equipment-add-error');

  wireOwnerModeToggle();

  toggle.addEventListener('click', () => {
    if (!form.hidden && document.getElementById('equipment-add-editing-id').value) {
      // Toggling "Dodaj" while mid-edit closes the edit form rather than repurposing it.
      resetAddForm();
      form.hidden = true;
      return;
    }
    form.hidden = !form.hidden;
    if (!form.hidden) {
      resetAddForm();
      document.getElementById('equipment-add-category').focus();
    }
  });
  cancel.addEventListener('click', () => {
    resetAddForm();
    form.hidden = true;
    errorEl.hidden = true;
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorEl.hidden = true;
    const editingId = document.getElementById('equipment-add-editing-id').value;
    const isPrivate = document.getElementById('equipment-owner-mode-private').checked;
    const categoryId = document.getElementById('equipment-add-category').value;
    const sectionId = document.getElementById('equipment-add-section').value;
    const description = document.getElementById('equipment-add-description').value.trim();
    let belongsToPersonId = null;
    if (isPrivate) {
      belongsToPersonId = resolveOwnerInput(document.getElementById('equipment-add-owner').value);
      if (!belongsToPersonId) {
        errorEl.textContent = 'Wybierz właściciela z listy.';
        errorEl.hidden = false;
        return;
      }
    }
    const payload = { categoryId, sectionId, description, belongsToPersonId };
    try {
      await window.MutationFeedback.confirmed({
        execute: () => apiFetch(editingId ? `/equipment?id=${encodeURIComponent(editingId)}` : '/equipment', {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        apply: async ({ equipment: saved }) => {
          // Neither POST nor PUT /equipment's response carries canEdit/canDelete - only the GET
          // /equipment list handler synthesizes them (server.ts's handleListEquipment, always true
          // on every item, see its own comment). Without this merge, a freshly-added item would
          // render with no edit/delete buttons until the page reloads (equipmentActionsHtml gates
          // both on item.canEdit/canDelete), and editing an existing item would wholesale replace
          // its entry - dropping the canEdit/canDelete it already had from the GET response - and
          // lose its buttons the same way.
          const withPermissions = { ...saved, canEdit: true, canDelete: true };
          const idx = equipment.findIndex(i => i.id === withPermissions.id);
          if (idx === -1) equipment.push(withPermissions);
          else equipment[idx] = withPermissions;
          resetAddForm();
          form.hidden = true;
          renderBothTables();
        },
        refreshFragment: () => loadEquipment(),
        // Anchor on the always-visible header toggle, not submitButton: apply() hides
        // #equipment-add-form (and submitButton with it), which would bury the checkmark in a
        // hidden subtree - same reasoning as pliki.js's wireAddForm.
        toast: true,
        control: document.getElementById('equipment-add-toggle'),
        viewRoot: document.getElementById('equipment-tables'),
      });
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

function wireTableActions() {
  document.getElementById('equipment-tables').addEventListener('click', async e => {
    const editButton = e.target.closest('[data-edit-id]');
    if (editButton) {
      const item = equipment.find(i => i.id === editButton.dataset.editId);
      if (item) {
        document.getElementById('equipment-add-form').hidden = false;
        openAddFormForEdit(item);
      }
      return;
    }
    const deleteButton = e.target.closest('[data-delete-id]');
    if (deleteButton) {
      if (!window.confirm('Czy na pewno chcesz usunąć ten sprzęt?')) return;
      try {
        await window.MutationFeedback.confirmed({
          execute: () => apiFetch(`/equipment?id=${encodeURIComponent(deleteButton.dataset.deleteId)}`, { method: 'DELETE' }),
          apply: async () => {
            equipment = equipment.filter(i => i.id !== deleteButton.dataset.deleteId);
            renderBothTables();
          },
          refreshFragment: () => loadEquipment(),
          // Anchor on the always-visible header toggle, not the clicked button: apply() re-renders
          // the tables, detaching the clicked button - same reasoning as pliki.js's wireDeleteButtons.
          toast: true,
          control: document.getElementById('equipment-add-toggle'),
          viewRoot: document.getElementById('equipment-tables'),
        });
      } catch (err) {
        window.alert(`Nie udało się usunąć sprzętu: ${err.message}`);
        // Refresh even on failure: if the delete failed because someone else already removed the
        // item (404), the stale row would otherwise linger with a dead delete button.
        await loadEquipment();
      }
    }
  });
}

async function loadEquipment() {
  const { equipment: items } = await apiFetch('/equipment', { method: 'GET' });
  equipment = items;
  renderBothTables();
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/wojownicy-upload/whoami',
  onSignedIn: async () => {
    showOnly(null);
    wireAddForm();
    wireTableActions();
    wireTaxonomyEditor();
    wireSectionFilter();
    try {
      // GET /lista-wyjazdowa/persons is staff-only (skladki access or admin/hovding - see
      // isPersonStaff in server.ts), so it cannot resolve owners for this page, which every
      // member uses. GET /lista-wyjazdowa/roster is the member-open equivalent: it already
      // unions members + accountless persons into one list (same source czlonkowie.js's own
      // personById union uses), which is exactly what the owner picker and the private table's
      // Właściciel column need.
      const [{ equipment: items }, { members }, { roster }, lookupLists] = await Promise.all([
        apiFetch('/equipment', { method: 'GET' }),
        apiFetch('/members/directory', { method: 'GET' }),
        apiFetch('/lista-wyjazdowa/roster', { method: 'GET' }),
        apiFetch('/lista-wyjazdowa/lookup-lists', { method: 'GET' }),
      ]);
      applyLookupLists(lookupLists);

      const memberRows = members.map(m => ({
        personId: m.email,
        accountless: false,
        email: m.email,
        lastName: m.lastName,
        firstName: m.firstName,
        nickname: m.nickname,
        sectionId: m.sectionId,
        categoryId: m.categoryId,
      }));
      const personRows = roster
        .filter(person => person.accountless)
        .map(person => ({
          personId: person.personId,
          accountless: true,
          email: null,
          lastName: person.lastName,
          firstName: person.firstName,
          nickname: person.nickname,
          sectionId: person.sectionId,
          categoryId: person.categoryId,
        }));
      rosterList = [...memberRows, ...personRows];
      personById = new Map(rosterList.map(p => [p.personId, p]));

      populateCategorySelect(null);
      populateSectionSelect(null);
      populateOwnerDatalist();

      equipment = items;
      renderBothTables();
    } catch (err) {
      document.getElementById('equipment-tables').innerHTML = `<p class="pliki-empty">Nie udało się wczytać sprzętu: ${escapeHtml(err.message)}</p>`;
    }
  },
  onSignedOut: () => showOnly(panels.signedOut),
  onForbidden: () => showOnly(panels.forbidden),
});
