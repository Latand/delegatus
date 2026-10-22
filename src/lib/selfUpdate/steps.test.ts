import { tmpdir } from "node:os";
import { afterAll, describe, expect, jest, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { builtRevision, prepareExistingRelease, realPorts, releaseBuilt, UpdateRunner, updateFailureDetail, type StepPorts } from "./steps";
import { releaseDirFor } from "./release";
import { runGit } from "./git";
import { setCpuPortsForTests } from "@/lib/runtime/cpuPlacement";
import { CpuPressureGate, DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";
import { CHECKOUT_STEPS as STEP_NAMES, type CheckoutStepName as StepName } from "./types";
import * as pid from "./pid";

const TARGET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const CHECKOUT = "/var/tmp/checkout";
const RELEASES = "/var/tmp/releases";
const RELEASE = `${RELEASES}/a1b2c3d4e5f6`;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test("retry recovery preserves a file created after the deleted-path listing", async () => {
  const root = mkdtempSync(join(tmpdir(), "llv-release-recovery-race-")); roots.push(root);
  const git = (args: string[]) => {
    const result = childProcess.spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
  };
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "source.txt"), "committed\n"); git(["add", "source.txt"]); git(["commit", "-qm", "initial"]);
  rmSync(join(root, "source.txt"));
  let injected = false;
  const refusal = await prepareExistingRelease(root, async (args, cwd) => {
    if (args[0] === "checkout-index") { injected = true; writeFileSync(join(root, "source.txt"), "late unique data\n"); }
    return runGit(args, cwd);
  });
  expect(injected).toBeTrue(); expect(refusal).not.toBeNull();
  expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("late unique data\n");
});

interface Script { lines?: string[]; exit?: number }

/* A stubbed spawn: each step's command is recognised by its argv and answers
   with scripted lines and an exit code. Nothing real runs. */
function harness(scripts: Partial<Record<StepName, Script>>, overrides: Partial<StepPorts> = {}, stepTimeoutMs?: Partial<Record<StepName, number>>, livenessPollMs?: number, releaseIdleTimeoutMs?: number) {
  const logDir = mkdtempSync(join(tmpdir(), "llv-self-update-steps-"));
  roots.push(logDir);
  const calls: string[][] = [];
  const cwds: string[] = [];
  const published: { sha: string; dir: string }[] = [];
  let clock = 1_000;
  const ports: StepPorts = {
    async run(command, { cwd, onLine }) {
      calls.push(command);
      cwds.push(cwd);
      const step = stepOf(command);
      clock += 250;
      for (const line of scripts[step]?.lines ?? [`${step} ok`]) onLine(line);
      return scripts[step]?.exit ?? 0;
    },
    memAvailableMb: () => 8_192,
    revParse: async () => TARGET,
    exists: () => false,
    buildIdReadable: () => true,
    publish: (release) => { published.push(release); },
    now: () => clock,
    prepareExistingRelease: async () => null,
    ...overrides,
  };
  const runner = new UpdateRunner(
    { checkout: CHECKOUT, remote: "/var/tmp/remote.git", branch: "main", bun: "/opt/bun", logDir, releasesDir: RELEASES, env: { PATH: "/usr/bin" }, stepTimeoutMs, livenessPollMs, releaseIdleTimeoutMs },
    ports,
    () => {},
  );
  return { runner, calls, cwds, published, logDir };
}

function stepOf(command: string[]): StepName {
  if (command.includes("fetch")) return "fetch";
  if (command.includes("checkout") || command.includes("worktree")) return "checkout";
  if (command.includes("install")) return "install";
  if (command.includes("build")) return "build";
  throw new Error(`unexpected command ${command.join(" ")}`);
}

async function flushPromises() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

test.each(["fetch", "checkout", "install", "build"] as const)("deployment diagnostics retain the %s phase and exit cause", async name => {
  const { runner } = harness({ [name]: { exit: 7 } });
  await runner.start(TARGET);
  expect(updateFailureDetail(runner.state)).toBe(`Release ${name} failed: exit 7`);
});

test.each(["install", "build"])("%s output renews its deadline beyond the old total limit", async name => {
  let output: (line: string) => void = () => {};
  let finish: (code: number) => void = () => {};
  let entered = () => {};
  const building = new Promise<void>(resolve => { entered = resolve; });
  jest.useFakeTimers();
  try {
    const { runner } = harness({}, { now: () => Date.now(), run: async (command, options) => {
      if (!command.includes(name)) return 0;
      output = options.onLine;
      return new Promise<number>(resolve => { finish = resolve; entered(); });
    } });
    const done = runner.start(TARGET);
    await building;
    for (let phase = 0; phase < 2; phase++) {
      jest.advanceTimersByTime(29 * 60_000);
      output(`completed phase ${phase}`);
      await flushPromises();
      expect(runner.state.state).toBe("running");
    }
    finish(0); await done;
    expect(runner.state.state).toBe("done");
  } finally { finish(0); jest.useRealTimers(); }
});

test.each((["install", "build"] as const).flatMap(name => (["silence", "total"] as const).map(reason => ({ name, reason }))))("$name has a bounded $reason deadline with load and elapsed evidence", async ({ name, reason }) => {
  let output: (line: string) => void = () => {};
  let finish: (code: number) => void = () => {};
  let entered = () => {};
  const building = new Promise<void>(resolve => { entered = resolve; });
  let aborts = 0;
  jest.useFakeTimers();
  try {
    const { runner, logDir } = harness({}, { now: () => Date.now(), cpuLoad: () => ({ load1: 23.5, cpus: 24 }), abort: () => { aborts++; },
      run: async (command, options) => {
        if (!command.includes(name)) return 0;
        output = options.onLine;
        return new Promise<number>(resolve => { finish = resolve; entered(); });
      },
    });
    const done = runner.start(TARGET); await building;
    const totalMinutes = name === "install" ? 60 : 120;
    const rounds = reason === "silence" ? 1 : Math.floor(totalMinutes / 29);
    for (let phase = 0; phase < rounds; phase++) {
      jest.advanceTimersByTime(29 * 60_000); output(`phase ${phase}`); await flushPromises();
      expect(runner.state.state).toBe("running");
    }
    jest.advanceTimersByTime((reason === "silence" ? 30 : totalMinutes - rounds * 29) * 60_000);
    await done;
    const minutes = reason === "silence" ? 59 : totalMinutes;
    expect(runner.state.steps.find(step => step.name === name)?.failure).toMatchObject({ kind: "timeout", reason, minutes, load1: 23.5, cpus: 24 });
    expect(updateFailureDetail(runner.state)).toContain(`Release ${name} failed: timeout after ${minutes} minutes`);
    expect(updateFailureDetail(runner.state)).toContain("load avg1 23.50 on 24 CPUs");
    expect(readFileSync(join(logDir, `${name}.log`), "utf8")).toContain("timeout after");
    expect(aborts).toBe(1);
    const saved = JSON.stringify(runner.state);
    output("late success"); finish(0); await flushPromises();
    expect(JSON.stringify(runner.state)).toBe(saved);
  } finally { finish(0); jest.useRealTimers(); }
});

test.each(["install", "build"])("%s silence expiry preserves a queued successful exit", async name => {
  let finish: (code: number) => void = () => {};
  let waiting = false;
  jest.useFakeTimers();
  try {
    const { runner } = harness({}, { now: Date.now, childAlive: () => waiting ? null : true,
      run: async command => {
        if (!command.includes(name)) return 0;
        waiting = true;
        return new Promise<number>(resolve => { finish = code => { waiting = false; resolve(code); }; });
      },
    }, {}, 10, 100);
    const done = runner.start(TARGET); await flushPromises();
    jest.advanceTimersByTime(100); await flushPromises();
    expect(runner.state.state).toBe("running");
    finish(0); await done;
    expect(runner.state.state).toBe("done");
  } finally { finish(0); jest.useRealTimers(); }
});

test("a refused timeout cleanup keeps the timeout cause in deployment diagnostics", async () => {
  let finish: (code: number) => void = () => {};
  jest.useFakeTimers();
  try {
    const { runner } = harness({}, { now: Date.now,
      run: async command => command.includes("build") ? new Promise<number>(resolve => { finish = resolve; }) : 0,
      abort: async () => { throw new Error("scope stop refused"); },
    }, { build: 100 });
    const done = runner.start(TARGET); await flushPromises();
    jest.advanceTimersByTime(100); await done;
    expect(updateFailureDetail(runner.state)).toContain("Release build failed: timeout after");
    expect(updateFailureDetail(runner.state)).toContain("scope stop refused");
  } finally { finish(0); jest.useRealTimers(); }
});

test.each(["install", "build"])("a real process restart interrupts %s without renewing its budget", async name => {
  const root = mkdtempSync(join(tmpdir(), "release-build-restart-")); roots.push(root);
  const saved = join(root, "saved.json");
  const code = `
    import { UpdateRunner } from ${JSON.stringify(join(import.meta.dir, "steps.ts"))};
    import { readFileSync, writeFileSync } from "node:fs";
    const runner = new UpdateRunner({ checkout: ${JSON.stringify(root)}, remote: "fixture", branch: "main", bun: "bun",
      logDir: ${JSON.stringify(join(root, "logs"))}, releasesDir: ${JSON.stringify(join(root, "releases"))}, env: {} }, {
      run: async command => { if (command.includes(${JSON.stringify(name)})) { writeFileSync(${JSON.stringify(saved)}, JSON.stringify(runner.state)); process.exit(0); } return 0; },
      memAvailableMb: () => 8192, revParse: async () => ${JSON.stringify(TARGET)}, exists: () => false,
      buildIdReadable: () => true, publish: () => {}, now: () => 1000,
    }, () => {});
    if (process.env.FIXTURE_GENERATION === "first") await runner.start(${JSON.stringify(TARGET)});
    else { runner.restore(JSON.parse(readFileSync(${JSON.stringify(saved)}, "utf8"))); console.log(JSON.stringify(runner.state)); }
  `;
  const run = async (generation: string) => {
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: root, env: { ...process.env, FIXTURE_GENERATION: generation }, stdout: "pipe", stderr: "pipe" });
    const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, error }).toEqual({ status: 0, error: "" });
    return output;
  };
  await run("first");
  const restored = JSON.parse(await run("second"));
  expect(restored.state).toBe("failed");
  expect(restored.steps.find((step: { name: string }) => step.name === name).failure).toEqual({ kind: "interrupted" });
});

test.skipIf(process.platform !== "linux")("a timeout retains its cause while the real build child exits during cleanup", async () => {
  const base = mkdtempSync(join(tmpdir(), "release-timeout-cause-")); roots.push(base);
  const real = realPorts(() => {});
  const { runner } = harness({}, {
    now: Date.now, childAlive: real.childAlive, abort: real.abort,
    run: (command, options) => command.includes("build")
      ? real.run([process.execPath, "-e", 'console.log("compiling"); setInterval(() => {}, 1000);'], { ...options, work: undefined, cwd: base, env: { ...process.env, TMPDIR: base } as Record<string, string> })
      : Promise.resolve(0),
  }, { build: 100 });
  try {
    await runner.start(TARGET);
    expect(runner.state.steps.find(step => step.name === "build")?.failure).toMatchObject({ kind: "timeout", reason: "total" });
  } finally { await real.abort(); }
});

test.skipIf(process.platform !== "linux").each(([["install", "silence"], ["install", "total"], ["build", "silence"], ["build", "total"]] as const))(
  "a parent observes UpdateRunner terminate a real %s child on its %s deadline",
  async (name, reason) => {
    const base = mkdtempSync(join(tmpdir(), "release-deadline-child-")); roots.push(base);
    const ownedFile = join(base, "owned-child.json");
    const source = `
      import { UpdateRunner, realPorts, updateFailureDetail } from ${JSON.stringify(join(import.meta.dir, "steps.ts"))};
      import { setCpuPortsForTests } from ${JSON.stringify(join(import.meta.dir, "../runtime/cpuPlacement.ts"))};
      import { readStartIdentity } from ${JSON.stringify(join(import.meta.dir, "pid.ts"))};
      import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
      const base = process.argv[1], name = process.argv[2], reason = process.argv[3], ownedFile = process.argv[4];
      process.env.DELEGATUS_AGENT_CPU = "off";
      process.env.FIXTURE_REASON = reason;
      const fixtureBun = base + "/fixture-bun";
      writeFileSync(fixtureBun, '#!/bin/sh\\nprintf "CHILD_PID=%s\\n" "$$"\\n' +
        'if [ "$FIXTURE_REASON" = "total" ]; then\\n  while :; do printf "progress\\n"; sleep 0.02; done\\n' +
        'else\\n  while :; do sleep 1; done\\nfi\\n');
      chmodSync(fixtureBun, 0o755);
      setCpuPortsForTests({ probe: () => ({ kind: "not-applicable", reason: "isolated process fixture" }) });
      const published = [];
      const ports = realPorts(release => { published.push(release); });
      const runner = new UpdateRunner({ checkout: base, remote: "fixture", branch: "main", bun: fixtureBun,
        logDir: base + "/logs", releasesDir: base + "/releases", env: { ...process.env, TMPDIR: base },
        stepTimeoutMs: { [name]: 300 }, releaseIdleTimeoutMs: 100, livenessPollMs: 10 }, {
        ...ports,
        async run(command, options) {
          if (!command.includes(name)) return 0;
          mkdirSync(options.cwd, { recursive: true });
          return ports.run(command, {
            ...options,
            onLine(line) {
              if (line.startsWith("CHILD_PID=")) {
                const pid = Number(line.slice(10));
                writeFileSync(ownedFile, JSON.stringify({ pid, startIdentity: readStartIdentity(pid) }));
              }
              options.onLine(line);
            },
          });
        },
        memAvailableMb: () => 8192, revParse: async () => ${JSON.stringify(TARGET)}, exists: () => false,
        buildIdReadable: () => true,
      }, () => {});
      await runner.start(${JSON.stringify(TARGET)});
      process.stdout.write(JSON.stringify({ state: runner.state.state, failure: runner.state.steps.find(step => step.name === name).failure,
        detail: updateFailureDetail(runner.state), published }));
    `;
    const env = { ...process.env, DELEGATUS_AGENT_CPU: "off", TMPDIR: base, HOME: join(base, "home"),
      XDG_CONFIG_HOME: join(base, "config"), LLV_STATE_DIR: join(base, "state") };
    mkdirSync(env.HOME); mkdirSync(env.XDG_CONFIG_HOME); mkdirSync(env.LLV_STATE_DIR);
    const child = Bun.spawn([process.execPath, "-e", source, base, name, reason, ownedFile], {
      cwd: base, env, stdout: "pipe", stderr: "pipe", detached: true,
    });
    const owner = child.pid ? { pid: child.pid, startIdentity: pid.readStartIdentity(child.pid)! } : null;
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([status, stdout, stderr]) => ({ status, stdout, stderr })),
        new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error(`independent ${reason} deadline guard expired`)), 2_000); }),
      ]);
      if (result.status !== 0) throw new Error(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
      const observed = JSON.parse(result.stdout);
      expect(observed.state).toBe("failed");
      expect(observed.failure).toMatchObject({ kind: "timeout", reason });
      expect(observed.detail).toContain(`Release ${name} failed: timeout after`);
      expect(observed.published).toEqual([]);
      const owned = JSON.parse(readFileSync(ownedFile, "utf8")) as pid.RecordedPid;
      expect(owned.startIdentity).toBeTruthy();
      expect(pid.sameProcess(owned)).toBe(false);
    } finally {
      if (guard) clearTimeout(guard);
      const recorded = existsSync(ownedFile) ? JSON.parse(readFileSync(ownedFile, "utf8")) as pid.RecordedPid : null;
      if (recorded?.startIdentity) pid.signalGroup(recorded, "SIGKILL");
      if (owner && pid.sameProcess(owner)) pid.signalGroup(owner, "SIGKILL");
      await child.exited;
    }
  },
);

test.skipIf(process.platform !== "linux")("CPU placement off never treats a command argument as an owned scope", async () => {
  const base = mkdtempSync(join(tmpdir(), "release-scope-argument-")); roots.push(base);
  const previous = process.env.DELEGATUS_AGENT_CPU;
  const unitArgument = `--unit=delegatus-test-${basename(base)}.scope`;
  process.env.DELEGATUS_AGENT_CPU = "off";
  let ready = () => {};
  const started = new Promise<void>(resolve => { ready = resolve; });
  let owned: pid.RecordedPid | null = null;
  const ports = realPorts(() => {});
  const done = ports.run(["/bin/sh", "-c", "echo $$; exec sleep 600", unitArgument], {
    cwd: base, env: { ...process.env, TMPDIR: base } as Record<string, string>, work: "update-build", onLine: line => {
      const child = Number(line);
      if (child > 0) { owned = { pid: child, startIdentity: pid.readStartIdentity(child)! }; ready(); }
    },
  }).catch(error => error);
  const control = spyOn(childProcess, "execFile").mockImplementation(((_command: string, _args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => { callback(null, "", ""); return {}; }) as unknown as typeof childProcess.execFile);
  try {
    await started;
    await ports.abort();
    expect(control).not.toHaveBeenCalled();
  } finally {
    control.mockRestore();
    if (owned) pid.signalGroup(owned, "SIGKILL");
    await done;
    if (previous === undefined) delete process.env.DELEGATUS_AGENT_CPU; else process.env.DELEGATUS_AGENT_CPU = previous;
  }
});

test.skipIf(process.platform !== "linux")("abort reaps a build child that ignores TERM before returning", async () => {
  const base = mkdtempSync(join(tmpdir(), "release-hung-child-")); roots.push(base);
  let ready = () => {};
  const started = new Promise<void>(resolve => { ready = resolve; });
  let owned: pid.RecordedPid | null = null;
  const ports = realPorts(() => {});
  const done = ports.run([process.execPath, "-e", 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);'], {
    cwd: base, env: { ...process.env, TMPDIR: base } as Record<string, string>, onLine: line => {
      const child = Number(line);
      if (child > 0) { owned = { pid: child, startIdentity: pid.readStartIdentity(child)! }; ready(); }
    },
  }).catch(error => error);
  try {
    await started;
    await ports.abort();
    const stillOwned = (): boolean | null => owned && pid.sameProcess(owned);
    expect(stillOwned()).toBe(false);
  } finally {
    if (owned) pid.signalGroup(owned, "SIGKILL");
    await done;
  }
}, 10_000);

describe("child exit while command output is draining", () => {
  // A missing PID can still have a normal exit event queued. The deadline
  // gives that event one I/O turn and one polling interval; absent a status,
  // the bounded wait expires as a timeout. A reported end without an exit
  // code proves interruption. Fake timers must advance the wait after I/O.
  test.each(["lost", "alive", "recovered"])("a %s child with no exit notification times out after a bounded wait", async (presence) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough(),
    });
    let alive = true;
    let aborts = 0;
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => child) as unknown as typeof childProcess.spawn);
    const sameProcess = spyOn(pid, "sameProcess").mockImplementation(() => alive);
    // The fake child must have a recorded identity on every supported platform.
    const identity = spyOn(pid, "readStartIdentity").mockReturnValue("fixture-start");
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (_command, options) => real.run(["fixture"], { ...options, cwd: logDir, env: { TMPDIR: logDir } }),
      childAlive: real.childAlive,
      // The spawned child is a fixture; never signal the test process.
      abort: () => { aborts += 1; },
    }, { fetch: 100 }, 10);
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      jest.advanceTimersByTime(15);
      alive = presence === "alive";
      jest.advanceTimersByTime(5);
      await flushPromises();
      expect(runner.state.state).toBe("running");
      // Repeated missing-PID polls cannot establish an absent exit status.
      jest.advanceTimersByTime(10);
      await flushPromises();
      expect(runner.state.state).toBe("running");
      jest.advanceTimersByTime(30);
      if (presence === "recovered") alive = true;
      jest.advanceTimersByTime(39);
      await flushPromises();
      expect(runner.state.state).toBe("running");
      jest.advanceTimersByTime(1);
      if (presence === "lost") {
        await flushPromises();
        expect(runner.state.steps[0]?.state).toBe("running");
        await new Promise<void>((resolve) => setImmediate(resolve));
        jest.advanceTimersByTime(9);
        await flushPromises();
        expect(runner.state.steps[0]?.state).toBe("running");
        expect(aborts).toBe(0);
        jest.advanceTimersByTime(1);
      }
      await run;
      expect(runner.state.steps[0]).toMatchObject({
        state: "failed", exitCode: null,
        failure: { kind: "timeout", minutes: 100 / 60_000 },
      });
      expect(runner.state.steps.slice(1).every((step) => step.state === "pending")).toBe(true);
      expect(aborts).toBe(1);
      // A late status cannot overwrite the failure already reported.
      child.stdout.end(); child.stderr.end(); child.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await flushPromises();
      expect(runner.state.state).toBe("failed");
      expect(runner.state.steps[0]?.failure?.kind).toBe("timeout");
      jest.advanceTimersByTime(100);
      await flushPromises();
      expect(aborts).toBe(1);
    } finally {
      child.stdout.end(); child.stderr.end(); child.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.useRealTimers(); spawn.mockRestore(); sameProcess.mockRestore(); identity.mockRestore();
    }
  });

  test("a lost child with no notification settles with real deadline timers", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough(),
    });
    let aborts = 0;
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => child) as unknown as typeof childProcess.spawn);
    const sameProcess = spyOn(pid, "sameProcess").mockReturnValue(false);
    const identity = spyOn(pid, "readStartIdentity").mockReturnValue("fixture-start");
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (_command, options) => real.run(["fixture"], { ...options, cwd: logDir, env: { TMPDIR: logDir } }),
      childAlive: real.childAlive,
      // The fake child's PID belongs to the test process; never signal it.
      abort: () => { aborts += 1; },
    }, { fetch: 100 }, 10);
    try {
      // The real deadline alone must settle this run.
      await runner.start(TARGET);
      expect(runner.state.steps[0]).toMatchObject({
        state: "failed", exitCode: null, failure: { kind: "timeout", minutes: 100 / 60_000 },
      });
      expect(runner.state.steps.slice(1).every((step) => step.state === "pending")).toBe(true);
      expect(aborts).toBe(1);
    } finally {
      child.stdout.end(); child.stderr.end(); child.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      spawn.mockRestore(); sameProcess.mockRestore(); identity.mockRestore();
    }
  }, 1_000);

  test.each([15, 25, 35, 85].flatMap((eventAt) => [0, 23].map((code) => [code, eventAt])))("exit %i delivered at %i ms keeps its exit status", async (code, eventAt) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, exitCode: null as number | null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    let alive = true;
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => child) as unknown as typeof childProcess.spawn);
    const sameProcess = spyOn(pid, "sameProcess").mockImplementation(() => alive);
    const identity = spyOn(pid, "readStartIdentity").mockReturnValue("fixture-start");
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (command, options) => command.includes("fetch") ? real.run(["fixture"], { ...options, cwd: logDir, env: { TMPDIR: logDir } }) : Promise.resolve(0),
      childAlive: real.childAlive,
    }, { fetch: 100 }, 10);
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      jest.advanceTimersByTime(10);
      await flushPromises();
      jest.advanceTimersByTime(5);
      alive = false;
      if (eventAt === 15) {
        child.exitCode = code;
        child.emit("exit", code, null);
      }
      jest.advanceTimersByTime(5);
      await flushPromises();
      // The PID is gone, but stdout/stderr still hold the run promise open.
      expect(runner.state.steps[0]?.state).toBe("running");
      if (eventAt > 15) {
        jest.advanceTimersByTime(eventAt - 20);
        await flushPromises();
        expect(runner.state.steps[0]?.state).toBe("running");
        child.exitCode = code;
        child.emit("exit", code, null);
      }
      jest.advanceTimersByTime(10);
      await flushPromises();
      // The recorded status wins even after several polls of a missing PID.
      expect(runner.state.steps[0]?.state).toBe("running");
      child.stdout.end("last output\n"); child.stderr.end();
      child.emit("close", code, null);
      await run;
      expect(runner.state.steps[0]).toMatchObject({
        state: code === 0 ? "done" : "failed", exitCode: code,
        failure: code === 0 ? null : { kind: "exit", code }, tail: ["last output"],
      });
      expect(runner.state.state).toBe(code === 0 ? "done" : "failed");
    } finally {
      child.stdout.destroy(); child.stderr.destroy();
      child.emit("close", code, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.useRealTimers(); spawn.mockRestore(); sameProcess.mockRestore(); identity.mockRestore();
    }
  });

  test.each(["closed", "draining"])("a signal with %s output is interrupted without an exit code", async (output) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, exitCode: null, signalCode: null as NodeJS.Signals | null,
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    let alive = true;
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => child) as unknown as typeof childProcess.spawn);
    const sameProcess = spyOn(pid, "sameProcess").mockImplementation(() => alive);
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (_command, options) => real.run(["fixture"], { ...options, cwd: logDir, env: { TMPDIR: logDir } }),
      childAlive: real.childAlive,
    }, { fetch: 100 }, 10);
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      jest.advanceTimersByTime(15);
      alive = false;
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      if (output === "closed") {
        child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGTERM");
        // Let run() settle before the next poll, as it does with empty pipes.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await flushPromises();
      }
      jest.advanceTimersByTime(5);
      await run;
      expect(runner.state.steps[0]).toMatchObject({ state: "failed", exitCode: null, failure: { kind: "interrupted" } });
      expect(runner.state.steps.slice(1).every((step) => step.state === "pending")).toBe(true);
    } finally {
      child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGTERM");
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.useRealTimers(); spawn.mockRestore(); sameProcess.mockRestore();
    }
  });

  test.each([0, 23])("a real child exiting %i records its final output and status", async (code) => {
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (command, options) => command.includes("fetch")
        ? real.run([process.execPath, "-e", `console.log("final output"); process.exit(${code});`], { ...options, cwd: logDir, env: { TMPDIR: logDir } })
        : Promise.resolve(0),
      childAlive: real.childAlive,
    }, { fetch: 5_000 }, 1);
    await runner.start(TARGET);
    expect(runner.state.steps[0]).toMatchObject({
      state: code === 0 ? "done" : "failed", exitCode: code,
      failure: code === 0 ? null : { kind: "exit", code }, tail: ["final output"],
    });
  });

  test.skipIf(process.platform !== "linux").each([0, 23])("a real child exiting %i before the deadline retains its queued status", async (code) => {
    const spawn = spyOn(childProcess, "spawn");
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (command, options) => command.includes("fetch")
        ? real.run([process.execPath, "-e", `console.log("final output"); process.exit(${code});`], { ...options, cwd: logDir, env: { TMPDIR: logDir } })
        : Promise.resolve(0),
      childAlive: real.childAlive,
    }, { fetch: 5_000 }, 10);
    let child: childProcess.ChildProcess | undefined;
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      child = spawn.mock.results[0]?.value as childProcess.ChildProcess | undefined;
      expect(child?.pid).toBeDefined();
      // Let the OS finish the child while JS cannot dispatch its exit event.
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const deadline = performance.now() + 5_000;
      while (pid.isAlive(child!.pid!) && performance.now() < deadline) Atomics.wait(pause, 0, 0, 5);
      expect(pid.isAlive(child!.pid!)).toBe(false);
      expect(child!.exitCode).toBeNull();
      for (let poll = 0; poll < 4; poll += 1) {
        jest.advanceTimersByTime(10);
        await flushPromises();
      }
      expect(runner.state.steps[0]?.state).toBe("running");
      // Cross the deadline and a polling interval before dispatching queued I/O.
      jest.advanceTimersByTime(5_000);
      await flushPromises();
      await run;
      expect(runner.state.steps[0]).toMatchObject({
        state: code === 0 ? "done" : "failed", exitCode: code,
        failure: code === 0 ? null : { kind: "exit", code }, tail: ["final output"],
      });
    } finally {
      jest.useRealTimers();
      // The only process this test may clean up is the child it just spawned.
      if (child?.pid && pid.isAlive(child.pid)) child.kill("SIGKILL");
      await new Promise<void>((resolve) => setImmediate(resolve));
      spawn.mockRestore();
    }
  });

  test.each([0, 23, null])("exit %p queued behind the deadline decides the step", async (code) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough(),
    });
    let alive = true;
    let aborts = 0;
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => child) as unknown as typeof childProcess.spawn);
    const sameProcess = spyOn(pid, "sameProcess").mockImplementation(() => alive);
    const identity = spyOn(pid, "readStartIdentity").mockReturnValue("fixture-start");
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (command, options) => command.includes("fetch")
        ? real.run(["fixture"], { ...options, cwd: logDir, env: { TMPDIR: logDir } })
        : Promise.resolve(0),
      childAlive: real.childAlive,
      abort: () => { aborts += 1; },
    }, { fetch: 100 }, 10);
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      alive = false;
      jest.advanceTimersByTime(100);
      await flushPromises();
      expect(runner.state.steps[0]?.state).toBe("running");
      expect(aborts).toBe(0);
      child.emit("exit", code, code === null ? "SIGTERM" : null);
      child.stdout.end("final output\n"); child.stderr.end();
      child.emit("close", code, code === null ? "SIGTERM" : null);
      await run;
      expect(runner.state.steps[0]).toMatchObject({
        state: code === 0 ? "done" : "failed", exitCode: code,
        failure: code === null ? { kind: "interrupted" } : code === 0 ? null : { kind: "exit", code },
        tail: ["final output"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(100);
      await flushPromises();
      expect(runner.state.state).toBe(code === 0 ? "done" : "failed");
      expect(aborts).toBe(0);
    } finally {
      child.stdout.end(); child.stderr.end(); child.emit("close", code, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.useRealTimers(); spawn.mockRestore(); sameProcess.mockRestore(); identity.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32")("a real child killed by a signal is interrupted", async () => {
    const real = realPorts(() => {});
    const { runner, logDir } = harness({}, {
      run: (_command, options) => real.run([process.execPath, "-e", 'process.kill(process.pid, "SIGTERM");'], { ...options, cwd: logDir, env: { TMPDIR: logDir } }),
      childAlive: real.childAlive,
    }, { fetch: 5_000 }, 1);
    await runner.start(TARGET);
    expect(runner.state.steps[0]).toMatchObject({ state: "failed", exitCode: null, failure: { kind: "interrupted" } });
  });

  test("late output from an interrupted run preserves the retry's completion record", async () => {
    const child = () => Object.assign(new EventEmitter(), { pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough() });
    const old = child(); const retry = child();
    const children = [old, retry];
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => children.shift()!) as unknown as typeof childProcess.spawn);
    const real = realPorts(() => {});
    const logDir = mkdtempSync(join(tmpdir(), "llv-self-update-retry-")); roots.push(logDir);
    const options = { cwd: logDir, env: { TMPDIR: logDir }, onLine: () => {} };
    const abandoned = real.run(["fixture"], options).catch((error: unknown) => error);
    old.emit("exit", null, "SIGTERM");
    const retried = real.run(["fixture"], options).catch((error: unknown) => error);
    try {
      expect(real.childAlive!()).toBe(true);
      old.stdout.end(); old.stderr.end(); old.emit("close", null, "SIGTERM");
      await abandoned;
      retry.emit("exit", null, "SIGTERM");
      expect(real.childAlive!()).toBe(false);
    } finally {
      old.stdout.end(); old.stderr.end(); old.emit("close", null, "SIGTERM");
      retry.stdout.end(); retry.stderr.end(); retry.emit("close", null, "SIGTERM");
      await Promise.all([abandoned, retried]);
      spawn.mockRestore();
    }
  });

  test("a retry waiting for CPU admission ignores the interrupted child's status", async () => {
    const child = () => Object.assign(new EventEmitter(), { pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough() });
    const old = child(); const retry = child();
    const children = [old, retry];
    const spawn = spyOn(childProcess, "spawn").mockImplementation((() => children.shift()!) as unknown as typeof childProcess.spawn);
    const previous = process.env.LLV_AGENT_CPU;
    process.env.LLV_AGENT_CPU = "off";
    let held = true;
    const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => held ? 90 : null, now: () => 0 });
    const real = realPorts(() => {}, { pressure: () => gate, pollMs: 5 });
    const logDir = mkdtempSync(join(tmpdir(), "llv-self-update-retry-")); roots.push(logDir);
    const options = { cwd: logDir, env: { TMPDIR: logDir }, onLine: () => {} };
    const abandoned = real.run(["fixture"], options).catch((error: unknown) => error);
    old.emit("exit", null, "SIGTERM");
    jest.useFakeTimers();
    const retried = real.run(["fixture"], { ...options, work: "update-package" });
    try {
      await flushPromises();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(real.childAlive!()).toBe(true);
      held = false;
      jest.advanceTimersByTime(5);
      await flushPromises();
      expect(spawn).toHaveBeenCalledTimes(2);
      old.stdout.end(); old.stderr.end(); old.emit("close", null, "SIGTERM");
      await abandoned;
      retry.emit("exit", 0, null);
      expect(real.childAlive!()).toBe(true);
      retry.stdout.end(); retry.stderr.end(); retry.emit("close", 0, null);
      expect(await retried).toBe(0);
    } finally {
      held = false; jest.advanceTimersByTime(5); await flushPromises();
      old.stdout.end(); old.stderr.end(); old.emit("close", null, "SIGTERM");
      retry.stdout.end(); retry.stderr.end(); retry.emit("close", 0, null);
      await Promise.all([abandoned, retried]);
      jest.useRealTimers(); spawn.mockRestore();
      if (previous === undefined) delete process.env.LLV_AGENT_CPU; else process.env.LLV_AGENT_CPU = previous;
    }
  });
});

describe("UpdateRunner", () => {
  test("runs the five steps in order and records durations", async () => {
    const { runner, calls, cwds } = harness({});
    await runner.start(TARGET);
    expect(runner.state.state).toBe("done");
    expect(runner.state.steps.map((step) => [step.name, step.state])).toEqual(STEP_NAMES.map((name) => [name, "done"]));
    expect(calls).toEqual([
      ["git", "fetch", "--no-tags", "/var/tmp/remote.git", "+refs/heads/main:refs/self-update/tip"],
      ["git", "worktree", "add", "--detach", RELEASE, TARGET],
      ["/opt/bun", "install", "--frozen-lockfile"],
      ["/opt/bun", "run", "build"],
    ]);
    expect(cwds).toEqual([CHECKOUT, CHECKOUT, RELEASE, RELEASE]);
    for (const step of runner.state.steps.slice(0, 4)) expect(step.durationMs).toBe(250);
    expect(runner.state.target).toBe(TARGET);
    expect(runner.state.finishedAt).not.toBeNull();
  });

  test("the running checkout is never installed into or built in; ready publishes the release", async () => {
    const { runner, published, cwds } = harness({});
    await runner.start(TARGET);
    expect(cwds.slice(2)).not.toContain(CHECKOUT);
    expect(runner.state.releaseDir).toBe(RELEASE);
    expect(published).toEqual([{ sha: TARGET, dir: RELEASE }]);
  });

  test("a release directory left by an earlier attempt is checked out in place", async () => {
    const { runner, calls, cwds } = harness({}, { exists: (path) => path === RELEASE });
    await runner.start(TARGET);
    expect(calls[1]).toEqual(["git", "checkout", "--detach", TARGET]);
    expect(cwds[1]).toBe(RELEASE);
  });

  test("a failed build publishes nothing", async () => {
    const { runner, published } = harness({ build: { exit: 1 } });
    await runner.start(TARGET);
    expect(published).toEqual([]);
  });

  test("stops at the first non-zero exit and leaves later steps pending", async () => {
    const { runner, calls } = harness({ build: { lines: ["Type error: nope"], exit: 1 } });
    await runner.start(TARGET);
    expect(runner.state.state).toBe("failed");
    const states = Object.fromEntries(runner.state.steps.map((step) => [step.name, step.state]));
    expect(states).toEqual({ fetch: "done", checkout: "done", install: "done", build: "failed", ready: "pending" });
    const build = runner.state.steps.find((step) => step.name === "build")!;
    expect(build.exitCode).toBe(1);
    expect(build.failure).toEqual({ kind: "exit", code: 1 });
    expect(build.tail).toEqual(["Type error: nope"]);
    expect(calls).toHaveLength(4);
  });

  test("keeps the last 40 lines in the tail and every line in the log file", async () => {
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
    const { runner, logDir } = harness({ install: { lines } });
    await runner.start(TARGET);
    const install = runner.state.steps.find((step) => step.name === "install")!;
    expect(install.tail).toHaveLength(40);
    expect(install.tail[0]).toBe("line 81");
    expect(install.tail[39]).toBe("line 120");
    const file = readFileSync(join(logDir, "install.log"), "utf8").trimEnd().split("\n");
    expect(file.filter((line) => line.startsWith("line "))).toHaveLength(120);
  });

  test("retry reruns from the failed step only", async () => {
    const scripts: Partial<Record<StepName, Script>> = { build: { exit: 1 } };
    const { runner, calls } = harness(scripts);
    await runner.start(TARGET);
    calls.length = 0;
    scripts.build = { exit: 0 };
    await runner.retry();
    expect(calls).toEqual([["/opt/bun", "run", "build"]]);
    expect(runner.state.state).toBe("done");
    expect(runner.state.target).toBe(TARGET);
  });

  test("retry is refused unless the update failed", async () => {
    const { runner } = harness({});
    await expect(runner.retry()).rejects.toThrow("not failed");
  });

  test("the memory guard fails install without spawning it", async () => {
    const { runner, calls, logDir } = harness({}, { memAvailableMb: () => 2_048 });
    await runner.start(TARGET);
    const install = runner.state.steps.find((step) => step.name === "install")!;
    expect(install.state).toBe("failed");
    expect(install.failure).toEqual({ kind: "memory", availableMb: 2048, neededMb: 4096 });
    expect(updateFailureDetail(runner.state)).toBe("Release install failed: only 2048 MB available; 4096 MB required");
    /* The sentence is for the log file; the surface words the fact. */
    expect(install.tail).toEqual([]);
    expect(readFileSync(join(logDir, "install.log"), "utf8")).toContain("Not enough free memory (2048 MB available, 4096 needed)");
    expect(calls.map(stepOf)).toEqual(["fetch", "checkout"]);
  });

  test("install and build carry release labels; git steps stay in the service", async () => {
    const work: (string | undefined)[][] = [];
    const { runner } = harness({}, { run: async (command, options) => { work.push([command[1], options.work]); return 0; } });
    await runner.start(TARGET);
    expect(work).toEqual(expect.arrayContaining([["install", "update-install"], ["run", "update-build"]]));
    expect(work.filter(([, label]) => label)).toHaveLength(2);
  });

  test("fetch fails when the fetched tip is not the target the check saw", async () => {
    const { runner, calls } = harness({}, { revParse: async () => "f".repeat(40) });
    await runner.start(TARGET);
    const fetch = runner.state.steps.find((step) => step.name === "fetch")!;
    expect(fetch.state).toBe("failed");
    expect(fetch.failure).toEqual({ kind: "remote-moved", expected: TARGET.slice(0, 7), fetched: "fffffff" });
    expect(fetch.tail).toEqual(["fetch ok"]);
    expect(calls).toHaveLength(1);
  });

  test.each([0, 1, 128])("an automatic frozen target requires a successful ancestry check (exit %s)", async (ancestryExit) => {
    const fetched = "f".repeat(40);
    const ancestry: string[][] = [];
    const { runner, published } = harness({}, {
      revParse: async (ref) => ref === "HEAD" ? TARGET : fetched,
      run: async (command, options) => {
        if (command.includes("merge-base")) {
          ancestry.push(command);
          expect(options.cwd).toBe(CHECKOUT);
          expect(options.lowPriority).toBe(true);
          return ancestryExit;
        }
        return 0;
      },
    });
    await runner.start(TARGET, { trigger: "auto" });
    expect(ancestry).toEqual([["git", "merge-base", "--is-ancestor", TARGET, fetched]]);
    expect(runner.state.state).toBe(ancestryExit === 0 ? "done" : "failed");
    if (ancestryExit === 0) expect(published).toEqual([{ sha: TARGET, dir: RELEASE }]);
    else {
      expect(published).toEqual([]);
      expect(runner.state.steps[0]?.failure).toEqual({ kind: "remote-moved", expected: TARGET.slice(0, 7), fetched: "fffffff" });
      expect(runner.state.steps[1]?.state).toBe("pending");
    }
  });

  test("ready fails when the build left no BUILD_ID, and publishes nothing", async () => {
    const { runner, published } = harness({}, { buildIdReadable: (dir) => dir !== RELEASE });
    await runner.start(TARGET);
    const ready = runner.state.steps.find((step) => step.name === "ready")!;
    expect(ready.state).toBe("failed");
    expect(ready.failure).toEqual({ kind: "build-id-missing" });
    expect(published).toEqual([]);
  });

  test("a run the web restart cut short reads back as failed at the step it was in", () => {
    const { runner } = harness({});
    const steps = runner.state.steps.map((step, index) => ({ ...step, state: index < 3 ? "done" as const : index === 3 ? "running" as const : "pending" as const }));
    runner.restore({ ...runner.state, state: "running", target: TARGET, steps });
    expect(runner.state.state).toBe("failed");
    expect(runner.state.steps.slice(0, 3).map((step) => [step.state, step.failure])).toEqual([["done", null], ["done", null], ["done", null]]);
    expect(runner.state.steps[4]?.state).toBe("pending");
    expect(runner.state.finishedAt).not.toBeNull();
    const build = runner.state.steps.find((step) => step.name === "build")!;
    expect(build.state).toBe("failed");
    expect(build.failure).toEqual({ kind: "interrupted" });
  });

  test("marks the running step while its command runs", async () => {
    let release: (code: number) => void = () => {};
    const seen: string[] = [];
    const { runner } = harness({}, {
      run: (command) => {
        if (!command.includes("fetch")) return Promise.resolve(0);
        return new Promise<number>((resolve) => { release = resolve; });
      },
    });
    const run = runner.start(TARGET);
    await Bun.sleep(5);
    seen.push(runner.state.state, runner.state.steps[0]!.state);
    release(0);
    await run;
    expect(seen).toEqual(["running", "running"]);
  });

  test("a stuck command settles in place at its deadline and can be retried", async () => {
    let release: (code: number) => void = () => {};
    let aborts = 0;
    let stuck = true;
    const { runner } = harness({}, {
      run: (command) => command.includes("fetch") && stuck
        ? new Promise<number>((resolve) => { release = resolve; })
        : Promise.resolve(0),
      abort: () => { aborts += 1; },
    }, { fetch: 10 });
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      jest.advanceTimersByTime(9);
      await flushPromises();
      expect(runner.state.state).toBe("running");
      expect(aborts).toBe(0);
      jest.advanceTimersByTime(1);
      await run;
      expect(aborts).toBe(1);
      expect(runner.state.state).toBe("failed");
      expect(runner.state.steps[0]?.failure).toEqual({ kind: "timeout", minutes: 10 / 60_000 });
      release(0);
      await flushPromises();
      expect(runner.state.state).toBe("failed");
      stuck = false;
      await runner.retry();
      expect(runner.state.state).toBe("done");
    } finally { release(0); jest.useRealTimers(); }
  });

  test("a vanished child interrupts the in-memory step without a web restart", async () => {
    let alive = true;
    let stuck = true;
    let release: (code: number) => void = () => {};
    const { runner } = harness({}, {
      run: (command) => command.includes("fetch") && stuck ? new Promise<number>((resolve) => { release = resolve; }) : Promise.resolve(0),
      childAlive: () => alive,
    }, { fetch: 10_000 }, 10);
    jest.useFakeTimers();
    try {
      const run = runner.start(TARGET);
      await flushPromises();
      jest.advanceTimersByTime(10);
      await flushPromises();
      expect(runner.state.state).toBe("running");
      jest.advanceTimersByTime(5);
      alive = false;
      jest.advanceTimersByTime(5);
      await run;
      expect(runner.state.state).toBe("failed");
      expect(runner.state.steps[0]).toMatchObject({ exitCode: null, failure: { kind: "interrupted" } });
      release(0);
      await flushPromises();
      expect(runner.state.state).toBe("failed");
      alive = true;
      stuck = false;
      await runner.retry();
      expect(runner.state.state).toBe("done");
    } finally { release(0); jest.useRealTimers(); }
  });

  test("automatic maintenance lowers priority while release preparation keeps priority", async () => {
    const priorities: Array<boolean | undefined> = [];
    const port = { run: async (_command: string[], options: { lowPriority?: boolean }) => { priorities.push(options.lowPriority); return 0; } } as Partial<StepPorts>;
    await harness({}, port).runner.start(TARGET);
    expect(priorities).toEqual([false, false, false, false]);
    priorities.length = 0;
    await harness({}, port).runner.start(TARGET, { trigger: "auto" });
    expect(priorities).toEqual([true, true, false, false]);
  });
});


/* A refused admission puts the previous pointer back and leaves the built
   directory. The same target then costs a pointer, never another build. */
describe("a release directory that already passed its ready check", () => {
  function built(overrides: Partial<StepPorts> = {}) {
    const base = mkdtempSync(join(tmpdir(), "llv-self-update-built-")); roots.push(base);
    const releasesDir = join(base, "releases"); const dir = releaseDirFor(releasesDir, TARGET);
    const calls: string[][] = []; const published: { sha: string; dir: string }[] = [];
    const real = realPorts(() => {});
    let head = TARGET; let memory = 8_192;
    const ports: StepPorts = {
      async run(command) {
        calls.push(command);
        // The build writes what the ready step reads.
        if (command.includes("worktree")) mkdirSync(dir, { recursive: true });
        if (command.includes("build")) { mkdirSync(join(dir, ".next"), { recursive: true }); writeFileSync(join(dir, ".next", "BUILD_ID"), "fixture"); }
        return 0;
      },
      memAvailableMb: () => memory, revParse: async (ref) => ref === "HEAD" ? head : TARGET,
      exists: existsSync, buildIdReadable: real.buildIdReadable, builtRevision: real.builtRevision, markBuilt: real.markBuilt,
      prepareExistingRelease: async () => null,
      publish: (release) => { published.push(release); }, now: () => 1_000, ...overrides,
    };
    const runner = () => new UpdateRunner({ checkout: CHECKOUT, remote: "/var/tmp/remote.git", branch: "main", bun: "/opt/bun", logDir: join(base, "logs"), releasesDir, env: { PATH: "/usr/bin" } }, ports, () => {});
    return { dir, calls, published, runner, setHead: (sha: string) => { head = sha; }, setMemory: (mb: number) => { memory = mb; } };
  }
  const commands = (calls: string[][]) => calls.map(stepOf);

  test("is published again without an install or a build, and without waiting for build memory", async () => {
    const h = built();
    await h.runner().start(TARGET);
    expect(commands(h.calls)).toEqual(["fetch", "checkout", "install", "build"]);
    expect(builtRevision(h.dir)).toBe(TARGET); expect(releaseBuilt(h.dir, TARGET)).toBe(true);
    h.calls.length = 0; h.setMemory(64);
    const again = h.runner(); await again.start(TARGET, { trigger: "auto" });
    expect(again.state.state).toBe("done");
    expect(commands(h.calls)).toEqual(["fetch", "checkout"]);
    expect(h.calls[1]).toEqual(["git", "checkout", "--detach", TARGET]);
    expect(again.state.steps.map((step) => [step.name, step.state])).toEqual(STEP_NAMES.map((name) => [name, "done"]));
    expect(h.published).toEqual([{ sha: TARGET, dir: h.dir }, { sha: TARGET, dir: h.dir }]);
    expect(readFileSync(again.logPath("build"), "utf8")).toContain("the build is reused");
  });

  test("is built again when its record names another commit, its HEAD moved or its build is gone", async () => {
    for (const change of ["other-commit", "head-moved", "build-gone"] as const) {
      const h = built();
      await h.runner().start(TARGET);
      h.calls.length = 0;
      if (change === "other-commit") writeFileSync(join(h.dir, ".next", "DELEGATUS_RELEASE_READY"), `${"b".repeat(40)}\n`);
      if (change === "build-gone") rmSync(join(h.dir, ".next", "BUILD_ID"));
      if (change === "head-moved") h.setHead("b".repeat(40));
      expect(releaseBuilt(h.dir, TARGET)).toBe(change === "head-moved");
      const again = h.runner(); await again.start(TARGET);
      expect(commands(h.calls)).toEqual(["fetch", "checkout", "install", "build"]);
      // The ready check still decides: a moved HEAD is refused after the build.
      expect(again.state.state).toBe(change === "head-moved" ? "failed" : "done");
    }
  });

  test("a build that starts withdraws the record of the earlier one", async () => {
    const h = built();
    await h.runner().start(TARGET);
    // The directory is no longer the build its record names, so it is built
    // again; that build fails and must leave no record behind.
    h.setHead("b".repeat(40));
    let failBuild = true;
    const failing = built({ run: async (command) => (command.includes("build") && failBuild ? 1 : 0), revParse: async () => TARGET });
    mkdirSync(join(failing.dir, ".next"), { recursive: true }); writeFileSync(join(failing.dir, ".next", "BUILD_ID"), "fixture");
    writeFileSync(join(failing.dir, ".next", "DELEGATUS_RELEASE_READY"), `${"b".repeat(40)}\n`);
    const runner = failing.runner(); await runner.start(TARGET);
    expect(runner.state.state).toBe("failed");
    expect(builtRevision(failing.dir)).toBeNull(); expect(releaseBuilt(failing.dir, TARGET)).toBe(false);
    failBuild = false; await runner.retry();
    expect(runner.state.state).toBe("done"); expect(builtRevision(failing.dir)).toBe(TARGET);
  });
});

/* The real runner behind install and build: heavy work is refused without CPU
   containment and waits for CPU pressure; git steps ask for neither. */
describe("release install and build admission", () => {
  const dir = () => { const base = mkdtempSync(join(tmpdir(), "llv-self-update-admission-")); roots.push(base); return base; };
  const available = { probe: () => ({ kind: "available" as const, systemdVersion: 255 }), runner: () => "" };
  async function withCpu<T>(ports: Parameters<typeof setCpuPortsForTests>[0], body: () => Promise<T>): Promise<T> {
    const previous = process.env.LLV_AGENT_CPU;
    process.env.LLV_AGENT_CPU = "auto";
    setCpuPortsForTests(ports);
    try { return await body(); }
    finally { setCpuPortsForTests(null); if (previous === undefined) delete process.env.LLV_AGENT_CPU; else process.env.LLV_AGENT_CPU = previous; }
  }
  /** A fake systemd-run on PATH that runs the command after `--`, so the wrapped launch needs no user manager. */
  function launch(base: string) {
    const bin = join(base, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "systemd-run"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$(dirname "$0")/args"\nwhile [[ "$1" != -- ]]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
    const marker = join(base, "ran");
    return { marker, argv: ["/bin/sh", "-c", `echo run >> "${marker}"`], env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: base } };
  }

  test("a missing CPU mechanism fails the step with its reason and starts no child; off opts out", async () => {
    const base = dir(); const { marker, argv, env } = launch(base);
    let probes = 0;
    const missing = { probe: () => { probes += 1; return { kind: "missing" as const, reason: "the systemd user manager is not running for this user" }; } };
    await withCpu(missing, async () => {
      const lines: string[] = [];
      await expect(realPorts(() => {}).run(argv, { cwd: base, env, onLine: (line) => lines.push(line), work: "update-build" }))
        .rejects.toThrow("CPU containment for agent work is unavailable: the systemd user manager is not running for this user. Set DELEGATUS_AGENT_CPU=off");
      expect(probes).toBe(1);
      expect(existsSync(marker)).toBe(false);
      // A step that is not heavy work (fetch, checkout) never asks.
      expect(await realPorts(() => {}).run(["/bin/true"], { cwd: base, env, onLine: () => {} })).toBe(0);
      expect(probes).toBe(1);
      process.env.LLV_AGENT_CPU = "off";
      expect(await realPorts(() => {}).run(argv, { cwd: base, env, onLine: () => {}, work: "update-build" })).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("run\n");
    });
  });

  test("the update records the refusal as the failed step's cause", async () => {
    const base = dir(); const { marker, argv, env } = launch(base);
    await withCpu({ probe: () => ({ kind: "missing", reason: "the systemd user manager does not delegate the cpu controller" }) }, async () => {
      const real = realPorts(() => {});
      const { runner } = harness({}, { run: (command, options) => options.work ? real.run(argv, { ...options, cwd: base, env }) : Promise.resolve(0) });
      await runner.start(TARGET);
      const install = runner.state.steps.find((step) => step.name === "install")!;
      expect(install.state).toBe("failed");
      expect(install.failure).toMatchObject({ kind: "error" });
      expect(install.tail.join("\n")).toContain("CPU containment for agent work is unavailable: the systemd user manager does not delegate the cpu controller");
      expect(runner.state.state).toBe("failed");
      expect(existsSync(marker)).toBe(false);
    });
  });

  test.each(["update-install", "update-build"])("%s starts ahead of pressure-held tests in a high-weight scope", async work => {
    const base = dir(); const { marker, argv, env } = launch(base);
    const held = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => 90, now: () => 0 });
    await withCpu(available, async () => {
      let reads = 0;
      const ports = realPorts(() => {}, { pressure: () => { reads++; return held; } });
      const done = ports.run(argv, { cwd: base, env, onLine: () => {}, work });
      try {
        expect(reads).toBe(0);
        expect(await done).toBe(0);
        expect(readFileSync(marker, "utf8")).toBe("run\n");
        const args = readFileSync(join(base, "bin", "args"), "utf8").split("\n");
        expect(args).toContain("--slice=delegatus-agents.slice");
        expect(args).toContain("CPUWeight=1000");
        expect(args.some(arg => arg.startsWith("CPUQuota="))).toBe(false);
      } finally { ports.abort(); await done; }
    });
  });

  test("package pressure admission starts no child; a recovered window starts the step once", async () => {
    const base = dir(); const { marker, argv, env } = launch(base);
    let pressure = 80; let clock = 0; let samples = 0;
    const gate = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => { samples += 1; return pressure; }, now: () => clock });
    await withCpu(available, async () => {
      const lines: string[] = [];
      const done = realPorts(() => {}, { pressure: () => gate, pollMs: 5 }).run(argv, { cwd: base, env, onLine: (line) => lines.push(line), work: "update-package" });
      await Bun.sleep(60);
      expect(existsSync(marker)).toBe(false);
      expect(lines).toEqual(["update-package held for CPU pressure since 1970-01-01T00:00:00.000Z (avg10 80% ≥ 30%)"]);
      clock = 120_000;
      await Bun.sleep(60);
      expect(existsSync(marker)).toBe(false);
      expect(lines[1]).toStartWith("update-package deferred by CPU pressure: held since 1970-01-01T00:00:00.000Z");
      pressure = 25; clock = 200_000; // between the thresholds the hold stays
      await Bun.sleep(60);
      pressure = 5; clock = 201_000;
      await Bun.sleep(60);
      expect(existsSync(marker)).toBe(false); // below 20% for less than ten seconds
      clock = 212_000;
      expect(await done).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("run\n");
      expect(samples).toBeGreaterThan(3);
    });
  });

  test("abort ends a held start without a child; a failed sample starts it at once", async () => {
    const base = dir(); const { marker, argv, env } = launch(base);
    await withCpu(available, async () => {
      const held = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => 90, now: Date.now });
      const ports = realPorts(() => {}, { pressure: () => held, pollMs: 60_000 });
      const waiting = ports.run(argv, { cwd: base, env, onLine: () => {}, work: "update-package" });
      await Bun.sleep(20);
      expect(ports.childAlive!()).toBe(true);
      ports.abort();
      expect(await waiting).toBe(143);
      expect(existsSync(marker)).toBe(false);
      const blind = new CpuPressureGate(DEFAULT_CPU_PRESSURE_POLICY, { sample: () => { throw new Error("EACCES"); }, now: Date.now });
      const lines: string[] = [];
      expect(await realPorts(() => {}, { pressure: () => blind }).run(argv, { cwd: base, env, onLine: (line) => lines.push(line), work: "update-package" })).toBe(0);
      expect(lines).toEqual([]);
      expect(readFileSync(marker, "utf8")).toBe("run\n");
      const args = readFileSync(join(base, "bin", "args"), "utf8").split("\n");
      for (const expected of ["--slice=delegatus-agents-work.slice", "CPUWeight=100", "CPUQuota=300%", "CPUQuotaPeriodSec=20ms"]) expect(args).toContain(expected);
    });
  });
});


test("checkout of an existing release directory restores deleted tracked files", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR!, "llv-release-restore-")); roots.push(root);
  const git = (args: string[], cwd = root) => {
    const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" }); expect(result.status).toBe(0); return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]); writeFileSync(join(root, "tracked.txt"), "recoverable"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "fixture"]);
  const target = git(["rev-parse", "HEAD"]); const releases = join(root, "releases"); const release = releaseDirFor(releases, target);
  git(["worktree", "add", "--detach", release]); rmSync(join(release, "tracked.txt"));
  const ports: StepPorts = {
    run: async (command, options) => {
      if (command[0] === "git" && command[1] === "checkout") git(command.slice(1), options.cwd);
      return 0;
    }, memAvailableMb: () => 8192, revParse: async () => target, exists: existsSync, buildIdReadable: () => true,
    now: Date.now, publish: () => {},
  };
  const runner = new UpdateRunner({ checkout: root, releasesDir: releases, remote: "fixture", branch: "main", bun: "bun", logDir: join(root, "logs"), env: {} }, ports, () => {});
  await runner.start(target);
  expect(runner.state.state).toBe("done"); expect(readFileSync(join(release, "tracked.txt"), "utf8")).toBe("recoverable");
});

test("retrying an existing release preserves tracked edits and untracked obstructions", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR!, "llv-release-preserve-")); roots.push(root);
  const git = (args: string[], cwd = root) => {
    const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "source.txt"), "committed source\n"); writeFileSync(join(root, ".gitignore"), "operator.local\n"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "fixture"]);
  const target = git(["rev-parse", "HEAD"]); const releases = join(root, "releases");
  const release = releaseDirFor(releases, target); git(["worktree", "add", "--detach", release]);
  writeFileSync(join(release, "source.txt"), "unique operator edit\n");
  writeFileSync(join(release, "obstructing.txt"), "keep this too\n");
  writeFileSync(join(release, "operator.local"), "ignored operator data\n");
  const ports: StepPorts = {
    run: async (command, options) => command.includes("checkout") ? (git(command.slice(1), options.cwd), 0) : 0,
    memAvailableMb: () => 8192, revParse: async () => target, exists: existsSync, buildIdReadable: () => true,
    now: Date.now, publish: () => {},
  };
  const runner = new UpdateRunner({ checkout: root, releasesDir: releases, remote: "fixture", branch: "main", bun: "bun", logDir: join(root, "logs"), env: {} }, ports, () => {});
  await runner.start(target);
  expect(runner.state.state).toBe("failed");
  expect(readFileSync(join(release, "source.txt"), "utf8")).toBe("unique operator edit\n");
  expect(readFileSync(join(release, "obstructing.txt"), "utf8")).toBe("keep this too\n");
  expect(readFileSync(join(release, "operator.local"), "utf8")).toBe("ignored operator data\n");
});
