import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtRevision, realPorts, releaseBuilt, UpdateRunner, type StepPorts } from "./steps";
import { releaseDirFor } from "./release";
import { CHECKOUT_STEPS as STEP_NAMES, type CheckoutStepName as StepName } from "./types";

const TARGET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const CHECKOUT = "/var/tmp/checkout";
const RELEASES = "/var/tmp/releases";
const RELEASE = `${RELEASES}/a1b2c3d4e5f6`;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

interface Script { lines?: string[]; exit?: number }

/* A stubbed spawn: each step's command is recognised by its argv and answers
   with scripted lines and an exit code. Nothing real runs. */
function harness(scripts: Partial<Record<StepName, Script>>, overrides: Partial<StepPorts> = {}, stepTimeoutMs?: Partial<Record<StepName, number>>, livenessPollMs?: number) {
  const logDir = mkdtempSync("/var/tmp/self-update-steps-");
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
    ...overrides,
  };
  const runner = new UpdateRunner(
    { checkout: CHECKOUT, remote: "/var/tmp/remote.git", branch: "main", bun: "/opt/bun", logDir, releasesDir: RELEASES, env: { PATH: "/usr/bin" }, stepTimeoutMs, livenessPollMs },
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
    /* The sentence is for the log file; the surface words the fact. */
    expect(install.tail).toEqual([]);
    expect(readFileSync(join(logDir, "install.log"), "utf8")).toContain("Not enough free memory (2048 MB available, 4096 needed)");
    expect(calls.map(stepOf)).toEqual(["fetch", "checkout"]);
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
    await runner.start(TARGET);
    expect(aborts).toBe(1);
    expect(runner.state.state).toBe("failed");
    expect(runner.state.steps[0]?.failure?.kind).toBe("timeout");
    release(0);
    await Bun.sleep(1);
    expect(runner.state.state).toBe("failed");
    stuck = false;
    await runner.retry();
    expect(runner.state.state).toBe("done");
  });

  test("a vanished child interrupts the in-memory step without a web restart", async () => {
    let alive = true;
    let stuck = true;
    let release: (code: number) => void = () => {};
    const { runner } = harness({}, {
      run: (command) => command.includes("fetch") && stuck ? new Promise<number>((resolve) => { release = resolve; }) : Promise.resolve(0),
      childAlive: () => alive,
    }, { fetch: 10_000 }, 10);
    const run = runner.start(TARGET);
    await Bun.sleep(1);
    alive = false;
    await run;
    expect(runner.state.state).toBe("failed");
    expect(runner.state.steps[0]?.failure).toEqual({ kind: "interrupted" });
    release(0);
    await Bun.sleep(1);
    expect(runner.state.state).toBe("failed");
    alive = true;
    stuck = false;
    await runner.retry();
    expect(runner.state.state).toBe("done");
  });

  test("only automatic builds ask spawned commands for lower priority", async () => {
    const priorities: Array<boolean | undefined> = [];
    const port = { run: async (_command: string[], options: { lowPriority?: boolean }) => { priorities.push(options.lowPriority); return 0; } } as Partial<StepPorts>;
    await harness({}, port).runner.start(TARGET);
    expect(priorities).toEqual([false, false, false, false]);
    priorities.length = 0;
    await harness({}, port).runner.start(TARGET, { trigger: "auto" });
    expect(priorities).toEqual([true, true, true, true]);
  });
});


/* A refused admission puts the previous pointer back and leaves the built
   directory. The same target then costs a pointer, never another build. */
describe("a release directory that already passed its ready check", () => {
  function built(overrides: Partial<StepPorts> = {}) {
    const base = mkdtempSync("/var/tmp/self-update-built-"); roots.push(base);
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
