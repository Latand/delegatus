import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STEP_NAMES, UpdateRunner, type StepName, type StepPorts } from "./steps";

const TARGET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

interface Script { lines?: string[]; exit?: number }

/* A stubbed spawn: each step's command is recognised by its argv and answers
   with scripted lines and an exit code. Nothing real runs. */
function harness(scripts: Partial<Record<StepName, Script>>, overrides: Partial<StepPorts> = {}) {
  const logDir = mkdtempSync("/var/tmp/self-update-steps-");
  roots.push(logDir);
  const calls: string[][] = [];
  let clock = 1_000;
  const ports: StepPorts = {
    async run(command, { onLine }) {
      calls.push(command);
      const step = stepOf(command);
      clock += 250;
      for (const line of scripts[step]?.lines ?? [`${step} ok`]) onLine(line);
      return scripts[step]?.exit ?? 0;
    },
    memAvailableMb: () => 8_192,
    revParse: async () => TARGET,
    buildIdReadable: () => true,
    now: () => clock,
    ...overrides,
  };
  const runner = new UpdateRunner(
    { checkout: "/var/tmp/checkout", remote: "/var/tmp/remote.git", branch: "main", bun: "/opt/bun", logDir, env: { PATH: "/usr/bin" } },
    ports,
    () => {},
  );
  return { runner, calls, logDir };
}

function stepOf(command: string[]): StepName {
  if (command.includes("fetch")) return "fetch";
  if (command.includes("checkout")) return "checkout";
  if (command.includes("install")) return "install";
  if (command.includes("build")) return "build";
  throw new Error(`unexpected command ${command.join(" ")}`);
}

describe("UpdateRunner", () => {
  test("runs the five steps in order and records durations", async () => {
    const { runner, calls } = harness({});
    await runner.start(TARGET);
    expect(runner.state.state).toBe("done");
    expect(runner.state.steps.map((step) => [step.name, step.state])).toEqual(STEP_NAMES.map((name) => [name, "done"]));
    expect(calls).toEqual([
      ["git", "fetch", "--no-tags", "/var/tmp/remote.git", "refs/heads/main:refs/self-update/tip"],
      ["git", "checkout", "--detach", TARGET],
      ["/opt/bun", "install", "--frozen-lockfile"],
      ["/opt/bun", "run", "build"],
    ]);
    for (const step of runner.state.steps.slice(0, 4)) expect(step.durationMs).toBe(250);
    expect(runner.state.target).toBe(TARGET);
    expect(runner.state.finishedAt).not.toBeNull();
  });

  test("stops at the first non-zero exit and leaves later steps pending", async () => {
    const { runner, calls } = harness({ build: { lines: ["Type error: nope"], exit: 1 } });
    await runner.start(TARGET);
    expect(runner.state.state).toBe("failed");
    const states = Object.fromEntries(runner.state.steps.map((step) => [step.name, step.state]));
    expect(states).toEqual({ fetch: "done", checkout: "done", install: "done", build: "failed", ready: "pending" });
    const build = runner.state.steps.find((step) => step.name === "build")!;
    expect(build.exitCode).toBe(1);
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
    const { runner, calls } = harness({}, { memAvailableMb: () => 2_048 });
    await runner.start(TARGET);
    const install = runner.state.steps.find((step) => step.name === "install")!;
    expect(install.state).toBe("failed");
    expect(install.tail).toEqual(["Not enough free memory (2048 MB available, 4096 needed)"]);
    expect(calls.map(stepOf)).toEqual(["fetch", "checkout"]);
  });

  test("fetch fails when the fetched tip is not the target the check saw", async () => {
    const { runner, calls } = harness({}, { revParse: async () => "f".repeat(40) });
    await runner.start(TARGET);
    const fetch = runner.state.steps.find((step) => step.name === "fetch")!;
    expect(fetch.state).toBe("failed");
    expect(fetch.tail.at(-1)).toBe("The remote moved since the last check. Check again.");
    expect(calls).toHaveLength(1);
  });

  test("ready fails when the build left no BUILD_ID", async () => {
    const { runner } = harness({}, { buildIdReadable: () => false });
    await runner.start(TARGET);
    const ready = runner.state.steps.find((step) => step.name === "ready")!;
    expect(ready.state).toBe("failed");
    expect(ready.tail.at(-1)).toBe(".next/BUILD_ID is missing after the build");
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
});
