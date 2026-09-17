import type { ApplyResult, PlannedAction, ReconciliationPlan } from "./types.js";

/** Reported by `applyPlan` before and after each action executes. */
export type ApplyProgressEvent =
  | { type: "start"; index: number; total: number; action: PlannedAction }
  | { type: "done"; index: number; total: number; action: PlannedAction; ok: boolean };

/**
 * Best-effort executor: run every planned action in order, continue past
 * individual failures, and report a summary. A transient failure on one of many
 * independent actions shouldn't abort a run that already correctly applied the
 * rest - and because the whole tool is idempotent, "best-effort + rerun" is a
 * strictly simpler recovery path than "fail-fast + manual cleanup."
 *
 * `plan.actions` is already ordered by buildPlan (via sortActions), so this just
 * executes in the given order.
 *
 * `onProgress`, if given, is called before and after each action - purely for
 * caller-side UX (e.g. a CLI progress indicator); it never affects execution.
 */
export async function applyPlan(
  plan: ReconciliationPlan,
  onProgress?: (event: ApplyProgressEvent) => void,
): Promise<ApplyResult> {
  const succeeded: PlannedAction[] = [];
  const failed: { action: PlannedAction; error: unknown }[] = [];
  const total = plan.actions.length;

  for (const [index, action] of plan.actions.entries()) {
    onProgress?.({ type: "start", index, total, action });
    const result = await action.execute();
    if (result.ok) {
      succeeded.push(action);
    } else {
      failed.push({ action, error: result.error });
    }
    onProgress?.({ type: "done", index, total, action, ok: result.ok });
  }

  return { succeeded, failed, skippedProtected: plan.warnings };
}
