import { cyan, dim, green, red, yellow } from "../colors.js";
import type { ActionKind, PlannedAction, ApplyResult, ReconciliationPlan } from "./types.js";

function symbolFor(kind: ActionKind): string {
  if (kind.startsWith("create-")) return "+";
  if (kind.startsWith("update-")) return "~";
  if (kind.startsWith("delete-")) return "-";
  if (kind.startsWith("unassign-")) return "<-";
  if (kind.startsWith("assign-")) return "->";
  return "?";
}

/** Destructive actions (deletes and unassigns) are red regardless of exact
 * kind - that's the one distinction operators scanning a plan most need to
 * catch at a glance. Non-destructive kinds get a lighter, purely cosmetic
 * hint (create/update/assign). */
function colorFor(action: PlannedAction): (text: string) => string {
  if (action.destructive) return red;
  if (action.kind.startsWith("create-")) return green;
  if (action.kind.startsWith("update-")) return yellow;
  if (action.kind.startsWith("assign-")) return cyan;
  return (text: string) => text;
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
      lines.push(colorFor(action)(`  ${symbolFor(action.kind)} ${action.description}`));
    }
    lines.push("");
    lines.push(`${plan.actions.length} action(s) planned.`);
  }

  if (plan.conflicts.length > 0) {
    lines.push("");
    lines.push(red("Conflicts (need manual resolution):"));
    for (const conflict of plan.conflicts) lines.push(red(`  ! ${conflict}`));
  }

  if (opts.showProtected && plan.warnings.length > 0) {
    lines.push("");
    lines.push("Protected (left untouched):");
    for (const warning of plan.warnings) lines.push(dim(`  ! ${warning}`));
  }

  return lines.join("\n");
}

export function errorMessage(error: unknown): string {
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
      lines.push(red(`  x ${action.description}: ${errorMessage(error)}`));
    }
  }

  if (opts.showProtected && result.skippedProtected.length > 0) {
    lines.push("");
    lines.push("Protected (left untouched):");
    for (const warning of result.skippedProtected) lines.push(dim(`  ! ${warning}`));
  }

  return lines.join("\n");
}
