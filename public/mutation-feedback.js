/* Global confirmation UI for mutations whose server write and local UI update both succeeded. */
(function () {
  function insertAfter(anchor, element) {
    anchor.insertAdjacentElement('afterend', element);
  }

  function removeExistingChecks(anchor) {
    if (!anchor?.isConnected) return;
    let sibling = anchor.nextElementSibling;
    while (sibling?.classList?.contains('mutation-feedback-check')) {
      const next = sibling.nextElementSibling;
      sibling.remove();
      sibling = next;
    }
  }

  function showCheck(anchor) {
    removeExistingChecks(anchor);
    const check = document.createElement('span');
    check.className = 'mutation-feedback-check';
    check.textContent = '✓';
    check.setAttribute('role', 'status');
    check.setAttribute('aria-label', 'Zapisano');
    insertAfter(anchor, check);
  }

  const TOAST_VISIBLE_MS = 2500;
  const TOAST_FADE_MS = 400;
  let toastTimers = [];

  // Generic, reusable "saved" toast: a fixed, bottom-centre pill that fades out by itself. For
  // mutations that have no sensible spot for an inline check (the control is gone after a re-render).
  function showToast(message = 'Zapisano') {
    let toast = document.getElementById('mutation-feedback-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mutation-feedback-toast';
      toast.className = 'mutation-feedback-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.append(toast);
    }
    toastTimers.forEach(clearTimeout);
    toast.textContent = '✓ ' + message;
    toast.classList.remove('is-hiding');
    toast.classList.add('is-visible');
    toastTimers = [
      setTimeout(() => toast.classList.add('is-hiding'), TOAST_VISIBLE_MS),
      setTimeout(() => toast.classList.remove('is-visible', 'is-hiding'), TOAST_VISIBLE_MS + TOAST_FADE_MS),
    ];
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

  // Where the success confirmation goes:
  //  - `toast: true`            -> always the toast (no good inline spot at all);
  //  - anchor / control         -> inline check right after it while it is still connected;
  //  - `fallbackAnchor`         -> used only when apply() removed that element: an element or a
  //    function (evaluated after apply()) returning one, e.g. the freshly rendered twin of the
  //    control. If it is 'toast', or resolves to nothing connected, the toast is shown instead.
  async function confirmed({ execute, apply, refreshFragment, control, anchor, fallbackAnchor, toast, rollback, shouldShowCheck, viewRoot }) {
    let feedbackAnchor = anchor || control;
    removeExistingChecks(feedbackAnchor);
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

    if (toast) {
      showToast();
      return result;
    }

    if ((!feedbackAnchor || !feedbackAnchor.isConnected) && fallbackAnchor) {
      const fallback = typeof fallbackAnchor === 'function' ? fallbackAnchor() : fallbackAnchor;
      if (fallback?.isConnected) feedbackAnchor = fallback;
      else {
        showToast();
        return result;
      }
    }

    if (!feedbackAnchor || !feedbackAnchor.isConnected) {
      const error = new Error('Mutation confirmation anchor is no longer connected after applying the view update.');
      showRefreshError(connectedErrorAnchor(feedbackAnchor), refreshFragment, viewRoot || feedbackAnchor);
      throw error;
    }

    showCheck(feedbackAnchor);
    return result;
  }

  // Exposed for callers whose apply() replaces the DOM around `control` wholesale (e.g. the
  // profile drawer's editor panel, rebuilt from scratch on every save) and so cannot pass a
  // fixed anchor up front: they pass `shouldShowCheck: () => false` to skip confirmed()'s own
  // placement, then call this directly once apply() has re-rendered and they can look up the
  // freshly-rendered control to anchor the checkmark next to.
  window.MutationFeedback = { confirmed, showCheck, showToast };
}());
