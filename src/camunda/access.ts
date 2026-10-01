import { stderrColors } from "../colors.js";
import { getClient } from "./client.js";
import { listAllAuthorizations } from "./list-all.js";
import { getGuardianClientId, PROTECTED_ROLE_ID } from "../reconcile/protect.js";
import type { AuthorizationEntity } from "../reconcile/types.js";
import type { PermissionType, ResourceType } from "../spec/schema.js";

// Why a preflight at all: Camunda's search endpoints do NOT reject a caller that
// lacks READ permission - they silently filter the result down to what the caller
// may see (often: nothing). Without this check, a client missing from the admin
// role reads an "empty" cluster, `plan` shows a bogus "create everything" diff, and
// only the individual writes during `apply` finally fail with 403.

/** "read" is enough for plan/export; "write" is what apply/drop-all need. */
export type AccessLevel = "read" | "write";

/** The subset of `GET /v2/authentication/me` this check relies on. Works for M2M
 * clients too (their `username` is null, but `roles`/`groups` are populated). */
export interface Identity {
  roles: string[];
  groups: string[];
}

export type AccessResult = { ok: true; via: "admin-role" | "authorizations" } | { ok: false; missing: string[] };

const MANAGED_RESOURCE_TYPES: readonly ResourceType[] = ["AUTHORIZATION", "ROLE", "GROUP", "TENANT", "MAPPING_RULE"];

const REQUIRED_PERMISSIONS: Record<AccessLevel, readonly PermissionType[]> = {
  read: ["READ"],
  write: ["CREATE", "READ", "UPDATE", "DELETE"],
};

/**
 * Pure evaluation of whether the caller may manage every entity type this tool
 * reconciles. Membership in the admin role is accepted outright; otherwise the
 * caller's effective permissions are derived from the given (visible)
 * authorizations owned by the client itself or by one of its roles/groups, and
 * only wildcard (`resourceId: "*"`) grants count, since the tool touches every
 * entity of a type. Authorizations owned by a MAPPING_RULE are not considered -
 * `/authentication/me` doesn't say which mapping rules matched.
 */
export function evaluateAccess(
  identity: Identity,
  authorizations: readonly AuthorizationEntity[],
  clientId: string | undefined,
  level: AccessLevel,
): AccessResult {
  if (identity.roles.includes(PROTECTED_ROLE_ID)) return { ok: true, via: "admin-role" };

  const roles = new Set(identity.roles);
  const groups = new Set(identity.groups);
  const granted = new Set<string>();
  for (const a of authorizations) {
    if (a.resourceId !== "*") continue;
    const ownsIt =
      (a.ownerType === "CLIENT" && clientId !== undefined && a.ownerId === clientId) ||
      (a.ownerType === "ROLE" && roles.has(a.ownerId)) ||
      (a.ownerType === "GROUP" && groups.has(a.ownerId));
    if (!ownsIt) continue;
    for (const p of a.permissionTypes) granted.add(`${a.resourceType}:${p}`);
  }

  const missing = MANAGED_RESOURCE_TYPES.flatMap((r) => REQUIRED_PERMISSIONS[level].map((p) => `${r}:${p}`)).filter(
    (key) => !granted.has(key),
  );
  return missing.length === 0 ? { ok: true, via: "authorizations" } : { ok: false, missing };
}

export class InsufficientPermissionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientPermissionsError";
  }
}

export function formatMissingAccess(identity: Identity, clientId: string | undefined, missing: readonly string[]): string {
  // Always reported via console.error (reportError / ping), hence stderr colors.
  const { bold, dim, red, yellow } = stderrColors;
  const who = clientId ? `Client '${clientId}'` : "The configured client";
  const roles = identity.roles.length > 0 ? identity.roles.join(", ") : "<none>";
  return [
    red(bold(`${who} lacks the permissions required to manage identity entities.`)),
    `${red("Missing:")} ${yellow(missing.join(", "))}`,
    `Assign it to the ${bold(`'${PROTECTED_ROLE_ID}'`)} role or grant these permissions on resourceId '*', then rerun.`,
    dim(`Roles seen for this client: ${roles}. (Use --no-permission-check to bypass this check.)`),
  ].join("\n");
}

/** Reads the caller's identity and, only if it isn't in the admin role, the
 * authorizations it can see - the inputs `evaluateAccess` needs. */
export async function fetchAccessInputs(): Promise<{ identity: Identity; authorizations: AuthorizationEntity[] }> {
  const me = await getClient().getAuthentication();
  const identity: Identity = { roles: me.roles ?? [], groups: me.groups ?? [] };
  const authorizations = identity.roles.includes(PROTECTED_ROLE_ID) ? [] : await listAllAuthorizations().catch(() => []);
  return { identity, authorizations };
}

/** Preflight for plan/export ("read") and apply/drop-all ("write"): throws
 * `InsufficientPermissionsError` before any cluster state is read or changed. */
export async function checkAccess(level: AccessLevel): Promise<void> {
  const { identity, authorizations } = await fetchAccessInputs();
  const clientId = getGuardianClientId();
  const result = evaluateAccess(identity, authorizations, clientId, level);
  if (!result.ok) throw new InsufficientPermissionsError(formatMissingAccess(identity, clientId, result.missing));
}
