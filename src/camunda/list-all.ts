import { getClient, NO_WAIT } from "./client.js";
import type {
  AuthorizationEntity,
  CurrentState,
  GroupEntity,
  MappingRuleEntity,
  RelationshipState,
  RoleEntity,
  TenantEntity,
} from "../reconcile/types.js";
import type { OwnerType, PermissionType, ResourceType } from "../spec/schema.js";

const client = () => getClient();

const PAGE_SIZE = 100;

async function paginateAll<T>(
  fetchPage: (page: { from: number; limit: number }) => Promise<{ items: T[]; page: { totalItems: number } }>,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { items, page } = await fetchPage({ from, limit: PAGE_SIZE });
    all.push(...items);
    from += items.length;
    if (items.length === 0 || from >= page.totalItems) break;
  }
  return all;
}

export async function listAllTenants(): Promise<TenantEntity[]> {
  const items = await paginateAll((page) => client().searchTenants({ page }, NO_WAIT));
  return items.map((t) => ({ tenantId: t.tenantId, name: t.name, description: t.description }));
}

export async function listAllRoles(): Promise<RoleEntity[]> {
  const items = await paginateAll((page) => client().searchRoles({ page }, NO_WAIT));
  return items.map((r) => ({ roleId: r.roleId, name: r.name, description: r.description }));
}

export async function listAllGroups(): Promise<GroupEntity[]> {
  const items = await paginateAll((page) => client().searchGroups({ page }, NO_WAIT));
  return items.map((g) => ({ groupId: g.groupId, name: g.name, description: g.description }));
}

export async function listAllMappingRules(): Promise<MappingRuleEntity[]> {
  const items = await paginateAll((page) => client().searchMappingRule({ page }, NO_WAIT));
  return items.map((m) => ({
    mappingRuleId: m.mappingRuleId,
    claimName: m.claimName,
    claimValue: m.claimValue,
    name: m.name,
  }));
}

export async function listAllAuthorizations(): Promise<AuthorizationEntity[]> {
  const items = await paginateAll((page) => client().searchAuthorizations({ page }, NO_WAIT));
  return items
    .filter((a): a is typeof a & { resourceId: string } => a.resourceId !== null)
    .map((a) => ({
      authorizationKey: a.authorizationKey,
      ownerId: a.ownerId,
      ownerType: a.ownerType as OwnerType,
      resourceType: a.resourceType as ResourceType,
      resourceId: a.resourceId,
      permissionTypes: a.permissionTypes as PermissionType[],
    }));
}

async function fetchRelationships(
  roles: RoleEntity[],
  groups: GroupEntity[],
  tenants: TenantEntity[],
  onProgress?: (completed: number, total: number) => void,
): Promise<RelationshipState> {
  const roleGroup = new Set<string>();
  const roleMappingRule = new Set<string>();
  const groupMappingRule = new Set<string>();
  const tenantRole = new Set<string>();
  const tenantGroup = new Set<string>();
  const groupUser = new Set<string>();
  const groupClient = new Set<string>();
  const roleUser = new Set<string>();
  const roleClient = new Set<string>();
  const tenantMappingRule = new Set<string>();

  const total = roles.length + groups.length + tenants.length;
  let completed = 0;
  const tick = () => onProgress?.(++completed, total);

  await Promise.all([
    ...roles.map(async (role) => {
      const [groupsForRole, mappingRulesForRole, usersForRole, clientsForRole] = await Promise.all([
        paginateAll((page) => client().searchGroupsForRole({ roleId: role.roleId, page }, NO_WAIT)),
        paginateAll((page) => client().searchMappingRulesForRole({ roleId: role.roleId, page }, NO_WAIT)),
        paginateAll((page) => client().searchUsersForRole({ roleId: role.roleId, page }, NO_WAIT)),
        paginateAll((page) => client().searchClientsForRole({ roleId: role.roleId, page }, NO_WAIT)),
      ]);
      for (const g of groupsForRole) roleGroup.add(`${role.roleId}::${g.groupId}`);
      for (const m of mappingRulesForRole) roleMappingRule.add(`${role.roleId}::${m.mappingRuleId}`);
      for (const u of usersForRole) roleUser.add(`${role.roleId}::${u.username}`);
      for (const c of clientsForRole) roleClient.add(`${role.roleId}::${c.clientId}`);
      tick();
    }),
    ...groups.map(async (group) => {
      const [mappingRulesForGroup, usersForGroup, clientsForGroup] = await Promise.all([
        paginateAll((page) => client().searchMappingRulesForGroup({ groupId: group.groupId, page }, NO_WAIT)),
        paginateAll((page) => client().searchUsersForGroup({ groupId: group.groupId, page }, NO_WAIT)),
        paginateAll((page) => client().searchClientsForGroup({ groupId: group.groupId, page }, NO_WAIT)),
      ]);
      for (const m of mappingRulesForGroup) groupMappingRule.add(`${group.groupId}::${m.mappingRuleId}`);
      for (const u of usersForGroup) groupUser.add(`${group.groupId}::${u.username}`);
      for (const c of clientsForGroup) groupClient.add(`${group.groupId}::${c.clientId}`);
      tick();
    }),
    ...tenants.map(async (tenant) => {
      const [rolesForTenant, groupIdsForTenant, mappingRulesForTenant] = await Promise.all([
        paginateAll((page) => client().searchRolesForTenant({ tenantId: tenant.tenantId, page }, NO_WAIT)),
        paginateAll((page) => client().searchGroupIdsForTenant({ tenantId: tenant.tenantId, page }, NO_WAIT)),
        paginateAll((page) => client().searchMappingRulesForTenant({ tenantId: tenant.tenantId, page }, NO_WAIT)),
      ]);
      for (const r of rolesForTenant) tenantRole.add(`${tenant.tenantId}::${r.roleId}`);
      for (const g of groupIdsForTenant) tenantGroup.add(`${tenant.tenantId}::${g.groupId}`);
      for (const m of mappingRulesForTenant) tenantMappingRule.add(`${tenant.tenantId}::${m.mappingRuleId}`);
      tick();
    }),
  ]);

  return {
    roleGroup,
    roleMappingRule,
    groupMappingRule,
    tenantRole,
    tenantGroup,
    groupUser,
    groupClient,
    roleUser,
    roleClient,
    tenantMappingRule,
  };
}

/** Reported by `fetchCurrentState` as it progresses through its two fetch phases. */
export interface FetchProgressEvent {
  phase: "entities" | "relationships";
  completed: number;
  total: number;
}

/**
 * Fetches the complete current cluster state in one pass: every tenant, role,
 * group, mapping rule and authorization, plus every relationship pair between
 * them. Relationship membership is queried for every *current* entity (not just
 * ones named in the desired spec) - this is what makes cascading deletes possible
 * in prune mode: an entity about to be pruned still has its stale links surfaced
 * here, so diff.ts can schedule the unassign/delete-authorization actions that
 * must run before the entity itself is deleted.
 *
 * `onProgress`, if given, is called as each of the two fetch phases (entity
 * lists, then per-entity relationship lookups) makes progress - purely for
 * caller-side UX (e.g. a CLI progress indicator); this function itself never
 * renders anything.
 */
export async function fetchCurrentState(onProgress?: (event: FetchProgressEvent) => void): Promise<CurrentState> {
  let entitiesCompleted = 0;
  const entityTick = () => onProgress?.({ phase: "entities", completed: ++entitiesCompleted, total: 5 });

  const [tenants, roles, groups, mappingRules, authorizations] = await Promise.all([
    listAllTenants().then((r) => {
      entityTick();
      return r;
    }),
    listAllRoles().then((r) => {
      entityTick();
      return r;
    }),
    listAllGroups().then((r) => {
      entityTick();
      return r;
    }),
    listAllMappingRules().then((r) => {
      entityTick();
      return r;
    }),
    listAllAuthorizations().then((r) => {
      entityTick();
      return r;
    }),
  ]);
  const relationships = await fetchRelationships(roles, groups, tenants, (completed, total) =>
    onProgress?.({ phase: "relationships", completed, total }),
  );
  return { tenants, roles, groups, mappingRules, authorizations, relationships };
}
