import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { startServingLoopProfiler } from "./loopProfilerServing";
import { createLoopProfileStore } from "./loopProfilerStore";
import { LOOP_PROFILE_COOLDOWN_MS } from "./loopProfilerSupervisor";

test("native collection failure retains its bounded cause and recovers after cooldown", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "profile-native-failure-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  let at = 1_000_000, calls = 0;
  const lines: string[] = [], decisions: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at);
  try {
    await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false, manualUntil: at + 55_000 }));
    const supervisor = await startServingLoopProfiler(monitor,
      { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) },
      { now: () => at, wallNow: () => at, poll: false, decision: reason => decisions.push(reason),
        sleep: async ms => { at += ms; }, collect: async work => {
          calls++; await work(); monitor.tick();
          if (calls === 1) throw Object.assign(new Error("private diagnostic input"), { code: "EIO" });
          return { stackTraces: { traces: [] } };
        },
      });
    expect(decisions).toContain("capture-failed phase=collect code=EIO");
    const gap = JSON.parse(lines.find(line => line.startsWith("[viewer loop-gap] "))!.slice("[viewer loop-gap] ".length));
    expect(gap.jsProfile).toEqual({ status: "unavailable", reason: "capture-failed", phase: "collect", code: "EIO" });
    expect(JSON.stringify({ lines, decisions })).not.toContain("private diagnostic input");
    const file = path.join(directory, "loop-profiler-captures.json");
    expect(JSON.parse(await fs.readFile(file, "utf8")).profiles).toHaveLength(0);
    at = 1_000_000 + LOOP_PROFILE_COOLDOWN_MS;
    await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false, manualUntil: at + 55_000 }));
    await supervisor!.refresh(); expect(calls).toBe(2);
    expect(JSON.parse(await fs.readFile(file, "utf8")).profiles).toHaveLength(1);
  } finally {
    monitor.stop();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each(["write", "lock"] as const)("collected profile survives a failed %s persistence and two gap references", async failure => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "profile-collected-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  const file = path.join(directory, "loop-profiler-captures.json");
  let at = 1_000_000, calls = 0;
  const lines: string[] = [], decisions: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at);
  const ledger = async () => JSON.parse(await fs.readFile(file, "utf8"));
  let lock: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false, manualUntil: at + 55_000 }));
    const supervisor = await startServingLoopProfiler(monitor,
      { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) },
      { now: () => at, wallNow: () => at, poll: false, decision: reason => decisions.push(reason),
        sleep: async ms => { at += ms; },
        collect: async work => {
          calls++; await work(); monitor.tick(); at += 724; monitor.tick();
          if (failure === "write") await fs.mkdir(`${file}.next`);
          else {
            lock = Bun.spawn([process.execPath, "--eval", `
              import { withFileTransactionAsync } from "./src/lib/state/fileTransaction";
              await withFileTransactionAsync(process.env.LLV_STATE_DIR + "/loop-profiler-captures.json", "busy", async () => {
                console.log("ready"); await Bun.stdin.text();
              });
            `], { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
            const reader = (lock.stdout as ReadableStream<Uint8Array>).getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
            reader.releaseLock();
          }
          return { stackTraces: { traces: Array.from({ length: 512 }, () => ({ frames: [{ name: "parse", line: 0, column: 0 }] })) } };
        },
      });
    expect(supervisor).toBeDefined();
    const profiles = lines.filter(line => line.startsWith("[viewer loop-gap] "))
      .map(line => JSON.parse(line.slice("[viewer loop-gap] ".length)).jsProfile);
    expect(profiles).toHaveLength(2);
    expect(profiles.every(profile => profile.status === "captured" && profile.categories.samples === 512)).toBe(true);
    expect(profiles[0].from).toBe(profiles[1].from);
    expect(profiles[0].to).toBe(profiles[1].to);
    expect((await ledger()).profiles).toHaveLength(0);
    // Keep storage unavailable beyond cooldown: no replacement may discard the profile.
    at += 2 * LOOP_PROFILE_COOLDOWN_MS;
    await supervisor!.refresh(); expect(calls).toBe(1);
    if (lock) {
      (lock.stdin as { end(): void }).end();
      expect(await lock.exited).toBe(0); lock = undefined;
    } else await fs.rm(`${file}.next`, { recursive: true });
    await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ enabled: false }));
    await supervisor!.refresh();
    const saved = await ledger();
    expect(saved.profiles).toHaveLength(1);
    expect(saved.profiles[0].profile.categories.samples).toBe(512);
    expect(saved.profiles[0].profile.from).toBe(profiles[0].from);
    expect(saved.profiles[0].profile.to).toBe(profiles[0].to);
    expect(saved.profiles[0].capturedAt).toBe(1_005_724);
    expect(saved.pendingCapture).toBeUndefined();
    expect(saved.nextCaptureAt).toBe(1_000_000 + LOOP_PROFILE_COOLDOWN_MS);
    await supervisor!.refresh(); expect((await ledger()).profiles).toHaveLength(1);
    expect(decisions).not.toContain("capture-failed");
    expect(decisions).toContain(`persistence-failed phase=persist code=${failure === "write" ? "EISDIR" : "BUSY"}`);
  } finally {
    if (lock) { (lock.stdin as { end(): void }).end(); await lock.exited; }
    monitor.stop();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test.each(["write", "lock"] as const)(
  "serving retries a failed %s completion without releasing an active capture or shortening cooldown", async failure => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "profile-recovery-"));
    const previous = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = directory;
    const file = path.join(directory, "loop-profiler-captures.json");
    let at = 1_000_000, calls = 0, sampledAt = 0;
    let entered!: () => void, release!: () => void;
    const collecting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const monitor = createViewerLoopMonitor(() => {}, () => at);
    const ledger = async () => JSON.parse(await fs.readFile(file, "utf8"));
    const obstruction = failure === "write" ? `${file}.next` : `${file}.write-lock`;
    const store = createLoopProfileStore(directory);
    try {
      const supervisor = await startServingLoopProfiler(monitor,
        { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) },
        { now: () => at, wallNow: () => at, poll: false, decision: () => {},
          sleep: async ms => { at += ms; },
          collect: async work => {
            calls++; sampledAt = at;
            if (calls === 1) { entered(); await held; }
            await work();
            if (calls <= 2) {
              if (failure === "write") await fs.mkdir(obstruction);
              else await fs.writeFile(obstruction, JSON.stringify({ pid: process.pid, token: "held-test-lock" }));
            }
            return { stackTraces: { traces: [] } };
          },
        });
      expect(supervisor).toBeDefined();
      at += 6010; monitor.tick();
      const run = supervisor!.refresh();
      await collecting;
      const firstSample = sampledAt;
      at += 2 * LOOP_PROFILE_COOLDOWN_MS;
      expect(await store.reserve(at)).toBe(false);
      expect((await ledger()).pendingCapture.pid).toBe(process.pid);
      release(); await run;
      expect(calls).toBe(1);
      expect((await ledger()).pendingCapture).toBeDefined();
      // More than thirty minutes pass while storage is unavailable.
      for (let i = 0; i < 3; i++) {
        at += LOOP_PROFILE_COOLDOWN_MS + 6010;
        monitor.tick(); await supervisor!.refresh();
        expect(calls).toBe(1);
      }
      await fs.rm(obstruction, { recursive: true });
      // Settlement runs even with automatic requests disabled.
      await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false }));
      await supervisor!.refresh();
      expect((await ledger()).pendingCapture).toBeUndefined();
      expect((await ledger()).nextCaptureAt).toBe(firstSample + LOOP_PROFILE_COOLDOWN_MS);
      await fs.writeFile(path.join(directory, "loop-profiler.json"), "{}");
      at += 6010; monitor.tick(); await supervisor!.refresh();
      expect(calls).toBe(2);
      const deadline = sampledAt + LOOP_PROFILE_COOLDOWN_MS;
      expect((await ledger()).pendingCapture).toBeDefined();
      await fs.rm(obstruction, { recursive: true });
      await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false }));
      at += 1000; await supervisor!.refresh();
      expect((await ledger()).pendingCapture).toBeUndefined();
      expect((await ledger()).nextCaptureAt).toBe(deadline);
      // A separate real process observes the durable deadline after recovery.
      const check = Bun.spawn([process.execPath, "--eval", `
        import { createLoopProfileStore } from "./src/lib/loopProfilerStore";
        console.log(await createLoopProfileStore(process.env.LLV_STATE_DIR).reserve(${deadline - 1}));
      `], { env: process.env, stdout: "pipe", stderr: "pipe" });
      expect(await new Response(check.stdout).text()).toBe("false\n");
      expect(await new Response(check.stderr).text()).toBe("");
      expect(await check.exited).toBe(0);
      at = deadline - 1;
      await fs.writeFile(path.join(directory, "loop-profiler.json"), JSON.stringify({ automatic: false, manualUntil: deadline + 30_000 }));
      await supervisor!.refresh(); expect(calls).toBe(2);
      at = deadline; await supervisor!.refresh();
      expect(calls).toBe(3);
      expect((await ledger()).pendingCapture).toBeUndefined();
      expect((await ledger()).nextCaptureAt).toBe(sampledAt + LOOP_PROFILE_COOLDOWN_MS);
    } finally {
      release?.(); monitor.stop();
      if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

test.each(["write", "lock"] as const)("serving retries a refused capture's %s cancellation", async failure => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "profile-cancel-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  const file = path.join(directory, "loop-profiler-captures.json");
  const settings = path.join(directory, "loop-profiler.json");
  const obstruction = failure === "write" ? `${file}.next` : `${file}.write-lock`;
  let at = 1_000_000, calls = 0, refuse = true;
  const monitor = createViewerLoopMonitor(() => {}, () => at);
  try {
    const supervisor = await startServingLoopProfiler(monitor,
      { ...process.env, LLV_STATE_OWNER: "viewer", NODE_ENV: "production", LLV_DIAGNOSTIC_REVISION: "a".repeat(40) },
      { now: () => at, wallNow: () => at, poll: false, decision: () => {},
        sleep: async ms => { at += ms; },
        collect: async work => { calls++; await work(); return { stackTraces: { traces: [] } }; },
        afterBeginCapturePersistence: async () => {
          if (!refuse) return;
          await fs.writeFile(settings, JSON.stringify({ enabled: false }));
          if (failure === "write") await fs.mkdir(obstruction);
          else await fs.writeFile(obstruction, JSON.stringify({ pid: process.pid, token: "held-test-lock" }));
        },
      });
    expect(supervisor).toBeDefined();
    at += 6010; monitor.tick(); await supervisor!.refresh();
    expect(calls).toBe(0);
    expect(JSON.parse(await fs.readFile(file, "utf8")).pendingCapture).toBeDefined();
    await supervisor!.refresh();
    expect(calls).toBe(0);
    await fs.rm(obstruction, { recursive: true });
    await supervisor!.refresh();
    const cancelled = JSON.parse(await fs.readFile(file, "utf8"));
    expect(cancelled.pendingCapture).toBeUndefined();
    expect(cancelled.nextCaptureAt).toBe(0);
    refuse = false;
    await fs.writeFile(settings, JSON.stringify({ automatic: false, manualUntil: at + 30_000 }));
    await supervisor!.refresh(); expect(calls).toBe(1);
  } finally {
    monitor.stop();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
