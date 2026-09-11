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

  function connectedErrorAnchor(anchor) {
    if (anchor && anchor.isConnected) return anchor;
    if (document.body && document.body.isConnected) return document.body;
    return document.documentElement;
  }

  function captureViewState(viewRoot) {
    const active = document.activeElement;
    return {
      scrollLeft: window.scrollX ?? 0,
      scrollTop: window.scrollY ?? 0,
      fragmentScrollTop: viewRoot?.scrollTop,
      focusId: active?.id || null,
    };
  }

  function restoreViewState(viewState, viewRoot) {
    if (viewRoot && viewState.fragmentScrollTop !== undefined) viewRoot.scrollTop = viewState.fragmentScrollTop;
    window.scrollTo?.({ left: viewState.scrollLeft, top: viewState.scrollTop });

    const focusTarget = viewState.focusId ? document.getElementById(viewState.focusId) : null;
    const fallbackTarget = viewRoot?.querySelector?.('button, input, select, textarea, a[href]');
    (focusTarget || fallbackTarget)?.focus?.({ preventScroll: true });
  }

  function showRefreshError(anchor, refreshFragment, viewRoot) {
    const viewState = captureViewState(viewRoot);
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
        restoreViewState(viewState, viewRoot);
      } finally {
        refreshing = false;
        refresh.disabled = false;
      }
    });

    error.append(refresh);
    if (anchor === document.body) {
      anchor.append(error);
    } else {
      insertAfter(anchor, error);
    }
  }

  async function confirmed({ execute, apply, refreshFragment, control, anchor, rollback, shouldShowCheck, viewRoot }) {
    const feedbackAnchor = anchor || control;
    let result;

    try {
      result = await execute();
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
      await apply(result);
      if (shouldShowCheck?.(result) === false) return result;
    } catch (error) {
      showRefreshError(connectedErrorAnchor(feedbackAnchor), refreshFragment, viewRoot || feedbackAnchor);
      throw error;
    }

    if (!feedbackAnchor || !feedbackAnchor.isConnected) {
      const error = new Error('Mutation confirmation anchor is no longer connected after applying the view update.');
      showRefreshError(connectedErrorAnchor(feedbackAnchor), refreshFragment, viewRoot || feedbackAnchor);
      throw error;
    }

    showCheck(feedbackAnchor);
    return result;
  }

  window.MutationFeedback = { confirmed };
}());
