// KRKG-142: one informational duplicate warning shared by every accountless-person registration
// form. It never selects a match; the caller retries only after an explicit "different person"
// confirmation, and cancellation prevents the write. Candidate fields are rendered as text.
(function () {
  const CANCELLED = Object.freeze({ cancelledDuplicateRegistration: true });
  const IN_FLIGHT = Object.freeze({ duplicateRegistrationAlreadyInFlight: true });
  let dialogSequence = 0;
  const inFlightControls = new WeakSet();
  const BUSY_MESSAGE = 'Rejestruję osobę w apce…';

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
      ${person.owner ? `<span>Osoba towarzysząca od: ${escapeHtml(person.owner)}</span>` : ''}
    </li>`;
  }

  function restoreFocus(target) {
    if (target?.isConnected && !target.disabled) target.focus();
  }

  function manageDialog(dialog, returnFocus, closeValue, onFinish, configure, afterOpen) {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      restoreFocus(returnFocus);
      onFinish?.(value);
      return value;
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(closeValue);
    }, { once: true });
    dialog.addEventListener('close', () => finish(closeValue), { once: true });
    configure?.(finish);
    try {
      document.body.append(dialog);
      dialog.showModal();
    } catch (error) {
      dialog.remove();
      throw error;
    }
    afterOpen?.();
    return finish;
  }

  function show(matches, fallbackFocus) {
    const activeElement = document.activeElement;
    const fallbackTarget = typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus;
    const returnFocus = activeElement && activeElement !== document.body && activeElement.isConnected && !activeElement.disabled
      ? activeElement
      : fallbackTarget;
    const dialog = document.createElement('dialog');
    const titleId = `person-registration-title-${++dialogSequence}`;
    const descriptionId = `person-registration-description-${dialogSequence}`;
    dialog.className = 'person-registration-dialog';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', descriptionId);
    dialog.innerHTML = `
      <div class="person-registration-dialog__content">
        <h2 id="${titleId}">Czy ta osoba już istnieje?</h2>
        <p id="${descriptionId}">Znaleźliśmy osoby bez konta o takim samym pseudonimie lub imieniu i nazwisku. Wśród osób towarzyszących przypisanych do tego samego konta sprawdzamy też samo imię. Sprawdź poniższe dane. Jeśli to inna osoba, możesz kontynuować rejestrację w apce.</p>
        <ul class="person-registration-dialog__matches" aria-labelledby="${titleId}" tabindex="0">${matches.map(candidateHtml).join('')}</ul>
        <div class="person-registration-dialog__actions">
          <button type="button" class="person-registration-dialog__confirm">Tak, zarejestruj, to zupełnie inna osoba.</button>
          <button type="button" class="person-registration-dialog__cancel">Anuluj</button>
        </div>
      </div>`;
    return new Promise((resolve) => {
      try {
        manageDialog(dialog, returnFocus, false, resolve, (finish) => {
          dialog.querySelector('.person-registration-dialog__confirm').addEventListener('click', () => finish(true));
          dialog.querySelector('.person-registration-dialog__cancel').addEventListener('click', () => finish(false));
        }, () => dialog.querySelector('.person-registration-dialog__cancel').focus());
      } catch (_) {
        restoreFocus(returnFocus);
        resolve(false);
        return;
      }
    });
  }

  /**
   * Attempt registration and show the informational prompt only for server-confirmed matches.
   * @param {(duplicateConfirmed: boolean) => Promise<unknown>} execute
   * @param {{fallbackFocus?: Element|(() => Element|null)}} options
   */
  async function run(execute, { fallbackFocus } = {}) {
    try {
      return await execute(false);
    } catch (error) {
      if (!Array.isArray(error?.duplicateMatches) || error.duplicateMatches.length === 0) throw error;
      if (!await show(error.duplicateMatches, fallbackFocus)) return CANCELLED;
      return execute(true);
    }
  }

  function wasCancelled(result) {
    return result === CANCELLED || result === IN_FLIGHT;
  }

  function showSuccess(details, preferredFocus) {
    const person = details?.person;
    if (!person) return Promise.resolve();
    const fullName = `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim();
    const nickname = person.ksywka ?? person.nickname;
    const status = details.statusLabel ?? person.categoryLabel ?? '—';
    const section = details.sectionLabel ?? person.sectionLabel ?? '—';
    const rows = [
      fullName ? `<p><strong>Imię i nazwisko:</strong> ${escapeHtml(fullName)}</p>` : '',
      nickname ? `<p><strong>Ksywka:</strong> ${escapeHtml(nickname)}</p>` : '',
      status ? `<p><strong>Status:</strong> ${escapeHtml(status)}</p>` : '',
      section ? `<p><strong>Sekcja:</strong> ${escapeHtml(section)}</p>` : '',
    ].filter(Boolean).join('');
    const activeElement = document.activeElement;
    const returnFocus = preferredFocus?.isConnected && !preferredFocus.disabled
      ? preferredFocus
      : activeElement && activeElement !== document.body && activeElement.isConnected && !activeElement.disabled
        ? activeElement
        : null;
    const dialog = document.createElement('dialog');
    const sequence = ++dialogSequence;
    dialog.className = 'person-registration-success-dialog';
    dialog.setAttribute('aria-labelledby', `person-registration-success-title-${sequence}`);
    dialog.setAttribute('aria-describedby', `person-registration-success-details-${sequence}`);
    dialog.innerHTML = `<div class="person-registration-success-dialog__content">
      <h2 id="person-registration-success-title-${sequence}">Osoba została zarejestrowana w apce</h2>
      <div id="person-registration-success-details-${sequence}" class="person-registration-success-dialog__details">${rows}</div>
      <button type="button" class="person-registration-success-dialog__done">Gotowe</button>
    </div>`;
    return new Promise((resolve, reject) => {
      try {
        manageDialog(dialog, returnFocus, undefined, resolve, (finish) => {
          dialog.querySelector('.person-registration-success-dialog__done').addEventListener('click', () => finish(undefined));
        }, () => dialog.querySelector('.person-registration-success-dialog__done').focus());
      } catch (error) {
        reject(error);
        return;
      }
    });
  }

  /**
   * Run an accountless-person mutation through the shared feedback lifecycle. Each request attempt
   * owns a blocking busy overlay; duplicate matches suspend it while the informational prompt is
   * open, and successful creation keeps it until the caller has refreshed its view.
   */
  async function confirmed({ execute, fallbackFocus, successDetails, apply, skipApplyWhen, ...feedbackOptions }) {
    const control = feedbackOptions.control;
    if (control && inFlightControls.has(control)) return IN_FLIGHT;
    if (control) inFlightControls.add(control);
    const originalDisabled = control?.disabled;
    let hideBusy = null;
    const releaseBusy = () => {
      hideBusy?.();
      hideBusy = null;
    };
    const unlockControl = () => {
      if (control) control.disabled = originalDisabled;
    };
    const focusFallback = () => {
      const target = typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus;
      if (target?.isConnected && !target.disabled) target.focus();
    };
    const executeAttempt = async (duplicateConfirmed) => {
      if (control) control.disabled = true;
      hideBusy ??= window.MutationFeedback.showBusy(BUSY_MESSAGE);
      try {
        return await execute(duplicateConfirmed);
      } catch (error) {
        releaseBusy();
        unlockControl();
        throw error;
      }
    };
    let focusAfterApplyTarget;
    let focusAfterApplyResolved = false;
    const originalFocusAfterApply = feedbackOptions.focusAfterApply;
    const deferFocusUntilSuccessCloses = typeof successDetails === 'function';
    try {
      const result = await window.MutationFeedback.confirmed({
        ...feedbackOptions,
        focusAfterApply: deferFocusUntilSuccessCloses ? async (value) => {
          try {
            focusAfterApplyTarget = await originalFocusAfterApply?.(value);
          } catch (_) {
            focusAfterApplyTarget = null;
          } finally {
            focusAfterApplyResolved = true;
          }
          return null;
        } : originalFocusAfterApply,
        execute: async () => {
          try {
            const result = await run(executeAttempt, { fallbackFocus });
            if (wasCancelled(result)) {
              releaseBusy();
              unlockControl();
            }
            return result;
          } catch (error) {
            releaseBusy();
            unlockControl();
            focusFallback();
            throw error;
          }
        },
        apply: async (result) => {
          try {
            await apply?.(result);
          } finally {
            releaseBusy();
          }
        },
        skipApplyWhen: (result) => wasCancelled(result) || skipApplyWhen?.(result),
      });
      if (!wasCancelled(result) && successDetails) {
        const successFocus = focusAfterApplyResolved ? focusAfterApplyTarget : await originalFocusAfterApply?.(result);
        const returnFocus = successFocus ?? (typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus);
        try {
          const details = await successDetails(result);
          if (details?.person) await showSuccess(details, returnFocus);
          else restoreFocus(returnFocus);
        } catch (_) {
          window.MutationFeedback.showToast('Osoba została zarejestrowana w apce');
          restoreFocus(returnFocus);
        }
      }
      return result;
    } finally {
      releaseBusy();
      unlockControl();
      if (control) inFlightControls.delete(control);
    }
  }

  window.PersonRegistrationPrompt = { run, confirmed, wasCancelled };
}());
