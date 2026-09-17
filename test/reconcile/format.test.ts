import { describe, expect, it } from "vitest";
import { formatApplyResult, formatPlan } from "../../src/reconcile/format.js";
import type { ApplyResult, PlannedAction, ReconciliationPlan } from "../../src/reconcile/types.js";

function fakeAction(description: string): PlannedAction {
  return {
    kind: "create-role",
    description,
    destructive: false,
    target: { kind: "other" },
    execute: async () => ({ ok: true, value: undefined }),
  };
}

describe("formatPlan", () => {
  const plan: ReconciliationPlan = {
    actions: [fakeAction('create role "process-owner"')],
    warnings: ['BLOCKED (the <default> system tenant must never be deleted): delete tenant "<default>"'],
    conflicts: [],
  };

  it("hides protection warnings by default - they're structural noise once the policy is known", () => {
    const output = formatPlan(plan);
    expect(output).toContain('create role "process-owner"');
    expect(output).not.toContain("Protected");
    expect(output).not.toContain("BLOCKED");
  });

  it("shows protection warnings when showProtected is true", () => {
    const output = formatPlan(plan, { showProtected: true });
    expect(output).toContain("Protected (left untouched):");
    expect(output).toContain("BLOCKED");
  });

  it("never shows an empty 'Protected' header when there are no warnings, even with showProtected", () => {
    const noWarnings: ReconciliationPlan = { actions: [], warnings: [], conflicts: [] };
    const output = formatPlan(noWarnings, { showProtected: true });
    expect(output).not.toContain("Protected");
  });

  it("always shows conflicts, unlike protection warnings, since they need a spec change and aren't structural noise", () => {
    const withConflict: ReconciliationPlan = {
      actions: [],
      warnings: [],
      conflicts: ['mapping rule "new-id" (claim azp=123) cannot be created: mapping rule "old-id" already uses this exact claim.'],
    };
    const output = formatPlan(withConflict);
    expect(output).toContain("Conflicts (need manual resolution):");
    expect(output).toContain("new-id");
    expect(output).toContain("old-id");
  });
});

describe("formatApplyResult", () => {
  const result: ApplyResult = {
    succeeded: [fakeAction('create role "process-owner"')],
    failed: [],
    skippedProtected: ['BLOCKED (...): delete tenant "<default>"'],
  };

  it("hides protection warnings by default", () => {
    const output = formatApplyResult(result);
    expect(output).toContain("1 succeeded, 0 failed.");
    expect(output).not.toContain("Protected");
  });

  it("shows protection warnings when showProtected is true", () => {
    const output = formatApplyResult(result, { showProtected: true });
    expect(output).toContain("Protected (left untouched):");
  });
});
