import type { OwnerType, PermissionType, ResourceType } from "../spec/schema.js";
import type { Result } from "@camunda8/orchestration-cluster-api";

export interface TenantEntity {
  tenantId: string;
  name: string;
  description: string | null;
}

export interface RoleEntity {
  roleId: string;
  name: string;
  description: string | null;
}

export interface GroupEntity {
  groupId: string;
  name: string;
  description: string | null;
}

export interface MappingRuleEntity {
  mappingRuleId: string;
  claimName: string;
  claimValue: string;
  name: string;
}

export interface AuthorizationEntity {
  authorizationKey: string;
  ownerId: string;
  ownerType: OwnerType;
  resourceType: ResourceType;
  resourceId: string;
  permissionTypes: PermissionType[];
}

/** "parentId::childId" pair sets, one per relationship type this tool reconciles. */
export interface RelationshipState {
  roleGroup: Set<string>;
  roleMappingRule: Set<string>;
  groupMappingRule: Set<string>;
  tenantRole: Set<string>;
  tenantGroup: Set<string>;
  groupUser: Set<string>;
  groupClient: Set<string>;
  roleUser: Set<string>;
  roleClient: Set<string>;
  tenantMappingRule: Set<string>;
}

export interface CurrentState {
  tenants: TenantEntity[];
  roles: RoleEntity[];
  groups: GroupEntity[];
  mappingRules: MappingRuleEntity[];
  authorizations: AuthorizationEntity[];
  relationships: RelationshipState;
}

export type ActionKind =
  | "create-tenant"
  | "update-tenant"
  | "delete-tenant"
  | "create-role"
  | "update-role"
  | "delete-role"
  | "create-group"
  | "update-group"
  | "delete-group"
  | "create-mapping-rule"
  | "update-mapping-rule"
  | "delete-mapping-rule"
  | "assign-role-mapping-rule"
  | "unassign-role-mapping-rule"
  | "assign-role-group"
  | "unassign-role-group"
  | "assign-group-mapping-rule"
  | "unassign-group-mapping-rule"
  | "assign-tenant-role"
  | "unassign-tenant-role"
  | "assign-tenant-group"
  | "unassign-tenant-group"
  | "assign-tenant-mapping-rule"
  | "unassign-tenant-mapping-rule"
  | "assign-group-user"
  | "unassign-group-user"
  | "assign-group-client"
  | "unassign-group-client"
  | "assign-role-user"
  | "unassign-role-user"
  | "assign-role-client"
  | "unassign-role-client"
  | "create-authorization"
  | "update-authorization"
  | "delete-authorization";

export const DESTRUCTIVE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "delete-tenant",
  "delete-role",
  "delete-group",
  "delete-mapping-rule",
  "delete-authorization",
  "unassign-role-mapping-rule",
  "unassign-role-group",
  "unassign-group-mapping-rule",
  "unassign-group-user",
  "unassign-group-client",
  "unassign-role-user",
  "unassign-role-client",
  "unassign-tenant-role",
  "unassign-tenant-group",
  "unassign-tenant-mapping-rule",
]);

/** Identifies the specific entity/tuple an action targets, so protect.ts can match
 * against it without string-parsing `description`. */
export type ActionTarget =
  | { kind: "delete-tenant"; tenantId: string }
  | { kind: "delete-role"; roleId: string }
  | { kind: "delete-group"; groupId: string }
  | { kind: "delete-mapping-rule"; mappingRuleId: string }
  // Covers create-authorization, update-authorization, AND delete-authorization -
  // the "admin" role's authorizations are fully hands-off (never created, updated,
  // or deleted by this tool), not merely protected from deletion.
  | { kind: "authorization"; ownerType: OwnerType; ownerId: string }
  // Only unassign-role-client carries this - lets protect.ts guard one specific
  // relationship edge (the tool's own client keeping the admin role) without
  // touching any other role-client pair.
  | { kind: "unassign-role-client"; roleId: string; clientId: string }
  | { kind: "other" };

export interface PlannedAction {
  kind: ActionKind;
  description: string;
  destructive: boolean;
  target: ActionTarget;
  execute: () => Promise<Result<unknown>>;
}

export interface ReconciliationPlan {
  actions: PlannedAction[];
  warnings: string[];
}

export interface ApplyResult {
  succeeded: PlannedAction[];
  failed: { action: PlannedAction; error: unknown }[];
  skippedProtected: string[];
}
