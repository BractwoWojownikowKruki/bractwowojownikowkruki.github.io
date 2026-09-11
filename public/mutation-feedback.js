/* Global confirmation UI for mutations whose server write and local UI update both succeeded. */
(function () {
  function insertAfter(anchor, element) {
    anchor.insertAdjacentElement('afterend', element);
  }

  function showCheck(anchor) {
    const check = document.createElement('span');
    check.className = 'mutation-feedback-check';
    check.textContent = '✓';
    check.setAttribute('role', 'status');
    check.setAttribute('aria-label', 'Zapisano');
    insertAfter(anchor, check);
  }

  function showRefreshError(anchor, refreshFragment) {
    const error = document.createElement('span');
    error.className = 'mutation-feedback-error';
    error.setAttribute('role', 'alert');
    error.textContent = 'Nie udało się odświeżyć danych.';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'mutation-feedback-refresh';
    refresh.textContent = 'Odśwież ten fragment';
    let refreshing = false;
    refresh.addEventListener('click', async event => {
      event.preventDefault();
      if (refreshing) return;
      refreshing = true;
      refresh.disabled = true;
      try {
        await refreshFragment();
      } finally {
        refreshing = false;
        refresh.disabled = false;
      }
    });

    error.append(refresh);
    insertAfter(anchor, error);
  }

  async function confirmed({ execute, apply, refreshFragment, control, anchor, rollback }) {
    const feedbackAnchor = anchor || control;

    try {
      await execute();
    } catch (error) {
      if (rollback) {
        try {
          await rollback(error);
        } catch (_) {
          // The original mutation failure remains the actionable error for the caller.
        }
      }
      throw error;
    }

    try {
      await apply();
    } catch (error) {
      showRefreshError(feedbackAnchor, refreshFragment);
      throw error;
    }

    showCheck(feedbackAnchor);
  }

  window.MutationFeedback = { confirmed };
}());
