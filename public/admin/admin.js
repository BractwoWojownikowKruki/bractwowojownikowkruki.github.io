function showReauth() {}
function hideReauth() {}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/admin/whoami',
  onSignedIn: payload => {
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-email').textContent = payload.email;
    document.getElementById('admin-panel').hidden = false;
    loadManageList();
  },
  onForbidden: () => {
    document.getElementById('admin-signin').hidden = true;
    document.getElementById('admin-forbidden').hidden = false;
  },
});

document.getElementById('add-person-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('add-person-status');
  status.textContent = 'Zapisywanie...';
  const category = document.getElementById('person-category').value;
  const name = document.getElementById('person-name').value.trim();
  const orderRaw = document.getElementById('person-order').value;
  const order = orderRaw === '' ? null : Number(orderRaw);
  const description = document.getElementById('person-description').value.trim();

  try {
    await apiFetch(
      '/admin/people',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, name, order, description }),
      },
      showReauth,
      hideReauth,
    );
    status.textContent = 'Dodano osobę.';
    document.getElementById('add-person-form').reset();
    loadManageList();
  } catch (err) {
    status.textContent = `Błąd: ${err.message}`;
  }
});

document.getElementById('manage-category').addEventListener('change', loadManageList);

async function loadManageList() {
  const category = document.getElementById('manage-category').value;
  const list = document.getElementById('manage-people-list');
  list.textContent = 'Ładowanie...';
  try {
    const data = await apiFetch(`/admin/people?category=${encodeURIComponent(category)}`, { method: 'GET' }, showReauth, hideReauth);
    renderManageList(data.people || []);
  } catch (err) {
    list.textContent = `Błąd: ${err.message}`;
  }
}

function renderManageList(people) {
  const list = document.getElementById('manage-people-list');
  if (!people.length) {
    list.innerHTML = '<p>Brak osób w tej kategorii.</p>';
    return;
  }
  list.innerHTML = people
    .map(
      p => `
    <div style="border:1px solid var(--border); border-radius:6px; padding:1rem; margin-bottom:1rem;">
      <strong>${escapeHtml(p.name)}</strong>
      <p style="color:var(--text-muted); font-size:13px;">${p.photos.length + (p.mainPhoto ? 1 : 0)} zdjęć</p>
      <textarea class="edit-description" data-folder-id="${p.folderId}" rows="3" style="width:100%; margin:0.5rem 0;">${escapeHtml(p.description)}</textarea>
      <button class="save-description" data-folder-id="${p.folderId}">Zapisz opis</button>
      <input type="file" class="upload-photo" data-folder-id="${p.folderId}" accept="image/*" multiple style="display:block; margin:0.5rem 0;" />
      <button class="delete-person" data-folder-id="${p.folderId}" style="color:var(--accent);">Usuń osobę</button>
    </div>`,
    )
    .join('');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.getElementById('manage-people-list').addEventListener('click', async e => {
  const saveBtn = e.target.closest('.save-description');
  if (saveBtn) {
    const folderId = saveBtn.dataset.folderId;
    const textarea = document.querySelector(`.edit-description[data-folder-id="${folderId}"]`);
    await apiFetch(
      `/admin/people/description?folderId=${encodeURIComponent(folderId)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: textarea.value }) },
      showReauth,
      hideReauth,
    );
    loadManageList();
    return;
  }
  const deleteBtn = e.target.closest('.delete-person');
  if (deleteBtn) {
    if (!window.confirm('Na pewno usunąć tę osobę?')) return;
    const folderId = deleteBtn.dataset.folderId;
    await apiFetch(`/admin/people?folderId=${encodeURIComponent(folderId)}`, { method: 'DELETE' }, showReauth, hideReauth);
    loadManageList();
  }
});

document.getElementById('manage-people-list').addEventListener('change', async e => {
  const input = e.target.closest('.upload-photo');
  if (!input || !input.files.length) return;
  const folderId = input.dataset.folderId;
  for (const file of input.files) {
    await apiFetch(
      `/admin/people/photo?folderId=${encodeURIComponent(folderId)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
      { method: 'POST', body: file },
      showReauth,
      hideReauth,
    );
  }
  input.value = '';
  loadManageList();
});
