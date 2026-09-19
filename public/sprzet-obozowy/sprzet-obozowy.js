/**
 * Protected member-zone Sprzęt obozowy page (KRKG-0096 batch 2/5). Same panel-swap pattern as
 * pliki.js: lists the club's camp equipment (namiot/wiata) split into a drużynowy (team-owned,
 * belongsToPersonId === null) and a prywatny (belongsToPersonId is a personId) table, lets any
 * signed-in member add/edit/delete any item against the /equipment HTTP contract (Batch 1), and
 * confirms every mutation through the shared MutationFeedback.confirmed() UX used site-wide.
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
 * pure function (no DOM) so the matching rule can be unit-tested directly - same
 * displayName()-based, Polish-locale-aware substring match the rest of this site's filters use
 * (see czlonkowie.js's renderTable filter). An empty/whitespace-only query matches nothing, same
 * as the datalist has nothing useful to suggest until the member starts typing.
 *
 * @param {Array<{nickname?: string|null, fullName?: string|null, email?: string|null}>} roster
 * @param {string} query
 */
function filterOwnerCandidates(roster, query) {
  const needle = String(query ?? '').trim().toLocaleLowerCase('pl');
  if (!needle) return [];
  return roster.filter(person => displayName(person).toLocaleLowerCase('pl').includes(needle));
}

let equipment = [];
let equipmentCategories = [];
let sections = [];
let categoryLabelById = new Map();
let sectionLabelById = new Map();
// personId -> { personId, accountless, email, fullName, nickname, sectionId, categoryId } -
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
  const ownerCell = includeOwner ? `<td>${ownerCellHtml(item.belongsToPersonId)}</td>` : '';
  return `
    <tr data-equipment-id="${escapeAttr(item.id)}">
      <td>${escapeHtml(categoryLabel)}</td>
      <td class="czl-section-cell" title="${escapeAttr(sectionLabel ?? '')}">${item.sectionId ? escapeHtml(sectionAbbr(item.sectionId)) : ''}</td>
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

function renderTeamTable() {
  const { team } = splitEquipmentByOwnership(equipment);
  const enriched = team.map(item => ({
    ...item,
    categoryLabel: categoryLabelById.get(item.categoryId) ?? item.categoryId,
    sectionLabel: sectionLabelById.get(item.sectionId) ?? item.sectionId,
  }));
  const sorted = sortItems(enriched, teamSortState);
  const tbody = document.getElementById('equipment-team-table-body');
  tbody.innerHTML = sorted.length
    ? sorted.map(item => equipmentRowHtml(item, { includeOwner: false })).join('')
    : '<tr><td colspan="4" class="czl-empty">Brak sprzętu drużynowego.</td></tr>';
}

function renderPrivateTable() {
  const { private: privateItems } = splitEquipmentByOwnership(equipment);
  const enriched = privateItems.map(item => {
    const owner = personById.get(item.belongsToPersonId);
    return {
      ...item,
      categoryLabel: categoryLabelById.get(item.categoryId) ?? item.categoryId,
      sectionLabel: sectionLabelById.get(item.sectionId) ?? item.sectionId,
      ownerName: owner ? displayName(owner) : item.belongsToPersonId,
    };
  });
  const sorted = sortItems(enriched, privateSortState);
  const tbody = document.getElementById('equipment-private-table-body');
  tbody.innerHTML = sorted.length
    ? sorted.map(item => equipmentRowHtml(item, { includeOwner: true })).join('')
    : '<tr><td colspan="5" class="czl-empty">Brak sprzętu prywatnego.</td></tr>';
}

function renderBothTables() {
  renderTeamTable();
  renderPrivateTable();
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
    renderOwnerDatalistOptions(filterOwnerCandidates(rosterList, ownerInput.value));

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
    try {
      // GET /lista-wyjazdowa/persons is staff-only (skladki access or admin/moderator - see
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
      equipmentCategories = lookupLists.equipmentCategories ?? [];
      sections = lookupLists.sections ?? [];
      categoryLabelById = new Map(equipmentCategories.map(c => [c.id, c.label]));
      sectionLabelById = new Map(sections.map(s => [s.id, s.label]));

      const memberRows = members.map(m => ({
        personId: m.email,
        accountless: false,
        email: m.email,
        fullName: m.fullName,
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
          fullName: person.fullName,
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
