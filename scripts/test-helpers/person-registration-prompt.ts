type MutationFeedbackMock = {
  confirmed(options: Record<string, any>): Promise<unknown>;
  showBusy?(message: string): (() => void) | void;
};

type MutationFeedbackMockOptions = {
  showBusy?: (message: string) => (() => void) | void;
};

/**
 * Shared MutationFeedback test double for page VM harnesses.
 * Runs execute, optional rollback, apply, skip, and focus hooks in the same order as confirmed().
 */
export function createMutationFeedbackMock({ showBusy }: MutationFeedbackMockOptions = {}) {
  return {
    showBusy: showBusy ?? (() => () => {}),
    showCheck: () => {},
    showToast: () => {},
    confirmed: async (options: Record<string, any>) => {
      let result: unknown;
      try {
        result = await options.execute();
      } catch (error) {
        if (options.rollback) await options.rollback(error);
        throw error;
      }
      if (options.skipApplyWhen?.(result)) return result;
      await options.apply?.(result);
      (await options.focusAfterApply?.(result))?.focus?.();
      return result;
    },
  };
}

type PromptOptions = {
  shouldCancelDuplicate?: (error: unknown) => boolean;
};

/** Shared page-test double for the registration duplicate and control-lock lifecycle. */
export function createPersonRegistrationPromptMock(
  mutationFeedback: MutationFeedbackMock,
  { shouldCancelDuplicate = () => false }: PromptOptions = {},
) {
  const cancelled = Object.freeze({ cancelledDuplicateRegistration: true });
  const alreadyInFlight = Object.freeze({ duplicateRegistrationAlreadyInFlight: true });
  const inFlightControls = new WeakSet<object>();

  const wasCancelled = (result: unknown) => result === cancelled || result === alreadyInFlight;
  const busyMessage = 'Rejestruję osobę w apce…';
  const run = async (execute: (duplicateConfirmed: boolean) => Promise<unknown>, options: { fallbackFocus?: () => { focus(): void } | null } = {}) => {
    try {
      return await execute(false);
    } catch (error) {
      if (!Array.isArray((error as any)?.duplicateMatches) || (error as any).duplicateMatches.length === 0) throw error;
      if (shouldCancelDuplicate(error)) {
        options.fallbackFocus?.()?.focus();
        return cancelled;
      }
      return execute(true);
    }
  };

  return {
    run,
    wasCancelled,
    confirmed: async (options: Record<string, any>) => {
      const control = options.control as (object & { disabled?: boolean }) | undefined;
      if (control && inFlightControls.has(control)) return alreadyInFlight;
      const wasDisabled = control?.disabled;
      if (control) {
        inFlightControls.add(control);
        control.disabled = true;
      }
      let hideBusy: (() => void) | null = null;
      const releaseBusy = () => {
        hideBusy?.();
        hideBusy = null;
      };
      const unlockControl = () => {
        if (control) control.disabled = wasDisabled;
      };
      const executeAttempt = async (duplicateConfirmed: boolean) => {
        if (control) control.disabled = true;
        hideBusy ??= mutationFeedback.showBusy?.(busyMessage) ?? null;
        try {
          return await options.execute(duplicateConfirmed);
        } catch (error) {
          releaseBusy();
          unlockControl();
          throw error;
        }
      };
      try {
        let focusAfterApplyTarget: any;
        let focusAfterApplyResolved = false;
        let skippedByCaller = false;
        const { successDetails, focusAfterApply, ...feedbackOptions } = options;
        const result = await mutationFeedback.confirmed({
          ...feedbackOptions,
          execute: () => run(executeAttempt, { fallbackFocus: options.fallbackFocus }),
          skipApplyWhen: (result: unknown) => {
            if (wasCancelled(result)) return true;
            skippedByCaller = Boolean(options.skipApplyWhen?.(result));
            return skippedByCaller;
          },
          focusAfterApply: successDetails ? async (value: unknown) => {
            try {
              focusAfterApplyTarget = await focusAfterApply?.(value);
            } catch {
              focusAfterApplyTarget = null;
            } finally {
              focusAfterApplyResolved = true;
            }
            return null;
          } : focusAfterApply,
          apply: async (value: unknown) => {
            try {
              await options.apply?.(value);
            } finally {
              releaseBusy();
            }
          },
        });
        if (wasCancelled(result)) {
          releaseBusy();
          unlockControl();
        }
        if (!wasCancelled(result) && !skippedByCaller && successDetails) {
          await successDetails(result);
          let preferredTarget = focusAfterApplyTarget;
          if (!focusAfterApplyResolved) {
            try { preferredTarget = await focusAfterApply?.(result); } catch { preferredTarget = null; }
          }
          const target = preferredTarget?.isConnected !== false && !preferredTarget?.disabled
            ? preferredTarget
            : options.fallbackFocus?.();
          if (target?.isConnected !== false && !target?.disabled) target?.focus?.({ preventScroll: true });
        }
        return result;
      } finally {
        releaseBusy();
        unlockControl();
        if (control) inFlightControls.delete(control);
      }
    },
  };
}
