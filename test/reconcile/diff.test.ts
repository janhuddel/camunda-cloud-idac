import { describe, expect, it } from "vitest";
import { buildPlan } from "../../src/reconcile/diff.js";
import { Spec } from "../../src/spec/schema.js";
import { currentState } from "../fixtures/current-state.fixtures.js";
import type { ActionKind } from "../../src/reconcile/types.js";

function kinds(actions: { kind: ActionKind }[]): ActionKind[] {
  return actions.map((a) => a.kind);
}

const emptySpec = () => Spec.parse({});

describe("buildPlan - entity create/update/no-op", () => {
  it("plans a create for a role that doesn't exist yet", () => {
    const spec = Spec.parse({ ...emptySpec(), roles: [{ roleId: "r1", name: "R1" }] });
    const plan = buildPlan(spec, currentState({}), "additive");
    expect(kinds(plan.actions)).toEqual(["create-role"]);
  });

  it("plans an update when name/description drift", () => {
    const spec = Spec.parse({ roles: [{ roleId: "r1", name: "New Name" }] });
    const current = currentState({ roles: [{ roleId: "r1", name: "Old Name", description: null }] });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual(["update-role"]);
  });

  it("is a no-op when the entity already matches", () => {
    const spec = Spec.parse({ roles: [{ roleId: "r1", name: "R1", description: "desc" }] });
    const current = currentState({ roles: [{ roleId: "r1", name: "R1", description: "desc" }] });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });

  it("treats an undefined spec description as equal to a null current description", () => {
    const spec = Spec.parse({ roles: [{ roleId: "r1", name: "R1" }] });
    const current = currentState({ roles: [{ roleId: "r1", name: "R1", description: null }] });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });
});

describe("buildPlan - additive mode never deletes", () => {
  it("does not delete an extra current role when the spec doesn't mention it", () => {
    const spec = emptySpec();
    const current = currentState({ roles: [{ roleId: "extra", name: "Extra", description: null }] });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });
});

describe("buildPlan - prune mode deletes extras", () => {
  it("deletes a current role not present in the spec", () => {
    const spec = emptySpec();
    const current = currentState({ roles: [{ roleId: "extra", name: "Extra", description: null }] });
    const plan = buildPlan(spec, current, "prune");
    expect(kinds(plan.actions)).toEqual(["delete-role"]);
  });

  it("deletes a current tenant, group, and mapping rule not present in the spec", () => {
    const spec = emptySpec();
    const current = currentState({
      tenants: [{ tenantId: "t1", name: "T1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      mappingRules: [{ mappingRuleId: "m1", claimName: "c", claimValue: "v", name: "m1" }],
    });
    const plan = buildPlan(spec, current, "prune");
    expect(kinds(plan.actions).sort()).toEqual(["delete-group", "delete-mapping-rule", "delete-tenant"].sort());
  });
});

describe("buildPlan - relationship diffing", () => {
  it("assigns a role-to-group pair declared in the spec but missing live", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "r1", name: "R1", groups: ["g1"] }],
      groups: [{ groupId: "g1", name: "G1" }],
    });
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual(["assign-role-group"]);
  });

  it("assigns a mapping rule declared under a tenant's mappingRules", () => {
    const spec = Spec.parse({
      tenants: [{ tenantId: "workflow", name: "Workflow", mappingRules: ["m-group-workflow"] }],
      mappingRules: [{ mappingRuleId: "m-group-workflow", claimName: "groups", claimValue: "AAD-Camunda-Workflow" }],
    });
    const current = currentState({
      tenants: [{ tenantId: "workflow", name: "Workflow", description: null }],
      mappingRules: [
        { mappingRuleId: "m-group-workflow", claimName: "groups", claimValue: "AAD-Camunda-Workflow", name: "m-group-workflow" },
      ],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual(["assign-tenant-mapping-rule"]);
  });

  it("does not re-assign a tenant mapping-rule pair that's already live (idempotent)", () => {
    const spec = Spec.parse({
      tenants: [{ tenantId: "workflow", name: "Workflow", mappingRules: ["m-group-workflow"] }],
      mappingRules: [{ mappingRuleId: "m-group-workflow", claimName: "groups", claimValue: "AAD-Camunda-Workflow" }],
    });
    const current = currentState({
      tenants: [{ tenantId: "workflow", name: "Workflow", description: null }],
      mappingRules: [
        { mappingRuleId: "m-group-workflow", claimName: "groups", claimValue: "AAD-Camunda-Workflow", name: "m-group-workflow" },
      ],
      relationships: { tenantMappingRule: new Set(["workflow::m-group-workflow"]) },
    });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });

  it("unassigns a stale tenant mapping-rule pair no longer in the spec, in prune mode only", () => {
    const spec = Spec.parse({
      tenants: [{ tenantId: "workflow", name: "Workflow" }],
    });
    const current = currentState({
      tenants: [{ tenantId: "workflow", name: "Workflow", description: null }],
      relationships: { tenantMappingRule: new Set(["workflow::m-stale"]) },
    });
    expect(buildPlan(spec, current, "additive").actions).toHaveLength(0);
    expect(kinds(buildPlan(spec, current, "prune").actions)).toEqual(["unassign-tenant-mapping-rule"]);
  });

  it("assigns a user and a client declared under a group's users/clients", () => {
    const spec = Spec.parse({
      groups: [{ groupId: "admin", name: "Admin", users: ["camunda-admin@provinzial.de"], clients: ["ci-bot"] }],
    });
    const current = currentState({ groups: [{ groupId: "admin", name: "Admin", description: null }] });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions).sort()).toEqual(["assign-group-client", "assign-group-user"]);
  });

  it("assigns a user declared under a role's users (the admin-role case)", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "admin", name: "Admin", users: ["camunda-admin@provinzial.de"] }],
    });
    const current = currentState({ roles: [{ roleId: "admin", name: "Admin", description: null }] });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual(["assign-role-user"]);
  });

  it("does not re-assign a role user pair that's already live (idempotent)", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "admin", name: "Admin", users: ["camunda-admin@provinzial.de"] }],
    });
    const current = currentState({
      roles: [{ roleId: "admin", name: "Admin", description: null }],
      relationships: { roleUser: new Set(["admin::camunda-admin@provinzial.de"]) },
    });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });

  it("does not re-assign a group user/client pair that's already live (idempotent)", () => {
    const spec = Spec.parse({
      groups: [{ groupId: "admin", name: "Admin", users: ["camunda-admin@provinzial.de"] }],
    });
    const current = currentState({
      groups: [{ groupId: "admin", name: "Admin", description: null }],
      relationships: { groupUser: new Set(["admin::camunda-admin@provinzial.de"]) },
    });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });

  it("does not re-assign a pair that's already live (idempotent)", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "r1", name: "R1", groups: ["g1"] }],
      groups: [{ groupId: "g1", name: "G1" }],
    });
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      relationships: { roleGroup: new Set(["r1::g1"]) },
    });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });

  it("unassigns a live pair no longer in the spec, in prune mode only", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "r1", name: "R1" }],
      groups: [{ groupId: "g1", name: "G1" }],
    });
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      relationships: { roleGroup: new Set(["r1::g1"]) },
    });

    const additivePlan = buildPlan(spec, current, "additive");
    expect(additivePlan.actions).toHaveLength(0);

    const prunePlan = buildPlan(spec, current, "prune");
    expect(kinds(prunePlan.actions)).toEqual(["unassign-role-group"]);
  });
});

describe("buildPlan - cascading deletes in prune mode", () => {
  it("unassigns and deletes-authorization for a role before deleting the role itself", () => {
    const spec = emptySpec();
    const current = currentState({
      roles: [{ roleId: "old-role", name: "Old", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      mappingRules: [{ mappingRuleId: "m1", claimName: "c", claimValue: "v", name: "m1" }],
      tenants: [{ tenantId: "t1", name: "T1", description: null }],
      authorizations: [
        {
          authorizationKey: "key-1",
          ownerId: "old-role",
          ownerType: "ROLE",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissionTypes: ["READ"],
        },
      ],
      relationships: {
        roleGroup: new Set(["old-role::g1"]),
        roleMappingRule: new Set(["old-role::m1"]),
        groupMappingRule: new Set(),
        tenantRole: new Set(["t1::old-role"]),
        tenantGroup: new Set(),
      },
    });

    const plan = buildPlan(spec, current, "prune");
    const actualKinds = kinds(plan.actions);

    // Every unassign/delete-authorization touching old-role must precede delete-role.
    const deleteRoleIndex = actualKinds.indexOf("delete-role");
    expect(deleteRoleIndex).toBeGreaterThan(-1);
    for (const [i, kind] of actualKinds.entries()) {
      if (kind.startsWith("unassign-") || kind === "delete-authorization") {
        expect(i).toBeLessThan(deleteRoleIndex);
      }
    }
    expect(actualKinds).toContain("unassign-role-group");
    expect(actualKinds).toContain("unassign-role-mapping-rule");
    expect(actualKinds).toContain("unassign-tenant-role");
    expect(actualKinds).toContain("delete-authorization");
  });
});

describe("buildPlan - authorization full-replace semantics", () => {
  it("creates an authorization with no existing match", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "r1", name: "R1" }],
      authorizations: [
        { ownerType: "ROLE", ownerId: "r1", resourceType: "PROCESS_DEFINITION", resourceId: "*", permissions: ["READ"] },
      ],
    });
    const plan = buildPlan(spec, currentState({ roles: [{ roleId: "r1", name: "R1", description: null }] }), "additive");
    expect(kinds(plan.actions)).toEqual(["create-authorization"]);
  });

  it("updates when permissions differ for the same tuple", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "r1", name: "R1" }],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ", "CREATE"],
        },
      ],
    });
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      authorizations: [
        {
          authorizationKey: "key-1",
          ownerId: "r1",
          ownerType: "ROLE",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissionTypes: ["READ"],
        },
      ],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual(["update-authorization"]);
  });

  it("is a no-op when permission sets match regardless of order", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "r1", name: "R1" }],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["CREATE", "READ"],
        },
      ],
    });
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      authorizations: [
        {
          authorizationKey: "key-1",
          ownerId: "r1",
          ownerType: "ROLE",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissionTypes: ["READ", "CREATE"],
        },
      ],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
  });
});

describe("buildPlan - mapping rule claim conflicts", () => {
  it("skips creating a mapping rule whose claim already belongs to a different live mappingRuleId, and reports it as a conflict", () => {
    const spec = Spec.parse({
      mappingRules: [{ mappingRuleId: "new-id", claimName: "azp", claimValue: "123" }],
    });
    const current = currentState({
      mappingRules: [{ mappingRuleId: "old-id", claimName: "azp", claimValue: "123", name: "old-id" }],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain("new-id");
    expect(plan.conflicts[0]).toContain("old-id");
    expect(plan.conflicts[0]).toContain("azp=123");
  });

  it("also skips role/group/tenant assignments and authorizations referencing the conflicted mappingRuleId", () => {
    const spec = Spec.parse({
      mappingRules: [{ mappingRuleId: "new-id", claimName: "azp", claimValue: "123" }],
      roles: [{ roleId: "r1", name: "R1", mappingRules: ["new-id"] }],
      groups: [{ groupId: "g1", name: "G1", mappingRules: ["new-id"] }],
      tenants: [{ tenantId: "t1", name: "T1", mappingRules: ["new-id"] }],
      authorizations: [
        {
          ownerType: "MAPPING_RULE",
          ownerId: "new-id",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ"],
        },
      ],
    });
    const current = currentState({
      mappingRules: [{ mappingRuleId: "old-id", claimName: "azp", claimValue: "123", name: "old-id" }],
      roles: [{ roleId: "r1", name: "R1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      tenants: [{ tenantId: "t1", name: "T1", description: null }],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(kinds(plan.actions)).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("does not flag a conflict when the spec's mappingRuleId matches the live one for the same claim (update path)", () => {
    const spec = Spec.parse({
      mappingRules: [{ mappingRuleId: "m1", claimName: "azp", claimValue: "123", name: "Renamed" }],
    });
    const current = currentState({
      mappingRules: [{ mappingRuleId: "m1", claimName: "azp", claimValue: "123", name: "Old Name" }],
    });
    const plan = buildPlan(spec, current, "additive");
    expect(plan.conflicts).toHaveLength(0);
    expect(kinds(plan.actions)).toEqual(["update-mapping-rule"]);
  });

  it("does not flag a conflict for two spec entries with different claims", () => {
    const spec = Spec.parse({
      mappingRules: [
        { mappingRuleId: "m1", claimName: "azp", claimValue: "123" },
        { mappingRuleId: "m2", claimName: "azp", claimValue: "456" },
      ],
    });
    const plan = buildPlan(spec, currentState({}), "additive");
    expect(plan.conflicts).toHaveLength(0);
    expect(kinds(plan.actions).sort()).toEqual(["create-mapping-rule", "create-mapping-rule"]);
  });
});
