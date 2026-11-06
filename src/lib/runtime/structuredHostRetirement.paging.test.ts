import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-paging-"));
  roots.push(directory);
  return directory;
}
async function sweep(directory: string, scenario: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "structuredHostRetirement.paging.fixture.ts"), scenario], {
    env: { ...process.env, LLV_STATE_DIR: directory, XDG_CONFIG_HOME: path.join(directory, "config"), HOME: directory },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr: exit ? stderr : "" }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

const session = (index: number) => ["00000000", "0000", "0000", "0000", String(index).padStart(12, "0")].join("-");

test("batch-deferred healthy hosts progress past permanently refused attempts on both 512-row pages after restart", async () => {
  const directory = root();
  const first = await sweep(directory, "batch-progress");
  expect(first.attempted).toEqual(Array.from({ length: 8 }, (_, index) => session(index + 1)));
  expect(first.report.failed).toHaveLength(8);
  expect(first.terminated).toEqual([]);
  expect(first.report.deferred).toBe(504);
  const second = await sweep(directory, "batch-progress");
  expect(second.report.progress.beforeKey).toBe(first.report.progress.afterKey);
  expect(second.terminated).toEqual(Array.from({ length: 8 }, (_, index) => session(index + 9)));
  expect(first.report.progress.afterKey).toBe(`codex:${session(8)}`);
  expect(first.report.progress.unvisited).toBe(1016);
  expect(first.report.progress.oldestUnvisited.key).toBe(`codex:${session(9)}`);

  // Resume at the next page's permanently refusing prefix as well.
  fs.writeFileSync(path.join(directory, "host-retirement-cursor.json"), JSON.stringify({ version: 1, afterKey: `codex:${session(512)}` }));
  const third = await sweep(directory, "batch-progress");
  expect(third.report.failed).toHaveLength(8);
  expect(third.report.progress.afterKey).toBe(`codex:${session(520)}`);
  const fourth = await sweep(directory, "batch-progress");
  expect(fourth.report.progress.beforeKey).toBe(third.report.progress.afterKey);
  expect(fourth.terminated).toEqual(Array.from({ length: 8 }, (_, index) => session(index + 521)));
}, 60_000);

test("persistent termination refusals advance every batch across two complete wraps and real process restarts", async () => {
  const directory = root();
  let cursor: string | null = null;
  for (let tick = 0; tick < 9; tick++) {
    const result = await sweep(directory, "batch-wrap");
    const start = tick % 4 * 8 + 1;
    expect(result.attempted).toEqual(Array.from({ length: 8 }, (_, index) => session(start + index)));
    expect(result.report.failed).toHaveLength(8);
    expect(result.terminated).toEqual([]);
    expect(result.remaining).toHaveLength(32);
    expect(result.report.deferred).toBe(24);
    expect(result.report.progress.beforeKey).toBe(cursor);
    cursor = `codex:${session(start + 7)}`;
    expect(result.report.progress.afterKey).toBe(cursor);
    expect(result.report.progress.unvisited).toBe(24);
    expect(result.report.progress.wrapped).toBe(tick > 0 && tick % 4 === 0);
  }
}, 60_000);

test("bounded sweeps reach eligible hosts behind 520 permanently refused rows across real process restarts", async () => {
  const directory = root();
  const first = await sweep(directory, "paging");
  expect(first.report.evaluated).toBe(512);
  expect([...new Set(first.report.refused.map((row: { clause: string }) => row.clause))]).toEqual(["events-flushed"]);
  expect(first.terminated).toEqual([]);
  const second = await sweep(directory, "paging");
  expect(second.terminated).toHaveLength(4);
  expect(second.report.retired).toHaveLength(4);
  expect(second.status).toBe("observed");
  expect(second.remaining).toHaveLength(520);
  expect(second.report.progress.afterKey).not.toBe(first.report.progress.afterKey);
  expect(second.report.progress.wrapped).toBe(true);
  expect(second.report.progress.oldestUnvisited.updatedAt).toBe("2026-10-26T09:00:00.501Z");
  expect(second.report.retired.every((row: { pss: unknown }) => JSON.stringify(row.pss) === JSON.stringify({ bytes: 60, measuredProcesses: 1 }))).toBe(true);
  const third = await sweep(directory, "paging");
  expect(third.terminated).toEqual([]);
  expect(third.report.evaluated).toBe(512);
}, 30_000);

test("busy, current seat and protected hosts remain untouched", async () => {
  const result = await sweep(root(), "guards");
  expect(result.terminated).toHaveLength(3);
  expect(result.report.refused.map((row: { clause: string }) => row.clause)).toEqual(["turn-settled", "seat-free", "no-active-flags"]);
  expect(result.remaining).toHaveLength(3);
});

test("gone rows are reconciled by the real registry without termination and stay gone after restart", async () => {
  const directory = root();
  const first = await sweep(directory, "gone");
  expect(first.terminated).toEqual([]);
  expect(first.report.gone).toHaveLength(6);
  expect(first.remaining).toEqual([]);
  expect(first.status).toBe("observed");
  const second = await sweep(directory, "gone");
  expect(second.report.evaluated).toBe(0);
  expect(second.terminated).toEqual([]);
  const third = await sweep(directory, "gone");
  expect(third.report.progress.beforeKey).toBeNull();
  expect(third.report.progress.afterKey).toBeNull();
});

const changedCustody = ["gone-replaced", "gone-claim", "gone-owner", "gone-writer", "gone-start", "gone-boot", "gone-cleared", "gone-scope-changed", "gone-cas-cleared", "gone-cas-replaced"];
for (const scenario of changedCustody) {
  test(`${scenario} leaves changed custody intact without a false failure`, async () => {
    const result = await sweep(root(), scenario);
    expect(result.terminated).toEqual([]);
    expect(result.report.failed).toEqual([]);
    expect(result.report.refused).toMatchObject([{ clause: "process-identity", changed: true,
      reason: "already-exited host custody was cleared or replaced" }]);
    expect(result.remaining).toHaveLength(scenario === "gone-cleared" || scenario === "gone-cas-cleared" ? 0 : 1);
    expect(result.historyIntact).toBe(true);
  });
}

const cleanupFailures = [
  ["gone-cas-refused", "registry retirement refused retained custody"],
  ["gone-survivor", "retained descendant is alive or its exit cannot be verified"],
  ["gone-revived", "host exit can no longer be verified"],
  ["gone-unbound", "retirement publication is no longer ready"],
  ["gone-failure", "fixture writer deadline expired"],
  ["gone-unknown-after-admission", "host exit can no longer be verified"],
  ["gone-scope-boot-changed", "scope boot identity changed during reconciliation"],
] as const;
for (const [scenario, reason] of cleanupFailures) {
  test(`${scenario} reports the actual cleanup failure and the already-exited host`, async () => {
    const result = await sweep(root(), scenario);
    expect(result.terminated).toEqual([]);
    expect(result.report.failed[0]).toMatchObject({ error: `host already exited; cleanup failed: ${reason}` });
    expect(result.report.failed).toHaveLength(scenario === "gone-scope-boot-changed" ? 6 : 1);
    expect(result.report.refused).toEqual([]);
    expect(result.remaining.length).toBe(scenario === "gone-unbound" || scenario === "gone-scope-boot-changed" ? 6 : 1);
    if (scenario === "gone-unbound") expect(result.report.standDown).toBe("unbound");
  });
}

for (const scenario of ["gone-curator", "gone-curator-cleared", "gone-curator-replaced"]) {
  test(`${scenario} keeps the settled curation successful and emits no retirement failure through restart`, async () => {
    const directory = root();
    const first = await sweep(directory, scenario);
    expect(first.curation).toMatchObject({ state: "succeeded", failure: null, finalText: "Curation completed" });
    expect(first.report.failed).toEqual([]);
    expect(first.report.gone).toHaveLength(scenario === "gone-curator" ? 6 : 5);
    expect(first.signals).toEqual([]);
    expect(first.attempted).toEqual([]);
    expect(first.historyIntact).toBe(true);
    expect(first.remaining).toHaveLength(scenario === "gone-curator-replaced" ? 1 : 0);
    const second = await sweep(directory, "gone-curator");
    expect(second.curation).toEqual(first.curation);
    expect(second.report.failed).toEqual([]);
    expect(second.signals).toEqual([]);
  });
}

for (const scenario of ["late-curator-cleared", "late-curator-replaced"]) {
  test(`${scenario} reconciles a real termination CAS refusal after the host finishes`, async () => {
    const result = await sweep(root(), scenario);
    expect(result.curation).toMatchObject({ state: "succeeded", failure: null });
    expect(result.report.failed).toEqual([]);
    expect(result.report.refused).toContainEqual(expect.objectContaining({ changed: true,
      reason: "already-exited host custody was cleared or replaced" }));
    expect(result.signals).toEqual([]);
    expect(result.attempted).toContain(session(1));
    expect(result.terminated).not.toContain(session(1));
    expect(result.remaining).toHaveLength(scenario === "late-curator-replaced" ? 4 : 3);
    expect(result.historyIntact).toBe(true);
  });
}

test("the real registry CAS rejects a successor installed at the final retirement boundary", async () => {
  const result = await sweep(root(), "gone-cas-replaced");
  expect(result.report.failed).toEqual([]);
  expect(result.report.refused).toContainEqual(expect.objectContaining({ changed: true,
    reason: "already-exited host custody was cleared or replaced" }));
  expect(result.remainingRows).toContainEqual({ key: `codex:${session(1)}`, claimEpoch: 2, pid: 2_000_001_000 });
});

test("an exited curator whose termination throws still signals the actual failure", async () => {
  const result = await sweep(root(), "late-curator-throw");
  expect(result.curation).toMatchObject({ state: "succeeded", failure: null });
  expect(result.report.failed).toMatchObject([{ error: "host already exited; cleanup failed: fixture termination writer failed" }]);
  expect(result.signals[0].label).toContain("host already exited; cleanup failed: fixture termination writer failed");
  expect(result.terminated).not.toContain(session(1));
  expect(result.remaining).toHaveLength(4);
});

test("a settled curator whose PID is reused while entering termination reconciles without a false failure", async () => {
  const result = await sweep(root(), "late-curator-pid-reuse");
  expect(result.curation).toMatchObject({ state: "succeeded", failure: null, finalText: "Curation completed" });
  expect(result.report.failed).toEqual([]);
  expect(result.report.gone).toContainEqual(expect.objectContaining({ key: `codex:${session(1)}` }));
  expect(result.report.refused.filter((row: { key: string }) => row.key === `codex:${session(1)}`)).toEqual([]);
  expect(result.signals).toEqual([]);
  expect(result.attempted).toContain(session(1));
  expect(result.terminated).not.toContain(session(1));
  expect(result.remaining).toHaveLength(3);
  expect(result.historyIntact).toBe(true);
});

test("an exited curator preserves the returned termination registry-writer failure", async () => {
  const result = await sweep(root(), "late-curator-returned-writer-failure");
  expect(result.curation).toMatchObject({ state: "succeeded", failure: null });
  expect(result.report.failed).toMatchObject([{ error: "host already exited; cleanup failed: termination evidence became unavailable: fixture registry write failed" }]);
  expect(result.signals[0].label).toContain("termination evidence became unavailable: fixture registry");
  expect(result.report.gone).toEqual([]);
  expect(result.remaining).toHaveLength(4);
});

test("an exited curator with an unresolved termination descendant still signals the true failure", async () => {
  const result = await sweep(root(), "late-curator-descendant");
  expect(result.curation).toMatchObject({ state: "succeeded", failure: null });
  expect(result.report.failed).toMatchObject([{ remaining: expect.arrayContaining([expect.any(Number)]),
    error: "host already exited; cleanup failed: retained descendant custody remains active" }]);
  expect(result.signals[0].label).toContain("host already exited; cleanup failed: retained descendant custody remains active");
  expect(result.terminated).not.toContain(session(1));
  expect(result.remaining).toHaveLength(4);
});

for (const [scenario, reason] of [["gone-curator-failure", "fixture writer deadline expired"],
  ["gone-curator-survivor", "retained descendant is alive or its exit cannot be verified"]]) {
  test(`${scenario} signals a cleanup failure separately from the settled curation`, async () => {
    const directory = root();
    const result = await sweep(directory, scenario!);
    expect(result.curation).toMatchObject({ state: "succeeded", failure: null });
    expect(result.signals).toMatchObject([{ id: "host-retirement", actionable: true }]);
    expect(result.signals[0].label).toContain(`host already exited; cleanup failed: ${reason}`);
    expect(result.attempted).toEqual([]);
    const repeated = await sweep(directory, scenario!);
    expect(repeated.curation).toEqual(result.curation);
    expect(repeated.signals).toMatchObject([{ id: "host-retirement", actionable: true }]);
    expect(repeated.signals[0].label).toContain(`host already exited; cleanup failed: ${reason}`);
  });
}

for (const [document, reason] of [
  [JSON.stringify({ version: 1, afterKey: "invalid" }), "retirement cursor is invalid"],
  ["{", "retirement cursor could not be read"],
  [" ".repeat(257), "retirement cursor exceeds its byte budget"],
]) test(`a durable cursor failure (${reason}) alarms before any host can be acted on`, async () => {
  const directory = root();
  fs.writeFileSync(path.join(directory, "host-retirement-cursor.json"), document!);
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "structuredHostRetirement.paging.fixture.ts"), "guards"], {
    env: { ...process.env, LLV_STATE_DIR: directory, XDG_CONFIG_HOME: path.join(directory, "config"), HOME: directory },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).not.toBe(0);
  expect(stderr).toContain(reason!);
  expect(stdout).not.toContain('"terminated"');
  expect(fs.existsSync(path.join(directory, "host-retirement-report.json"))).toBe(false);
});


for (const scenario of ["gone-scope-old", "gone-scope-current", "gone-exit", "gone-reused"]) {
  test(`${scenario} reconciles before live clauses, preserves history and stays gone after process restart`, async () => {
    const directory = root();
    const first = await sweep(directory, scenario);
    expect(first.report.gone).toHaveLength(6);
    expect(first.report.retired).toEqual([]);
    expect(first.report.refused).toEqual([]);
    expect(first.attempted).toEqual([]);
    expect(first.remaining).toEqual([]);
    expect(first.historyIntact).toBe(true);
    if (scenario === "gone-scope-old" && process.platform === "linux" || scenario === "gone-reused") expect(first.scopeReads).toEqual([]);
    const second = await sweep(directory, scenario);
    expect(second.report.evaluated).toBe(0);
    expect(second.attempted).toEqual([]);
    expect(second.historyIntact).toBe(true);
  });
}

for (const scenario of ["live-lag", "identity-unknown"]) {
  test(`${scenario} keeps every live clause and never reconciles or terminates`, async () => {
    const result = await sweep(root(), scenario);
    expect(result.report.gone).toEqual([]);
    expect(result.attempted).toEqual([]);
    expect(result.remaining).toHaveLength(6);
    expect(result.report.liveRefused).toEqual(scenario === "live-lag"
      ? { count: 6, byClause: { "events-flushed": 4, "turn-settled": 1, "no-active-flags": 1 } }
      : { count: 0, byClause: {} });
    expect(result.report.refused.map((row: { clause: string }) => row.clause)).toEqual([
      "events-flushed", "turn-settled", "events-flushed", "no-active-flags", "events-flushed", "events-flushed",
    ]);
  });
}

for (const scenario of ["gone-scope-live", "gone-scope-unknown"]) {
  test(`${scenario} preserves unproven or replaced scope custody without termination`, async () => {
    const result = await sweep(root(), scenario);
    expect(result.attempted).toEqual([]);
    expect(result.report.failed.length).toBeGreaterThan(0);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(result.historyIntact).toBe(true);
  });
}


test("a scoped host that disappears during memory measurement reconciles without entering termination", async () => {
  const result = await sweep(root(), "gone-after-measurement");
  expect(result.report.gone).toHaveLength(3);
  expect(result.report.retired).toEqual([]);
  expect(result.report.failed).toEqual([]);
  expect(result.report.refused.map((row: { clause: string }) => row.clause)).toEqual(["turn-settled", "seat-free", "no-active-flags"]);
  expect(result.attempted).toEqual([]);
  expect(result.remaining).toHaveLength(3);
  expect(result.historyIntact).toBe(true);
});
