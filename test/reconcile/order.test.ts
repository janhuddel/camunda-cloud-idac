import { describe, expect, it } from "vitest";
import { sortActions } from "../../src/reconcile/order.js";
import type { ActionKind, PlannedAction } from "../../src/reconcile/types.js";

function action(kind: ActionKind): PlannedAction {
  return {
    kind,
    description: kind,
    destructive: false,
    target: { kind: "other" },
    execute: async () => ({ ok: true, value: undefined }),
  };
}

describe("sortActions", () => {
  it("orders create/update phases: tenants, mapping rules, groups, roles, assigns, then authorizations", () => {
    const shuffled: ActionKind[] = [
      "create-authorization",
      "assign-tenant-group",
      "assign-role-group",
      "create-role",
      "assign-role-mapping-rule",
      "create-group",
      "assign-tenant-role",
      "create-mapping-rule",
      "assign-group-mapping-rule",
      "create-tenant",
    ];
    const sorted = sortActions(shuffled.map(action)).map((a) => a.kind);
    expect(sorted).toEqual([
      "create-tenant",
      "create-mapping-rule",
      "create-group",
      "create-role",
      "assign-group-mapping-rule",
      "assign-role-mapping-rule",
      "assign-role-group",
      "assign-tenant-role",
      "assign-tenant-group",
      "create-authorization",
    ]);
  });

  it("orders delete/unassign phases: authorizations first, then unassigns, then entity deletes last", () => {
    const shuffled: ActionKind[] = [
      "delete-tenant",
      "unassign-role-group",
      "delete-authorization",
      "delete-role",
      "unassign-tenant-group",
      "unassign-group-mapping-rule",
      "delete-group",
      "unassign-tenant-role",
      "delete-mapping-rule",
      "unassign-role-mapping-rule",
    ];
    const sorted = sortActions(shuffled.map(action)).map((a) => a.kind);

    expect(sorted[0]).toBe("delete-authorization");
    const deleteAuthIndex = sorted.indexOf("delete-authorization");
    const unassignIndices = sorted
      .map((k, i) => [k, i] as const)
      .filter(([k]) => k.startsWith("unassign-"))
      .map(([, i]) => i);
    const entityDeleteIndices = sorted
      .map((k, i) => [k, i] as const)
      .filter(([k]) => k !== "delete-authorization" && k.startsWith("delete-"))
      .map(([, i]) => i);

    // All unassigns come after the authorization delete and before every entity delete.
    for (const i of unassignIndices) {
      expect(i).toBeGreaterThan(deleteAuthIndex);
      for (const j of entityDeleteIndices) expect(i).toBeLessThan(j);
    }
  });

  it("places create-tenant before create-role even when input order is reversed", () => {
    const sorted = sortActions([action("create-role"), action("create-tenant")]).map((a) => a.kind);
    expect(sorted).toEqual(["create-tenant", "create-role"]);
  });
});
