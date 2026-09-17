import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { ZodError } from "zod";
import { Spec } from "./schema.js";
import type { Spec as SpecType } from "./schema.js";

export class SpecValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly issues: string[],
  ) {
    super(`Invalid spec at ${filePath}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "SpecValidationError";
  }
}

function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

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

  const result = Spec.safeParse(parsed);
  if (!result.success) {
    throw new SpecValidationError(filePath, formatZodError(result.error));
  }

  return result.data;
}
