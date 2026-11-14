import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { WorktreeSweepWorker } from "./worktreeSweepWorker";
import { AttemptTempStore } from "../runtime/attemptTempRetention";
import { attemptTempJournalPath } from "../tempSweep";

// Watches are IPC barriers. Elapsed real time only limits a broken test.
function barrier(file: string, signal?: AbortSignal) {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`missing barrier ${path.basename(file)}`)); }, 60_000);
    signal?.addEventListener("abort", () => { clearTimeout(timer); watcher.close(); resolve(); }, { once: true });
    if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
}

// The real reference child is the Linux Docker-mount observation.
for (const releaseAt of [3500, 5500]) for (const round of [1, 2, 3]) test.skipIf(process.platform !== "linux")(`queued attempt tick at ${releaseAt} preserves its deadline and helper, round ${round}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-deadline-"));
  const savedEnv = { ...process.env };
  let worker: WorktreeSweepWorker | undefined;
  const state = path.join(root, "state"), directory = path.join(root, "llv-stage-due");
  const clockFile = path.join(root, "clock");
  let now = 0;
  const abort = new AbortController();
  const timers = new Set<{ at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { at: now + ms, callback }; timers.add(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => { timers.delete(handle as unknown as { at: number; callback: () => void }); },
  };
  const advance = (ms: number) => {
    now = ms; fs.writeFileSync(clockFile, String(ms));
    for (const timer of timers) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
  };
  // Instrument calendar-based parents and their request timers too, so this
  // fixture reproduces the failure before the constructor clock port existed.
  const epoch = Date.now(), nativeTimer = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const date = spyOn(Date, "now").mockImplementation(() => epoch + now);
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    ms === 6000 || ms === 3000 ? clock.setTimeout(() => callback(...args), ms) : nativeTimer(callback, ms, ...args)) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    const timer = handle as unknown as { at: number; callback: () => void };
    if (timers.has(timer)) timers.delete(timer); else Reflect.apply(nativeClear, globalThis, [handle]);
  });
  try {
    for (const name of ["home", "config", "state", "tmp"]) fs.mkdirSync(path.join(root, name));
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "retained");
    Object.assign(process.env, { HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
      PATH: root + path.delimiter + savedEnv.PATH, LLV_STATE_DIR: state, TMPDIR: path.join(root, "tmp"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_TEMP_SWEEP: "on" });
    const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
    try { store.register({ directory, pipelineId: null, launchId: "due-root", retainUntilClose: false, createdAt: 1 }); }
    finally { store.close(); }
    const before = fs.lstatSync(directory);
    advance(0);
    const preload = path.join(root, "preload.ts"), childEntry = path.join(root, "docker");
    fs.writeFileSync(childEntry, `#!${process.execPath}
      import fs from "node:fs";
      const root = ${JSON.stringify(root)};
      const watcher = fs.watch(root, () => {
        if (fs.existsSync(root + "/release-reference")) { watcher.close(); process.exit(0); }
      });
      fs.writeFileSync(root + "/reference", String(process.pid));
    `, { mode: 0o700 });
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import { mock, spyOn } from "bun:test";
      import cp from "node:child_process";
      import { promisify } from "node:util";
      const root = ${JSON.stringify(root)};
      fs.appendFileSync(root + "/starts", process.pid + "\\n");
      spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(fs.readFileSync(root + "/clock", "utf8")) * 1000000n);
      spyOn(performance, "now").mockImplementation(() => Number(fs.readFileSync(root + "/clock", "utf8")));
      // Command timers also follow test time: the IPC barrier owns completion.
      // Keep the production timeout calculation observable before suppressing
      // its wall timer, so scheduling speed cannot decide this test.
      const exec = cp.execFile;
      const controlled = (command, args, options, callback) => {
        fs.appendFileSync(root + "/timeouts", JSON.stringify({ command, timeout: options.timeout }) + "\\n");
        return exec(command, args, { ...options, timeout: 0 }, callback);
      };
      const asyncExec = (command, args, options) => new Promise((resolve, reject) =>
        controlled(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
      Object.defineProperty(controlled, promisify.custom, { value: asyncExec });
      mock.module("node:child_process", () => ({ ...cp, execFile: controlled }));
      const parked = (name) => new Promise(resolve => {
        const watcher = fs.watch(root, () => {
          if (fs.existsSync(root + "/release-" + name)) { watcher.close(); resolve(); }
        });
        fs.writeFileSync(root + "/" + name, "ready");
      });
      const temp = await import(${JSON.stringify(path.join(import.meta.dir, "../tempSweep.ts"))});
      const evidence = await import(${JSON.stringify(path.join(import.meta.dir, "../runtime/attemptTempEvidence.ts"))});
      const sweep = temp.runTempSweepInHelper;
      spyOn(temp, "runTempSweepInHelper").mockImplementation(async (...args) => {
        await parked("temp"); return sweep(...args);
      });
      spyOn(temp, "scanProcesses").mockImplementation(() => ({ ownNamespace: null, processes: [] }));
      const preserve = evidence.preserveAttemptEvidence;
      spyOn(evidence, "preserveAttemptEvidence").mockImplementation(async (...args) => {
        if (Number(fs.readFileSync(root + "/clock", "utf8")) >= 5500) {
          await parked("overrun"); throw new Error("test overrun barrier released");
        }
        return preserve(...args);
      });
    `);
    // The third constructor argument is intentionally ignored on the red base.
    worker = new (WorktreeSweepWorker as unknown as new (...args: unknown[]) => WorktreeSweepWorker)(
      { executable: process.execPath, entry: "--preload", args: [preload, path.join(import.meta.dir, "../worktreeSweep.worker.ts")] }, 6000, clock);
    const temp = worker.temp({ ...process.env, LLV_TEMP_SWEEP: "off" });
    await barrier(path.join(root, "temp"));
    const attempt = worker.attemptTemp();
    const settled = attempt.then(report => ({ report }), error => ({ error }));
    advance(3000); fs.writeFileSync(path.join(root, "release-temp"), "go");
    expect(await temp).toBeNull();
    await barrier(path.join(root, "reference"));
    const childPid = Number(fs.readFileSync(path.join(root, "reference"), "utf8"));
    advance(releaseAt); fs.writeFileSync(path.join(root, "release-reference"), "go");
    const result = await Promise.race([settled, barrier(path.join(root, "overrun"), abort.signal).then(() => ({ overrun: true }))]);
    if ("overrun" in result) {
      advance(6000);
      const expired = await settled;
      expect("error" in expired && expired.error.message).toContain("attempt temp tick exceeded");
      console.error(JSON.stringify({ fixture: "queued-due-root", round, tickMs: now, outcome: "parent deadline exceeded" }));
      expect("overrun" in result, "attempt temp tick exceeded its parent deadline").toBeFalse();
    }
    expect(result).toHaveProperty("report");
    expect((result as { report: unknown }).report).toMatchObject({ deferred: releaseAt === 5500 ? 1 : 0,
      removed: releaseAt === 5500 ? 0 : 1, errors: 0 });
    if (releaseAt === 5500) {
      expect((result as { report: unknown }).report).toMatchObject({ outcomes: [
        { directory, disposition: "deferred", reason: expect.stringContaining("deadline") },
      ] });
      const after = fs.lstatSync(directory);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("retained");
    } else expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
    expect(fs.readdirSync(root).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
    expect(() => process.kill(childPid, 0)).toThrow();
    const commands = fs.readFileSync(path.join(root, "timeouts"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(commands.find(row => row.command === "docker").timeout).toBeLessThanOrEqual(2000);
    expect(await worker.temp({ ...process.env, LLV_TEMP_SWEEP: "off" })).toBeNull();
    expect(fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\n")).toHaveLength(1);
    console.error(JSON.stringify({ fixture: "queued-due-root", round, tickMs: now,
      outcome: releaseAt === 5500 ? "deferred; helper reused" : "removed; helper reused" }));
  } finally {
    abort.abort();
    await worker?.close();
    date.mockRestore(); timerSpy.mockRestore(); clearSpy.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
