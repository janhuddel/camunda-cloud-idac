import { createCamundaClientLoose, type CamundaClientLoose, type Result } from "@camunda8/orchestration-cluster-api";

// The SDK also ships `createCamundaResultClient`, a proxy that mirrors CamundaClient
// but returns Promise<Result<T>> everywhere. Its own .d.ts marks it
// "@experimental ... not guaranteed to be fully tested or stable", so we deliberately
// do NOT depend on it here. Instead we use the throwing client and wrap calls
// ourselves with `toResult`, using the SDK's own `Result`/`ok` discriminant shape so
// the rest of the codebase still gets Result-style branching without depending on
// experimental SDK surface.
//
// We use the "Loose" client variant (all branded ID types - tenantId, authorizationKey,
// username - widened to plain string) rather than the strict one: every ID in this tool
// comes from user-authored YAML or from a prior search response, so the branded-type
// safety net buys nothing and would otherwise force casts at every tenant/authorization
// call site.

let client: CamundaClientLoose | undefined;

export function getClient(): CamundaClientLoose {
  if (!client) client = createCamundaClientLoose();
  return client;
}

/** Skip eventual-consistency polling: every get/search in this tool re-reads full
 * current state right before diffing, so waiting mid-computation buys nothing. */
export const NO_WAIT = { consistency: { waitUpToMs: 0 } } as const;

export async function toResult<T>(op: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await op();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}
