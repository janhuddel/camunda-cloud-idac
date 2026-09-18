#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { loadSpec, SpecValidationError } from "./spec/load.js";
import { EMPTY_SPEC } from "./spec/schema.js";
import { checkConnection } from "./camunda/client.js";
import { fetchCurrentState } from "./camunda/list-all.js";
import { buildPlan, type Mode } from "./reconcile/diff.js";
import { applyPlan } from "./reconcile/apply.js";
import { gatherClusterInfo, gatherRunContext, writeAuditLog } from "./reconcile/audit-log.js";
import { errorMessage, formatApplyResult, formatPlan } from "./reconcile/format.js";
import { createProgressReporter } from "./progress.js";

// Load ./.env into process.env (if present) so CAMUNDA_* vars work without the
// operator having to `export` each line by hand. Silently ignored when there's
// no .env file - real env vars (e.g. injected by CI) still take precedence
// wherever they're already set, since loadEnvFile does not override existing vars.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

function reportError(err: unknown): void {
  const message = err instanceof SpecValidationError || err instanceof Error ? err.message : String(err);
  console.error(message);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause) {
    console.error(`Caused by: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (message === "fetch failed") {
    console.error(
      "Hint: check that CAMUNDA_REST_ADDRESS/CAMUNDA_OAUTH_URL/CAMUNDA_CLIENT_ID/CAMUNDA_CLIENT_SECRET are set (via .env or the environment) and reachable.",
    );
  }
}

async function fetchCurrentStateWithProgress(): ReturnType<typeof fetchCurrentState> {
  const progress = createProgressReporter();
  try {
    const current = await fetchCurrentState((e) => {
      progress.update(
        e.phase === "entities"
          ? `Fetching entities… (${e.completed}/${e.total})`
          : `Resolving relationships… (${e.completed}/${e.total})`,
      );
    });
    progress.stop(
      `Fetched current cluster state: ${current.tenants.length} tenants, ${current.roles.length} roles, ${current.groups.length} groups, ${current.mappingRules.length} mapping rules, ${current.authorizations.length} authorizations.`,
    );
    return current;
  } finally {
    progress.stop();
  }
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const program = new Command();
program
  .name("camunda-idac")
  .description("Identity-as-code reconciler for Camunda 8 (tenants, roles, groups, mapping rules, authorizations)")
  .version(version, "-v, --version", "output the current version");

program
  .command("validate")
  .description("validate the spec's schema and referential integrity - no network access")
  .argument("<spec>", "path to the YAML spec file")
  .action(async (specPath: string) => {
    try {
      await loadSpec(specPath);
      console.log("Spec is valid.");
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

program
  .command("render")
  .description("print the fully resolved spec as YAML - resolves include/values composition, no network access")
  .argument("<spec>", "path to the YAML spec file or environment file")
  .action(async (specPath: string) => {
    try {
      const spec = await loadSpec(specPath);
      console.log(stringifyYaml(spec));
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

program
  .command("ping")
  .description("check that the cluster is reachable and credentials are valid - no spec needed")
  .action(async () => {
    const result = await checkConnection();
    if (result.ok) {
      const t = result.value;
      console.log(`Connected. Gateway version ${t.gatewayVersion}, cluster ${t.clusterId ?? "<unknown>"}.`);
      console.log(`Cluster size: ${t.clusterSize}, partitions: ${t.partitionsCount}, replication factor: ${t.replicationFactor}.`);
    } else {
      reportError(result.error);
      process.exitCode = 1;
    }
  });

program
  .command("plan")
  .description("show what would change against the live cluster, without applying anything")
  .argument("<spec>", "path to the YAML spec file")
  .option("--prune", "also compute deletions for anything not in the spec", false)
  .option("--show-protected", "also list actions blocked by the admin/default safety guard", false)
  .action(async (specPath: string, opts: { prune: boolean; showProtected: boolean }) => {
    try {
      const spec = await loadSpec(specPath);
      const current = await fetchCurrentStateWithProgress();
      const mode: Mode = opts.prune ? "prune" : "additive";
      const plan = buildPlan(spec, current, mode);
      console.log(formatPlan(plan, { showProtected: opts.showProtected }));
      // Mirrors `terraform plan -detailed-exitcode`: 0 = no drift, 1 = drift found (or
      // an unresolved mapping-rule claim conflict, which needs a spec change either way).
      process.exitCode = plan.actions.length > 0 || plan.conflicts.length > 0 ? 1 : 0;
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

program
  .command("apply")
  .description("apply the spec to the live cluster")
  .argument("<spec>", "path to the YAML spec file")
  .option("--prune", "also delete anything not in the spec", false)
  .option("--yes", "skip the interactive confirmation prompt", false)
  .option("--show-protected", "also list actions blocked by the admin/default safety guard", false)
  .option("--no-audit-log", "skip writing an audit log file to ./auditlog/")
  .action(async (specPath: string, opts: { prune: boolean; yes: boolean; showProtected: boolean; auditLog: boolean }) => {
    try {
      const spec = await loadSpec(specPath);
      const current = await fetchCurrentStateWithProgress();
      const mode: Mode = opts.prune ? "prune" : "additive";
      const plan = buildPlan(spec, current, mode);
      console.log(formatPlan(plan, { showProtected: opts.showProtected }));

      if (plan.actions.length === 0) {
        process.exitCode = plan.conflicts.length > 0 ? 1 : 0;
        return;
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error("\nRefusing to apply without --yes in a non-interactive shell.");
          process.exitCode = 1;
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const suffix = mode === "prune" ? " (including deletions)" : "";
        const answer = await rl.question(`\nApply ${plan.actions.length} action(s)${suffix}? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("Aborted.");
          return;
        }
      }

      const applyProgress = createProgressReporter();
      let result;
      try {
        result = await applyPlan(plan, (e) => {
          if (e.type === "start") {
            applyProgress.update(`[${e.index + 1}/${e.total}] ${e.action.description}`);
          }
        });
      } finally {
        applyProgress.stop();
      }
      console.log("");
      console.log(formatApplyResult(result, { showProtected: opts.showProtected }));

      if (opts.auditLog) {
        try {
          const cluster = await gatherClusterInfo();
          const auditPath = writeAuditLog(join(process.cwd(), "auditlog"), gatherRunContext(version), cluster, specPath, mode, result);
          console.log(`Audit log written to ${auditPath}`);
        } catch (err) {
          console.error(`Warning: failed to write audit log: ${errorMessage(err)}`);
        }
      }

      process.exitCode = result.failed.length > 0 || plan.conflicts.length > 0 ? 1 : 0;
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

program
  .command("drop-all")
  .description("delete every tenant, role, group, mapping rule, and authorization from the cluster (except the admin/<default> safety guard) - no spec needed")
  .option("--yes", "skip the interactive confirmation prompt", false)
  .option("--no-audit-log", "skip writing an audit log file to ./auditlog/")
  .action(async (opts: { yes: boolean; auditLog: boolean }) => {
    try {
      const cluster = await gatherClusterInfo();
      const current = await fetchCurrentStateWithProgress();
      const plan = buildPlan(EMPTY_SPEC, current, "prune");
      console.log(formatPlan(plan, { showProtected: true }));

      if (plan.actions.length === 0) {
        console.log("Nothing to drop.");
        process.exitCode = plan.conflicts.length > 0 ? 1 : 0;
        return;
      }

      const clusterLabel = `${cluster.address ?? "<unknown address>"}${cluster.clusterId ? ` (clusterId: ${cluster.clusterId})` : ""}`;
      console.error(`\nWARNING: this will delete ${plan.actions.length} object(s) from cluster ${clusterLabel}.`);

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error("\nRefusing to drop all without --yes in a non-interactive shell.");
          process.exitCode = 1;
          return;
        }
        const token = cluster.clusterId ?? "DROP ALL";
        const prompt = cluster.clusterId
          ? `\nType the cluster ID (${token}) to confirm deletion: `
          : `\nNo clusterId could be determined for this cluster. Type "DROP ALL" to confirm deletion: `;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(prompt);
        rl.close();
        if (answer.trim() !== token) {
          console.log("Aborted.");
          return;
        }
      }

      const applyProgress = createProgressReporter();
      let result;
      try {
        result = await applyPlan(plan, (e) => {
          if (e.type === "start") {
            applyProgress.update(`[${e.index + 1}/${e.total}] ${e.action.description}`);
          }
        });
      } finally {
        applyProgress.stop();
      }
      console.log("");
      console.log(formatApplyResult(result, { showProtected: true }));

      if (opts.auditLog) {
        try {
          const auditPath = writeAuditLog(join(process.cwd(), "auditlog"), gatherRunContext(version), cluster, "drop-all", "prune", result);
          console.log(`Audit log written to ${auditPath}`);
        } catch (err) {
          console.error(`Warning: failed to write audit log: ${errorMessage(err)}`);
        }
      }

      process.exitCode = result.failed.length > 0 || plan.conflicts.length > 0 ? 1 : 0;
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
