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

test("an explicit request bypasses the daily wait without rewriting its clock", async () => {
  const work = fixture();
  const clock = JSON.stringify({ until: CHECK_INTERVAL_MS, notice: null });
  fs.writeFileSync(work.ports.clockFile, clock);
  const requests: boolean[] = [];
  work.ports.update = async requested => { requests.push(requested); };
  const tick = createCodexUpdateTicker(work.ports);
  await tick(); await tick(true); await tick();
  expect(requests).toEqual([true]);
  expect(fs.readFileSync(work.ports.clockFile, "utf8")).toBe(clock);
});

test.each(["unreadable", "demoted"])("pending recovery keeps authority and readable-state guards (%s)", async outcome => {
  const work = fixture(); await createCodexUpdateTicker(work.ports)();
  const clock = fs.readFileSync(work.ports.clockFile, "utf8");
  let current = true, calls = 0;
  work.ports.current = () => current;
  work.ports.update = async () => { calls++; };
  work.ports.hasPending = async () => {
    if (outcome === "unreadable") throw new Error("pending state unreadable");
    current = false;
    return true;
  };
  const check = createCodexUpdateTicker(work.ports)();
  if (outcome === "unreadable") await expect(check).rejects.toThrow("pending state unreadable");
  else await check;
  expect(calls).toBe(0);
  expect(fs.readFileSync(work.ports.clockFile, "utf8")).toBe(clock);
});

test("requests during outbox delivery join the budget decision and coalesce during preparation", async () => {
  const work = fixture();
  fs.writeFileSync(work.ports.clockFile, JSON.stringify({ until: CHECK_INTERVAL_MS, notice: {
    id: "retained", at: 0, version: "0.164.0", failed: false, line: "retained report",
  } }));
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  work.ports.report = async () => { entered(); await hold; };
  const requests: boolean[] = [];
  let updating!: () => void, finish!: () => void;
  const prepared = new Promise<void>(resolve => { updating = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  work.ports.update = async requested => { requests.push(requested); updating(); await pending; };
  const tick = createCodexUpdateTicker(work.ports), run = tick();
  await ready; await tick(true); release(); await prepared;
  await tick(true); await tick(true); expect(requests).toEqual([true]);
  finish(); await run;
});

test.each([false, true])("an explicit request survives failed report delivery until update entry (initial explicit: %s)", async initialExplicit => {
  const work = fixture();
  const notice: UpdateNotice = { id: "retained", at: 0, version: "0.164.0", failed: false, line: "retained report" };
  const clock = JSON.stringify({ until: CHECK_INTERVAL_MS, notice });
  fs.writeFileSync(work.ports.clockFile, clock);
  let entered!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>((_, refuse) => { reject = refuse; });
  work.ports.report = async () => { entered(); await hold; };
  const requests: boolean[] = [];
  work.ports.update = async requested => { requests.push(requested); };
  const tick = createCodexUpdateTicker(work.ports);
  const run = tick(initialExplicit);
  const failed = run.then(() => null, (error: unknown) => error);
  await ready; await tick(true); await tick(true);
  reject(new Error("journal busy"));
  expect(await failed).toMatchObject({ message: "journal busy" });
  expect(requests).toEqual([]);
  expect(fs.readFileSync(work.ports.clockFile, "utf8")).toBe(clock);

  // Repeated delivery failures and ticks without authority cannot consume it.
  work.ports.report = async () => { throw new Error("journal busy"); };
  await expect(tick()).rejects.toThrow("journal busy");
  work.ports.current = () => false;
  await tick(); expect(requests).toEqual([]);
  expect(fs.readFileSync(work.ports.clockFile, "utf8")).toBe(clock);

  work.ports.current = () => true;
  work.ports.report = async delivered => { work.reports.push(delivered); };
  await tick();
  expect(requests).toEqual([true]);
  expect(work.reports).toEqual([notice]);
  expect(JSON.parse(fs.readFileSync(work.ports.clockFile, "utf8"))).toEqual({ until: CHECK_INTERVAL_MS, notice: null });
  await tick(); expect(requests).toEqual([true]);
});

test("demotion while delivering a report refuses even an explicit request", async () => {
  const work = fixture(); let current = true;
  work.ports.current = () => current;
  fs.writeFileSync(work.ports.clockFile, JSON.stringify({ until: 0, notice: {
    id: "retained", at: 0, version: "0.164.0", failed: false, line: "retained report",
  } }));
  work.ports.report = async () => { current = false; };
  await createCodexUpdateTicker(work.ports)(true);
  expect(work.updates()).toBe(0);
});

test("a request after automatic preparation starts gets one explicit follow-up", async () => {
  const work = fixture();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const requests: boolean[] = [];
  const tick = createCodexUpdateTicker(work.ports);
  work.ports.update = async requested => {
    requests.push(requested);
    if (!requested) { entered(); await hold; }
    else { await tick(true); await tick(true); }
  };
  const run = tick(); await ready;
  await tick(true); await tick(true); release(); await run;
  expect(requests).toEqual([false, true]);
});

test("explicit location requests retain the daily wait across real process replacement", async () => {
  const work = fixture();
  for (const mode of ["scheduler-fail", "scheduler-request", "scheduler-fail"]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "update.fixture.ts"), work.root, mode, "0"], { stdout: "pipe", stderr: "pipe" });
    const [exit, diagnostic] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(exit, diagnostic).toBe(0);
  }
  const lines = fs.readFileSync(path.join(work.root, "calls"), "utf8").trim().split("\n");
  expect(lines.filter(line => line.startsWith("scheduler update"))).toEqual(["scheduler update", "scheduler update requested"]);
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
