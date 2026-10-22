import { afterEach, expect, spyOn, test } from "bun:test";
import { blockingWaitDiagnostics, recordBlockingWait, resetBlockingWaitsForTests, type BlockingWaitSite } from "./blockingWaits";
import path from "node:path";

afterEach(() => { resetBlockingWaitsForTests(); });

function deferred(operationId = "operation-a", callSite = "probe.zero", durationMs = 0) {
  recordBlockingWait({ site: "state-write-lock", durationMs, synchronous: true, refused: true,
    correlation: { label: "probe", operationId },
    stateWait: { callSite, reason: "sqlite", outcome: "deferred", attempts: 1, maxSliceMs: 0,
      backoffMs: 0, synchronousSleepMs: 0, pid: 7, processKind: "viewer", release: null } });
}

function capture() {
  const lines: string[] = [];
  resetBlockingWaitsForTests(line => lines.push(line));
  return { lines, samples: () => lines.map(line => JSON.parse(line.slice("[blocking-wait] ".length))) };
}

test("window boundaries retain exact counts across operation ids and flush a quiet final window", () => {
  const { lines, samples } = capture();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timer = spyOn(globalThis, "setTimeout");
  try {
    deferred();
    now = 4_999;
    for (let index = 0; index < 4; index++) deferred(`operation-${index}`);
    expect(lines).toHaveLength(0);
    expect(blockingWaitDiagnostics().sites["state-write-lock"]?.count).toBe(5);
    now = 5_000;
    deferred();
    expect(samples()).toHaveLength(1);
    expect(samples()[0]).toMatchObject({ count: 5, suppressedCount: 4, windowMs: 5_000, deferred: true });
    expect(samples()[0].refused).toBeUndefined();
    deferred();
    now = 10_000;
    expect(timer.mock.calls.at(-1)![1]).toBe(5_000);
    const callback = timer.mock.calls.at(-1)![0] as () => void;
    callback();
    expect(samples()).toHaveLength(2);
    expect(samples()[1]).toMatchObject({ count: 2, suppressedCount: 1 });
    process.emit("beforeExit", 0);
    expect(lines).toHaveLength(2);
  } finally { timer.mockRestore(); clock.mockRestore(); }
});

test("distinct callers stay distinct and a full group cache flushes exact receipts before eviction", () => {
  const { samples } = capture();
  for (let group = 0; group < 129; group++) {
    deferred("operation-a", `probe.${group}`);
    deferred("operation-b", `probe.${group}`);
  }
  expect(samples()).toHaveLength(1);
  process.emit("beforeExit", 0);
  expect(samples()).toHaveLength(129);
  expect(samples().reduce((total, sample) => total + sample.count, 0)).toBe(258);
  expect(samples().every(sample => sample.count === 2 && sample.suppressedCount === 1)).toBe(true);
});

test("wait thresholds and terminal refusal evidence bypass deferral coalescing", () => {
  const { samples } = capture();
  for (const site of ["state-write-lock", "state-lease", "file-transaction", "registry-lock", "registry-lock-async",
    "registry-revision-retry", "snapshot-collect", "snapshot-serialize", "snapshot-transfer", "snapshot-parse"] as BlockingWaitSite[]) {
    const threshold = ["state-write-lock", "state-lease", "file-transaction"].includes(site) ? 50 : 250;
    const before = samples().length;
    recordBlockingWait({ site, durationMs: threshold - 0.1, synchronous: true });
    expect(samples()).toHaveLength(before);
    recordBlockingWait({ site, durationMs: threshold, synchronous: true });
    expect(samples()).toHaveLength(before + 1);
  }
  // The existing threshold is applied after rounding to a tenth of a ms.
  deferred("operation-a", "probe.slow", 49.96);
  expect(samples().at(-1)).toMatchObject({ deferred: true, durationMs: 50 });
  for (const outcome of ["error", "timeout", "cancelled"]) for (let count = 0; count < 5; count++) {
    recordBlockingWait({ site: "state-write-lock", durationMs: 0, synchronous: false, refused: true,
      stateWait: { callSite: "probe.write", reason: "lease", outcome, attempts: 1,
        maxSliceMs: 0, backoffMs: 0, synchronousSleepMs: 0, pid: 7, processKind: "viewer", release: null } });
  }
  expect(samples().filter(sample => sample.refused)).toHaveLength(15);
  expect(samples().filter(sample => sample.refused).every(sample => sample.count === undefined)).toBe(true);
});

test("a failed journal sink cannot fail admission or retain an expired window", () => {
  resetBlockingWaitsForTests(() => { throw new Error("journal unavailable"); });
  expect(() => { deferred(); process.emit("beforeExit", 0); }).not.toThrow();
  const lines: string[] = [];
  resetBlockingWaitsForTests(line => lines.push(line));
  deferred();
  process.emit("beforeExit", 0);
  expect(JSON.parse(lines[0]!.slice("[blocking-wait] ".length)).count).toBe(1);
});

test("real process restarts get fresh refusal windows and scan completion transitions", async () => {
  for (let restart = 0; restart < 2; restart++) {
    const env = { ...process.env, LLV_QUIET_DIAGNOSTICS: "0" };
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "blockingWaits.fixture.ts"), restart === 0 ? "natural" : "exit"],
      { env, stdout: "pipe", stderr: "pipe" });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code).toBe(0);
      const summaries = stderr.trim().split("\n").map(line => JSON.parse(line.slice("[blocking-wait] ".length)));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ count: 5, suppressedCount: 4, deferred: true });
      const scanLines = stdout.trim().split("\n");
      expect(scanLines).toHaveLength(2);
      expect(scanLines[0]).toContain("still scanning: started");
      expect(scanLines[1]).toContain("scan completed: ageMs=25000 incompleteChecks=5 suppressedCount=4");
    } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  }
});
