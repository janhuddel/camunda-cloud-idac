import type { Result } from "@camunda8/orchestration-cluster-api";
import { getClient, toResult } from "./client.js";
import type { OwnerType, PermissionType, ResourceType } from "../spec/schema.js";

const client = () => getClient();

export const tenantOps = {
  create: (tenantId: string, name: string, description?: string): Promise<Result<unknown>> =>
    toResult(() => client().createTenant({ tenantId, name, description })),
  update: (tenantId: string, name: string, description?: string): Promise<Result<unknown>> =>
    toResult(() => client().updateTenant({ tenantId, name, description })),
  delete: (tenantId: string): Promise<Result<unknown>> =>
    toResult(() => client().deleteTenant({ tenantId })),
  assignRole: (tenantId: string, roleId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignRoleToTenant({ tenantId, roleId })),
  unassignRole: (tenantId: string, roleId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignRoleFromTenant({ tenantId, roleId })),
  assignGroup: (tenantId: string, groupId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignGroupToTenant({ tenantId, groupId })),
  unassignGroup: (tenantId: string, groupId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignGroupFromTenant({ tenantId, groupId })),
  assignMappingRule: (tenantId: string, mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignMappingRuleToTenant({ tenantId, mappingRuleId })),
  unassignMappingRule: (tenantId: string, mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignMappingRuleFromTenant({ tenantId, mappingRuleId })),
};

export const roleOps = {
  create: (roleId: string, name: string, description?: string): Promise<Result<unknown>> =>
    toResult(() => client().createRole({ roleId, name, description })),
  update: (roleId: string, name: string, description?: string): Promise<Result<unknown>> =>
    toResult(() => client().updateRole({ roleId, name, description })),
  delete: (roleId: string): Promise<Result<unknown>> => toResult(() => client().deleteRole({ roleId })),
  assignGroup: (roleId: string, groupId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignRoleToGroup({ roleId, groupId })),
  unassignGroup: (roleId: string, groupId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignRoleFromGroup({ roleId, groupId })),
  assignMappingRule: (roleId: string, mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignRoleToMappingRule({ roleId, mappingRuleId })),
  unassignMappingRule: (roleId: string, mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignRoleFromMappingRule({ roleId, mappingRuleId })),
  assignUser: (roleId: string, username: string): Promise<Result<unknown>> =>
    toResult(() => client().assignRoleToUser({ roleId, username })),
  unassignUser: (roleId: string, username: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignRoleFromUser({ roleId, username })),
  assignClient: (roleId: string, clientId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignRoleToClient({ roleId, clientId })),
  unassignClient: (roleId: string, clientId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignRoleFromClient({ roleId, clientId })),
};

export const groupOps = {
  create: (groupId: string, name: string, description?: string): Promise<Result<unknown>> =>
    toResult(() => client().createGroup({ groupId, name, description })),
  update: (groupId: string, name: string, description?: string): Promise<Result<unknown>> =>
    toResult(() => client().updateGroup({ groupId, name, description })),
  delete: (groupId: string): Promise<Result<unknown>> => toResult(() => client().deleteGroup({ groupId })),
  assignMappingRule: (groupId: string, mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignMappingRuleToGroup({ groupId, mappingRuleId })),
  unassignMappingRule: (groupId: string, mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignMappingRuleFromGroup({ groupId, mappingRuleId })),
  assignUser: (groupId: string, username: string): Promise<Result<unknown>> =>
    toResult(() => client().assignUserToGroup({ groupId, username })),
  unassignUser: (groupId: string, username: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignUserFromGroup({ groupId, username })),
  assignClient: (groupId: string, clientId: string): Promise<Result<unknown>> =>
    toResult(() => client().assignClientToGroup({ groupId, clientId })),
  unassignClient: (groupId: string, clientId: string): Promise<Result<unknown>> =>
    toResult(() => client().unassignClientFromGroup({ groupId, clientId })),
};

export const mappingRuleOps = {
  create: (mappingRuleId: string, claimName: string, claimValue: string, name: string): Promise<Result<unknown>> =>
    toResult(() => client().createMappingRule({ mappingRuleId, claimName, claimValue, name })),
  update: (mappingRuleId: string, claimName: string, claimValue: string, name: string): Promise<Result<unknown>> =>
    toResult(() => client().updateMappingRule({ mappingRuleId, claimName, claimValue, name })),
  delete: (mappingRuleId: string): Promise<Result<unknown>> =>
    toResult(() => client().deleteMappingRule({ mappingRuleId })),
};

export interface AuthorizationTuple {
  ownerType: OwnerType;
  ownerId: string;
  resourceType: ResourceType;
  resourceId: string;
  permissions: PermissionType[];
}

export const authorizationOps = {
  create: (auth: AuthorizationTuple): Promise<Result<unknown>> =>
    toResult(() =>
      client().createAuthorization({
        ownerId: auth.ownerId,
        ownerType: auth.ownerType,
        resourceId: auth.resourceId,
        resourceType: auth.resourceType,
        permissionTypes: auth.permissions,
      }),
    ),
  // updateAuthorization is a full replace, never a partial patch - always send the
  // complete desired shape.
  update: (authorizationKey: string, auth: AuthorizationTuple): Promise<Result<unknown>> =>
    toResult(() =>
      client().updateAuthorization({
        authorizationKey,
        ownerId: auth.ownerId,
        ownerType: auth.ownerType,
        resourceId: auth.resourceId,
        resourceType: auth.resourceType,
        permissionTypes: auth.permissions,
      }),
    ),
  delete: (authorizationKey: string): Promise<Result<unknown>> =>
    toResult(() => client().deleteAuthorization({ authorizationKey })),
};
