import { describe, expect, it } from "vitest";
import { evaluateAccess, formatMissingAccess } from "../../src/camunda/access.js";
import type { AuthorizationEntity } from "../../src/reconcile/types.js";
import type { OwnerType, PermissionType, ResourceType } from "../../src/spec/schema.js";

const MANAGED: ResourceType[] = ["AUTHORIZATION", "ROLE", "GROUP", "TENANT", "MAPPING_RULE"];
const CRUD: PermissionType[] = ["CREATE", "READ", "UPDATE", "DELETE"];

let key = 0;
function grants(ownerType: OwnerType, ownerId: string, permissionTypes: PermissionType[], resourceId = "*"): AuthorizationEntity[] {
  return MANAGED.map((resourceType) => ({
    authorizationKey: String(++key),
    ownerId,
    ownerType,
    resourceType,
    resourceId,
    permissionTypes,
  }));
}

describe("evaluateAccess", () => {
  it("accepts membership in the admin role without looking at authorizations", () => {
    expect(evaluateAccess({ roles: ["admin"], groups: [] }, [], "idac", "write")).toEqual({ ok: true, via: "admin-role" });
  });

  it("reports every managed permission as missing when no authorizations are visible", () => {
    const result = evaluateAccess({ roles: ["process-application"], groups: [] }, [], "idac", "write");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toHaveLength(MANAGED.length * CRUD.length);
      expect(result.missing).toContain("AUTHORIZATION:CREATE");
      expect(result.missing).toContain("MAPPING_RULE:DELETE");
    }
  });

  it.each([
    ["CLIENT", "idac", { roles: [], groups: [] }],
    ["ROLE", "identity-manager", { roles: ["identity-manager"], groups: [] }],
    ["GROUP", "platform-team", { roles: [], groups: ["platform-team"] }],
  ] as const)("derives effective permissions from %s-owned authorizations", (ownerType, ownerId, identity) => {
    const auths = grants(ownerType, ownerId, CRUD);
    expect(evaluateAccess({ roles: [...identity.roles], groups: [...identity.groups] }, auths, "idac", "write")).toEqual({
      ok: true,
      via: "authorizations",
    });
  });

  it("ignores authorizations owned by someone else", () => {
    const auths = [...grants("CLIENT", "other-client", CRUD), ...grants("ROLE", "not-mine", CRUD)];
    expect(evaluateAccess({ roles: [], groups: [] }, auths, "idac", "write").ok).toBe(false);
  });

  it("ignores CLIENT-owned authorizations when no client ID is configured", () => {
    expect(evaluateAccess({ roles: [], groups: [] }, grants("CLIENT", "idac", CRUD), undefined, "write").ok).toBe(false);
  });

  it("only counts wildcard grants", () => {
    const auths = grants("CLIENT", "idac", CRUD, "some-role");
    expect(evaluateAccess({ roles: [], groups: [] }, auths, "idac", "read").ok).toBe(false);
  });

  it("distinguishes read from write access", () => {
    const auths = grants("ROLE", "readonly-admin", ["READ"]);
    const identity = { roles: ["readonly-admin"], groups: [] };
    expect(evaluateAccess(identity, auths, "idac", "read")).toEqual({ ok: true, via: "authorizations" });
    const write = evaluateAccess(identity, auths, "idac", "write");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.missing).not.toContain("ROLE:READ");
  });

  it("combines grants across owners", () => {
    const auths = [...grants("CLIENT", "idac", ["CREATE", "READ"]), ...grants("GROUP", "ops", ["UPDATE", "DELETE"])];
    expect(evaluateAccess({ roles: [], groups: ["ops"] }, auths, "idac", "write").ok).toBe(true);
  });
});

describe("formatMissingAccess", () => {
  it("names the client, the missing permissions, the roles seen and the escape hatch", () => {
    const text = formatMissingAccess({ roles: [], groups: [] }, "idac", ["ROLE:CREATE", "TENANT:DELETE"]);
    expect(text).toMatch(/Client 'idac'/);
    expect(text).toMatch(/ROLE:CREATE, TENANT:DELETE/);
    expect(text).toMatch(/'admin' role/);
    expect(text).toMatch(/Roles seen for this client: <none>/);
    expect(text).toMatch(/--no-permission-check/);
  });
});
