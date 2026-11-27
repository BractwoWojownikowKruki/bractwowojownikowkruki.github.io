type MutationFeedbackMock = {
  confirmed(options: Record<string, any>): Promise<unknown>;
};

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
      try {
        let focusAfterApplyTarget: any;
        let focusAfterApplyResolved = false;
        const { successDetails, focusAfterApply, ...feedbackOptions } = options;
        const result = await mutationFeedback.confirmed({
          ...feedbackOptions,
          execute: () => run(async (duplicateConfirmed) => {
            if (control) control.disabled = true;
            try {
              return await options.execute(duplicateConfirmed);
            } catch (error) {
              if (control) control.disabled = wasDisabled;
              throw error;
            }
          }, { fallbackFocus: options.fallbackFocus }),
          skipApplyWhen: (result: unknown) => wasCancelled(result) || options.skipApplyWhen?.(result),
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
        });
        if (!wasCancelled(result) && successDetails) {
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
        if (control) {
          control.disabled = wasDisabled;
          inFlightControls.delete(control);
        }
      }
    },
  };
}
