import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexUpdateTicker, type UpdateSchedulerPorts } from "./scheduler";
import { CHECK_INTERVAL_MS, CodexUpdateReportPending, type UpdateNotice } from "./update";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-scheduler-")); roots.push(root);
  const reports: UpdateNotice[] = []; let updates = 0;
  const ports: UpdateSchedulerPorts = {
    clockFile: path.join(root, "clock.json"), now: () => 0, current: () => true,
    update: async () => { updates++; throw new Error("unwritable location"); },
    report: async notice => { reports.push(notice); },
  };
  return { root, ports, reports, updates: () => updates };
}

test("location failure is reported once and the daily bound survives ticker replacement", async () => {
  const work = fixture(); await createCodexUpdateTicker(work.ports)(); await createCodexUpdateTicker(work.ports)();
  expect(work.updates()).toBe(1); expect(work.reports).toHaveLength(1);
  expect(work.reports[0]?.line).toContain("unavailable; skipped");
  work.ports.now = () => CHECK_INTERVAL_MS; await createCodexUpdateTicker(work.ports)(); expect(work.updates()).toBe(2);
});
test("a seat journal failure retains the location notice for the next minute", async () => {
  const work = fixture(); work.ports.report = async () => { throw new Error("journal busy"); };
  await expect(createCodexUpdateTicker(work.ports)()).rejects.toThrow("journal busy");
  work.ports.report = async notice => { work.reports.push(notice); };
  await createCodexUpdateTicker(work.ports)(); expect(work.updates()).toBe(1); expect(work.reports).toHaveLength(1);
});
test("the CLI's pending precise report retries without a generic notice or daily delay", async () => {
  const work = fixture(); let attempts = 0;
  work.ports.update = async () => { attempts++; throw new CodexUpdateReportPending(new Error("journal busy")); };
  const tick = createCodexUpdateTicker(work.ports); await tick(); await tick();
  expect(attempts).toBe(2); expect(work.reports).toEqual([]); expect(fs.existsSync(work.ports.clockFile)).toBeFalse();
});
test("demoted releases and overlapping checks start no extra work", async () => {
  const work = fixture(); work.ports.current = () => false;
  const tick = createCodexUpdateTicker(work.ports); await tick(); expect(work.updates()).toBe(0);
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { enter = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; work.ports.current = () => true;
  work.ports.update = async () => { calls++; enter(); await hold; };
  const pending = tick(); await ready; await tick(); expect(calls).toBe(1); release(); await pending;
});
test("a malformed clock never silently resets the daily budget", async () => {
  const work = fixture(); fs.writeFileSync(work.ports.clockFile, "broken");
  await expect(createCodexUpdateTicker(work.ports)()).rejects.toThrow(); expect(work.updates()).toBe(0);
});
test("an unavailable install's daily budget survives real process replacement", async () => {
  const work = fixture();
  for (const now of [0, 1, CHECK_INTERVAL_MS]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "update.fixture.ts"), work.root, "scheduler-fail", String(now)], { stdout: "pipe", stderr: "pipe" });
    const [exit, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(exit, diagnostic).toBe(0);
  }
  const lines = fs.readFileSync(path.join(work.root, "calls"), "utf8").trim().split("\n");
  expect(lines.filter(line => line === "scheduler update")).toHaveLength(2);
  expect(lines.filter(line => line.startsWith("Codex CLI unknown:"))).toHaveLength(2);
});
