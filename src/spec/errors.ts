import type { ZodError } from "zod";

export class SpecValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly issues: string[],
  ) {
    super(`Invalid spec at ${filePath}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "SpecValidationError";
  }
}

export function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
