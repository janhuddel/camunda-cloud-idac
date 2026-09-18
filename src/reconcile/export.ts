import { Spec, type Spec as SpecType } from "../spec/schema.js";
import { formatZodError } from "../spec/errors.js";
import type { CurrentState } from "./types.js";

/** Thrown when the live cluster's own state fails the spec's referential-integrity
 * checks - e.g. a relationship still referencing an entity deleted mid-fetch, since
 * `fetchCurrentState()` reads entities and relationships concurrently. Narrow and
 * rare; `cli.ts`'s generic `Error` handling already reports this correctly. */
export class SpecExportError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cluster state produced an invalid spec:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "SpecExportError";
  }
}

/** Plain codepoint comparison, not localeCompare - locale/ICU-dependent ordering
 * would make export's output vary by machine, defeating the point of a
 * deterministic, git-diffable snapshot. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inverts a flat "parentId::childId" pair set (as stored on `CurrentState.relationships`)
 * back into parentId -> childId[], each list sorted for deterministic output. This is
 * the literal inverse of the flattening loop in `diffRelationships()` (diff.ts). */
function unflatten(pairs: Set<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pair of pairs) {
    const separator = pair.indexOf("::");
    const parentId = pair.slice(0, separator);
    const childId = pair.slice(separator + 2);
    const children = map.get(parentId);
    if (children) children.push(childId);
    else map.set(parentId, [childId]);
  }
  for (const children of map.values()) children.sort(compareStrings);
  return map;
}

/** Converts a full live-cluster read into a spec - the reverse of `diffRelationships()`
 * in diff.ts. Used by the `export` CLI command. */
export function stateToSpec(current: CurrentState): SpecType {
  const roleGroups = unflatten(current.relationships.roleGroup);
  const roleMappingRules = unflatten(current.relationships.roleMappingRule);
  const roleUsers = unflatten(current.relationships.roleUser);
  const roleClients = unflatten(current.relationships.roleClient);
  const groupMappingRules = unflatten(current.relationships.groupMappingRule);
  const groupUsers = unflatten(current.relationships.groupUser);
  const groupClients = unflatten(current.relationships.groupClient);
  const tenantRoles = unflatten(current.relationships.tenantRole);
  const tenantGroups = unflatten(current.relationships.tenantGroup);
  const tenantMappingRules = unflatten(current.relationships.tenantMappingRule);

  const tenants = [...current.tenants]
    .sort((a, b) => compareStrings(a.tenantId, b.tenantId))
    .map((t) => ({
      tenantId: t.tenantId,
      name: t.name,
      ...(t.description != null ? { description: t.description } : {}),
      roles: tenantRoles.get(t.tenantId) ?? [],
      groups: tenantGroups.get(t.tenantId) ?? [],
      mappingRules: tenantMappingRules.get(t.tenantId) ?? [],
    }));

  const roles = [...current.roles]
    .sort((a, b) => compareStrings(a.roleId, b.roleId))
    .map((r) => ({
      roleId: r.roleId,
      name: r.name,
      ...(r.description != null ? { description: r.description } : {}),
      mappingRules: roleMappingRules.get(r.roleId) ?? [],
      groups: roleGroups.get(r.roleId) ?? [],
      users: roleUsers.get(r.roleId) ?? [],
      clients: roleClients.get(r.roleId) ?? [],
    }));

  const groups = [...current.groups]
    .sort((a, b) => compareStrings(a.groupId, b.groupId))
    .map((g) => ({
      groupId: g.groupId,
      name: g.name,
      ...(g.description != null ? { description: g.description } : {}),
      mappingRules: groupMappingRules.get(g.groupId) ?? [],
      users: groupUsers.get(g.groupId) ?? [],
      clients: groupClients.get(g.groupId) ?? [],
    }));

  const mappingRules = [...current.mappingRules]
    .sort((a, b) => compareStrings(a.mappingRuleId, b.mappingRuleId))
    .map((m) => ({
      mappingRuleId: m.mappingRuleId,
      claimName: m.claimName,
      claimValue: m.claimValue,
      name: m.name,
    }));

  const authorizations = [...current.authorizations]
    .sort((a, b) =>
      compareStrings(
        `${a.ownerType}::${a.ownerId}::${a.resourceType}::${a.resourceId}`,
        `${b.ownerType}::${b.ownerId}::${b.resourceType}::${b.resourceId}`,
      ),
    )
    .map((a) => ({
      ownerType: a.ownerType,
      ownerId: a.ownerId,
      resourceType: a.resourceType,
      resourceId: a.resourceId,
      permissions: [...a.permissionTypes].sort(compareStrings),
    }));

  const result = Spec.safeParse({ tenants, roles, groups, mappingRules, authorizations });
  if (!result.success) {
    throw new SpecExportError(formatZodError(result.error));
  }
  return result.data;
}
