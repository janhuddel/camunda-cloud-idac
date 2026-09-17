import { describe, expect, it } from "vitest";
import { Spec } from "../../src/spec/schema.js";

const base = {
  tenants: [],
  roles: [],
  groups: [],
  mappingRules: [],
  authorizations: [],
};

describe("Spec schema", () => {
  it("accepts the canonical example spec", () => {
    const result = Spec.safeParse({
      tenants: [
        { tenantId: "default", name: "Default Tenant", roles: ["process-owner"], groups: ["ops-team"] },
      ],
      roles: [
        {
          roleId: "process-owner",
          name: "Process Owner",
          description: "Vollzugriff auf Prozessdefinitionen",
          mappingRules: ["m-process-owner"],
          groups: ["ops-team"],
        },
      ],
      groups: [{ groupId: "ops-team", name: "Ops Team", mappingRules: ["m-ops"] }],
      mappingRules: [
        { mappingRuleId: "m-process-owner", claimName: "groups", claimValue: "process-owners" },
        { mappingRuleId: "m-ops", claimName: "groups", claimValue: "ops" },
      ],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "process-owner",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["CREATE", "READ", "UPDATE_PROCESS_INSTANCE"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty spec (all fields default to [])", () => {
    expect(Spec.safeParse({}).success).toBe(true);
  });

  it("rejects a role referencing an unknown mappingRuleId", () => {
    const result = Spec.safeParse({
      ...base,
      roles: [{ roleId: "r1", name: "R1", mappingRules: ["does-not-exist"] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("does-not-exist");
    }
  });

  it("rejects a role referencing an unknown groupId", () => {
    const result = Spec.safeParse({
      ...base,
      roles: [{ roleId: "r1", name: "R1", groups: ["ghost-group"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a group referencing an unknown mappingRuleId", () => {
    const result = Spec.safeParse({
      ...base,
      groups: [{ groupId: "g1", name: "G1", mappingRules: ["ghost-rule"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tenant referencing an unknown roleId", () => {
    const result = Spec.safeParse({
      ...base,
      tenants: [{ tenantId: "t1", name: "T1", roles: ["ghost-role"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tenant referencing an unknown groupId", () => {
    const result = Spec.safeParse({
      ...base,
      tenants: [{ tenantId: "t1", name: "T1", groups: ["ghost-group"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tenant referencing an unknown mappingRuleId", () => {
    const result = Spec.safeParse({
      ...base,
      tenants: [{ tenantId: "t1", name: "T1", mappingRules: ["ghost-rule"] }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a tenant referencing a declared mappingRuleId", () => {
    const result = Spec.safeParse({
      ...base,
      mappingRules: [{ mappingRuleId: "m1", claimName: "groups", claimValue: "AAD-Camunda-Workflow" }],
      tenants: [{ tenantId: "t1", name: "T1", mappingRules: ["m1"] }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an authorization with a ROLE owner that doesn't exist", () => {
    const result = Spec.safeParse({
      ...base,
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "ghost-role",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("allows a USER owner even though users aren't declared entities", () => {
    const result = Spec.safeParse({
      ...base,
      authorizations: [
        {
          ownerType: "USER",
          ownerId: "someone@example.com",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate roleId values", () => {
    const result = Spec.safeParse({
      ...base,
      roles: [
        { roleId: "dup", name: "One" },
        { roleId: "dup", name: "Two" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate authorization tuples with different permissions", () => {
    const result = Spec.safeParse({
      ...base,
      roles: [{ roleId: "r1", name: "R1" }],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ"],
        },
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["CREATE"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("allows duplicate authorization tuples with identical permissions", () => {
    const result = Spec.safeParse({
      ...base,
      roles: [{ roleId: "r1", name: "R1" }],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["READ", "CREATE"],
        },
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["CREATE", "READ"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown permission literal", () => {
    const result = Spec.safeParse({
      ...base,
      roles: [{ roleId: "r1", name: "R1" }],
      authorizations: [
        {
          ownerType: "ROLE",
          ownerId: "r1",
          resourceType: "PROCESS_DEFINITION",
          resourceId: "*",
          permissions: ["NOT_A_REAL_PERMISSION"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized key instead of silently ignoring it (e.g. singular mappingRuleId instead of mappingRules)", () => {
    const result = Spec.safeParse({
      ...base,
      groups: [{ groupId: "g1", name: "G1", mappingRuleId: ["some-rule"] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/mappingRuleId/);
    }
  });

  it("rejects an unrecognized top-level key", () => {
    const result = Spec.safeParse({ ...base, mappingRule: [] });
    expect(result.success).toBe(false);
  });
});
