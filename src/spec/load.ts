import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { Spec } from "./schema.js";
import type { Spec as SpecType } from "./schema.js";
import { composeSpec, EnvironmentFile, isEnvironmentFile } from "./compose.js";
import { formatZodError, SpecValidationError } from "./errors.js";

export { SpecValidationError } from "./errors.js";

export async function loadSpec(filePath: string): Promise<SpecType> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new SpecValidationError(filePath, [
      err instanceof Error ? err.message : `Could not read file: ${String(err)}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new SpecValidationError(filePath, [err.message]);
    }
    throw err;
  }

  let assembled: unknown = parsed;
  if (isEnvironmentFile(parsed)) {
    const envResult = EnvironmentFile.safeParse(parsed);
    if (!envResult.success) {
      throw new SpecValidationError(filePath, formatZodError(envResult.error));
    }
    assembled = await composeSpec(filePath, envResult.data);
  }

  const result = Spec.safeParse(assembled);
  if (!result.success) {
    throw new SpecValidationError(filePath, formatZodError(result.error));
  }

  return result.data;
}
