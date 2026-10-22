/**
 * A schema statement this SQLite cannot compile is not damage.
 *
 * SQLite reads a database's schema on first use and reports a statement its
 * parser refuses as SQLITE_CORRUPT, "malformed database schema (<name>) -
 * <parser error>". On macOS bun:sqlite runs the SQLite Apple ships (3.39 on
 * macOS 13, 3.43 on macOS 14 and 15), so a database written where Bun links a
 * newer SQLite can carry statements this one cannot parse. Treating that as
 * corruption set healthy state aside and started users empty; it is told
 * apart here, and every caller fails loudly with the version and the statement
 * instead.
 */

/** Parser and resolver refusals, as opposed to damaged pages or a broken
    catalogue ("invalid rootpage", "orphan index", or no detail at all). */
const COMPILE_FAILURE = /syntax error|unrecognized token|no such function|wrong number of arguments to function|no such collation sequence|no such module|prohibited in|not supported|unsupported/i;

export interface SchemaCompileFailure {
  /** The schema object whose statement did not compile. */
  object: string;
  /** What the parser said. */
  reason: string;
}

export function schemaCompileFailure(error: unknown): SchemaCompileFailure | null {
  if (error instanceof IncompatibleSchemaError) return error.failure;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = /malformed database schema \(([\s\S]*)\) - ([\s\S]+)$/.exec(message);
  if (!match || !COMPILE_FAILURE.test(match[2]!)) return null;
  return { object: match[1]!, reason: match[2]!.trim() };
}

/** Keep newly submitted DDL failures as explicit as incompatible saved schema.
 * Only the object name enters the error; SQL values and bindings stay private. */
export function classifySchemaStatementError(error: unknown, sql: unknown, database: string): unknown {
  if (error instanceof IncompatibleSchemaError) return error;
  const saved = schemaCompileFailure(error);
  if (saved) return new IncompatibleSchemaError(database, saved, { cause: error });
  if (typeof sql !== "string" || !(error instanceof Error) || !COMPILE_FAILURE.test(error.message)) return error;
  const object = /^\s*(?:CREATE\s+(?:UNIQUE\s+|VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE)\s+("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[\w.]+)/i.exec(sql)?.[1];
  return object ? new IncompatibleSchemaError(database, { object, reason: error.message }, { cause: error }) : error;
}

let runtimeVersion: string | undefined;

/** The SQLite this process runs, as `sqlite_version()` reports it. */
export function sqliteRuntimeVersion(): string {
  if (runtimeVersion) return runtimeVersion;
  try {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) return "unknown";
    const db = new sqlite.Database(":memory:");
    try {
      runtimeVersion = db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()!.version;
    } finally {
      db.close();
    }
  } catch {
    return "unknown";
  }
  return runtimeVersion;
}

export function describeSchemaCompileFailure(database: string, failure: SchemaCompileFailure, version = sqliteRuntimeVersion()): string {
  return `${database} holds a schema statement SQLite ${version} cannot compile: ${failure.object} (${failure.reason}). `
    + "The database is not damaged.";
}

export class IncompatibleSchemaError extends Error {
  override name = "IncompatibleSchemaError";
  readonly code = "SQLITE_INCOMPATIBLE_SCHEMA";
  readonly sqliteVersion: string;

  constructor(readonly database: string, readonly failure: SchemaCompileFailure, options: { cause?: unknown; version?: string } = {}) {
    const version = options.version ?? sqliteRuntimeVersion();
    super(`${describeSchemaCompileFailure(database, failure, version)} It was left as it is.`, { cause: options.cause });
    this.sqliteVersion = version;
  }
}
