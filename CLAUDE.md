# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Identity-as-code reconciler for Camunda 8: declares tenants, roles, groups, mapping
rules, and authorizations in a YAML spec, then reconciles a live cluster against it
via `@camunda8/orchestration-cluster-api`. It complements (does not replace) Camunda
8.8's built-in "Identity as Code" Spring Boot feature, which only creates missing
entities once at cluster boot and never updates or deletes anything — this tool can
run anytime, updates entities in place, and supports pruning (`--prune`) to delete
anything not in the spec.

## Commands

```sh
npm install
cp .env.example .env   # fill in CAMUNDA_* connection details

npx tsx src/cli.ts validate spec.yaml          # schema + referential integrity only, no network
npx tsx src/cli.ts render spec.yaml            # print the fully resolved spec as YAML, no network
npx tsx src/cli.ts ping                        # check cluster connectivity - no spec needed
npx tsx src/cli.ts plan spec.yaml [--prune]    # dry-run diff; exit 1 if there's drift (CI-friendly)
npx tsx src/cli.ts apply spec.yaml [--prune] [--yes]
npx tsx src/cli.ts --version                   # print the tool's version

npm run typecheck   # tsc --noEmit, includes test/ via tsconfig.typecheck.json
npm test            # vitest run — schema, diff, protect (safety-critical), order
npm run build        # tsc -p tsconfig.json -> dist/, then: node dist/cli.js ...
```

Run a single test file: `npx vitest run test/reconcile/protect.test.ts`.

`--prune` absent = additive mode (default): only creates/updates, never deletes.
`apply` without `--yes` prints the plan and asks for interactive confirmation; it
refuses to run without `--yes` on a non-interactive shell (CI), so a pipeline can
never silently confirm a destructive prune.

There is no integration test suite against a live cluster — run the CLI commands
above manually against a local `c8run` cluster before relying on `--prune` in
production.

## Architecture

Pipeline, front to back: `spec/load.ts` (YAML → validated `Spec`) →
`camunda/list-all.ts` (`fetchCurrentState()`, one full read of the live cluster) →
`reconcile/diff.ts` (`buildPlan()`, `Spec` + `CurrentState` → `ReconciliationPlan`)
→ `reconcile/apply.ts` (executes the plan) → `reconcile/format.ts` (renders plan /
result for the CLI). `src/cli.ts` wires these together per subcommand
(`validate`/`render`/`plan`/`apply`) via `commander`. `render` just loads the spec
(resolving composition if it's an environment file) and prints it back as YAML via
the `yaml` package's `stringify` - no network access, same as `validate`.

### Spec and validation (`src/spec/`)

`schema.ts` defines the Zod schema for the YAML spec: `tenants`, `roles`, `groups`,
`mappingRules`, `authorizations` (all optional, default `[]`). Every object schema
uses `.strict()` deliberately — a typo'd key would otherwise be silently dropped
and parse "successfully" while doing nothing. `OwnerType`/`ResourceType`/
`PermissionType` enums are copied verbatim from the SDK's shipped `.d.ts`; re-check
them against `node_modules/@camunda8/orchestration-cluster-api` whenever the pinned
SDK version in `package.json` changes, since a drifted enum here would silently
accept specs the live API rejects.

The "container" entity is authoritative for its own relationships — e.g. a role
declares its own `groups`/`mappingRules`; there's no reverse field on group or
mapping rule — which avoids conflicting declarations by construction. Roles/groups
can also declare direct `users`/`clients` membership (for OIDC setups granting
access by username/client ID rather than IdP group claim); these aren't declared
entities elsewhere in the spec, so there's no referential-integrity check on them.
`schema.ts`'s `superRefine` enforces cross-references (rules 1–6), duplicate-ID
detection (rule 7), and rejects two authorization entries for the same
owner/resource tuple with different permission sets (rule 8).

`load.ts` reads the YAML file, parses it, and wraps any YAML or Zod failure in
`SpecValidationError` with per-issue messages. `SpecValidationError`/`formatZodError`
live in `errors.ts` (extracted out of `load.ts`) so `compose.ts` can reuse them
without a circular import; `load.ts` re-exports `SpecValidationError` so nothing
outside `src/spec/` needs to know about the split.

Before the final `Spec.safeParse()`, `load.ts` checks whether the parsed YAML has a
top-level `include` key — `RawSpec` is `.strict()` with no such field, so this can
never collide with a real flat spec. If present, `compose.ts`'s `composeSpec()`
handles a second, optional pipeline stage: an **environment file**
(`{ include: string[], values?: Record<string,string> }`) names a flat list of
fragment YAML files (resolved relative to the environment file's own directory,
exactly one level deep — a fragment with its own `include` is rejected) and a
`${VAR}` substitution map applied to each fragment's raw text before it's parsed
(unresolved placeholders after substitution are a hard error, never passed through
as a literal). Fragments are parsed against a looser per-entity schema where only
the ID field is required; `mergeEntitiesById()` then merges same-ID entities across
fragments by **unioning array fields** (`groups`/`mappingRules`/`users`/`clients`/
`roles`, deduped) and **rejecting conflicting scalar fields** (`name`/`description`/
`claimName`/`claimValue`) — this is what lets a role like `process-owner` span every
procapp without any one fragment knowing about the others, while still being one
logical owner making one non-contradictory declaration (consistent with the
"container is authoritative" principle above — merging is just that one owner's
declaration arriving in pieces, never a second entity asserting a competing
relationship). `authorizations` have no ID field and are concatenated as-is, relying
on the existing rule 8 to catch genuine conflicts. Only the fully merged result is
handed to the same, unmodified `Spec.safeParse()` used for flat specs — `schema.ts`
itself has zero awareness of composition. See the README's "Environment files"
section and `test/fixtures/compose/` for the full contract and a worked example.

### Reading cluster state (`src/camunda/`)

`client.ts` builds a single lazily-created `CamundaClientLoose` (the "loose" SDK
client variant, with branded ID types widened to plain `string` — every ID here
comes from user YAML or a prior search response, so the branded-type safety net
buys nothing). The SDK also ships an experimental `createCamundaResultClient`; this
project deliberately avoids it and instead wraps the throwing client itself via
`toResult()`, using the SDK's own `Result`/`ok` discriminant shape.

`list-all.ts`'s `fetchCurrentState()` is the one full read of the cluster: every
tenant/role/group/mapping-rule/authorization plus every relationship pair between
them, paginated via `paginateAll()`. Relationship membership is queried for every
*current* entity, not just ones named in the desired spec — this is what makes
cascading deletes possible in prune mode, since an entity about to be pruned still
has its stale links surfaced for `diff.ts` to unassign first.

`ops.ts` has one object per entity type (`tenantOps`, `roleOps`, `groupOps`,
`mappingRuleOps`, `authorizationOps`) with thin `Result`-returning wrappers around
the raw SDK calls.

### Reconciliation (`src/reconcile/`)

- **`types.ts`** — `CurrentState`, `ActionKind` (the full enum of possible
  diff actions), `PlannedAction` (carries an `execute()` closure plus a structured
  `ActionTarget` so `protect.ts` can match without string-parsing `description`),
  and `DESTRUCTIVE_KINDS`.
- **`diff.ts`** — `buildPlan(spec, current, mode)` walks each entity type
  (tenants/roles/groups/mapping rules), then relationships (via the generic
  `diffRelationship()` helper), then authorizations, appending `PlannedAction`s.
  In `"additive"` mode only creates/updates are ever produced; `"prune"` mode also
  emits deletes/unassigns for anything present in `current` but absent from
  `spec`. `buildPlan` always finishes by piping the raw action list through
  `applyProtections()` (protect.ts) and then `sortActions()` (order.ts) — the
  safety guard and dependency ordering are unconditional, not mode-dependent.
  Before diffing, `findMappingRuleClaimConflicts()` checks desired mapping rules
  against `current` for a claim collision: Camunda allows only one mapping rule
  per `(claimName, claimValue)` pair cluster-wide, so a spec declaring a fresh
  `mappingRuleId` that reuses a claim already owned by a different live id (e.g.
  one created by Camunda 8.8's built-in boot-time Identity-as-code feature, or
  left over from an earlier, differently-keyed run) can never be created as-is.
  Matched ids are collected into `conflictedIds` and skipped everywhere —
  `diffMappingRules` never emits the doomed create, and `diffRelationships`/
  `diffAuthorizations` drop any relationship or authorization entry that
  references that id — instead of letting the create fail at `apply` time and
  cascading into further failures for everything that referenced it. Each
  collision becomes a `ReconciliationPlan.conflicts` entry: unlike
  `protect.ts`'s `warnings`, these are always shown (never gated behind
  `--show-protected`) and fail the CLI's exit code, since they need a spec
  change, not just operator awareness.
- **`protect.ts`** — **the single audit point** for this tool's hard safety
  guarantee (see below). A pure post-filter over the already-computed action
  list, so it can't be bypassed by any particular shape of spec.
- **`order.ts`** — a fixed phase table (not a per-run topological sort, since
  dependencies here are structural, not data-dependent): creates/updates flow
  base entities → relationship assigns → authorizations; deletes/unassigns flow
  in reverse (authorizations first, then every relationship unassign, then base
  entities) so nothing is deleted while still referenced.
- **`apply.ts`** — `applyPlan()` executes `plan.actions` in the order `buildPlan`
  already sorted them into. Best-effort: it runs every action and continues past
  individual failures, since the whole tool is idempotent and rerunning is
  simpler than fail-fast + manual cleanup.
- **`format.ts`** — renders a plan or apply result for terminal output.

### Hard safety guarantee (`protect.ts`)

Applied unconditionally after diffing, regardless of spec content:

- The `admin` role is never deleted.
- The `admin` role's authorizations are fully hands-off: never created, updated,
  or deleted by this tool at all — not merely protected from deletion.
- This tool's own client (`CAMUNDA_CLIENT_ID`) never loses its assignment to the
  `admin` role, so a full `--prune` reset can never lock the tool itself out. This
  guard only protects an *existing* assignment from removal — it does **not**
  proactively assign the client if that assignment is missing (deliberately not
  self-healing).
- The `<default>` system tenant is never deleted (defense in depth — the API
  already rejects this server-side).
- The `admin` role never loses its assignment to the `<default>` tenant, so a
  full `--prune` reset can never leave the tenant without an admin role. Like the
  guardian-client guard, this only protects an *existing* assignment from
  removal — it does not proactively assign the role if that assignment is
  missing.

The `admin` *group* (if one exists) has **no special protection** — it's
reconciled like any other group, including deletion under `--prune`. Adding or
removing members (users/clients/groups/mapping rules) on the `admin` role is
always fine; only deleting the role itself, mutating its authorizations, or
unassigning the tool's own client from it are guarded.

`test/reconcile/protect.test.ts` and `test/reconcile/diff.test.ts` are the
load-bearing test suites — they cover this invariant and the cascading-delete
ordering directly. Any change to `protect.ts` or the phase table in `order.ts`
should be checked against them.

## Known limitations

- Direct **tenant**-to-user/client assignments aren't modeled by the spec (only
  tenant-to-role/group are) — role- and group-level user/client membership is
  fully supported and reconciled/cascaded by `--prune`, but tenant-level direct
  user/client assignment is not.
- `plan`/`apply` read full current state once per run (not continuously), so
  back-to-back runs within the cluster's eventual-consistency window could
  theoretically miss very recent changes.
