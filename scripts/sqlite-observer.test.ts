import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The benchmark extension is a native fixture. Supply SQLITE_INCLUDE just as
// in docs/perf/mcp-state-writers.md when headers are outside the system root.
const include = process.env.SQLITE_INCLUDE ?? "/usr/include";
const compiler = Bun.which("cc");
const available = process.platform === "linux" && compiler !== null
  && fs.existsSync(path.join(include, "sqlite3ext.h"));
let root: string;

async function run(cmd: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn({ cmd, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1:halt_on_error=1", UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1", ...extra } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return stdout;
}

const harness = String.raw`
#include <sqlite3.h>
#define SQLITE_CORE
#include <sqlite3ext.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void check(int actual, int expected) {
  if (actual != expected) { fprintf(stderr, "SQLite: got %d expected %d\n", actual, expected); exit(2); }
}
static void replacement(sqlite3_context *c, int count, sqlite3_value **values) {
  (void)count; (void)values; sqlite3_result_null(c);
}
static int refuse_owner(sqlite3 *db, const char *name, int encoding, void *argument,
  int (*compare)(void *, int, const void *, int, const void *), void (*destroy)(void *)) {
  (void)db; (void)name; (void)encoding; (void)argument; (void)compare; (void)destroy;
  return SQLITE_NOMEM;
}
static void sql(sqlite3 *db, const char *text) {
  check(sqlite3_exec(db, text, NULL, NULL, NULL), SQLITE_OK);
}
static int load(sqlite3 *db, const char *extension) {
  char *error = NULL;
  int code = sqlite3_load_extension(db, extension, "sqlite3_observer_init", &error);
  sqlite3_free(error);
  return code;
}
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  sqlite3 *db = NULL;
  const char *mode = argv[2];
  sqlite3_api_routines refused_api;
  check(sqlite3_open(":memory:", &db), SQLITE_OK);
  check(sqlite3_enable_load_extension(db, 1), SQLITE_OK);
  check(load(db, argv[1]), SQLITE_OK);
  if (strstr(mode, "replace"))
    for (int i = 0; i < 3; i++)
      check(sqlite3_create_function(db, "delegatus_observer_context", 0, SQLITE_UTF8,
        NULL, replacement, NULL, NULL), SQLITE_OK);
  if (!strcmp(mode, "delete"))
    check(sqlite3_create_function(db, "delegatus_observer_context", 0, SQLITE_UTF8,
      NULL, NULL, NULL, NULL), SQLITE_OK);
  if (!strcmp(mode, "reload")) check(load(db, argv[1]), SQLITE_OK);
  if (!strcmp(mode, "failed-registration")) {
    sqlite3_stmt *active = NULL;
    check(sqlite3_prepare_v2(db, "SELECT delegatus_observer_context()", -1, &active, NULL), SQLITE_OK);
    check(sqlite3_step(active), SQLITE_ROW);
    check(load(db, argv[1]), SQLITE_ERROR);
    check(sqlite3_finalize(active), SQLITE_OK);
  }
  if (!strcmp(mode, "failed-owner-registration")) {
    void *handle = dlopen(argv[1], RTLD_NOW);
    if (!handle) return 2;
    const sqlite3_api_routines **api = dlsym(handle, "sqlite3_api");
    int (*init)(sqlite3 *, char **, const sqlite3_api_routines *) = dlsym(handle, "sqlite3_observer_init");
    if (!api || !init) return 2;
    refused_api = **api;
    refused_api.create_collation_v2 = refuse_owner;
    check(init(db, NULL, &refused_api), SQLITE_NOMEM);
    if (dlclose(handle)) return 2;
  }
  if (!strcmp(mode, "remove-owner-running")) {
    sqlite3_stmt *statement = NULL;
    check(sqlite3_prepare_v2(db, "SELECT 1", -1, &statement, NULL), SQLITE_OK);
    check(sqlite3_step(statement), SQLITE_ROW);
    /* An application may replace tracing before the pending PROFILE clears
     * the observer's thread-local VFS attribution. */
    check(sqlite3_trace_v2(db, 0, NULL, NULL), SQLITE_OK);
    check(sqlite3_finalize(statement), SQLITE_OK);
  }
  if (!strncmp(mode, "remove-owner", 12))
    check(sqlite3_create_collation_v2(db, "delegatus_observer_context", SQLITE_UTF8,
      NULL, NULL, NULL), SQLITE_OK);
  if (!strcmp(mode, "release-handle")) {
    void *handle = dlopen(argv[1], RTLD_NOW);
    if (!handle || dlclose(handle)) return 2;
  }
  sql(db, "CREATE TABLE state_rows (value); BEGIN; INSERT INTO state_rows VALUES (1); COMMIT;"
    "BEGIN; INSERT INTO state_rows VALUES (2); ROLLBACK;");
  if (strstr(mode, "deferred") || strstr(mode, "busy-close")) {
    sqlite3_stmt *statement = NULL;
    sql(db, "BEGIN");
    check(sqlite3_prepare_v2(db, "INSERT INTO state_rows VALUES (3) RETURNING value", -1, &statement, NULL), SQLITE_OK);
    check(sqlite3_step(statement), SQLITE_ROW);
    if (strstr(mode, "busy-close")) {
      check(sqlite3_close(db), SQLITE_BUSY);
      sql(db, "SELECT 1");
    }
    check(sqlite3_close_v2(db), SQLITE_OK);
    check(sqlite3_step(statement), SQLITE_DONE);
    check(sqlite3_finalize(statement), SQLITE_OK);
  } else if (!strcmp(mode, "rollback-close")) {
    sql(db, "BEGIN; INSERT INTO state_rows VALUES (3)");
    check(sqlite3_close(db), SQLITE_OK);
  } else check(sqlite3_close(db), SQLITE_OK);
  /* xSleep remains installed after the connection and a caller's dlopen handle
   * are gone; the extension's permanent load must still protect its code. */
  sqlite3_sleep(1);
  puts("completed");
  return 0;
}
`;

afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!available)("SQLite observer native lifetime (ASan/UBSan)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-observer-"));
    fs.writeFileSync(path.join(root, "harness.c"), harness);
    const flags = ["-I", include, "-O1", "-g", "-Wall", "-Wextra", "-Werror", "-fno-omit-frame-pointer", "-fsanitize=address,undefined"];
    await run([compiler!, ...flags, "-fPIC", "-shared", path.join(import.meta.dir, "sqlite-observer.c"), "-o", "observer.so"]);
    // A fixed executable mapping avoids GCC ASan/PIE address-space collisions.
    await run([compiler!, ...flags, "-no-pie", "harness.c", "-l:libsqlite3.so.0", "-ldl", "-o", "harness"]);
  });

  async function observe(mode: string) {
    const file = path.join(root, `${mode}.ndjson`);
    expect(await run([path.join(root, "harness"), path.join(root, "observer.so"), mode], { MCP_SQL_EVENTS: file })).toBe("completed\n");
    return fs.readFileSync(file, "utf8").trim().split("\n").map(line => {
      const row = JSON.parse(line) as Record<string, unknown>;
      delete row.pid; delete row.atNs; delete row.atMs;
      if (row.event === "sqlite-sleep-ns") row.value = 0;
      return row;
    });
  }

  for (const mode of ["normal", "replace", "delete", "release-handle", "failed-registration", "failed-owner-registration"]) {
    test(`${mode} retains the complete event stream`, async () => {
      const rows = await observe(mode);
      expect(rows.map(row => [row.event, row.value])).toEqual([
        ["open", 0], ...mode === "failed-registration" ? [["sqlite-contention", 5]] : [],
        ["autocommit-statement-attempt", 1], ["commit", 1], ["commit-kinds", 1], ["committed-changes", 0],
        ["begin-attempt", 1], ["begin", 1], ["domain-statement", 1], ["commit-attempt", 1], ["commit", 1], ["commit-kinds", 4], ["committed-changes", 1],
        ["begin-attempt", 1], ["begin", 1], ["domain-statement", 1], ["rollback", 1], ["close-request", 1], ["close", 1], ["sqlite-sleep-ns", 0],
      ]);
      expect(rows.slice(0, -1).every(row => row.connection === 1 && row.database === "memory" && row.call === "" && row.collection === "")).toBe(true);
      expect(rows.filter(row => row.sql).map(row => row.sql)).toEqual(["INSERT INTO state_rows VALUES (1);", "INSERT INTO state_rows VALUES (2);"]);
      expect(rows.at(-1)).toEqual({ connection: 0, database: "none", call: "", collection: "", event: "sqlite-sleep-ns", value: 0 });
    });
  }

  for (const mode of ["deferred", "busy-close"]) {
    test(`${mode} keeps callbacks alive until the last statement finishes`, async () => {
      const rows = await observe(mode);
      expect(await observe(`replace-${mode}`)).toEqual(rows);
      const request = rows.findIndex(row => row.event === "close-request");
      expect(rows.slice(request).map(row => row.event)).toEqual([
        ...mode === "busy-close" ? ["close-request"] : [],
        "close-request", "rollback", "close", "sqlite-sleep-ns",
      ]);
    });
  }

  test("reload releases the old observer before installing the new callbacks", async () => {
    const rows = await observe("reload");
    expect(rows.slice(0, 3).map(row => [row.connection, row.event])).toEqual([[1, "open"], [1, "close"], [2, "open"]]);
    expect(rows.slice(2, -1).every(row => row.connection === 2)).toBe(true);
    expect(rows.filter(row => row.event === "close").map(row => row.connection)).toEqual([1, 2]);
  });

  test("closing with an open transaction rolls back before releasing the observer", async () => {
    const rows = await observe("rollback-close");
    expect(rows.slice(-4).map(row => row.event)).toEqual(["close-request", "rollback", "close", "sqlite-sleep-ns"]);
  });

  for (const mode of ["remove-owner", "remove-owner-running"]) {
    test(`${mode} detaches callbacks before freeing their context`, async () => {
      expect((await observe(mode)).map(row => row.event)).toEqual(["open", "close", "sqlite-sleep-ns"]);
    });
  }
});
