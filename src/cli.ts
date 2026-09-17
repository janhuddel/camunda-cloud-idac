#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { loadSpec, SpecValidationError } from "./spec/load.js";
import { fetchCurrentState } from "./camunda/list-all.js";
import { buildPlan, type Mode } from "./reconcile/diff.js";
import { applyPlan } from "./reconcile/apply.js";
import { formatApplyResult, formatPlan } from "./reconcile/format.js";
import { createProgressReporter } from "./progress.js";
import { createColors } from "./colors.js";

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

// Progress output goes to stderr (see progress.ts), so its color-enablement
// must be judged against stderr's TTY-ness, not stdout's - a separate
// `Colors` instance from the one `format.ts` uses for stdout.
const errColors = createColors(process.stderr);

/** Formats an elapsed duration for a progress line, colored by how slow it
 * was - lets a real cluster's slow individual requests (which the aggregate
 * phase counter alone can't show) stand out at a glance. */
function formatDuration(durationMs: number): string {
  const text = `${(durationMs / 1000).toFixed(1)}s`;
  if (durationMs >= 5000) return errColors.red(text);
  if (durationMs >= 2000) return errColors.yellow(text);
  return errColors.dim(text);
}

async function fetchCurrentStateWithProgress(): ReturnType<typeof fetchCurrentState> {
  const progress = createProgressReporter();
  try {
    const current = await fetchCurrentState((e) => {
      progress.log(`  ${errColors.green("✓")} ${e.label} ${formatDuration(e.durationMs)}`);
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

const program = new Command();
program.name("camunda-idac").description("Identity-as-code reconciler for Camunda 8 (tenants, roles, groups, mapping rules, authorizations)");

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
      // Mirrors `terraform plan -detailed-exitcode`: 0 = no drift, 1 = drift found. CI-usable.
      process.exitCode = plan.actions.length > 0 ? 1 : 0;
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
  .action(async (specPath: string, opts: { prune: boolean; yes: boolean; showProtected: boolean }) => {
    try {
      const spec = await loadSpec(specPath);
      const current = await fetchCurrentStateWithProgress();
      const mode: Mode = opts.prune ? "prune" : "additive";
      const plan = buildPlan(spec, current, mode);
      console.log(formatPlan(plan, { showProtected: opts.showProtected }));

      if (plan.actions.length === 0) {
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
          } else {
            const mark = e.ok ? errColors.green("✓") : errColors.red("✗");
            applyProgress.log(`  ${mark} ${e.action.description} ${formatDuration(e.durationMs)}`);
          }
        });
      } finally {
        applyProgress.stop();
      }
      console.log("");
      console.log(formatApplyResult(result, { showProtected: opts.showProtected }));
      process.exitCode = result.failed.length > 0 ? 1 : 0;
    } catch (err) {
      reportError(err);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
