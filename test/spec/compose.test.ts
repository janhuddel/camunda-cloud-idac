import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpec, SpecValidationError } from "../../src/spec/load.js";
import { EnvironmentFile } from "../../src/spec/compose.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composeDir = path.join(__dirname, "..", "fixtures", "compose");

describe("loadSpec with environment files", () => {
  it("still loads a flat spec unchanged, without treating ${...}-looking text as a placeholder", async () => {
    const spec = await loadSpec(path.join(composeDir, "flat-with-dollar-literal.yaml"));
    expect(spec.mappingRules[0].claimValue).toBe("literal-${FOO}-value");
  });

  it("merges base + all procapp fragments and substitutes values", async () => {
    const spec = await loadSpec(path.join(composeDir, "env-full.yaml"));

    expect(spec.tenants.map((t) => t.tenantId).sort()).toEqual(["billing", "logistics", "workflow"]);

    const processOwner = spec.roles.find((r) => r.roleId === "process-owner")!;
    expect(processOwner.groups.sort()).toEqual(["group-billing", "group-logistics", "group-workflow"]);

    const processApplication = spec.roles.find((r) => r.roleId === "process-application")!;
    expect(processApplication.mappingRules).toEqual(["map-client-integration"]);

    const adminClaim = spec.mappingRules.find((m) => m.mappingRuleId === "map-group-admin")!;
    expect(adminClaim.claimValue).toBe("AAD-Camunda-Admin-DEV");

    const partnerClaim = spec.mappingRules.find((m) => m.mappingRuleId === "map-client-partner")!;
    expect(partnerClaim.claimValue).toBe("partner");
  });

  it("excludes a procapp omitted from include, without leaving a dangling reference", async () => {
    const spec = await loadSpec(path.join(composeDir, "env-partial.yaml"));

    expect(spec.tenants.map((t) => t.tenantId).sort()).toEqual(["billing", "workflow"]);
    expect(spec.groups.some((g) => g.groupId === "group-logistics")).toBe(false);

    const processOwner = spec.roles.find((r) => r.roleId === "process-owner")!;
    expect(processOwner.groups.sort()).toEqual(["group-billing", "group-workflow"]);
  });

  it("dedupes an array contribution repeated across fragments", async () => {
    const spec = await loadSpec(path.join(composeDir, "env-array-dedup.yaml"));
    const processOwner = spec.roles.find((r) => r.roleId === "process-owner")!;
    expect(processOwner.groups).toEqual(["group-billing"]);
  });

  it("rejects two fragments giving the same entity a conflicting scalar value", async () => {
    await expect(loadSpec(path.join(composeDir, "env-scalar-conflict.yaml"))).rejects.toThrow(
      /conflicting "name"/,
    );
  });

  it("rejects an unresolved placeholder with a clear error", async () => {
    await expect(loadSpec(path.join(composeDir, "env-unresolved.yaml"))).rejects.toThrow(
      /unresolved placeholder.*INTEGRATION_CLIENT_ID/s,
    );
  });

  it("rejects a fragment that itself declares a top-level include", async () => {
    await expect(loadSpec(path.join(composeDir, "env-nested-include.yaml"))).rejects.toThrow(
      /nested composition isn't supported/,
    );
  });

  it("rejects a duplicate include entry resolving to the same file", async () => {
    await expect(loadSpec(path.join(composeDir, "env-duplicate-include.yaml"))).rejects.toThrow(
      /Duplicate include entry/,
    );
  });

  it("still enforces the underlying Spec schema on the merged result", async () => {
    await expect(loadSpec(path.join(composeDir, "env-missing-name.yaml"))).rejects.toBeInstanceOf(
      SpecValidationError,
    );
    await expect(loadSpec(path.join(composeDir, "env-missing-name.yaml"))).rejects.toThrow(/name/);
  });

  it("rejects include: [] via the EnvironmentFile schema itself", async () => {
    await expect(loadSpec(path.join(composeDir, "env-empty-include.yaml"))).rejects.toBeInstanceOf(
      SpecValidationError,
    );
  });

  it("EnvironmentFile schema requires at least one include entry", () => {
    expect(EnvironmentFile.safeParse({ include: [] }).success).toBe(false);
    expect(EnvironmentFile.safeParse({ include: ["a.yaml"] }).success).toBe(true);
  });
});
