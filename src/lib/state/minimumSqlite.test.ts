/** The minimum-library substitution belongs only to this owned child.
 * Other collected files keep their native module, hook and version cache. */
import { expect, test } from "bun:test";
import path from "node:path";
import { Database } from "bun:sqlite";
import { sqliteRuntimeVersion } from "./schemaCompatibility";
import { assertStateChildSuccess } from "./stateChildResult.fixture";

test("successful state admission telemetry does not fail a child result", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    const { recordBlockingWait } = await import(${JSON.stringify(path.join(import.meta.dir, "../blockingWaits.ts"))});
    for (const synchronous of [false, true]) {
      if (!synchronous) recordBlockingWait({
        site: "state-write-lock", durationMs: 75, synchronous,
        stateWait: { callSite: "state.schema", reason: "sqlite", outcome: "waiting", attempts: 1,
          maxSliceMs: 0, backoffMs: 0, synchronousSleepMs: 0, release: null, pid: process.pid, processKind: "embedded" },
      });
      recordBlockingWait({
      site: "state-write-lock", durationMs: 75, synchronous,
      stateWait: { callSite: "state.schema", reason: "sqlite", outcome: "success", attempts: 1,
        maxSliceMs: 75, backoffMs: 0, synchronousSleepMs: 0, release: null, pid: process.pid, processKind: "embedded" },
      });
    }
    console.log(JSON.stringify({ retained: 1 }));
  `], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stderr.split("\n").filter(Boolean)).toHaveLength(3);
  assertStateChildSuccess(code, stderr);
  expect(JSON.parse(stdout)).toEqual({ retained: 1 });
  assertStateChildSuccess(0, "");
});

test("child result checks retain failure exits, refusals and unexpected stderr", () => {
  const sample = { site: "state-write-lock", durationMs: 75, synchronous: false,
    stateWait: { callSite: "state.schema", outcome: "success", pid: 7 } };
  const waiting = { ...sample, stateWait: { ...sample.stateWait, outcome: "waiting" } };
  const line = (value: unknown) => `[blocking-wait] ${JSON.stringify(value)}\n`;
  for (const stderr of [
    "unexpected warning\n", "[blocking-wait] invalid json\n", line(null), line({}),
    line({ ...sample, site: "registry-lock" }), line({ ...sample, refused: true }),
    ...["error", "deferred", "timeout", "waiting", "cancelled"].map(outcome => line({ ...sample, stateWait: { ...sample.stateWait, outcome } })),
    line({ ...sample, durationMs: null }), line(sample) + "unexpected warning\n",
    line(sample) + line(waiting),
    ...[
      { ...waiting, stateWait: { ...waiting.stateWait, pid: 8 } },
      { ...waiting, stateWait: { ...waiting.stateWait, callSite: "state.other" } },
      { ...waiting, subject: "other" }, { ...waiting, operationId: "other" },
      { ...waiting, synchronous: true },
    ].map(value => line(value) + line(sample)),
  ]) expect(() => assertStateChildSuccess(0, stderr)).toThrow();
  for (const code of [1, null]) expect(() => assertStateChildSuccess(code, line(sample))).toThrow();
});

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
