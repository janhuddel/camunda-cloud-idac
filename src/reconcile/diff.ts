import type { Spec } from "../spec/schema.js";
import { tenantOps, roleOps, groupOps, mappingRuleOps, authorizationOps, type AuthorizationTuple } from "../camunda/ops.js";
import { applyProtections } from "./protect.js";
import { sortActions } from "./order.js";
import type { ActionKind, ActionTarget, CurrentState, PlannedAction, ReconciliationPlan } from "./types.js";
import { DESTRUCTIVE_KINDS } from "./types.js";

export type Mode = "additive" | "prune";

function mkAction(
  kind: ActionKind,
  description: string,
  execute: PlannedAction["execute"],
  target: ActionTarget = { kind: "other" },
): PlannedAction {
  return { kind, description, target, destructive: DESTRUCTIVE_KINDS.has(kind), execute };
}

function descChanged(current: string | null, desired: string | undefined): boolean {
  return (current ?? "") !== (desired ?? "");
}

function diffTenants(spec: Spec, current: CurrentState, mode: Mode, actions: PlannedAction[]): void {
  const curById = new Map(current.tenants.map((t) => [t.tenantId, t]));
  const desiredIds = new Set(spec.tenants.map((t) => t.tenantId));

  for (const desired of spec.tenants) {
    const existing = curById.get(desired.tenantId);
    if (!existing) {
      actions.push(
        mkAction(
          "create-tenant",
          `create tenant "${desired.tenantId}" (${desired.name})`,
          () => tenantOps.create(desired.tenantId, desired.name, desired.description),
        ),
      );
    } else if (existing.name !== desired.name || descChanged(existing.description, desired.description)) {
      actions.push(
        mkAction(
          "update-tenant",
          `update tenant "${desired.tenantId}"`,
          () => tenantOps.update(desired.tenantId, desired.name, desired.description),
        ),
      );
    }
  }

  if (mode === "prune") {
    for (const existing of current.tenants) {
      if (!desiredIds.has(existing.tenantId)) {
        actions.push(
          mkAction(
            "delete-tenant",
            `delete tenant "${existing.tenantId}"`,
            () => tenantOps.delete(existing.tenantId),
            { kind: "delete-tenant", tenantId: existing.tenantId },
          ),
        );
      }
    }
  }
}

function diffRoles(spec: Spec, current: CurrentState, mode: Mode, actions: PlannedAction[]): void {
  const curById = new Map(current.roles.map((r) => [r.roleId, r]));
  const desiredIds = new Set(spec.roles.map((r) => r.roleId));

  for (const desired of spec.roles) {
    const existing = curById.get(desired.roleId);
    if (!existing) {
      actions.push(
        mkAction("create-role", `create role "${desired.roleId}" (${desired.name})`, () =>
          roleOps.create(desired.roleId, desired.name, desired.description),
        ),
      );
    } else if (existing.name !== desired.name || descChanged(existing.description, desired.description)) {
      actions.push(
        mkAction("update-role", `update role "${desired.roleId}"`, () =>
          roleOps.update(desired.roleId, desired.name, desired.description),
        ),
      );
    }
  }

  if (mode === "prune") {
    for (const existing of current.roles) {
      if (!desiredIds.has(existing.roleId)) {
        actions.push(
          mkAction("delete-role", `delete role "${existing.roleId}"`, () => roleOps.delete(existing.roleId), {
            kind: "delete-role",
            roleId: existing.roleId,
          }),
        );
      }
    }
  }
}

function diffGroups(spec: Spec, current: CurrentState, mode: Mode, actions: PlannedAction[]): void {
  const curById = new Map(current.groups.map((g) => [g.groupId, g]));
  const desiredIds = new Set(spec.groups.map((g) => g.groupId));

  for (const desired of spec.groups) {
    const existing = curById.get(desired.groupId);
    if (!existing) {
      actions.push(
        mkAction("create-group", `create group "${desired.groupId}" (${desired.name})`, () =>
          groupOps.create(desired.groupId, desired.name, desired.description),
        ),
      );
    } else if (existing.name !== desired.name || descChanged(existing.description, desired.description)) {
      actions.push(
        mkAction("update-group", `update group "${desired.groupId}"`, () =>
          groupOps.update(desired.groupId, desired.name, desired.description),
        ),
      );
    }
  }

  if (mode === "prune") {
    for (const existing of current.groups) {
      if (!desiredIds.has(existing.groupId)) {
        actions.push(
          mkAction("delete-group", `delete group "${existing.groupId}"`, () => groupOps.delete(existing.groupId), {
            kind: "delete-group",
            groupId: existing.groupId,
          }),
        );
      }
    }
  }
}

function claimKey(claimName: string, claimValue: string): string {
  return `${claimName}::${claimValue}`;
}

/**
 * Camunda enforces a single mapping rule per (claimName, claimValue) pair
 * cluster-wide - creating a second one with the same claim under a different
 * mappingRuleId is rejected by the live API. `diffMappingRules` only ever
 * matched by id, so a spec declaring a fresh id that happens to reuse a claim
 * already owned by some other mapping rule (e.g. one created by Camunda 8.8's
 * built-in boot-time Identity-as-code feature, or left over from an earlier,
 * differently-keyed run) produced a doomed create-mapping-rule action - which
 * failed at apply time, and then cascaded into further failures for every
 * relationship/authorization action that referenced the never-created id.
 *
 * This runs against `current` (live cluster state) before diffing, so the
 * conflict is surfaced as a clear, actionable message at `plan` time instead
 * of an opaque API error mid-`apply`, and the doomed downstream actions are
 * never generated in the first place.
 */
function findMappingRuleClaimConflicts(
  spec: Spec,
  current: CurrentState,
): { conflictedIds: Set<string>; conflicts: string[] } {
  const currentIds = new Set(current.mappingRules.map((m) => m.mappingRuleId));
  const currentIdByClaim = new Map<string, string>();
  for (const m of current.mappingRules) {
    currentIdByClaim.set(claimKey(m.claimName, m.claimValue), m.mappingRuleId);
  }

  const conflictedIds = new Set<string>();
  const conflicts: string[] = [];

  for (const desired of spec.mappingRules) {
    if (currentIds.has(desired.mappingRuleId)) continue; // update path, not a create - no conflict possible
    const existingId = currentIdByClaim.get(claimKey(desired.claimName, desired.claimValue));
    if (existingId !== undefined && existingId !== desired.mappingRuleId) {
      conflictedIds.add(desired.mappingRuleId);
      conflicts.push(
        `mapping rule "${desired.mappingRuleId}" (claim ${desired.claimName}=${desired.claimValue}) cannot be created: ` +
          `mapping rule "${existingId}" already uses this exact claim, and Camunda allows only one mapping rule per claim. ` +
          `Skipped creating "${desired.mappingRuleId}" and any relationship/authorization entries in the spec that reference it. ` +
          `To resolve: change mappingRuleId "${desired.mappingRuleId}" in your spec to "${existingId}" to adopt the existing rule; ` +
          `or, if "${existingId}" isn't declared in your spec and you're running with --prune, rerun after this apply prunes it, which frees the claim for "${desired.mappingRuleId}".`,
      );
    }
  }

  return { conflictedIds, conflicts };
}

function diffMappingRules(
  spec: Spec,
  current: CurrentState,
  mode: Mode,
  actions: PlannedAction[],
  conflictedIds: Set<string>,
): void {
  const curById = new Map(current.mappingRules.map((m) => [m.mappingRuleId, m]));
  const desiredIds = new Set(spec.mappingRules.map((m) => m.mappingRuleId));

  for (const desired of spec.mappingRules) {
    if (conflictedIds.has(desired.mappingRuleId)) continue;
    // The SDK requires `name` on create/update; the YAML schema leaves it optional
    // (matching the example spec, which omits it) - fall back to the mapping rule's
    // own id so a name-less spec entry still round-trips.
    const effectiveName = desired.name ?? desired.mappingRuleId;
    const existing = curById.get(desired.mappingRuleId);
    if (!existing) {
      actions.push(
        mkAction("create-mapping-rule", `create mapping rule "${desired.mappingRuleId}"`, () =>
          mappingRuleOps.create(desired.mappingRuleId, desired.claimName, desired.claimValue, effectiveName),
        ),
      );
    } else if (
      existing.claimName !== desired.claimName ||
      existing.claimValue !== desired.claimValue ||
      existing.name !== effectiveName
    ) {
      actions.push(
        mkAction("update-mapping-rule", `update mapping rule "${desired.mappingRuleId}"`, () =>
          mappingRuleOps.update(desired.mappingRuleId, desired.claimName, desired.claimValue, effectiveName),
        ),
      );
    }
  }

  if (mode === "prune") {
    for (const existing of current.mappingRules) {
      if (!desiredIds.has(existing.mappingRuleId)) {
        actions.push(
          mkAction(
            "delete-mapping-rule",
            `delete mapping rule "${existing.mappingRuleId}"`,
            () => mappingRuleOps.delete(existing.mappingRuleId),
            { kind: "delete-mapping-rule", mappingRuleId: existing.mappingRuleId },
          ),
        );
      }
    }
  }
}

function diffRelationship(
  desiredPairs: Set<string>,
  currentPairs: Set<string>,
  mode: Mode,
  assignKind: ActionKind,
  unassignKind: ActionKind,
  describe: (parentId: string, childId: string) => string,
  doAssign: (parentId: string, childId: string) => ReturnType<typeof roleOps.assignGroup>,
  doUnassign: (parentId: string, childId: string) => ReturnType<typeof roleOps.unassignGroup>,
  actions: PlannedAction[],
  // Lets specific relationship types (currently just role<->client) attach a
  // structured target so protect.ts can guard one exact edge, e.g. "this tool's
  // own client keeping the admin role." Defaults to untargeted for every other
  // relationship type, which has no such per-edge protection need.
  makeUnassignTarget: (parentId: string, childId: string) => ActionTarget = () => ({ kind: "other" }),
): void {
  for (const pair of desiredPairs) {
    if (!currentPairs.has(pair)) {
      const [parentId, childId] = pair.split("::");
      actions.push(mkAction(assignKind, describe(parentId, childId), () => doAssign(parentId, childId)));
    }
  }
  if (mode === "prune") {
    for (const pair of currentPairs) {
      if (!desiredPairs.has(pair)) {
        const [parentId, childId] = pair.split("::");
        actions.push(
          mkAction(
            unassignKind,
            `un${describe(parentId, childId)}`,
            () => doUnassign(parentId, childId),
            makeUnassignTarget(parentId, childId),
          ),
        );
      }
    }
  }
}

function diffRelationships(
  spec: Spec,
  current: CurrentState,
  mode: Mode,
  actions: PlannedAction[],
  conflictedIds: Set<string>,
): void {
  const roleGroupDesired = new Set<string>();
  const roleMappingRuleDesired = new Set<string>();
  const roleUserDesired = new Set<string>();
  const roleClientDesired = new Set<string>();
  for (const role of spec.roles) {
    for (const groupId of role.groups) roleGroupDesired.add(`${role.roleId}::${groupId}`);
    for (const mappingRuleId of role.mappingRules) {
      if (conflictedIds.has(mappingRuleId)) continue;
      roleMappingRuleDesired.add(`${role.roleId}::${mappingRuleId}`);
    }
    for (const username of role.users) roleUserDesired.add(`${role.roleId}::${username}`);
    for (const clientId of role.clients) roleClientDesired.add(`${role.roleId}::${clientId}`);
  }

  const groupMappingRuleDesired = new Set<string>();
  const groupUserDesired = new Set<string>();
  const groupClientDesired = new Set<string>();
  for (const group of spec.groups) {
    for (const mappingRuleId of group.mappingRules) {
      if (conflictedIds.has(mappingRuleId)) continue;
      groupMappingRuleDesired.add(`${group.groupId}::${mappingRuleId}`);
    }
    for (const username of group.users) groupUserDesired.add(`${group.groupId}::${username}`);
    for (const clientId of group.clients) groupClientDesired.add(`${group.groupId}::${clientId}`);
  }

  const tenantRoleDesired = new Set<string>();
  const tenantGroupDesired = new Set<string>();
  const tenantMappingRuleDesired = new Set<string>();
  for (const tenant of spec.tenants) {
    for (const roleId of tenant.roles) tenantRoleDesired.add(`${tenant.tenantId}::${roleId}`);
    for (const groupId of tenant.groups) tenantGroupDesired.add(`${tenant.tenantId}::${groupId}`);
    for (const mappingRuleId of tenant.mappingRules) {
      if (conflictedIds.has(mappingRuleId)) continue;
      tenantMappingRuleDesired.add(`${tenant.tenantId}::${mappingRuleId}`);
    }
  }

  diffRelationship(
    groupMappingRuleDesired,
    current.relationships.groupMappingRule,
    mode,
    "assign-group-mapping-rule",
    "unassign-group-mapping-rule",
    (groupId, mappingRuleId) => `assign mapping rule "${mappingRuleId}" to group "${groupId}"`,
    (groupId, mappingRuleId) => groupOps.assignMappingRule(groupId, mappingRuleId),
    (groupId, mappingRuleId) => groupOps.unassignMappingRule(groupId, mappingRuleId),
    actions,
  );

  diffRelationship(
    groupUserDesired,
    current.relationships.groupUser,
    mode,
    "assign-group-user",
    "unassign-group-user",
    (groupId, username) => `assign user "${username}" to group "${groupId}"`,
    (groupId, username) => groupOps.assignUser(groupId, username),
    (groupId, username) => groupOps.unassignUser(groupId, username),
    actions,
  );

  diffRelationship(
    groupClientDesired,
    current.relationships.groupClient,
    mode,
    "assign-group-client",
    "unassign-group-client",
    (groupId, clientId) => `assign client "${clientId}" to group "${groupId}"`,
    (groupId, clientId) => groupOps.assignClient(groupId, clientId),
    (groupId, clientId) => groupOps.unassignClient(groupId, clientId),
    actions,
  );

  diffRelationship(
    roleUserDesired,
    current.relationships.roleUser,
    mode,
    "assign-role-user",
    "unassign-role-user",
    (roleId, username) => `assign user "${username}" to role "${roleId}"`,
    (roleId, username) => roleOps.assignUser(roleId, username),
    (roleId, username) => roleOps.unassignUser(roleId, username),
    actions,
  );

  diffRelationship(
    roleClientDesired,
    current.relationships.roleClient,
    mode,
    "assign-role-client",
    "unassign-role-client",
    (roleId, clientId) => `assign client "${clientId}" to role "${roleId}"`,
    (roleId, clientId) => roleOps.assignClient(roleId, clientId),
    (roleId, clientId) => roleOps.unassignClient(roleId, clientId),
    actions,
    (roleId, clientId) => ({ kind: "unassign-role-client", roleId, clientId }),
  );

  diffRelationship(
    roleMappingRuleDesired,
    current.relationships.roleMappingRule,
    mode,
    "assign-role-mapping-rule",
    "unassign-role-mapping-rule",
    (roleId, mappingRuleId) => `assign mapping rule "${mappingRuleId}" to role "${roleId}"`,
    (roleId, mappingRuleId) => roleOps.assignMappingRule(roleId, mappingRuleId),
    (roleId, mappingRuleId) => roleOps.unassignMappingRule(roleId, mappingRuleId),
    actions,
  );

  diffRelationship(
    roleGroupDesired,
    current.relationships.roleGroup,
    mode,
    "assign-role-group",
    "unassign-role-group",
    (roleId, groupId) => `assign role "${roleId}" to group "${groupId}"`,
    (roleId, groupId) => roleOps.assignGroup(roleId, groupId),
    (roleId, groupId) => roleOps.unassignGroup(roleId, groupId),
    actions,
  );

  diffRelationship(
    tenantRoleDesired,
    current.relationships.tenantRole,
    mode,
    "assign-tenant-role",
    "unassign-tenant-role",
    (tenantId, roleId) => `assign role "${roleId}" to tenant "${tenantId}"`,
    (tenantId, roleId) => tenantOps.assignRole(tenantId, roleId),
    (tenantId, roleId) => tenantOps.unassignRole(tenantId, roleId),
    actions,
    (tenantId, roleId) => ({ kind: "unassign-tenant-role", tenantId, roleId }),
  );

  diffRelationship(
    tenantGroupDesired,
    current.relationships.tenantGroup,
    mode,
    "assign-tenant-group",
    "unassign-tenant-group",
    (tenantId, groupId) => `assign group "${groupId}" to tenant "${tenantId}"`,
    (tenantId, groupId) => tenantOps.assignGroup(tenantId, groupId),
    (tenantId, groupId) => tenantOps.unassignGroup(tenantId, groupId),
    actions,
  );

  diffRelationship(
    tenantMappingRuleDesired,
    current.relationships.tenantMappingRule,
    mode,
    "assign-tenant-mapping-rule",
    "unassign-tenant-mapping-rule",
    (tenantId, mappingRuleId) => `assign mapping rule "${mappingRuleId}" to tenant "${tenantId}"`,
    (tenantId, mappingRuleId) => tenantOps.assignMappingRule(tenantId, mappingRuleId),
    (tenantId, mappingRuleId) => tenantOps.unassignMappingRule(tenantId, mappingRuleId),
    actions,
  );
}

function authTupleKey(t: { ownerType: string; ownerId: string; resourceType: string; resourceId: string }): string {
  return `${t.ownerType}::${t.ownerId}::${t.resourceType}::${t.resourceId}`;
}

function samePermissionSet(a: string[], b: string[]): boolean {
  return a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
}

function diffAuthorizations(
  spec: Spec,
  current: CurrentState,
  mode: Mode,
  actions: PlannedAction[],
  conflictedIds: Set<string>,
): void {
  const curByTuple = new Map(current.authorizations.map((a) => [authTupleKey(a), a]));
  const desiredTuples = new Set<string>();

  for (const desired of spec.authorizations) {
    if (
      (desired.ownerType === "MAPPING_RULE" && conflictedIds.has(desired.ownerId)) ||
      (desired.resourceType === "MAPPING_RULE" && conflictedIds.has(desired.resourceId))
    ) {
      continue;
    }
    const key = authTupleKey(desired);
    desiredTuples.add(key);
    const tuple: AuthorizationTuple = {
      ownerType: desired.ownerType,
      ownerId: desired.ownerId,
      resourceType: desired.resourceType,
      resourceId: desired.resourceId,
      permissions: desired.permissions,
    };
    const label = `${desired.ownerType}:${desired.ownerId} -> ${desired.resourceType}:${desired.resourceId}`;
    const target: ActionTarget = { kind: "authorization", ownerType: desired.ownerType, ownerId: desired.ownerId };
    const existing = curByTuple.get(key);
    if (!existing) {
      actions.push(
        mkAction(
          "create-authorization",
          `create authorization ${label} [${desired.permissions.join(", ")}]`,
          () => authorizationOps.create(tuple),
          target,
        ),
      );
    } else if (!samePermissionSet(existing.permissionTypes, desired.permissions)) {
      actions.push(
        mkAction(
          "update-authorization",
          `update authorization ${label} permissions -> [${desired.permissions.join(", ")}]`,
          () => authorizationOps.update(existing.authorizationKey, tuple),
          target,
        ),
      );
    }
  }

  if (mode === "prune") {
    for (const existing of current.authorizations) {
      const key = authTupleKey(existing);
      if (!desiredTuples.has(key)) {
        const label = `${existing.ownerType}:${existing.ownerId} -> ${existing.resourceType}:${existing.resourceId}`;
        actions.push(
          mkAction(
            "delete-authorization",
            `delete authorization ${label}`,
            () => authorizationOps.delete(existing.authorizationKey),
            { kind: "authorization", ownerType: existing.ownerType, ownerId: existing.ownerId },
          ),
        );
      }
    }
  }
}

export function buildPlan(spec: Spec, current: CurrentState, mode: Mode): ReconciliationPlan {
  const actions: PlannedAction[] = [];

  const { conflictedIds, conflicts } = findMappingRuleClaimConflicts(spec, current);

  diffTenants(spec, current, mode, actions);
  diffRoles(spec, current, mode, actions);
  diffGroups(spec, current, mode, actions);
  diffMappingRules(spec, current, mode, actions, conflictedIds);
  diffRelationships(spec, current, mode, actions, conflictedIds);
  diffAuthorizations(spec, current, mode, actions, conflictedIds);

  const { actions: protectedActions, warnings } = applyProtections(actions);
  return { actions: sortActions(protectedActions), warnings, conflicts };
}
