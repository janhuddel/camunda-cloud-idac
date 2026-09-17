import type { PlannedAction } from "./types.js";

export const PROTECTED_ROLE_ID = "admin";
export const PROTECTED_TENANT_ID = "<default>";

/**
 * The client this tool itself authenticates as (from CAMUNDA_CLIENT_ID, the same
 * variable createCamundaClientLoose() reads). Its assignment to the admin role is
 * protected from removal so a full reset can never lock the tool itself out.
 * Deliberately NOT self-healing (per explicit product decision): if this client
 * isn't already assigned to the admin role, this tool will not assign it - it
 * only guards an existing assignment from being pruned away.
 */
function getGuardianClientId(): string | undefined {
  return process.env.CAMUNDA_CLIENT_ID;
}

/**
 * Unconditional safety filter, applied after diffing regardless of spec content.
 * This is deliberately NOT a "skip if the spec doesn't mention admin" heuristic
 * inside diff.ts: if the spec never mentions the admin role at all, the raw diff
 * would otherwise queue every one of its authorizations for deletion in prune
 * mode (they're simply "not in spec" = "extra"). Keeping the guard here, as a
 * pure post-filter over the already-computed action list, means it can't be
 * bypassed by any particular shape of spec and is the one place to audit to
 * trust the invariant holds.
 *
 * Current invariants (narrowed by explicit product decision - the "admin" group,
 * if one exists, is no longer specially protected; only the "admin" role is):
 *  1. The "admin" role itself is never deleted.
 *  2. The "admin" role's authorizations are fully hands-off: never created,
 *     updated, or deleted by this tool - not merely protected from deletion.
 *  3. This tool's own client (CAMUNDA_CLIENT_ID) never loses its assignment to
 *     the admin role, so a full reset can't lock the tool out of the cluster it
 *     just reset. Every other role<->client pair (including other clients
 *     assigned to the admin role) is unaffected by this rule.
 *  4. The `<default>` system tenant is never deleted (defense in depth - the API
 *     already rejects this server-side).
 *
 * Only entity-delete/authorization-mutation/the one guarded unassign-role-client
 * edge are ever blocked. Every other unassign-* action - including removing
 * other roles/members from the admin role, or removing a non-guardian client
 * from it - passes through untouched.
 */
export function applyProtections(actions: PlannedAction[]): { actions: PlannedAction[]; warnings: string[] } {
  const warnings: string[] = [];
  const guardianClientId = getGuardianClientId();

  const kept = actions.filter((action) => {
    const block = (reason: string) => {
      warnings.push(`BLOCKED (${reason}): ${action.description}`);
      return false;
    };

    const target = action.target;

    if (target.kind === "delete-role" && target.roleId === PROTECTED_ROLE_ID) {
      return block(`the "${PROTECTED_ROLE_ID}" role must never be deleted`);
    }

    if (target.kind === "delete-tenant" && target.tenantId === PROTECTED_TENANT_ID) {
      return block(`the ${PROTECTED_TENANT_ID} system tenant must never be deleted`);
    }

    if (target.kind === "authorization" && target.ownerType === "ROLE" && target.ownerId === PROTECTED_ROLE_ID) {
      return block(`authorizations of the "${PROTECTED_ROLE_ID}" role must never be created, updated, or deleted`);
    }

    if (
      target.kind === "unassign-role-client" &&
      target.roleId === PROTECTED_ROLE_ID &&
      guardianClientId !== undefined &&
      target.clientId === guardianClientId
    ) {
      return block(
        `this tool's own client ("${guardianClientId}") must keep the "${PROTECTED_ROLE_ID}" role, or a full reset would lock the tool out`,
      );
    }

    return true;
  });

  return { actions: kept, warnings };
}
