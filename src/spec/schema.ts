import { z } from "zod";

// Copied verbatim from node_modules/@camunda8/orchestration-cluster-api's shipped
// .d.ts (OwnerTypeEnum / ResourceTypeEnum / PermissionTypeEnum). Re-check these
// against the installed package whenever the pinned SDK version in package.json
// changes - a drifted enum here would silently accept specs the live API rejects.

export const OwnerType = z.enum(["USER", "CLIENT", "ROLE", "GROUP", "MAPPING_RULE", "UNSPECIFIED"]);
export type OwnerType = z.infer<typeof OwnerType>;

export const ResourceType = z.enum([
  "AUDIT_LOG",
  "AUTHORIZATION",
  "BATCH",
  "CLUSTER_VARIABLE",
  "COMPONENT",
  "DECISION_DEFINITION",
  "DECISION_REQUIREMENTS_DEFINITION",
  "DOCUMENT",
  "EXPRESSION",
  "GLOBAL_LISTENER",
  "GROUP",
  "MAPPING_RULE",
  "MESSAGE",
  "PROCESS_DEFINITION",
  "RESOURCE",
  "ROLE",
  "SYSTEM",
  "TENANT",
  "USER",
  "USER_TASK",
]);
export type ResourceType = z.infer<typeof ResourceType>;

export const PermissionType = z.enum([
  "ACCESS",
  "CANCEL_PROCESS_INSTANCE",
  "CLAIM",
  "CLAIM_USER_TASK",
  "COMPLETE",
  "COMPLETE_USER_TASK",
  "CREATE",
  "CREATE_BATCH_OPERATION_CANCEL_PROCESS_INSTANCE",
  "CREATE_BATCH_OPERATION_DELETE_DECISION_DEFINITION",
  "CREATE_BATCH_OPERATION_DELETE_DECISION_INSTANCE",
  "CREATE_BATCH_OPERATION_DELETE_PROCESS_DEFINITION",
  "CREATE_BATCH_OPERATION_DELETE_PROCESS_INSTANCE",
  "CREATE_BATCH_OPERATION_MIGRATE_PROCESS_INSTANCE",
  "CREATE_BATCH_OPERATION_MODIFY_PROCESS_INSTANCE",
  "CREATE_BATCH_OPERATION_RESOLVE_INCIDENT",
  "CREATE_DECISION_INSTANCE",
  "CREATE_PROCESS_INSTANCE",
  "CREATE_TASK_LISTENER",
  "DELETE",
  "DELETE_DECISION_INSTANCE",
  "DELETE_DRD",
  "DELETE_FORM",
  "DELETE_PROCESS",
  "DELETE_PROCESS_INSTANCE",
  "DELETE_RESOURCE",
  "DELETE_TASK_LISTENER",
  "EVALUATE",
  "MODIFY_PROCESS_INSTANCE",
  "READ",
  "READ_DECISION_DEFINITION",
  "READ_DECISION_INSTANCE",
  "READ_JOB_METRIC",
  "READ_PROCESS_DEFINITION",
  "READ_PROCESS_INSTANCE",
  "READ_USAGE_METRIC",
  "READ_USER_TASK",
  "READ_TASK_LISTENER",
  "UPDATE",
  "UPDATE_PROCESS_INSTANCE",
  "UPDATE_USER_TASK",
  "UPDATE_TASK_LISTENER",
]);
export type PermissionType = z.infer<typeof PermissionType>;

// Entities that can own an authorization and are also declared as first-class
// entities in this spec (used by the referential-integrity check below).
const OWNER_TYPES_WITH_DECLARED_ENTITIES = new Set<OwnerType>(["ROLE", "GROUP", "MAPPING_RULE"]);

// .strict() on every object below is deliberate, not incidental: zod's default
// z.object() silently drops unrecognized keys instead of rejecting them, which
// would let a typo (e.g. `mappingRuleId: [...]` instead of `mappingRules: [...]`
// on a group) parse "successfully" while silently doing nothing - exactly the
// class of error this tool uses zod to prevent in the first place.

const MappingRuleSpec = z
  .object({
    mappingRuleId: z.string().min(1),
    claimName: z.string().min(1),
    claimValue: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();
export type MappingRuleSpec = z.infer<typeof MappingRuleSpec>;

const GroupSpec = z
  .object({
    groupId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    mappingRules: z.array(z.string()).default([]),
    // Direct membership, not modeled via mapping rules/OIDC claims. Usernames and
    // client IDs aren't declared entities elsewhere in this spec (unlike
    // roles/groups/mappingRules), so there's no referential-integrity check for
    // these - any string is accepted, matching how authorization owners of type
    // USER/CLIENT are handled.
    users: z.array(z.string()).default([]),
    clients: z.array(z.string()).default([]),
  })
  .strict();
export type GroupSpec = z.infer<typeof GroupSpec>;

const RoleSpec = z
  .object({
    roleId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    mappingRules: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    // Direct membership - not modeled via mapping rules/OIDC claims, no
    // referential-integrity check (same rationale as GroupSpec.users/clients above).
    users: z.array(z.string()).default([]),
    clients: z.array(z.string()).default([]),
  })
  .strict();
export type RoleSpec = z.infer<typeof RoleSpec>;

const TenantSpec = z
  .object({
    tenantId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    roles: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    mappingRules: z.array(z.string()).default([]),
  })
  .strict();
export type TenantSpec = z.infer<typeof TenantSpec>;

const AuthorizationSpec = z
  .object({
    ownerType: OwnerType,
    ownerId: z.string().min(1),
    resourceType: ResourceType,
    resourceId: z.string().min(1),
    permissions: z.array(PermissionType).min(1),
  })
  .strict();
export type AuthorizationSpec = z.infer<typeof AuthorizationSpec>;

const RawSpec = z
  .object({
    tenants: z.array(TenantSpec).default([]),
    roles: z.array(RoleSpec).default([]),
    groups: z.array(GroupSpec).default([]),
    mappingRules: z.array(MappingRuleSpec).default([]),
    authorizations: z.array(AuthorizationSpec).default([]),
  })
  .strict();

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

export const Spec = RawSpec.superRefine((spec, ctx) => {
  const mappingRuleIds = new Set(spec.mappingRules.map((m) => m.mappingRuleId));
  const groupIds = new Set(spec.groups.map((g) => g.groupId));
  const roleIds = new Set(spec.roles.map((r) => r.roleId));

  // Rule 7: no duplicate IDs within each entity array.
  for (const [label, ids] of [
    ["tenants[].tenantId", spec.tenants.map((t) => t.tenantId)],
    ["roles[].roleId", spec.roles.map((r) => r.roleId)],
    ["groups[].groupId", spec.groups.map((g) => g.groupId)],
    ["mappingRules[].mappingRuleId", spec.mappingRules.map((m) => m.mappingRuleId)],
  ] as const) {
    for (const dupe of findDuplicates(ids)) {
      ctx.addIssue({
        code: "custom",
        path: [label],
        message: `Duplicate ${label} value: "${dupe}"`,
      });
    }
  }

  // Rules 1-3: role/group references to mapping rules and groups.
  spec.roles.forEach((role, i) => {
    role.mappingRules.forEach((id, j) => {
      if (!mappingRuleIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", i, "mappingRules", j],
          message: `roles[${i}] ("${role.roleId}") references unknown mappingRuleId "${id}"`,
        });
      }
    });
    role.groups.forEach((id, j) => {
      if (!groupIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", i, "groups", j],
          message: `roles[${i}] ("${role.roleId}") references unknown groupId "${id}"`,
        });
      }
    });
  });

  spec.groups.forEach((group, i) => {
    group.mappingRules.forEach((id, j) => {
      if (!mappingRuleIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["groups", i, "mappingRules", j],
          message: `groups[${i}] ("${group.groupId}") references unknown mappingRuleId "${id}"`,
        });
      }
    });
  });

  // Rules 4-5: tenant references to roles and groups.
  spec.tenants.forEach((tenant, i) => {
    tenant.roles.forEach((id, j) => {
      if (!roleIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tenants", i, "roles", j],
          message: `tenants[${i}] ("${tenant.tenantId}") references unknown roleId "${id}"`,
        });
      }
    });
    tenant.groups.forEach((id, j) => {
      if (!groupIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tenants", i, "groups", j],
          message: `tenants[${i}] ("${tenant.tenantId}") references unknown groupId "${id}"`,
        });
      }
    });
    tenant.mappingRules.forEach((id, j) => {
      if (!mappingRuleIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tenants", i, "mappingRules", j],
          message: `tenants[${i}] ("${tenant.tenantId}") references unknown mappingRuleId "${id}"`,
        });
      }
    });
  });

  // Rule 6: authorization owner must exist among declared entities, when the
  // owner type corresponds to a declared entity type in this spec.
  const idsByOwnerType: Record<string, Set<string>> = {
    ROLE: roleIds,
    GROUP: groupIds,
    MAPPING_RULE: mappingRuleIds,
  };
  spec.authorizations.forEach((auth, i) => {
    if (OWNER_TYPES_WITH_DECLARED_ENTITIES.has(auth.ownerType)) {
      const ids = idsByOwnerType[auth.ownerType];
      if (!ids.has(auth.ownerId)) {
        ctx.addIssue({
          code: "custom",
          path: ["authorizations", i, "ownerId"],
          message: `authorizations[${i}] references unknown ${auth.ownerType} ownerId "${auth.ownerId}"`,
        });
      }
    }
  });

  // Rule 8: no two authorization entries with the same tuple but different permissions.
  const tupleToPermissions = new Map<string, { index: number; permissions: PermissionType[] }>();
  spec.authorizations.forEach((auth, i) => {
    const key = `${auth.ownerType}::${auth.ownerId}::${auth.resourceType}::${auth.resourceId}`;
    const existing = tupleToPermissions.get(key);
    if (!existing) {
      tupleToPermissions.set(key, { index: i, permissions: auth.permissions });
      return;
    }
    const sameSet =
      existing.permissions.length === auth.permissions.length &&
      new Set(existing.permissions).size === new Set([...existing.permissions, ...auth.permissions]).size;
    if (!sameSet) {
      ctx.addIssue({
        code: "custom",
        path: ["authorizations", i],
        message: `authorizations[${i}] duplicates the tuple (${auth.ownerType}, ${auth.ownerId}, ${auth.resourceType}, ${auth.resourceId}) already declared at authorizations[${existing.index}] with different permissions`,
      });
    }
  });
});

export type Spec = z.infer<typeof Spec>;
