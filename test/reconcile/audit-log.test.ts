import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatAuditLog, writeAuditLog, type ClusterInfo, type RunContext } from "../../src/reconcile/audit-log.js";
import type { ApplyResult, PlannedAction } from "../../src/reconcile/types.js";

function fakeAction(description: string): PlannedAction {
  return {
    kind: "create-role",
    description,
    destructive: false,
    target: { kind: "other" },
    execute: async () => ({ ok: true, value: undefined }),
  };
}

const context: RunContext = {
  timestamp: new Date("2026-09-18T12:34:56.789Z"),
  user: "jdoe",
  hostname: "jdoes-laptop.local",
  ipAddresses: ["192.168.1.42"],
  toolVersion: "1.2.3",
};

const cluster: ClusterInfo = {
  address: "https://abc-123.bru-2.zeebe.camunda.io/abc-123",
  clusterId: "abc-123",
  gatewayVersion: "8.8.0",
};

const result: ApplyResult = {
  succeeded: [fakeAction('create role "process-owner"')],
  failed: [{ action: fakeAction('delete tenant "legacy"'), error: new Error("authorization denied") }],
  skippedProtected: [],
};

describe("formatAuditLog", () => {
  it("renders who/when/where, the target cluster, the spec/mode, every action, and a summary", () => {
    const output = formatAuditLog(context, cluster, "spec.yaml", "prune", result);
    expect(output).toContain("Timestamp: 2026-09-18T12:34:56.789Z");
    expect(output).toContain("User: jdoe");
    expect(output).toContain("Host: jdoes-laptop.local (192.168.1.42)");
    expect(output).toContain("Tool version: 1.2.3");
    expect(output).toContain("Cluster: https://abc-123.bru-2.zeebe.camunda.io/abc-123 (clusterId: abc-123, gateway: 8.8.0)");
    expect(output).toContain("Spec: spec.yaml");
    expect(output).toContain("Mode: prune");
    expect(output).toContain('[OK]   create role "process-owner"');
    expect(output).toContain('[FAIL] delete tenant "legacy": authorization denied');
    expect(output).toContain("Summary: 1 succeeded, 1 failed.");
  });

  it("omits the parenthesized IP list when there are no addresses", () => {
    const output = formatAuditLog({ ...context, ipAddresses: [] }, cluster, "spec.yaml", "additive", result);
    expect(output).toContain("Host: jdoes-laptop.local\n");
  });

  it("falls back to a placeholder when the cluster address is unknown and omits parens when topology is unavailable", () => {
    const output = formatAuditLog(context, { address: undefined }, "spec.yaml", "additive", result);
    expect(output).toContain("Cluster: <unknown - CAMUNDA_REST_ADDRESS not set>\n");
  });

  it("shows the configured address without a clusterId/gateway parenthetical if the topology call failed", () => {
    const output = formatAuditLog(context, { address: "https://example.com" }, "spec.yaml", "additive", result);
    expect(output).toContain("Cluster: https://example.com\n");
  });
});

describe("writeAuditLog", () => {
  let baseDir: string;

  afterEach(() => {
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("creates a YYYY-MM subdirectory and writes a .txt file matching formatAuditLog's output", () => {
    baseDir = mkdtempSync(join(tmpdir(), "audit-log-test-"));

    const filePath = writeAuditLog(baseDir, context, cluster, "spec.yaml", "prune", result);

    expect(filePath).toContain(join(baseDir, "2026-09"));
    expect(filePath.endsWith(".txt")).toBe(true);

    const monthDir = join(baseDir, "2026-09");
    expect(readdirSync(monthDir)).toHaveLength(1);

    const written = readFileSync(filePath, "utf8");
    expect(written).toBe(`${formatAuditLog(context, cluster, "spec.yaml", "prune", result)}\n`);
  });

  it("gives each run a distinct file even with the same timestamp/spec/mode", () => {
    baseDir = mkdtempSync(join(tmpdir(), "audit-log-test-"));

    const first = writeAuditLog(baseDir, context, cluster, "spec.yaml", "prune", result);
    const second = writeAuditLog(baseDir, context, cluster, "spec.yaml", "prune", result);

    expect(first).not.toBe(second);
  });
});
