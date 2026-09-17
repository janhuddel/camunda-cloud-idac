import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { OwnerType, PermissionType, ResourceType } from "./schema.js";
import { formatZodError, SpecValidationError } from "./errors.js";

export const EnvironmentFile = z
  .object({
    include: z.array(z.string().min(1)).min(1),
    values: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type EnvironmentFile = z.infer<typeof EnvironmentFile>;

export function isEnvironmentFile(parsed: unknown): boolean {
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, "include");
}

const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;

export function substituteVariables(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_PATTERN, (match, name: string) => (Object.hasOwn(values, name) ? values[name] : match));
}

export function findUnresolvedPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    found.add(match[1]);
  }
  return [...found];
}

// Fragment schemas mirror schema.ts's entities, but only the ID field is required -
// every other field (including `name`, required on the final Spec) is optional,
// since a fragment may only be contributing a piece of an entity that another
// fragment (or base.yaml) already fully declares. mergeEntitiesById() below unions
// array fields and rejects conflicting scalar fields across fragments; only the
// fully merged result is validated against the real, unmodified `Spec` schema in
// load.ts, which is what actually enforces that every entity ends up complete.

const MappingRuleFragment = z
  .object({
    mappingRuleId: z.string().min(1),
    claimName: z.string().min(1).optional(),
    claimValue: z.string().min(1).optional(),
    name: z.string().optional(),
  })
  .strict();

const GroupFragment = z
  .object({
    groupId: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    mappingRules: z.array(z.string()).default([]),
    users: z.array(z.string()).default([]),
    clients: z.array(z.string()).default([]),
  })
  .strict();

const RoleFragment = z
  .object({
    roleId: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    mappingRules: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    users: z.array(z.string()).default([]),
    clients: z.array(z.string()).default([]),
  })
  .strict();

const TenantFragment = z
  .object({
    tenantId: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    roles: z.array(z.string()).default([]),
    groups: z.array(z.string()).default([]),
    mappingRules: z.array(z.string()).default([]),
  })
  .strict();

const AuthorizationFragment = z
  .object({
    ownerType: OwnerType,
    ownerId: z.string().min(1),
    resourceType: ResourceType,
    resourceId: z.string().min(1),
    permissions: z.array(PermissionType).min(1),
  })
  .strict();

const FragmentSpec = z
  .object({
    tenants: z.array(TenantFragment).default([]),
    roles: z.array(RoleFragment).default([]),
    groups: z.array(GroupFragment).default([]),
    mappingRules: z.array(MappingRuleFragment).default([]),
    authorizations: z.array(AuthorizationFragment).default([]),
  })
  .strict();
type FragmentSpecData = z.infer<typeof FragmentSpec>;

interface MergeConfig {
  idField: string;
  scalarFields: string[];
  arrayFields: string[];
}

// Merges entities sharing the same ID across fragments: array fields are unioned
// (deduped, first-seen order), scalar fields must agree everywhere they're set -
// two fragments giving the same ID a different value for the same scalar field is
// a real authoring conflict, not something a union could resolve.
function mergeEntitiesById(
  entries: Array<{ filePath: string; entity: Record<string, unknown> }>,
  config: MergeConfig,
  entityLabel: string,
): Record<string, unknown>[] {
  const order: string[] = [];
  const merged = new Map<string, Record<string, unknown>>();
  const scalarSources = new Map<string, Map<string, { value: string; filePath: string }>>();

  for (const { filePath, entity } of entries) {
    const id = entity[config.idField] as string;
    if (!merged.has(id)) {
      merged.set(id, { [config.idField]: id });
      scalarSources.set(id, new Map());
      order.push(id);
    }
    const target = merged.get(id)!;
    const sources = scalarSources.get(id)!;

    for (const field of config.scalarFields) {
      const value = entity[field];
      if (value === undefined) continue;
      const existing = sources.get(field);
      if (existing && existing.value !== value) {
        throw new Error(
          `${entityLabel} "${id}" has conflicting "${field}": "${existing.value}" (${existing.filePath}) vs. "${value}" (${filePath})`,
        );
      }
      if (!existing) {
        sources.set(field, { value: value as string, filePath });
        target[field] = value;
      }
    }

    for (const field of config.arrayFields) {
      const values = (entity[field] as string[] | undefined) ?? [];
      const union = [...((target[field] as string[] | undefined) ?? [])];
      for (const v of values) {
        if (!union.includes(v)) union.push(v);
      }
      target[field] = union;
    }
  }

  return order.map((id) => merged.get(id)!);
}

async function loadFragment(fragmentPath: string, values: Record<string, string>): Promise<FragmentSpecData> {
  let raw: string;
  try {
    raw = await readFile(fragmentPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read fragment "${fragmentPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const substituted = substituteVariables(raw, values);
  const unresolved = findUnresolvedPlaceholders(substituted);
  if (unresolved.length > 0) {
    throw new Error(`Fragment "${fragmentPath}" has unresolved placeholder(s): ${unresolved.map((n) => `\${${n}}`).join(", ")}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(substituted);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new Error(`Fragment "${fragmentPath}" is not valid YAML: ${err.message}`);
    }
    throw err;
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, "include")) {
    throw new Error(
      `Fragment "${fragmentPath}" has a top-level "include" key - nested composition isn't supported, "include" may only appear in the top-level environment file`,
    );
  }

  const result = FragmentSpec.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Fragment "${fragmentPath}" is invalid:\n${formatZodError(result.error).map((i) => `  - ${i}`).join("\n")}`);
  }
  return result.data;
}

export function mergeFragments(fragments: Array<{ filePath: string; data: FragmentSpecData }>): {
  tenants: unknown[];
  roles: unknown[];
  groups: unknown[];
  mappingRules: unknown[];
  authorizations: unknown[];
} {
  const asEntries = (key: keyof FragmentSpecData) =>
    fragments.flatMap((f) => (f.data[key] as Record<string, unknown>[]).map((entity) => ({ filePath: f.filePath, entity })));

  return {
    tenants: mergeEntitiesById(asEntries("tenants"), {
      idField: "tenantId",
      scalarFields: ["name", "description"],
      arrayFields: ["roles", "groups", "mappingRules"],
    }, "Tenant"),
    roles: mergeEntitiesById(asEntries("roles"), {
      idField: "roleId",
      scalarFields: ["name", "description"],
      arrayFields: ["mappingRules", "groups", "users", "clients"],
    }, "Role"),
    groups: mergeEntitiesById(asEntries("groups"), {
      idField: "groupId",
      scalarFields: ["name", "description"],
      arrayFields: ["mappingRules", "users", "clients"],
    }, "Group"),
    mappingRules: mergeEntitiesById(asEntries("mappingRules"), {
      idField: "mappingRuleId",
      scalarFields: ["claimName", "claimValue", "name"],
      arrayFields: [],
    }, "Mapping rule"),
    authorizations: fragments.flatMap((f) => f.data.authorizations),
  };
}

export async function composeSpec(envFilePath: string, envFile: EnvironmentFile): Promise<unknown> {
  const baseDir = dirname(envFilePath);
  const seen = new Set<string>();
  const resolvedPaths: string[] = [];
  for (const includePath of envFile.include) {
    const resolved = resolve(baseDir, includePath);
    if (seen.has(resolved)) {
      throw new SpecValidationError(envFilePath, [`Duplicate include entry resolves to the same file: "${resolved}"`]);
    }
    seen.add(resolved);
    resolvedPaths.push(resolved);
  }

  const fragments: Array<{ filePath: string; data: FragmentSpecData }> = [];
  for (const fragmentPath of resolvedPaths) {
    try {
      fragments.push({ filePath: fragmentPath, data: await loadFragment(fragmentPath, envFile.values) });
    } catch (err) {
      throw new SpecValidationError(envFilePath, [err instanceof Error ? err.message : String(err)]);
    }
  }

  try {
    return mergeFragments(fragments);
  } catch (err) {
    throw new SpecValidationError(envFilePath, [err instanceof Error ? err.message : String(err)]);
  }
}
