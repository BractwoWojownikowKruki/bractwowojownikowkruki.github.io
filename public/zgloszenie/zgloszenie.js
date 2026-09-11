/**
 * "Zarejestruj się" self-service membership application (KRKG-0046). Reuses the site's existing
 * Google Sign-In (auth.js) exactly like every other member-area page - see profil.js's header
 * comment for the general apiFetch/initGoogleSignIn contract this follows.
 *
 * The one thing this page does differently: it's gated by GET /membership/whoami, not the usual
 * member whoamiPath (e.g. /wojownicy-upload/whoami) - that endpoint succeeds for *any* signed-in
 * Google account, member or not, returning {email, status} where status is null/pending/active/
 * suspended/rejected/removed. onForbidden never fires here (the endpoint has no allowlist to
 * reject against) - only onSignedOut (no session at all) and onSignedIn (any session, whatever
 * its status) are used.
 */

function showOnly(panel) {
  for (const p of Object.values(panels)) p.hidden = p !== panel;
}

const panels = {
  checking: document.getElementById('zg-checking'),
  signedOut: document.getElementById('zg-signin'),
  active: document.getElementById('zg-active'),
  pending: document.getElementById('zg-pending'),
  suspended: document.getElementById('zg-suspended'),
  form: document.getElementById('zg-form-panel'),
};

showOnly(panels.checking);

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function populateSectionSelect(select, sections) {
  select.innerHTML = sections
    .filter(s => !s.retired)
    .map(s => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.label)}</option>`)
    .join('');
}

let submitHandlerAttached = false;

async function showForm(previousStatus) {
  const form = document.getElementById('zg-form');
  const noteEl = document.getElementById('zg-form-note');
  if (previousStatus === 'rejected' || previousStatus === 'removed') {
    noteEl.textContent =
      previousStatus === 'rejected'
        ? 'Twoje poprzednie zgłoszenie zostało odrzucone. Możesz zgłosić się ponownie.'
        : 'Twoje członkostwo zostało zakończone. Możesz zgłosić się ponownie.';
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  try {
    const { sections } = await apiFetch('/membership/sections', { method: 'GET' });
    populateSectionSelect(form.sectionId, sections);
  } catch (err) {
    const errorEl = document.getElementById('zg-form-error');
    errorEl.textContent = `Nie udało się wczytać listy sekcji: ${err.message}`;
    errorEl.hidden = false;
  }

  if (!submitHandlerAttached) {
    submitHandlerAttached = true;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const errorEl = document.getElementById('zg-form-error');
      const submitBtn = document.getElementById('zg-form-submit');
      errorEl.hidden = true;
      submitBtn.disabled = true;
      try {
        await window.MutationFeedback.confirmed({
          control: submitBtn,
          anchor: panels.pending,
          execute: () => apiFetch('/membership/apply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: form.fullName.value || null, nickname: form.nickname.value || null, sectionId: form.sectionId.value }),
          }),
          apply: () => showOnly(panels.pending),
          viewRoot: panels.form,
          refreshFragment: () => showOnly(panels.pending),
        });
      } catch (err) {
        errorEl.textContent = `Błąd: ${err.message}`;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  showOnly(panels.form);
}

initGoogleSignIn({
  buttonIds: ['google-signin-button'],
  whoamiPath: '/membership/whoami',
  onSignedOut: () => showOnly(panels.signedOut),
  onSignedIn: identity => {
    if (identity.status === 'active') {
      showOnly(panels.active);
    } else if (identity.status === 'pending') {
      showOnly(panels.pending);
    } else if (identity.status === 'suspended') {
      showOnly(panels.suspended);
    } else {
      showForm(identity.status);
    }
  },
});
