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
      if (!Array.isArray((error as any)?.duplicateMatches)) throw error;
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
        const { successDetails, focusAfterApply, ...feedbackOptions } = options;
        const result = await mutationFeedback.confirmed({
          ...feedbackOptions,
          execute: () => run(options.execute, { fallbackFocus: options.fallbackFocus }),
          skipApplyWhen: (result: unknown) => wasCancelled(result) || options.skipApplyWhen?.(result),
          focusAfterApply: successDetails ? async (value: unknown) => {
            focusAfterApplyTarget = await focusAfterApply?.(value);
            return null;
          } : focusAfterApply,
        });
        if (!wasCancelled(result) && successDetails) {
          await successDetails(result);
          const target = focusAfterApplyTarget ?? options.fallbackFocus?.();
          if (target?.isConnected !== false) target?.focus?.({ preventScroll: true });
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
