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

for (const scenario of ["gone-replaced", "gone-survivor", "gone-revived", "gone-unbound", "gone-failure"]) {
  test(`${scenario} rechecks after writer admission and preserves the refusal reason without signals`, async () => {
    const result = await sweep(root(), scenario);
    expect(result.terminated).toEqual([]);
    expect(result.report.failed).toHaveLength(1);
    expect(result.remaining.length).toBe(scenario === "gone-unbound" ? 6 : 1);
    expect(result.report.failed[0].error).toBe(scenario === "gone-failure"
      ? "fixture writer deadline expired" : "gone host reconciliation refused changed custody or retained processes");
    if (scenario === "gone-unbound") expect(result.report.standDown).toBe("unbound");
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
