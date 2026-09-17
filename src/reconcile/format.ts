import type { ActionKind, ApplyResult, ReconciliationPlan } from "./types.js";

function symbolFor(kind: ActionKind): string {
  if (kind.startsWith("create-")) return "+";
  if (kind.startsWith("update-")) return "~";
  if (kind.startsWith("delete-")) return "-";
  if (kind.startsWith("unassign-")) return "<-";
  if (kind.startsWith("assign-")) return "->";
  return "?";
}

/** Shared renderer used by both `plan` and the pre-confirmation display in `apply`,
 * so what `apply` is about to do is guaranteed to match what `plan` reported.
 *
 * Protection warnings (admin role/authorizations/guardian client blocked from a
 * would-be deletion, the <default> tenant, etc.) are structural and permanent -
 * they'll fire on every single prune run for as long as those invariants exist,
 * so they're noise once you already know the policy. Hidden by default; pass
 * `showProtected: true` to see them (e.g. while first verifying the guard). */
export function formatPlan(plan: ReconciliationPlan, opts: { showProtected?: boolean } = {}): string {
  const lines: string[] = [];

  if (plan.actions.length === 0) {
    lines.push("No changes - cluster state already matches the spec.");
  } else {
    for (const action of plan.actions) {
      lines.push(`  ${symbolFor(action.kind)} ${action.description}`);
    }
    lines.push("");
    lines.push(`${plan.actions.length} action(s) planned.`);
  }

  if (opts.showProtected && plan.warnings.length > 0) {
    lines.push("");
    lines.push("Protected (left untouched):");
    for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function formatApplyResult(result: ApplyResult, opts: { showProtected?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`${result.succeeded.length} succeeded, ${result.failed.length} failed.`);

  if (result.failed.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const { action, error } of result.failed) {
      lines.push(`  x ${action.description}: ${errorMessage(error)}`);
    }
  }

  if (opts.showProtected && result.skippedProtected.length > 0) {
    lines.push("");
    lines.push("Protected (left untouched):");
    for (const warning of result.skippedProtected) lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}
