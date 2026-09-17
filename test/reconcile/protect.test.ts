import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProtections } from "../../src/reconcile/protect.js";
import { buildPlan } from "../../src/reconcile/diff.js";
import { Spec } from "../../src/spec/schema.js";
import { currentState } from "../fixtures/current-state.fixtures.js";
import type { PlannedAction } from "../../src/reconcile/types.js";

function fakeAction(partial: Partial<PlannedAction> & Pick<PlannedAction, "kind" | "target">): PlannedAction {
  return {
    description: partial.kind,
    destructive: true,
    execute: async () => ({ ok: true, value: undefined }),
    ...partial,
  };
}

describe("applyProtections - unit level", () => {
  it("blocks deleting the admin role", () => {
    const action = fakeAction({ kind: "delete-role", target: { kind: "delete-role", roleId: "admin" } });
    const { actions, warnings } = applyProtections([action]);
    expect(actions).toHaveLength(0);
    expect(warnings[0]).toMatch(/admin.*role.*never be deleted/i);
  });

  it("does NOT block deleting the admin group - the group has no special protection anymore", () => {
    const action = fakeAction({ kind: "delete-group", target: { kind: "delete-group", groupId: "admin" } });
    const { actions, warnings } = applyProtections([action]);
    expect(actions).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("blocks deleting the <default> tenant", () => {
    const action = fakeAction({ kind: "delete-tenant", target: { kind: "delete-tenant", tenantId: "<default>" } });
    const { actions, warnings } = applyProtections([action]);
    expect(actions).toHaveLength(0);
    expect(warnings[0]).toMatch(/default.*tenant.*never be deleted/i);
  });

  it("blocks creating, updating, and deleting authorizations owned by ROLE:admin", () => {
    const actions = [
      fakeAction({ kind: "create-authorization", target: { kind: "authorization", ownerType: "ROLE", ownerId: "admin" } }),
      fakeAction({ kind: "update-authorization", target: { kind: "authorization", ownerType: "ROLE", ownerId: "admin" } }),
      fakeAction({ kind: "delete-authorization", target: { kind: "authorization", ownerType: "ROLE", ownerId: "admin" } }),
    ];
    const { actions: kept, warnings } = applyProtections(actions);
    expect(kept).toHaveLength(0);
    expect(warnings).toHaveLength(3);
    for (const w of warnings) expect(w).toMatch(/authorizations.*"admin".*never be created, updated, or deleted/i);
  });

  it("does NOT block authorization mutations for GROUP:admin - the group has no special protection anymore", () => {
    const actions = [
      fakeAction({ kind: "create-authorization", target: { kind: "authorization", ownerType: "GROUP", ownerId: "admin" } }),
      fakeAction({ kind: "delete-authorization", target: { kind: "authorization", ownerType: "GROUP", ownerId: "admin" } }),
    ];
    const { actions: kept, warnings } = applyProtections(actions);
    expect(kept).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it("does NOT block deleting a non-admin role/tenant", () => {
    const actions = [
      fakeAction({ kind: "delete-role", target: { kind: "delete-role", roleId: "not-admin" } }),
      fakeAction({ kind: "delete-tenant", target: { kind: "delete-tenant", tenantId: "some-tenant" } }),
    ];
    const { actions: kept, warnings } = applyProtections(actions);
    expect(kept).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  it("does NOT block an authorization mutation for a different owner named similarly", () => {
    const action = fakeAction({
      kind: "delete-authorization",
      target: { kind: "authorization", ownerType: "USER", ownerId: "admin" },
    });
    const { actions } = applyProtections([action]);
    // ownerType USER:admin is not the protected ROLE:admin - allowed through.
    expect(actions).toHaveLength(1);
  });

  it("blocks unassigning the admin role from the <default> tenant", () => {
    const action = fakeAction({
      kind: "unassign-tenant-role",
      target: { kind: "unassign-tenant-role", tenantId: "<default>", roleId: "admin" },
    });
    const { actions, warnings } = applyProtections([action]);
    expect(actions).toHaveLength(0);
    expect(warnings[0]).toMatch(/admin.*never be unassigned.*<default>/i);
  });

  it("does NOT block unassigning a different role from the <default> tenant", () => {
    const action = fakeAction({
      kind: "unassign-tenant-role",
      target: { kind: "unassign-tenant-role", tenantId: "<default>", roleId: "not-admin" },
    });
    const { actions, warnings } = applyProtections([action]);
    expect(actions).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("does NOT block unassigning the admin role from a non-default tenant", () => {
    const action = fakeAction({
      kind: "unassign-tenant-role",
      target: { kind: "unassign-tenant-role", tenantId: "some-tenant", roleId: "admin" },
    });
    const { actions, warnings } = applyProtections([action]);
    expect(actions).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("does NOT block unassign-* actions that remove a member from the admin role", () => {
    const actions = [
      fakeAction({ kind: "unassign-role-group", target: { kind: "other" } }),
      fakeAction({ kind: "unassign-role-mapping-rule", target: { kind: "other" } }),
      fakeAction({ kind: "unassign-tenant-role", target: { kind: "other" } }),
      fakeAction({ kind: "unassign-group-user", target: { kind: "other" } }),
      fakeAction({ kind: "unassign-group-client", target: { kind: "other" } }),
      fakeAction({ kind: "unassign-role-user", target: { kind: "other" } }),
    ];
    const { actions: kept, warnings } = applyProtections(actions);
    expect(kept).toHaveLength(6);
    expect(warnings).toHaveLength(0);
  });

  describe("guardian client (CAMUNDA_CLIENT_ID) protection", () => {
    const ORIGINAL_ENV = process.env.CAMUNDA_CLIENT_ID;

    beforeEach(() => {
      process.env.CAMUNDA_CLIENT_ID = "tool-service-account";
    });

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.CAMUNDA_CLIENT_ID;
      else process.env.CAMUNDA_CLIENT_ID = ORIGINAL_ENV;
    });

    it("blocks unassigning the guardian client from the admin role", () => {
      const action = fakeAction({
        kind: "unassign-role-client",
        target: { kind: "unassign-role-client", roleId: "admin", clientId: "tool-service-account" },
      });
      const { actions, warnings } = applyProtections([action]);
      expect(actions).toHaveLength(0);
      expect(warnings[0]).toMatch(/tool-service-account.*admin.*lock/i);
    });

    it("does NOT block unassigning a different client from the admin role", () => {
      const action = fakeAction({
        kind: "unassign-role-client",
        target: { kind: "unassign-role-client", roleId: "admin", clientId: "some-other-client" },
      });
      const { actions, warnings } = applyProtections([action]);
      expect(actions).toHaveLength(1);
      expect(warnings).toHaveLength(0);
    });

    it("does NOT block unassigning the guardian client from a non-admin role", () => {
      const action = fakeAction({
        kind: "unassign-role-client",
        target: { kind: "unassign-role-client", roleId: "process-owner", clientId: "tool-service-account" },
      });
      const { actions } = applyProtections([action]);
      expect(actions).toHaveLength(1);
    });

    it("does not blow up and does not block anything when CAMUNDA_CLIENT_ID is unset", () => {
      delete process.env.CAMUNDA_CLIENT_ID;
      const action = fakeAction({
        kind: "unassign-role-client",
        target: { kind: "unassign-role-client", roleId: "admin", clientId: "tool-service-account" },
      });
      const { actions, warnings } = applyProtections([action]);
      expect(actions).toHaveLength(1);
      expect(warnings).toHaveLength(0);
    });
  });
});

describe("applyProtections - integration with buildPlan (prune mode)", () => {
  it("never queues the admin role or its authorizations for mutation, even when the spec never mentions it - but the admin group is treated like any other group", () => {
    const spec = Spec.parse({});
    const current = currentState({
      roles: [{ roleId: "admin", name: "Admin", description: null }],
      groups: [{ groupId: "admin", name: "Admin", description: null }],
      tenants: [{ tenantId: "<default>", name: "Default", description: null }],
      authorizations: [
        {
          authorizationKey: "admin-auth-1",
          ownerId: "admin",
          ownerType: "ROLE",
          resourceType: "RESOURCE",
          resourceId: "*",
          permissionTypes: ["ACCESS"],
        },
        {
          authorizationKey: "admin-auth-2",
          ownerId: "admin",
          ownerType: "GROUP",
          resourceType: "RESOURCE",
          resourceId: "*",
          permissionTypes: ["ACCESS"],
        },
      ],
    });

    const plan = buildPlan(spec, current, "prune");
    const kinds = plan.actions.map((a) => a.kind);

    // The admin group and its own authorization are no longer protected - both
    // get pruned like any other unreferenced entity.
    expect(kinds).toContain("delete-group");
    expect(kinds).toContain("delete-authorization"); // the GROUP:admin one
    expect(kinds.filter((k) => k === "delete-authorization")).toHaveLength(1); // only the group one, not the role one

    // The role and its authorization are still fully protected.
    expect(kinds).not.toContain("delete-role");
    expect(plan.warnings.some((w) => /"admin".*role.*never be deleted/i.test(w))).toBe(true);
    expect(plan.warnings.some((w) => /authorizations.*"admin".*never be created, updated, or deleted/i.test(w))).toBe(
      true,
    );
    expect(plan.warnings.some((w) => /default.*tenant/i.test(w))).toBe(true);
  });

  it("still allows adding new members to the admin group via assign, and does not block unassign of a stale one", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "admin", name: "Admin", groups: ["admin"] }],
      groups: [
        { groupId: "admin", name: "Admin", mappingRules: ["m-new"], users: ["camunda-admin@provinzial.de"] },
      ],
      mappingRules: [{ mappingRuleId: "m-new", claimName: "groups", claimValue: "admins" }],
    });
    const current = currentState({
      roles: [{ roleId: "admin", name: "Admin", description: null }],
      groups: [{ groupId: "admin", name: "Admin", description: null }],
      mappingRules: [{ mappingRuleId: "m-new", claimName: "groups", claimValue: "admins", name: "m-new" }],
      relationships: {
        groupMappingRule: new Set(["admin::m-stale"]),
      },
    });

    const plan = buildPlan(spec, current, "prune");
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain("assign-role-group"); // adding admin role to admin group is allowed
    expect(kinds).toContain("assign-group-mapping-rule"); // adding new mapping rule to admin group
    expect(kinds).toContain("assign-group-user"); // adding a new user to admin group is allowed
    expect(kinds).toContain("unassign-group-mapping-rule"); // removing the stale one is allowed too
    expect(plan.warnings).toHaveLength(0);
  });

  it("allows assigning a new user directly to the admin role, even in prune mode", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "admin", name: "Admin", users: ["camunda-admin@provinzial.de"] }],
    });
    const current = currentState({ roles: [{ roleId: "admin", name: "Admin", description: null }] });

    const plan = buildPlan(spec, current, "prune");
    expect(plan.actions.map((a) => a.kind)).toEqual(["assign-role-user"]);
    expect(plan.warnings).toHaveLength(0);
  });

  it("blocks creating a new ROLE:admin authorization declared in the spec - admin's authorizations are fully hands-off", () => {
    const spec = Spec.parse({
      roles: [{ roleId: "admin", name: "Admin" }],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "admin",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ"],
        },
      ],
    });
    const current = currentState({ roles: [{ roleId: "admin", name: "Admin", description: null }] });

    const plan = buildPlan(spec, current, "additive");
    expect(plan.actions).toHaveLength(0);
    expect(plan.warnings.some((w) => /authorizations.*"admin".*never be created, updated, or deleted/i.test(w))).toBe(
      true,
    );
  });

  it("never unassigns the admin role from the <default> tenant during a full prune reset", () => {
    const spec = Spec.parse({}); // spec says nothing about tenant-role assignments
    const current = currentState({
      roles: [{ roleId: "admin", name: "Admin", description: null }],
      tenants: [{ tenantId: "<default>", name: "Default", description: null }],
      relationships: { tenantRole: new Set(["<default>::admin"]) },
    });

    const plan = buildPlan(spec, current, "prune");
    expect(plan.actions.map((a) => a.kind)).not.toContain("unassign-tenant-role");
    expect(plan.warnings.some((w) => /admin.*never be unassigned.*<default>/i.test(w))).toBe(true);
  });

  it("still prunes a non-admin role from the <default> tenant", () => {
    const spec = Spec.parse({});
    const current = currentState({
      roles: [{ roleId: "process-owner", name: "Process Owner", description: null }],
      tenants: [{ tenantId: "<default>", name: "Default", description: null }],
      relationships: { tenantRole: new Set(["<default>::process-owner"]) },
    });

    const plan = buildPlan(spec, current, "prune");
    expect(plan.actions.map((a) => a.kind)).toContain("unassign-tenant-role");
  });

  describe("guardian client protection end-to-end", () => {
    const ORIGINAL_ENV = process.env.CAMUNDA_CLIENT_ID;

    beforeEach(() => {
      process.env.CAMUNDA_CLIENT_ID = "tool-service-account";
    });

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.CAMUNDA_CLIENT_ID;
      else process.env.CAMUNDA_CLIENT_ID = ORIGINAL_ENV;
    });

    it("never unassigns the tool's own client from the admin role during a full prune reset", () => {
      const spec = Spec.parse({}); // spec says nothing about admin's client assignments
      const current = currentState({
        roles: [{ roleId: "admin", name: "Admin", description: null }],
        relationships: { roleClient: new Set(["admin::tool-service-account"]) },
      });

      const plan = buildPlan(spec, current, "prune");
      expect(plan.actions.map((a) => a.kind)).not.toContain("unassign-role-client");
      expect(plan.warnings.some((w) => /tool-service-account.*admin.*lock/i.test(w))).toBe(true);
    });

    it("still prunes a different, non-guardian client from the admin role", () => {
      const spec = Spec.parse({});
      const current = currentState({
        roles: [{ roleId: "admin", name: "Admin", description: null }],
        relationships: { roleClient: new Set(["admin::some-other-client"]) },
      });

      const plan = buildPlan(spec, current, "prune");
      expect(plan.actions.map((a) => a.kind)).toContain("unassign-role-client");
    });
  });
});
