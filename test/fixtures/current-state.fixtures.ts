import type { CurrentState, RelationshipState } from "../../src/reconcile/types.js";

export function emptyState(): CurrentState {
  return {
    tenants: [],
    roles: [],
    groups: [],
    mappingRules: [],
    authorizations: [],
    relationships: {
      roleGroup: new Set(),
      roleMappingRule: new Set(),
      groupMappingRule: new Set(),
      tenantRole: new Set(),
      tenantGroup: new Set(),
      groupUser: new Set(),
      groupClient: new Set(),
      roleUser: new Set(),
      roleClient: new Set(),
      tenantMappingRule: new Set(),
    },
  };
}

type CurrentStateOverrides = Partial<Omit<CurrentState, "relationships">> & {
  relationships?: Partial<RelationshipState>;
};

/** Merges partial overrides onto an empty state - pass only the fields a test cares about. */
export function currentState(overrides: CurrentStateOverrides): CurrentState {
  const base = emptyState();
  return {
    tenants: overrides.tenants ?? base.tenants,
    roles: overrides.roles ?? base.roles,
    groups: overrides.groups ?? base.groups,
    mappingRules: overrides.mappingRules ?? base.mappingRules,
    authorizations: overrides.authorizations ?? base.authorizations,
    relationships: { ...base.relationships, ...overrides.relationships },
  };
}
