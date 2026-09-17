import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpec, SpecValidationError } from "../../src/spec/load.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures");

describe("loadSpec", () => {
  it("loads and validates the canonical example spec", async () => {
    const spec = await loadSpec(path.join(fixturesDir, "valid-spec.yaml"));
    expect(spec.tenants).toHaveLength(1);
    expect(spec.tenants[0].tenantId).toBe("default");
    expect(spec.roles[0].roleId).toBe("process-owner");
    expect(spec.authorizations[0].permissions).toEqual(["CREATE", "READ", "UPDATE_PROCESS_INSTANCE"]);
  });

  it("throws SpecValidationError for a missing file", async () => {
    await expect(loadSpec(path.join(fixturesDir, "does-not-exist.yaml"))).rejects.toBeInstanceOf(
      SpecValidationError,
    );
  });

  it("throws SpecValidationError for invalid YAML syntax", async () => {
    const tmpDir = path.join(fixturesDir, "..", "..", "test-tmp");
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });
    const badFile = path.join(tmpDir, "bad.yaml");
    await writeFile(badFile, "tenants: [this is not: valid: yaml");
    try {
      await expect(loadSpec(badFile)).rejects.toBeInstanceOf(SpecValidationError);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
