import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { WorktreeSweepWorker } from "./worktreeSweepWorker";
import { AttemptTempStore } from "../runtime/attemptTempRetention";
import { attemptTempJournalPath } from "../tempSweep";

// Publish IPC values after their complete write. Directory watchers can see a
// newly created empty file before writeFileSync fills it in another process.
function publish(file: string, value: string) {
  const pending = file + ".pending";
  fs.writeFileSync(pending, value);
  fs.renameSync(pending, file);
}
const ipcPublisher = `function publish(file, value) {
  const pending = file + ".pending";
  fs.writeFileSync(pending, value);
  fs.renameSync(pending, file);
}`;

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
const cases = [
  ...[3500, 5500].flatMap(releaseAt => [1, 2, 3].map(round => ({ mode: "reference", releaseAt, round }))),
  ...["native", "namespace-delayed", "namespace-subsecond", "namespace-remove-delayed", "namespace-remove-subsecond", "namespace-expired", "namespace-failure", "namespace-failure-killed", "namespace-failure-killed-boundary", "namespace-failure-signal", "namespace-failure-late", "namespace-image-expired", "namespace-client-timeout", "evidence-copy", "evidence-copy-control"].map(mode => ({ mode, releaseAt: 3500, round: 1 })),
];
for (const { mode, releaseAt, round } of cases) test.skipIf(process.platform !== "linux")(`queued attempt tick ${mode} at ${releaseAt} preserves its deadline and helper, round ${round}`, async () => {
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
    now = ms; publish(clockFile, String(ms)); publish(path.join(root, "uptime"), `${ms / 1000} 0`);
    for (const timer of timers) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
  };
  // Instrument calendar-based parents and their request timers too, so this
  // fixture reproduces the failure before the constructor clock port existed.
  const epoch = Date.UTC(2026, 10, 14), nativeTimer = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const date = spyOn(Date, "now").mockImplementation(() => epoch + now);
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    ms === 6000 || ms === 3000 ? clock.setTimeout(() => callback(...args), ms) : nativeTimer(callback, ms, ...args)) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    const timer = handle as unknown as { at: number; callback: () => void };
    if (timers.has(timer)) timers.delete(timer); else Reflect.apply(nativeClear, globalThis, [handle]);
  });
  try {
    for (const name of ["home", "config", "state", "tmp"]) fs.mkdirSync(path.join(root, name));
    fs.mkdirSync(directory); if (mode.startsWith("evidence-copy")) fs.writeFileSync(path.join(directory, "capture.png"), "capture bytes");
    fs.writeFileSync(path.join(directory, "payload"), "retained"); fs.writeFileSync(path.join(directory, "partial"), "disposable");
    Object.assign(process.env, { HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
      PATH: root + path.delimiter + savedEnv.PATH, LLV_STATE_DIR: state, TMPDIR: path.join(root, "tmp"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_TEMP_SWEEP: "on", ...(mode.startsWith("namespace") && mode !== "namespace-image-expired" ? { LLV_ATTEMPT_TEMP_CLEANUP_IMAGE: "fixture" } : {}) });
    const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
    try { store.register({ directory, pipelineId: null, launchId: "due-root", retainUntilClose: false, createdAt: 1 }); }
    finally { store.close(); }
    const before = fs.lstatSync(directory);
    advance(0);
    const preload = path.join(root, "preload.ts"), childEntry = path.join(root, "docker");
    fs.writeFileSync(childEntry, `#!${process.execPath}
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      ${ipcPublisher}
      const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
      const args = process.argv.slice(2);
      const parked = name => new Promise(resolve => {
        if (fs.existsSync(root + "/release-" + name)) { resolve(); return; }
        const watcher = fs.watch(root, () => {
          if (fs.existsSync(root + "/release-" + name)) { watcher.close(); resolve(); }
        });
        publish(root + "/" + name, String(process.pid));
      });
      if (!mode.startsWith("namespace")) { await parked("reference"); process.exit(0); }
      if (args[0] === "ps") process.exit(0);
      if (args[0] === "image") { await parked("namespace"); process.exit(0); }
      if (args[0] === "rm") {
        const name = fs.readFileSync(root + "/container-name", "utf8");
        if (args[2] !== name) process.exit(2);
        fs.writeFileSync(root + "/cleaned", "done");
        process.exit(0);
      }
      if (args[0] !== "run") process.exit(2);
      fs.writeFileSync(root + "/container-name", args[args.indexOf("--name") + 1] || "legacy");
      await parked("namespace");
      if (mode.startsWith("namespace-failure")) {
        fs.writeSync(2, "fixture command failure\\n");
        if (mode === "namespace-failure-signal") process.kill(process.pid, "SIGKILL");
        process.exit(mode.startsWith("namespace-failure-killed") ? 137 : 42); }
      const entry = args.indexOf("--entrypoint");
      // Execute the production startup guard. Substitute only the kernel clock
      // source; the parent and helper use the same injected monotonic time.
      const wrapper = args[entry + 4].replaceAll("/proc/uptime", root + "/uptime");
      const child = spawn("/bin/sh", ["-c", wrapper, ...args.slice(entry + 5, entry + 7),
        "-c", "exit 0"], { stdio: "inherit" });
      child.on("exit", code => process.exit(code ?? 1));
    `, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "timeout"), `#!${process.execPath}
      import fs from "node:fs";
      ${ipcPublisher}
      const ipcPublisher = ${JSON.stringify(ipcPublisher)};
      const root = ${JSON.stringify(root)};
      const start = Number(fs.readFileSync(root + "/clock", "utf8"));
      const duration = Number(process.argv[4]) * 1000;
      const watcher = fs.watch(root, () => {
        if (Number(fs.readFileSync(root + "/clock", "utf8")) >= start + duration) {
          watcher.close(); process.exit(124);
        }
      });
      publish(root + "/inner", JSON.stringify({ start, duration, pid: process.pid }));
    `, { mode: 0o700 });
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import { mock, spyOn } from "bun:test";
      import cp from "node:child_process";
      import { promisify } from "node:util";
      ${ipcPublisher}
      const ipcPublisher = ${JSON.stringify(ipcPublisher)};
      const root = ${JSON.stringify(root)};
      fs.appendFileSync(root + "/starts", process.pid + "\\n");
      spyOn(Date, "now").mockImplementation(() => ${epoch} + Number(fs.readFileSync(root + "/clock", "utf8")));
      spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(fs.readFileSync(root + "/clock", "utf8")) * 1000000n);
      spyOn(performance, "now").mockImplementation(() => Number(fs.readFileSync(root + "/clock", "utf8")));
      // Command timers also follow test time: the IPC barrier owns completion.
      // Keep the production timeout calculation observable before suppressing
      // its wall timer, so scheduling speed cannot decide this test.
      const exec = cp.execFile;
      const controlled = (command, args, options, callback) => {
        fs.appendFileSync(root + "/timeouts", JSON.stringify({ command, timeout: options.timeout }) + "\\n");
        const native = ${JSON.stringify(mode)} === "native" && !fs.existsSync(root + "/native") && command === process.execPath && args[0] === "-e";
        const copy = ${JSON.stringify(mode)} === "evidence-copy" && !fs.existsSync(root + "/copy") && command === process.execPath && args[0] === "-e" && args[1].includes("DELEGATUS_COPY_CODE");
        if (copy) args = ["-e", \`const fs = require('node:fs'); \${ipcPublisher} fs.writeFileSync(process.argv[2], 'partial copy');
          fs.watch(\${JSON.stringify(root)}, () => {});
          publish(\${JSON.stringify(root + "/copy")}, String(process.pid));\`, ...args.slice(2)];
        if (native) args = ["-e", \`const fs = require('node:fs'); \${ipcPublisher} fs.unlinkSync(process.argv[1] + '/partial');
          fs.watch(\${JSON.stringify(root)}, () => {});
          publish(\${JSON.stringify(root + "/native")}, String(process.pid));\`, args[2]];
        const child = exec(command, args, { ...options, timeout: 0 }, callback);
        const clientTimeout = ${JSON.stringify(mode)} === "namespace-client-timeout" && command === "docker" && args[0] === "run";
        if (native || copy || clientTimeout) {
          const cutoff = Number(fs.readFileSync(root + "/clock", "utf8")) + options.timeout;
          const watcher = fs.watch(root, () => {
            if (Number(fs.readFileSync(root + "/clock", "utf8")) >= cutoff) { child.kill(options.killSignal); watcher.close(); }
          });
          child.once("close", () => watcher.close());
        }
        return child;
      };
      const asyncExec = (command, args, options) => new Promise((resolve, reject) =>
        controlled(command, args, options, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
      Object.defineProperty(controlled, promisify.custom, { value: asyncExec });
      mock.module("node:child_process", () => ({ ...cp, execFile: controlled }));
      const parked = (name) => new Promise(resolve => {
        if (fs.existsSync(root + "/release-" + name)) { resolve(); return; }
        const watcher = fs.watch(root, () => {
          if (fs.existsSync(root + "/release-" + name)) { watcher.close(); resolve(); }
        });
        publish(root + "/" + name, "ready");
      });
      const temp = await import(${JSON.stringify(path.join(import.meta.dir, "../tempSweep.ts"))});
      const evidence = await import(${JSON.stringify(path.join(import.meta.dir, "../runtime/attemptTempEvidence.ts"))});
      const sweep = temp.runTempSweepInHelper;
      spyOn(temp, "runTempSweepInHelper").mockImplementation(async (...args) => {
        await parked("temp"); return sweep(...args);
      });
      spyOn(temp, "scanProcesses").mockImplementation(() => ({ ownNamespace: null, processes: [] }));
      if (${JSON.stringify(mode)}.startsWith("namespace-remove")) {
        const removal = await import(${JSON.stringify(path.join(import.meta.dir, "../runtime/attemptTempRemoval.ts"))});
        spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async () => {
          throw Object.assign(new Error("fixture permission fallback"), { code: "EACCES" });
        });
      }
      if (${JSON.stringify(mode)}.startsWith("namespace") && !${JSON.stringify(mode)}.startsWith("namespace-remove")) {
        const lstat = fs.promises.lstat;
        spyOn(fs.promises, "lstat").mockImplementation(async (file, ...args) => {
          if (String(file) === ${JSON.stringify(directory)}) throw Object.assign(new Error("fixture unreadable root"), { code: "EACCES" });
          return lstat(file, ...args);
        });
      }
      if (${JSON.stringify(mode)}.startsWith("namespace")) {
        const read = fs.readFileSync;
        spyOn(fs, "readFileSync").mockImplementation((file, ...args) =>
          read(String(file) === "/proc/uptime" ? root + "/uptime" : file, ...args));
      }
      // Keep the same fixture red on the old unbounded copy path.
      if (${JSON.stringify(mode)} === "evidence-copy")
        spyOn(fs.promises, "copyFile").mockImplementation(async () => { await parked("unbounded-copy"); });
      const preserve = evidence.preserveAttemptEvidence;
      spyOn(evidence, "preserveAttemptEvidence").mockImplementation(async (...args) => {
        if (${JSON.stringify(mode)} === "reference" && Number(fs.readFileSync(root + "/clock", "utf8")) >= 5500) {
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
    advance(3000); publish(path.join(root, "release-temp"), "go");
    expect(await temp).toBeNull();
    if (mode.startsWith("evidence-copy")) {
      await barrier(path.join(root, "reference"));
      if (mode.endsWith("control")) advance(3500);
      publish(path.join(root, "release-reference"), "go");
      if (mode === "evidence-copy") {
        await Promise.race([barrier(path.join(root, "copy"), abort.signal), barrier(path.join(root, "unbounded-copy"), abort.signal)]);
        advance(fs.existsSync(path.join(root, "unbounded-copy")) ? 6000 : 5500);
      }
      const result = await settled;
      console.error(JSON.stringify({ fixture: mode, tickMs: now, outcome: "error" in result ? "parent timeout" : "helper replied" }));
      expect(result).toHaveProperty("report");
      const deferred = mode === "evidence-copy";
      expect((result as { report: unknown }).report).toMatchObject({ removed: deferred ? 0 : 1, deferred: deferred ? 1 : 0, errors: 0 });
      if (deferred) {
        expect((result as { report: unknown }).report).toMatchObject({ outcomes: [{ disposition: "deferred", reason: expect.stringContaining("deadline") }] });
        expect([fs.lstatSync(directory).dev, fs.lstatSync(directory).ino]).toEqual([before.dev, before.ino]);
        expect(fs.readFileSync(path.join(directory, "capture.png"), "utf8")).toBe("capture bytes");
        const pid = Number(fs.readFileSync(path.join(root, "copy"), "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBeTrue();
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
      expect(fs.readdirSync(root).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
      expect(fs.readdirSync(path.join(state, "evidence"), { recursive: true }).some(name => String(name).includes(".copy-"))).toBeFalse();
      expect(await worker.temp({ ...process.env, LLV_TEMP_SWEEP: "off" })).toBeNull();
      expect(fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\n")).toHaveLength(1);
      // A new helper resumes preservation using the same durable owner/copy rows.
      await worker.close();
      worker = new (WorktreeSweepWorker as unknown as new (...args: unknown[]) => WorktreeSweepWorker)(
        { executable: process.execPath, entry: "--preload", args: [preload, path.join(import.meta.dir, "../worktreeSweep.worker.ts")] }, 6000, clock);
      if (deferred) {
        advance(65_000);
        expect(await worker.attemptTemp()).toMatchObject({ removed: 1, errors: 0 });
      }
      const captures = fs.readdirSync(path.join(state, "evidence"), { recursive: true }).filter(name => String(name).endsWith("files/capture.png"));
      expect(captures).toHaveLength(1);
      expect(fs.readFileSync(path.join(state, "evidence", String(captures[0])), "utf8")).toBe("capture bytes");
      expect(fs.existsSync(directory)).toBeFalse();
      return;
    }
    if (mode !== "reference") {
      const native = mode === "native";
      await barrier(path.join(root, native ? "reference" : "namespace"));
      if (native) {
        publish(path.join(root, "release-reference"), "go");
        await barrier(path.join(root, "native"));
        advance(5000);
      } else {
        advance(mode.endsWith("subsecond") || (mode === "namespace-failure" || mode === "namespace-failure-killed") ? 3500 : (mode.endsWith("delayed") || mode.endsWith("boundary") || mode === "namespace-client-timeout") ? 4500 : 5500);
        if (mode !== "namespace-client-timeout") publish(path.join(root, "release-namespace"), "go");
        if (mode.endsWith("subsecond")) {
          await barrier(path.join(root, "inner"));
          const inner = JSON.parse(fs.readFileSync(path.join(root, "inner"), "utf8"));
          expect(inner.duration).toBeGreaterThan(0);
          expect(inner.duration).toBeLessThan(1000);
          expect(inner.start + inner.duration + 200).toBeLessThanOrEqual(5000);
          advance(4000);
        }
      }
      const result = await settled;
      expect(result).toHaveProperty("report");
      const genuine = mode.startsWith("namespace-failure");
      expect((result as { report: unknown }).report).toMatchObject({ removed: 0, deferred: genuine ? 0 : 1, errors: genuine ? 1 : 0 });
      if (genuine) expect((result as { report: unknown }).report).toMatchObject({ outcomes: [{ disposition: "failed",
        reason: expect.stringMatching(new RegExp(`${mode === "namespace-failure-signal" ? "signal=SIGKILL" : `code=${mode.startsWith("namespace-failure-killed") ? 137 : 42}`}.*stderr=fixture command failure`)) }] });
      if (native) {
        const journal = JSON.parse(fs.readFileSync(attemptTempJournalPath(directory), "utf8"));
        expect(fs.readFileSync(path.join(journal.trash, "payload"), "utf8")).toBe("retained");
        expect(fs.existsSync(path.join(journal.trash, "partial"))).toBeFalse();
        expect(() => process.kill(Number(fs.readFileSync(path.join(root, "native"), "utf8")), 0)).toThrow();
      } else if (mode.startsWith("namespace-remove")) {
        const journal = JSON.parse(fs.readFileSync(attemptTempJournalPath(directory), "utf8"));
        expect([fs.lstatSync(journal.trash).dev, fs.lstatSync(journal.trash).ino]).toEqual([before.dev, before.ino]);
        expect(fs.readFileSync(path.join(journal.trash, "payload"), "utf8")).toBe("retained");
        expect(fs.existsSync(path.join(root, "cleaned"))).toBeTrue();
        if (mode.endsWith("delayed")) expect(fs.existsSync(path.join(root, "inner"))).toBeFalse();
        else {
          const inner = JSON.parse(fs.readFileSync(path.join(root, "inner"), "utf8"));
          expect(() => process.kill(inner.pid, 0)).toThrow();
        }
      } else {
        expect([fs.lstatSync(directory).dev, fs.lstatSync(directory).ino]).toEqual([before.dev, before.ino]);
        expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("retained");
        expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
        if (mode === "namespace-client-timeout") {
          const pid = Number(fs.readFileSync(path.join(root, "namespace"), "utf8"));
          expect(Number.isSafeInteger(pid) && pid > 0).toBeTrue();
          expect(() => process.kill(pid, 0)).toThrow();
        }
        if (mode === "namespace-client-timeout" || mode === "namespace-failure-killed-boundary" || mode === "namespace-delayed" || mode === "namespace-subsecond" || mode === "namespace-failure" || mode === "namespace-failure-killed") expect(fs.existsSync(path.join(root, "cleaned"))).toBeTrue();
        if (mode === "namespace-delayed") expect(fs.existsSync(path.join(root, "inner"))).toBeFalse();
        if (mode.endsWith("subsecond")) {
          const inner = JSON.parse(fs.readFileSync(path.join(root, "inner"), "utf8"));
          expect(() => process.kill(inner.pid, 0)).toThrow();
        }
      }
      expect(await worker.temp({ ...process.env, LLV_TEMP_SWEEP: "off" })).toBeNull();
      if (native) {
        advance(65_000);
        expect(await worker.attemptTemp()).toMatchObject({ removed: 1, errors: 0 });
        expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
        expect(fs.readdirSync(root).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
      }
      expect(fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\n")).toHaveLength(1);
      console.error(JSON.stringify({ fixture: mode, tickMs: now, outcome: genuine ? "failed command retained" : "deferred; helper reused" }));
      return;
    }
    await barrier(path.join(root, "reference"));
    const childPid = Number(fs.readFileSync(path.join(root, "reference"), "utf8"));
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBeTrue();
    advance(releaseAt); publish(path.join(root, "release-reference"), "go");
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
