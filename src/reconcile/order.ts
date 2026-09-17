import type { ActionKind, PlannedAction } from "./types.js";

/**
 * Fixed phase ordering. Dependencies here are structural (an assignment can't be
 * created before both its endpoints exist; an entity can't be deleted while
 * something still references it), not data-dependent, so a static table is
 * sufficient - no per-run topological sort needed.
 *
 * Create/update phase (ascending): base entities first (tenants can be created
 * with no dependencies; mapping rules/groups/roles likewise), then relationship
 * assigns, then authorizations last since they reference the others by id.
 *
 * Delete/unassign phase (prune only): the reverse shape - authorizations first,
 * then every relationship unassign, then base entities. This guarantees every
 * edge referencing an entity is severed before the entity itself is deleted
 * (see "Cascading deletes in prune mode" in the design plan) - entity-delete
 * order among tenants/roles/groups/mapping-rules doesn't matter once every
 * relationship touching them has already been unassigned.
 */
const PHASE: Record<ActionKind, number> = {
  "create-tenant": 0,
  "update-tenant": 0,
  "create-mapping-rule": 1,
  "update-mapping-rule": 1,
  "create-group": 2,
  "update-group": 2,
  "create-role": 3,
  "update-role": 3,
  "assign-group-mapping-rule": 4,
  "assign-group-user": 4,
  "assign-group-client": 4,
  "assign-role-mapping-rule": 5,
  "assign-role-user": 5,
  "assign-role-client": 5,
  "assign-role-group": 6,
  "assign-tenant-role": 7,
  "assign-tenant-group": 8,
  "assign-tenant-mapping-rule": 8,
  "create-authorization": 9,
  "update-authorization": 9,

  "delete-authorization": 10,
  "unassign-tenant-group": 11,
  "unassign-tenant-mapping-rule": 11,
  "unassign-tenant-role": 12,
  "unassign-role-group": 13,
  "unassign-role-mapping-rule": 14,
  "unassign-role-user": 14,
  "unassign-role-client": 14,
  "unassign-group-mapping-rule": 15,
  "unassign-group-user": 15,
  "unassign-group-client": 15,
  "delete-role": 16,
  "delete-group": 16,
  "delete-mapping-rule": 16,
  "delete-tenant": 16,
};

export function sortActions(actions: PlannedAction[]): PlannedAction[] {
  return [...actions].sort((a, b) => PHASE[a.kind] - PHASE[b.kind]);
}
