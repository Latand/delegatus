import { expect, test } from "bun:test";
import path from "node:path";
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
    role: "unowned", subject: null, label: null, operationId: null, at: "2026-01-01T00:00:00.000Z",
    stateWait: { callSite: "state.schema", reason: "sqlite", outcome: "success", pid: 7,
      attempts: 1, maxSliceMs: 75, backoffMs: 0, synchronousSleepMs: 0, release: null, processKind: "embedded" } };
  const waiting = { ...sample, stateWait: { ...sample.stateWait, outcome: "waiting" } };
  const line = (value: unknown) => `[blocking-wait] ${JSON.stringify(value)}\n`;
  for (const stderr of [
    "unexpected warning\n", "[blocking-wait] invalid json\n", line(null), line({}),
    line({ ...sample, site: "registry-lock" }), line({ ...sample, refused: true }),
    ...["error", "deferred", "timeout", "waiting", "cancelled"].map(outcome => line({ ...sample, stateWait: { ...sample.stateWait, outcome } })),
    line({ ...sample, durationMs: null }), line(sample) + "unexpected warning\n",
    ...[49, -1, "75"].map(durationMs => line({ ...sample, durationMs })),
    ...[null, "bad-date"].map(at => line({ ...sample, at })),
    line({ ...sample, error: "failed" }), line({ ...sample, deferred: true }),
    line({ ...sample, stateWait: { ...sample.stateWait, error: "failed" } }),
    line({ ...sample, stateWait: { callSite: "state.schema", outcome: "success", pid: 7 } }),
    ...[0, -1, 1.5, "7"].map(pid => line({ ...sample, stateWait: { ...sample.stateWait, pid } })),
    line({ ...sample, stateWait: { ...sample.stateWait, attempts: -1 } }),
    line({ ...sample, stateWait: { ...sample.stateWait, maxSliceMs: -1 } }),
    line({ ...sample, stateWait: { ...sample.stateWait, processKind: "unknown" } }),
    " \n", "\n", line(sample) + "\n", line(sample).trimEnd() + " trailing error\n",
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

test.each([
  ["real error", "Error: child write failed\n"],
  ["malformed diagnostic", "[blocking-wait] invalid json\n"],
])(
  "%s from a child fails even with a successful exit", async (_name, stderr) => {
    const child = Bun.spawn([process.execPath, "--eval", `process.stderr.write(${JSON.stringify(stderr)})`], {
      stdout: "pipe", stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(output).toBe("");
    expect(error).toBe(stderr);
    expect(() => assertStateChildSuccess(code, error)).toThrow();
  },
);

test("complete MCP timing diagnostics pass while malformed timing and mixed errors fail", () => {
  const timing = "[mcp slow] pid=7 role=unowned tool=list_tasks callerMs=0 httpMs=0 claimMs=0 bindingMs=2000 completionMs=0 serializationMs=0 serviceTotalMs=2000 replayMs=0";
  assertStateChildSuccess(0, timing + "\n");
  assertStateChildSuccess(0, timing + "\r\n");
  for (const stderr of [
    "[mcp slow] invalid\n", timing + " Error: failed\n", timing + "\nError: failed\n",
    timing.replace("pid=7", "pid=0"), timing.replace("pid=7", "pid=9007199254740992"),
    timing.replace("bindingMs=2000", "bindingMs=-1"), timing.replace("completionMs=0 ", ""),
    timing.replace("serviceTotalMs=2000", "serviceTotalMs=1999"),
  ]) expect(() => assertStateChildSuccess(0, stderr)).toThrow();
  expect(() => assertStateChildSuccess(1, timing)).toThrow();
});

test("a child emitting the service's real MCP timing format passes", async () => {
  const child = Bun.spawn([process.execPath, "--eval", `
    const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import(${JSON.stringify(path.join(import.meta.dir, "../mcp/server.ts"))});
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})]));
    let clock = 0;
    const realNow = performance.now;
    performance.now = () => clock;
    try {
      bindings.list_tasks = async () => { clock = 2100; return {}; };
      const service = createMcpToolService(bindings, new MemoryMcpReceiptStore(), { permit: () => ({ allowed: true }) });
      const result = await service.callTool("list_tasks", { clientRequestId: "fixture-timing" });
      if (!result.ok) throw new Error("fixture call failed");
    } finally { performance.now = realNow; }
  `], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(stdout).toBe("");
  expect(stderr.split("\n").filter(line => line.startsWith("[mcp slow] "))).toHaveLength(1);
  expect(stderr).toContain("[mcp slow] ");
  expect(stderr).toContain("serviceTotalMs=2100");
  assertStateChildSuccess(code, stderr);
});
