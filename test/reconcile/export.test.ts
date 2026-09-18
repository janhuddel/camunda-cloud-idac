import { describe, expect, it } from "vitest";
import { stateToSpec, SpecExportError } from "../../src/reconcile/export.js";
import { buildPlan } from "../../src/reconcile/diff.js";
import { EMPTY_SPEC } from "../../src/spec/schema.js";
import { currentState, emptyState } from "../fixtures/current-state.fixtures.js";

describe("stateToSpec - basic entity mapping", () => {
  it("maps one of each entity type with no relationships", () => {
    const current = currentState({
      tenants: [{ tenantId: "t1", name: "T1", description: "tenant desc" }],
      roles: [{ roleId: "r1", name: "R1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      mappingRules: [{ mappingRuleId: "m1", claimName: "c", claimValue: "v", name: "M1" }],
      authorizations: [
        {
          authorizationKey: "auth-1",
          ownerId: "r1",
          ownerType: "ROLE",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissionTypes: ["READ"],
        },
      ],
    });

    const spec = stateToSpec(current);

    expect(spec.tenants).toEqual([{ tenantId: "t1", name: "T1", description: "tenant desc", roles: [], groups: [], mappingRules: [] }]);
    expect(spec.roles).toEqual([{ roleId: "r1", name: "R1", mappingRules: [], groups: [], users: [], clients: [] }]);
    expect(spec.groups).toEqual([{ groupId: "g1", name: "G1", mappingRules: [], users: [], clients: [] }]);
    expect(spec.mappingRules).toEqual([{ mappingRuleId: "m1", claimName: "c", claimValue: "v", name: "M1" }]);
    expect(spec.authorizations).toEqual([
      { ownerId: "r1", ownerType: "ROLE", resourceType: "PROCESS_DEFINITION", resourceId: "*", permissions: ["READ"] },
    ]);
  });
});

describe("stateToSpec - description handling", () => {
  it("omits the description key when null", () => {
    const current = currentState({ roles: [{ roleId: "r1", name: "R1", description: null }] });
    const spec = stateToSpec(current);
    expect(spec.roles[0]).not.toHaveProperty("description");
  });

  it("preserves a non-null description", () => {
    const current = currentState({ groups: [{ groupId: "g1", name: "G1", description: "some text" }] });
    const spec = stateToSpec(current);
    expect(spec.groups[0].description).toBe("some text");
  });
});

describe("stateToSpec - relationship unflattening", () => {
  it("reconstructs all 10 relationship kinds, grouping multiple children per parent", () => {
    const current = currentState({
      tenants: [
        { tenantId: "t1", name: "T1", description: null },
        { tenantId: "t2", name: "T2", description: null },
      ],
      roles: [
        { roleId: "r1", name: "R1", description: null },
        { roleId: "r2", name: "R2", description: null },
      ],
      groups: [
        { groupId: "g1", name: "G1", description: null },
        { groupId: "g2", name: "G2", description: null },
      ],
      mappingRules: [
        { mappingRuleId: "m1", claimName: "c1", claimValue: "v1", name: "M1" },
        { mappingRuleId: "m2", claimName: "c2", claimValue: "v2", name: "M2" },
      ],
      relationships: {
        roleGroup: new Set(["r1::g2", "r1::g1"]),
        roleMappingRule: new Set(["r1::m1", "r1::m2"]),
        roleUser: new Set(["r1::bob", "r1::alice"]),
        roleClient: new Set(["r1::client-b", "r1::client-a"]),
        groupMappingRule: new Set(["g1::m1", "g1::m2"]),
        groupUser: new Set(["g1::bob", "g1::alice"]),
        groupClient: new Set(["g1::client-b", "g1::client-a"]),
        tenantRole: new Set(["t1::r2", "t1::r1"]),
        tenantGroup: new Set(["t1::g2", "t1::g1"]),
        tenantMappingRule: new Set(["t1::m2", "t1::m1"]),
      },
    });

    const spec = stateToSpec(current);
    const role1 = spec.roles.find((r) => r.roleId === "r1")!;
    const group1 = spec.groups.find((g) => g.groupId === "g1")!;
    const tenant1 = spec.tenants.find((t) => t.tenantId === "t1")!;

    expect(role1.groups).toEqual(["g1", "g2"]);
    expect(role1.mappingRules).toEqual(["m1", "m2"]);
    expect(role1.users).toEqual(["alice", "bob"]);
    expect(role1.clients).toEqual(["client-a", "client-b"]);
    expect(group1.mappingRules).toEqual(["m1", "m2"]);
    expect(group1.users).toEqual(["alice", "bob"]);
    expect(group1.clients).toEqual(["client-a", "client-b"]);
    expect(tenant1.roles).toEqual(["r1", "r2"]);
    expect(tenant1.groups).toEqual(["g1", "g2"]);
    expect(tenant1.mappingRules).toEqual(["m1", "m2"]);
  });
});

describe("stateToSpec - authorizations", () => {
  it("renames permissionTypes to permissions (sorted) and drops authorizationKey", () => {
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      authorizations: [
        {
          authorizationKey: "auth-1",
          ownerId: "r1",
          ownerType: "ROLE",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissionTypes: ["READ", "CREATE"],
        },
      ],
    });

    const spec = stateToSpec(current);

    expect(spec.authorizations).toEqual([
      { ownerId: "r1", ownerType: "ROLE", resourceType: "PROCESS_DEFINITION", resourceId: "*", permissions: ["CREATE", "READ"] },
    ]);
    expect(spec.authorizations[0]).not.toHaveProperty("authorizationKey");
    expect(spec.authorizations[0]).not.toHaveProperty("permissionTypes");
  });
});

describe("stateToSpec - determinism", () => {
  it("produces identical output regardless of entity/relationship insertion order", () => {
    const base = {
      roles: [
        { roleId: "r1", name: "R1", description: null },
        { roleId: "r2", name: "R2", description: null },
      ],
      groups: [{ groupId: "g1", name: "G1", description: null }],
    };

    const currentA = currentState({
      ...base,
      relationships: { roleGroup: new Set(["r1::g1", "r2::g1"]) },
    });
    const currentB = currentState({
      roles: [...base.roles].reverse(),
      groups: base.groups,
      relationships: { roleGroup: new Set(["r2::g1", "r1::g1"]) },
    });

    expect(stateToSpec(currentA)).toEqual(stateToSpec(currentB));
  });
});

describe("stateToSpec - round-trip idempotency", () => {
  it("produces a spec that diffs to zero actions and zero conflicts against the state it came from", () => {
    const current = currentState({
      tenants: [{ tenantId: "t1", name: "T1", description: "d" }],
      roles: [{ roleId: "r1", name: "R1", description: null }],
      groups: [{ groupId: "g1", name: "G1", description: null }],
      mappingRules: [{ mappingRuleId: "m1", claimName: "c", claimValue: "v", name: "M1" }],
      authorizations: [
        {
          authorizationKey: "auth-1",
          ownerId: "r1",
          ownerType: "ROLE",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissionTypes: ["READ"],
        },
      ],
      relationships: {
        roleGroup: new Set(["r1::g1"]),
        roleMappingRule: new Set(["r1::m1"]),
        tenantRole: new Set(["t1::r1"]),
        tenantGroup: new Set(["t1::g1"]),
        tenantMappingRule: new Set(["t1::m1"]),
      },
    });

    const spec = stateToSpec(current);
    const plan = buildPlan(spec, current, "additive");

    expect(plan.actions).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });
});

describe("stateToSpec - invalid state", () => {
  it("throws SpecExportError when a relationship references a since-deleted entity", () => {
    const current = currentState({
      roles: [{ roleId: "r1", name: "R1", description: null }],
      relationships: {
        roleMappingRule: new Set(["r1::stale-mr"]),
      },
    });

    expect(() => stateToSpec(current)).toThrow(SpecExportError);
  });
});

describe("stateToSpec - empty state", () => {
  it("equals EMPTY_SPEC for an empty cluster", () => {
    expect(stateToSpec(emptyState())).toEqual(EMPTY_SPEC);
  });
});
