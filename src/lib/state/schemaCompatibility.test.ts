import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runtimeDataCorruptionCode } from "@/lib/runtime/dataCorruption";
import { IncompatibleSchemaError, schemaCompileFailure, sqliteRuntimeVersion } from "./schemaCompatibility";

const corrupt = (message: string) => Object.assign(new Error(message), { code: "SQLITE_CORRUPT", errno: 11 });

test("a schema statement this SQLite cannot parse or resolve is told apart from damage", () => {
  for (const [message, object, reason] of [
    ['malformed database schema (pipeline_refs_insert) - near "ORDER": syntax error', "pipeline_refs_insert", 'near "ORDER": syntax error'],
    ["malformed database schema (history_input_index) - no such function: jsonb_extract", "history_input_index", "no such function: jsonb_extract"],
    ['malformed database schema (t) - unrecognized token: "1_000"', "t", 'unrecognized token: "1_000"'],
    ["malformed database schema (v) - wrong number of arguments to function json_valid()", "v", "wrong number of arguments to function json_valid()"],
    ["malformed database schema (search) - no such module: fts5", "search", "no such module: fts5"],
  ] as const) {
    expect(schemaCompileFailure(corrupt(message))).toEqual({ object, reason });
    expect(runtimeDataCorruptionCode(corrupt(message))).toBeUndefined();
  }
  for (const message of [
    "database disk image is malformed",
    "file is not a database",
    "malformed database schema (state_rows)",
    "malformed database schema (state_rows) - invalid rootpage",
    "malformed database schema (sqlite_autoindex_state_rows_1) - orphan index",
  ]) {
    expect(schemaCompileFailure(corrupt(message))).toBeNull();
    expect(runtimeDataCorruptionCode(corrupt(message))).toBe("SQLITE_CORRUPT");
  }
  expect(schemaCompileFailure('malformed database schema (x) - near "ORDER": syntax error')).toEqual({ object: "x", reason: 'near "ORDER": syntax error' });
  expect(schemaCompileFailure(null)).toBeNull();
});

test("the loud error names the database, the SQLite version and the statement, and is no corruption code", () => {
  const cause = corrupt('malformed database schema (pipeline_refs_insert) - near "ORDER": syntax error');
  const error = new IncompatibleSchemaError("state.sqlite", schemaCompileFailure(cause)!, { cause, version: "3.39.5" });
  expect(error.message).toBe('state.sqlite holds a schema statement SQLite 3.39.5 cannot compile: pipeline_refs_insert (near "ORDER": syntax error). '
    + "The database is not damaged. It was left as it is.");
  expect(error.code).toBe("SQLITE_INCOMPATIBLE_SCHEMA");
  expect(error.cause).toBe(cause);
  expect(runtimeDataCorruptionCode(error)).toBeUndefined();
});

test("the runtime version is the one this process's SQLite reports", () => {
  const db = new Database(":memory:");
  try {
    expect(sqliteRuntimeVersion()).toBe(db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()!.v);
  } finally { db.close(); }
});
