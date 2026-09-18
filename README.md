# camunda-cloud-idac

Identity-as-code reconciler for Camunda 8: declares tenants, roles, groups,
mapping rules, and authorizations in a YAML spec, then reconciles a live
cluster against it via `@camunda8/orchestration-cluster-api`.

Complements (does not replace) Camunda 8.8's built-in "Identity as Code"
Spring Boot feature, which only creates missing entities once at cluster
boot and never updates or deletes anything. This tool can run anytime
against a live cluster, updates entities in place, and supports pruning
(`--prune`) to delete anything not in the spec.

**Hard safety guarantee** (see `src/reconcile/protect.ts` - the single audit
point for all of this, applied unconditionally after diffing regardless of
spec content):

- The `admin` role is never deleted.
- The `admin` role's authorizations are fully hands-off: never created,
  updated, or deleted by this tool at all - not merely protected from
  deletion.
- This tool's own client (`CAMUNDA_CLIENT_ID`) never loses its assignment to
  the `admin` role, so a full `--prune` reset can never lock the tool itself
  out. This guard only protects an *existing* assignment from removal - it
  does not proactively assign the client if that assignment is missing.
- The `<default>` system tenant is never deleted (the API already rejects
  this server-side; this is defense in depth).

The `admin` *group* (if one exists) has **no special protection** - it's
reconciled like any other group, including deletion under `--prune`. Adding
or removing members (users/clients/groups/mapping rules) on the `admin`
role is always fine and unaffected by any of the above; only deleting the
role itself, mutating its authorizations, or unassigning the tool's own
client from it are guarded.

## Installation

Set the `CAMUNDA_*` connection env vars first (OAuth client credentials for
an M2M client with admin authorizations, cluster REST address, optional
mTLS) - see `.env.example` for the full list.

Run without installing:

```sh
npx camunda-cloud-idac plan spec.yaml [--prune]
```

Or install globally and use the `camunda-idac` (or shorter `cci`) command:

```sh
npm install -g camunda-cloud-idac

camunda-idac validate spec.yaml
camunda-idac ping                       # check cluster connectivity - no spec needed
camunda-idac plan spec.yaml [--prune]
camunda-idac apply spec.yaml [--prune] [--yes] [--no-audit-log]
camunda-idac drop-all [--yes] [--no-audit-log]  # delete everything except the admin/<default> guard rail - no spec needed
camunda-idac --version

# cci is an alias for camunda-idac
cci plan spec.yaml
```

`--prune` absent = additive mode (default): only creates/updates, never
deletes. `apply` without `--yes` prints the plan and asks for interactive
confirmation; it refuses to run without `--yes` on a non-interactive shell
(CI), so a pipeline can never silently confirm a destructive prune.

## drop-all

```sh
camunda-idac drop-all [--yes] [--no-audit-log]
```

Deletes every tenant, role, group, mapping rule, and authorization from the
cluster - the nuclear option, useful for tearing down a throwaway/demo/test
cluster. Takes no spec argument: it's equivalent to `apply --prune` against
an implicit, fully-empty spec.

Because there's no spec file to act as a "receipt" of intent, confirmation
is stricter than `apply --prune`'s y/N prompt: instead you must type the
target cluster's ID to proceed (or the literal phrase `DROP ALL` if no
cluster ID could be determined). `--yes` skips this entirely and is
required on a non-interactive shell (CI), same as `apply`.

The same **Hard safety guarantee** described above applies unchanged -
`drop-all` goes through the identical `applyProtections()` post-filter, so
the `admin` role, its authorizations, this tool's own client's `admin`
assignment, and the `<default>` tenant are never touched. Protected/blocked
actions are always shown (no `--show-protected` flag needed).

## Audit log

Every `apply` run (unless `--no-audit-log` is passed) writes one plain-text
record to `./auditlog/<YYYY-MM>/` (relative to the current working
directory) - one subdirectory per calendar month, one file per run. Each
record captures who ran it (OS user), when, from which machine (hostname +
IP addresses), which version of this tool made the change, which Camunda
cluster was targeted (the configured REST address plus its clusterId/gateway
version), the spec file and mode, and
every action that was attempted, succeeded or failed. This is a soft audit
trail, not a tamper-proof one - the file can be edited or deleted after the
fact - so `auditlog/` is meant to be committed to version control to build a
durable history over time rather than gitignored.

## Development

```sh
npm install
cp .env.example .env   # fill in CAMUNDA_* connection details, then export them

npx tsx src/cli.ts validate spec.yaml          # schema + referential integrity only, no network
npx tsx src/cli.ts render spec.yaml            # print the fully resolved spec as YAML, no network
npx tsx src/cli.ts ping                        # check cluster connectivity - no spec needed
npx tsx src/cli.ts plan spec.yaml [--prune]    # dry-run diff; exit 1 if there's drift (CI-friendly)
npx tsx src/cli.ts apply spec.yaml [--prune] [--yes] [--no-audit-log]
npx tsx src/cli.ts drop-all [--yes] [--no-audit-log]  # delete everything except the admin/<default> guard rail - no spec needed
```

Build once for a compiled binary: `npm run build && node dist/cli.js ...`.

## Spec format

See `test/fixtures/valid-spec.yaml` for a complete example. Top-level keys:
`tenants`, `roles`, `groups`, `mappingRules`, `authorizations` (all
optional, default to `[]`). The "container" entity is authoritative for its
own relationships - e.g. a role declares its own `groups`/`mappingRules`;
there's no reverse field - which avoids conflicting declarations by
construction.

Roles and groups can also declare direct `users`/`clients` membership (not
just mapping-rule/group-based provisioning) - useful for OIDC setups where
some principals are granted access by username/client ID rather than by an
IdP group claim. These aren't declared entities elsewhere in the spec, so
there's no referential-integrity check on them (any string is accepted).

## Environment files

The single `<spec>` argument to `validate`/`render`/`plan`/`apply` can be either a
flat spec (above) or an **environment file** that composes several spec
fragments into one, for organizations that run the same identity model
across multiple environments/clusters with per-cluster differences:

```yaml
# specs/e0.yaml
include:
  - base.yaml
  - procapps/leistung.yaml
  - procapps/workflow.yaml
  # a procapp fragment can be left out here if this cluster doesn't need it

values:
  ENV_SUFFIX: E0
  KUMUL_CLIENT_ID: kumul
```

A file is treated as an environment file purely because it has a top-level
`include` key (flat specs never do, since `RawSpec` is `.strict()` and has
no such field, so detection can't collide with the existing format).
`include` paths resolve relative to the environment file's own directory.
See `test/fixtures/compose/` for a complete worked example (base + 3
procapp fragments + a full and a partial environment file).

Use `camunda-idac render <spec>` to print the fully composed and
interpolated spec as YAML - useful to double-check what an environment
file actually resolves to (which procapps ended up included, what
`${VAR}` placeholders became) before running `plan`/`apply` against it.

**Fragments** are plain YAML files shaped like a spec, but looser: only
each entity's ID field (`tenantId`/`roleId`/`groupId`/`mappingRuleId`) is
required - every other field is optional, since one fragment may only be
contributing a *piece* of an entity that another fragment (or a shared
`base.yaml`) already declares in full. This is what lets a role like
`process-owner` span every procapp without every procapp fragment knowing
about the others: `base.yaml` declares `process-owner`'s `name`, and each
`procapps/<name>.yaml` fragment separately contributes its own group to
`process-owner.groups`.

When multiple fragments mention the same entity ID:

- **Array fields** (`groups`, `mappingRules`, `users`, `clients`, `roles`)
  are **unioned** (deduplicated, first-seen order).
- **Scalar fields** (`name`, `description`, `claimName`, `claimValue`) must
  not disagree - two fragments giving the same ID a different value for the
  same scalar field is a composition error naming both files and values.
- `authorizations` have no ID field and are simply concatenated; the
  existing schema already tolerates exact duplicate authorization tuples
  and flags genuine permission conflicts, so no special merging is needed.

Only the fully merged, ID-deduplicated result is validated against the same
unmodified `Spec` schema used for flat specs - so every existing guarantee
(referential integrity, no duplicate IDs, authorization-tuple conflicts)
still applies to the assembled spec exactly as it does today. If no
fragment ever provides a required field (e.g. `name`), that surfaces as the
same "Required" error you'd get from an incomplete flat spec.

`include` is exactly one level deep - a fragment listed under `include` may
not itself have a top-level `include` key (nested composition isn't
supported, and produces a clear error if attempted).

**`${VAR}` substitution**: each fragment's raw text is scanned for
`${NAME}` placeholders before it's parsed as YAML, substituted from the
environment file's `values` map. Any placeholder left unresolved after
substitution (a typo, or a `values` map missing an entry) is a hard error
naming the fragment file and the unresolved name(s) - it never silently
passes through as a literal string. A flat spec (no `include` key) is never
scanned for placeholders, so a literal `${...}`-looking value in a flat
spec is passed through untouched.

**Prune caveat**: omitting a procapp fragment from an environment's
`include` is, to the reconciler, indistinguishable from "this was
intentionally removed." If that procapp's tenant/group/mapping rules still
exist on the target cluster (e.g. it was deployed there before, or under a
different environment file), a later `apply --prune` run against that
cluster will delete them - same as removing any other entity from a flat
spec. Make sure `include` lists match what should actually exist on each
cluster before pruning.

## Known limitations

- Direct **tenant**-to-user/client assignments aren't modeled by the spec
  (only tenant-to-role/group are) - role- and group-level user/client
  membership is fully supported and reconciled/cascaded by `--prune`, but
  tenant-level direct user/client assignment is not.
- `plan`/`apply` read full current state once per run (not continuously),
  so back-to-back runs within the cluster's eventual-consistency window
  could theoretically miss very recent changes. Acceptable for an
  interactively/CI-run admin CLI.

## Testing

```sh
npm run typecheck   # includes test/ via tsconfig.typecheck.json
npm test            # vitest - schema, diff, protect (safety-critical), order
```

`test/reconcile/protect.test.ts` and `test/reconcile/diff.test.ts` are the
load-bearing suites: they cover the admin/default protection invariant and
the cascading-delete ordering directly.

No integration test suite against a live cluster yet - run the commands
above manually against a local `c8run` cluster before relying on `--prune`
in production, per the design plan's verification section.
