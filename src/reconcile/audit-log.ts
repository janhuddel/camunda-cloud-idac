import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces, userInfo } from "node:os";
import { basename, extname, join } from "node:path";
import { checkConnection } from "../camunda/client.js";
import type { Mode } from "./diff.js";
import { errorMessage } from "./format.js";
import type { ApplyResult } from "./types.js";

export interface RunContext {
  timestamp: Date;
  user: string;
  hostname: string;
  ipAddresses: string[];
  /** This tool's own version (the client performing the change, not the
   * cluster's gateway version - see `ClusterInfo.gatewayVersion` for that). */
  toolVersion: string;
}

export interface ClusterInfo {
  /** `CAMUNDA_REST_ADDRESS` this run was configured to connect to. */
  address: string | undefined;
  /** From the gateway's own topology response - undefined if that call fails
   * (connection to the cluster already succeeded by the time this is
   * gathered, since it runs after `fetchCurrentState`, so this is only a
   * defensive fallback, not the expected path). */
  clusterId?: string;
  gatewayVersion?: string;
}

/** Identifies which cluster this run targeted: the configured REST address,
 * plus the authoritative clusterId/gateway version straight from the
 * cluster's own topology endpoint (the same call `ping` uses) - the
 * configured address alone can be ambiguous behind a shared ingress/proxy. */
export async function gatherClusterInfo(): Promise<ClusterInfo> {
  const address = process.env.CAMUNDA_REST_ADDRESS;
  const topology = await checkConnection();
  if (!topology.ok) return { address };
  return { address, clusterId: topology.value.clusterId ?? undefined, gatewayVersion: topology.value.gatewayVersion };
}

/** `userInfo().username` is the cross-platform way to resolve "who ran this" -
 * on Windows it falls back to the `USERNAME` env var internally, on POSIX to
 * `USER`/`LOGNAME`/the passwd entry, so this works the same on every OS
 * without reading any env var by hand. */
export function gatherRunContext(toolVersion: string): RunContext {
  return {
    timestamp: new Date(),
    user: userInfo().username,
    hostname: hostname(),
    ipAddresses: nonInternalIPv4Addresses(),
    toolVersion,
  };
}

function nonInternalIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) addresses.push(addr.address);
    }
  }
  return addresses;
}

function formatClusterInfo(cluster: ClusterInfo): string {
  const address = cluster.address ?? "<unknown - CAMUNDA_REST_ADDRESS not set>";
  const details: string[] = [];
  if (cluster.clusterId) details.push(`clusterId: ${cluster.clusterId}`);
  if (cluster.gatewayVersion) details.push(`gateway: ${cluster.gatewayVersion}`);
  return details.length > 0 ? `${address} (${details.join(", ")})` : address;
}

/** Renders one audit record as plain text. Pure (no I/O) so it's directly
 * unit-testable; `writeAuditLog` below handles persisting it. */
export function formatAuditLog(context: RunContext, cluster: ClusterInfo, specPath: string, mode: Mode, result: ApplyResult): string {
  const lines: string[] = [];
  lines.push(`Timestamp: ${context.timestamp.toISOString()}`);
  lines.push(`User: ${context.user}`);
  lines.push(`Host: ${context.hostname}${context.ipAddresses.length > 0 ? ` (${context.ipAddresses.join(", ")})` : ""}`);
  lines.push(`Tool version: ${context.toolVersion}`);
  lines.push(`Cluster: ${formatClusterInfo(cluster)}`);
  lines.push(`Spec: ${specPath}`);
  lines.push(`Mode: ${mode}`);
  lines.push("");
  lines.push("Actions:");
  for (const action of result.succeeded) {
    lines.push(`  [OK]   ${action.description}`);
  }
  for (const { action, error } of result.failed) {
    lines.push(`  [FAIL] ${action.description}: ${errorMessage(error)}`);
  }
  lines.push("");
  lines.push(`Summary: ${result.succeeded.length} succeeded, ${result.failed.length} failed.`);
  return lines.join("\n");
}

/** Writes one audit record under `<baseDir>/<YYYY-MM>/`, one file per run, so
 * a long-lived, VCS-committed `auditlog/` directory never accumulates more
 * than a month's worth of files in one place. Returns the path written. */
export function writeAuditLog(
  baseDir: string,
  context: RunContext,
  cluster: ClusterInfo,
  specPath: string,
  mode: Mode,
  result: ApplyResult,
): string {
  const month = context.timestamp.toISOString().slice(0, 7); // "YYYY-MM"
  const dir = join(baseDir, month);
  mkdirSync(dir, { recursive: true });

  const safeTimestamp = context.timestamp.toISOString().replace(/[:.]/g, "-");
  const specName = basename(specPath, extname(specPath));
  const suffix = randomBytes(3).toString("hex");
  const filePath = join(dir, `${safeTimestamp}-apply-${mode}-${specName}-${suffix}.txt`);

  writeFileSync(filePath, `${formatAuditLog(context, cluster, specPath, mode, result)}\n`);
  return filePath;
}
