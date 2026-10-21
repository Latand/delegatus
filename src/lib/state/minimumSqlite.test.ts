/** The minimum-library substitution belongs only to this owned child.
 * Other collected files keep their native module, hook and version cache. */
import { expect, test } from "bun:test";
import path from "node:path";
import { Database } from "bun:sqlite";
import { sqliteRuntimeVersion } from "./schemaCompatibility";

test("minimum SQLite regressions run in an isolated process without changing the collecting process", async () => {
  const builtin = process.getBuiltinModule;
  const native = new Database(":memory:");
  const version = sqliteRuntimeVersion();
  try {
    const child = Bun.spawn([process.execPath, "test", "--preload", path.join(import.meta.dir, "minimumSqlite.preload.ts"),
      path.join(import.meta.dir, "minimumSqliteCases.fixture.ts"), "--timeout", "60000"], {
      stdout: "inherit", stderr: "inherit",
    });
    expect(await child.exited).toBe(0);
    expect(process.getBuiltinModule).toBe(builtin);
    expect(sqliteRuntimeVersion()).toBe(version);
    expect(native.query("SELECT sqlite_version() AS version").get()).toEqual({ version });
  } finally { native.close(); }
}, 300_000);
