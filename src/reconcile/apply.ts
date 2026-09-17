import type { ApplyResult, PlannedAction, ReconciliationPlan } from "./types.js";

/**
 * Best-effort executor: run every planned action in order, continue past
 * individual failures, and report a summary. A transient failure on one of many
 * independent actions shouldn't abort a run that already correctly applied the
 * rest - and because the whole tool is idempotent, "best-effort + rerun" is a
 * strictly simpler recovery path than "fail-fast + manual cleanup."
 *
 * `plan.actions` is already ordered by buildPlan (via sortActions), so this just
 * executes in the given order.
 */
export async function applyPlan(plan: ReconciliationPlan): Promise<ApplyResult> {
  const succeeded: PlannedAction[] = [];
  const failed: { action: PlannedAction; error: unknown }[] = [];

  for (const action of plan.actions) {
    const result = await action.execute();
    if (result.ok) {
      succeeded.push(action);
    } else {
      failed.push({ action, error: result.error });
    }
  }

  return { succeeded, failed, skippedProtected: plan.warnings };
}
