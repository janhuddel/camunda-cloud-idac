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
camunda-idac plan spec.yaml [--prune]
camunda-idac apply spec.yaml [--prune] [--yes]

# cci is an alias for camunda-idac
cci plan spec.yaml
```

`--prune` absent = additive mode (default): only creates/updates, never
deletes. `apply` without `--yes` prints the plan and asks for interactive
confirmation; it refuses to run without `--yes` on a non-interactive shell
(CI), so a pipeline can never silently confirm a destructive prune.

## Development

```sh
npm install
cp .env.example .env   # fill in CAMUNDA_* connection details, then export them

npx tsx src/cli.ts validate spec.yaml          # schema + referential integrity only, no network
npx tsx src/cli.ts plan spec.yaml [--prune]    # dry-run diff; exit 1 if there's drift (CI-friendly)
npx tsx src/cli.ts apply spec.yaml [--prune] [--yes]
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
