import { schemaCompileFailure } from "@/lib/state/schemaCompatibility";

/** Safe wire categories; never forward arbitrary dependency error properties. */
export const RUNTIME_DATA_CORRUPTION = "RUNTIME_DATA_CORRUPTION";
const CORRUPTION_CODES = new Set([RUNTIME_DATA_CORRUPTION, "SQLITE_CORRUPT", "SQLITE_NOTADB"]);

export class RuntimeDataCorruptionError extends Error {
  readonly code = RUNTIME_DATA_CORRUPTION;
}

export function runtimeDataCorruptionCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  /* A schema statement this SQLite cannot compile reports SQLITE_CORRUPT too; it is not damage. */
  if (schemaCompileFailure(error)) return undefined;
  return typeof error.code === "string" && CORRUPTION_CODES.has(error.code) ? error.code : undefined;
}
