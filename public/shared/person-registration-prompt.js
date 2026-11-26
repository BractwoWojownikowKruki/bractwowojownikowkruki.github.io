// KRKG-142: one informational duplicate warning shared by every accountless-person registration
// form. It never selects a match; the caller retries only after an explicit "different person"
// confirmation, and cancellation prevents the write. Candidate fields are rendered as text.
(function () {
  const CANCELLED = Object.freeze({ cancelledDuplicateRegistration: true });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function candidateHtml(person) {
    const fullName = `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim();
    return `<li class="person-registration-match">
      <strong>${escapeHtml(fullName || '—')}</strong>
      ${person.nickname ? `<span>Ksywka: ${escapeHtml(person.nickname)}</span>` : ''}
      <span>Sekcja: ${escapeHtml(person.section || '—')}</span>
      <span>Właściciel: ${escapeHtml(person.owner || '—')}</span>
    </li>`;
  }

  function show(matches) {
    const dialog = document.createElement('dialog');
    dialog.className = 'person-registration-dialog';
    dialog.setAttribute('aria-labelledby', 'person-registration-title');
    dialog.innerHTML = `
      <div class="person-registration-dialog__content">
        <h2 id="person-registration-title">Czy ta osoba już istnieje?</h2>
        <p>Znaleźliśmy osoby bez konta o takim samym pseudonimie lub imieniu i nazwisku. Sprawdź poniższe dane. Jeśli to inna osoba, możesz kontynuować rejestrację w apce.</p>
        <ul class="person-registration-dialog__matches">${matches.map(candidateHtml).join('')}</ul>
        <div class="person-registration-dialog__actions">
          <button type="button" class="person-registration-dialog__confirm">Tak, zarejestruj, to zupełnie inna osoba.</button>
          <button type="button" class="person-registration-dialog__cancel">Anuluj</button>
        </div>
      </div>`;
    document.body.append(dialog);
    return new Promise((resolve) => {
      const finish = (confirmed) => {
        dialog.close();
        dialog.remove();
        resolve(confirmed);
      };
      dialog.querySelector('.person-registration-dialog__confirm').addEventListener('click', () => finish(true));
      dialog.querySelector('.person-registration-dialog__cancel').addEventListener('click', () => finish(false));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(false);
      }, { once: true });
      dialog.showModal();
      dialog.querySelector('.person-registration-dialog__confirm').focus();
    });
  }

  /**
   * Attempt registration and show the informational prompt only for server-confirmed matches.
   * @param {(duplicateConfirmed: boolean) => Promise<unknown>} execute
   */
  async function run(execute) {
    try {
      return await execute(false);
    } catch (error) {
      if (!Array.isArray(error?.duplicateMatches) || error.duplicateMatches.length === 0) throw error;
      if (!await show(error.duplicateMatches)) return CANCELLED;
      return execute(true);
    }
  }

  function wasCancelled(result) {
    return result === CANCELLED;
  }

  window.PersonRegistrationPrompt = { run, wasCancelled };
}());
