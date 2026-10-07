import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexFixture, discover, endingOf, fetchMain, gateTemporaryRoot, isolatedEnvironment, NATIVE_GROUP, NoVerdict, pinnedBunVersion, plan, pushDeadline, requiresMediaTools, runSteps, type PlanEnvironment, type PushDeadline, type Step } from "./local-gate";
import { nativeBatches } from "./verify-native-codex-runtime";
import { changedSinceBase } from "./ci-platform-scope";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(overrides: Partial<PlanEnvironment> = {}): PlanEnvironment {
  return { base: "base", existing: new Set(["src/example.ts", "src/example.test.ts", "src/example.integration.test.ts", "src/example.browser.test.tsx", "image.png", "package.json"]), tests: ["src/example.test.ts", "src/example.integration.test.ts", "src/example.browser.test.tsx"], skippedMedia: [], linux: false, runtime: false, native: false, linuxTests: ["src/platform.test.ts"], runtimeTests: ["scripts/runtime.test.ts"], codexVersions: ["0.154.0", "0.159.0"], ...overrides };
}
function fixtureGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]) delete clean[key];
  for (const key of Object.keys(clean)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete clean[key];
  return clean;
}
test("commit plan checks staged whitespace/privacy/lint and leaves types and tests to push", () => {
  const steps = plan("pre-commit", ["src/example.ts"], context());
  expect(steps.map(step => step.name)).toEqual(["staged whitespace", "privacy", "eslint"]);
  expect(steps[1]!.command).toContain("--require-known-values");
  expect(steps[1]!.command.slice(-2)).toEqual(["--paths", "src/example.ts"]);
  expect(steps[2]!.command).toEqual(["bun", "scripts/eslint-changes.ts", "--base", "base", "./src/example.ts"]);
  expect(steps[2]!.capped).toBeTrue();
});
test("push checks commits, types and all sibling test variants, excluding browsers and deleted files", () => {
  const steps = plan("pre-push", ["src/example.ts", "src/deleted.test.ts"], context());
  expect(steps.find(step => step.name === "privacy")!.command).toContain("--check-commits");
  const tests = steps.find(step => step.name === "touched tests")!;
  expect(tests.command).toEqual(["bun", "scripts/local-gate-tests.ts", "--base", "base", "./src/example.test.ts", "./src/example.integration.test.ts"]);
  expect(tests.isolated).toBeTrue();
  for (const step of steps.filter(step => step.command[1] === "test")) for (const file of step.command.slice(2)) expect(file).toMatch(/\.test\.[jt]sx?$/);
});
test("scoped heavy steps retain pin, host interpreter and both native fixture versions", () => {
  const steps = plan("pre-push", ["package.json"], context({ linux: true, runtime: true, native: true }));
  expect(steps.some(step => step.name === "Linux backend")).toBeTrue();
  expect(steps.find(step => step.name === "Viewer build")!.pinned).toBeTrue();
  expect(steps.find(step => step.name === "runtime host")!.pinned).toBeTrue();
  expect(steps.find(step => step.name === "runtime negative controls")!.pinned).toBeTrue();
  expect(steps.filter(step => step.selection === "--engine-only").map(step => step.codex)).toEqual(["0.154.0", "0.159.0"]);
  expect(steps.some(step => step.name === "supply chain")).toBeTrue();
  expect(plan("pre-push", ["src/example.ts"], context()).some(step => step.pinned)).toBeFalse();
});
test("native Codex runs its engine files once per version and its shared contracts once, as one group", () => {
  const steps = plan("pre-push", ["src/example.ts"], context({ native: true }));
  const native = steps.filter(step => step.group === NATIVE_GROUP);
  expect(native.map(step => [step.name, step.codex, step.selection, step.deferrable === true])).toEqual([
    ["native Codex 0.154.0", "0.154.0", "--engine-only", false],
    ["native Codex 0.159.0", "0.159.0", "--engine-only", false],
    ["native Codex shared contracts", "0.154.0", "--shared-only", true],
  ]);
  // One contiguous group: the runner starts all three at once.
  const first = steps.indexOf(native[0]!);
  expect(steps.slice(first, first + native.length)).toEqual(native);
  for (const step of native) expect(step).toMatchObject({ command: ["bun", "scripts/verify-native-codex-runtime.ts"], capped: true, isolated: true, pinned: true });
  expect(plan("pre-push", ["src/example.ts"], context()).some(step => step.group === NATIVE_GROUP)).toBeFalse();
});
test("the engine and shared selections are exactly the hosted job's selection, split by who starts Codex", () => {
  const all = nativeBatches().flat(), engine = nativeBatches("--engine-only").flat(), shared = nativeBatches("--shared-only").flat();
  expect(new Set(all).size).toBe(all.length);
  expect([...engine, ...shared].sort()).toEqual([...all].sort());
  const startsCodex = /NATIVE_CODEX_QUEUE_TEST_BINARY|LLV_CODEX_HISTORY_CLI|LLV_CODEX_BINARY/;
  // A shared file that starts the executable would be judged under one
  // version only: it belongs in the engine lists.
  for (const file of shared) expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(startsCodex);
  for (const file of engine) expect(readFileSync(path.join(root, file), "utf8"), file).toMatch(startsCodex);
});
test("only a caller's deadline bounds the push, and it must be a Unix time in milliseconds", () => {
  expect(pushDeadline({}, 1_000)).toBeNull();
  expect(pushDeadline({ LLV_GATE_PUSH_DEADLINE: "" }, 1_000)).toBeNull();
  expect(pushDeadline({ LLV_GATE_PUSH_DEADLINE: "5000" }, 1_000)).toEqual({ at: 5_000, startedAt: 1_000 });
  for (const bad of ["soon", "-1", "1.5"]) expect(() => pushDeadline({ LLV_GATE_PUSH_DEADLINE: bad }, 1_000)).toThrow("LLV_GATE_PUSH_DEADLINE");
});

function stepRunner(deadline: PushDeadline | null, scripts: (dir: string) => Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-steps-")); roots.push(dir);
  const lines: string[] = [], commands = scripts(dir);
  const run = (steps: Step[]) => runSteps("pre-push", steps, { root: dir, deadline, logDir: dir, say: line => lines.push(line),
    prepare: step => ({ command: ["bash", "-c", commands[step.name]!], env: process.env }) }).then(() => null, (caught: unknown) => caught);
  return { lines, run, dir };
}
const grouped = (name: string, deferrable = false): Step => ({ name, command: [], group: NATIVE_GROUP, ...(deferrable ? { deferrable } : {}) });
const soon = (ms: number): PushDeadline => ({ at: Date.now() + ms, startedAt: Date.now() });
function alive(pid: number): boolean {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}
/** Live processes whose command line names `needle`; read-only. */
function processesNaming(needle: string): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle) && alive(pid); } catch { return false; }
  });
}
function ownCgroup(): string {
  return readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
}
function scopeProcesses(scope: string): string[] {
  try { return readFileSync(path.join("/sys/fs/cgroup", scope, "cgroup.procs"), "utf8").split("\n").filter(Boolean); } catch { return []; }
}

test("a group's steps run at once and report each verdict", async () => {
  const runner = stepRunner(soon(60_000), () => ({ a: "sleep 1.5", b: "sleep 1.5", c: "sleep 1.5" }));
  const started = performance.now();
  expect(await runner.run([grouped("a"), grouped("b"), grouped("c", true)])).toBeNull();
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(runner.lines[0]).toBe(`pre-push: ${NATIVE_GROUP}`);
  for (const name of ["a", "b", "c"]) expect(runner.lines).toContainEqual(expect.stringMatching(new RegExp(`^pre-push: ${name}: passed in \\d+ s$`)));
}, 20_000);
test("a caller's deadline leaves a deferrable check to the hosted job and says so; a decisive one that finished keeps its verdict", async () => {
  const runner = stepRunner(soon(2_500), () => ({ engine: "sleep 0.5", tail: "sleep 60" }));
  const started = performance.now();
  expect(await runner.run([grouped("engine"), grouped("tail", true)])).toBeNull();
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: left to the hosted job: "tail" was stopped after it had run \d+ s, when the push budget of \d+ s ran out; its verdict comes from the "Bun runtime pin" workflow/));
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: engine: passed in \d+ s$/));
  expect(runner.lines.at(-1)).toBe("pre-push: passed; left to the hosted job: tail");
  // After the group's own marker, no verdict or deferral reads as a phase marker to the publication.
  for (const line of runner.lines.slice(1)) expect(line).not.toMatch(/^pre-push: [^;:]{1,60}$/);
}, 30_000);
test("without a caller's deadline nothing is stopped: a person's push waits for every verdict", async () => {
  const runner = stepRunner(null, () => ({ engine: "sleep 1", tail: "sleep 1" }));
  expect(await runner.run([grouped("engine"), grouped("tail", true)])).toBeNull();
  expect(runner.lines.filter(line => line.includes("hosted job"))).toEqual([]);
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: tail: passed in \d+ s$/));
}, 30_000);
test("a caller's deadline stops a decisive step and everything it started, with no verdict", async () => {
  const runner = stepRunner(soon(1_500), dir => ({ "touched tests": `sleep 60 & echo $! > '${dir}/helper.pid'; wait` }));
  const started = performance.now();
  const error = await runner.run([{ name: "touched tests", command: [] }]);
  expect(error).toBeInstanceOf(NoVerdict);
  expect((error as Error).message).toMatch(/^no verdict within the push budget of \d+ s: "touched tests" was still running after \d+ s and was stopped; nothing was judged$/);
  expect(performance.now() - started).toBeLessThan(15_000);
  const helper = Number(readFileSync(path.join(runner.dir, "helper.pid"), "utf8"));
  for (let wait = 0; wait < 40 && alive(helper); wait++) await Bun.sleep(50);
  expect(alive(helper)).toBeFalse();
  // A step the deadline already passed never starts.
  const lateRunner = stepRunner(soon(-1), dir => ({ "touched tests": `touch '${dir}/started'` }));
  const late = await lateRunner.run([{ name: "touched tests", command: [] }]);
  expect((late as Error).message).toContain('"touched tests" could not start');
  expect(existsSync(path.join(lateRunner.dir, "started"))).toBeFalse();
}, 30_000);
test("a red verdict in a group fails the push with its log, even while the long tail is deferred", async () => {
  const runner = stepRunner(soon(2_500), () => ({ "native Codex 0.154.0": "echo '(fail) installed Codex: adapter pagination [3.00ms]'; exit 1", tail: "sleep 60" }));
  const error = await runner.run([grouped("native Codex 0.154.0"), grouped("tail", true)]);
  expect((error as Error).message).toBe("native Codex 0.154.0 failed");
  expect(runner.lines).toContain("(fail) installed Codex: adapter pagination [3.00ms]");
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: native Codex 0\.154\.0: failed \(1\) after \d+ s$/));
}, 30_000);
test("a deadline that passed before a step starts prepares nothing, alone or in a group", async () => {
  const prepared: string[] = [];
  const runner = stepRunner(soon(-1), () => ({}));
  const prepare = (step: Step) => { prepared.push(step.name); return { command: ["true"], env: process.env }; };
  for (const steps of [[{ name: "touched tests", command: [] }], [grouped("native Codex 0.154.0"), grouped("tail", true)]]) {
    const error = await runSteps("pre-push", steps, { root: runner.dir, deadline: soon(-1), logDir: runner.dir, say: () => {}, prepare }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoVerdict);
    expect((error as Error).message).toContain(`"${steps[0]!.name}" could not start`);
  }
  expect(prepared).toEqual([]);
});
test("a cold fixture install held by machine admission ends at the deadline with a named missing verdict and no installer left", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-cold-")); roots.push(dir);
  writeFileSync(path.join(dir, "pressure"), "some avg10=99.00 avg60=99.00 avg300=99.00 total=1\n");
  // The real installer path: gate-slot holds it for CPU pressure, so npm never starts.
  const env = { ...process.env, LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_LOCK_DIR: dir, LLV_GATE_POLL_SECONDS: "0.2" };
  const cache = path.join(dir, "cold-cache");
  const lines: string[] = [];
  const started = performance.now();
  const error = await runSteps("pre-push", [grouped("native Codex 0.154.0"), grouped("native Codex shared contracts", true)], {
    root, deadline: soon(1_500), logDir: dir, say: line => lines.push(line),
    prepare: async (step, until) => ({ command: ["true", await codexFixture(root, cache, "0.154.0", until, env)], env: process.env }),
  }).then(() => null, (caught: unknown) => caught);
  expect(performance.now() - started).toBeLessThan(6_000);
  expect(error).toBeInstanceOf(NoVerdict);
  expect((error as Error).message).toMatch(/"native Codex 0\.154\.0" was stopped while it was being prepared after \d+ s; nothing was judged$/);
  expect(lines).toContainEqual(expect.stringMatching(/^pre-push: left to the hosted job: "native Codex shared contracts" was stopped while it was being prepared/));
  await Bun.sleep(200);
  expect(processesNaming(cache)).toEqual([]);
}, 30_000);
test("the fetch before planning ends at the deadline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-fetch-")); roots.push(dir);
  const remote = path.join(dir, "remote.git"), work = path.join(dir, "work");
  const env = fixtureGitEnv();
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  execFileSync("git", ["init", "-q", work], { env });
  // An upload-pack that never answers stands in for a remote that hangs.
  const hang = path.join(dir, "hang.sh");
  writeFileSync(hang, `#!/bin/sh\necho $$ > '${dir}/upload.pid'\nexec sleep 60\n`); chmodSync(hang, 0o755);
  execFileSync("git", ["-C", work, "remote", "add", "origin", remote], { env });
  execFileSync("git", ["-C", work, "config", "remote.origin.uploadpack", hang], { env });
  const started = performance.now();
  expect(await fetchMain(work, Date.now() + 1_000)).toBe("stopped");
  expect(performance.now() - started).toBeLessThan(5_000);
  const upload = Number(readFileSync(path.join(dir, "upload.pid"), "utf8"));
  for (let wait = 0; wait < 40 && alive(upload); wait++) await Bun.sleep(50);
  expect(alive(upload)).toBeFalse();
  expect(await fetchMain(work, Date.now() - 1)).toBe("stopped");
}, 20_000);
const userManager = process.platform === "linux" && Bun.which("systemd-run") !== null
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
test.skipIf(!userManager)("a stopped step's own work scope goes with it, helpers that left the tree included, and no other scope is touched", async () => {
  // A neighbour scope this run must leave alone.
  const neighbour = Bun.spawn({ cmd: ["systemd-run", "--user", "--scope", "-q", "--collect", "--", "sleep", "60"], stdio: ["ignore", "ignore", "ignore"] });
  try {
    // gate-slot as the step's own command, and gate-slot under a process that
    // stays in this hook's cgroup while the work runs in a run-*.scope.
    for (const wrapped of [false, true]) {
      const dir = mkdtempSync(path.join(tmpdir(), "gate-scope-")); roots.push(dir);
      writeFileSync(path.join(dir, "pressure"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n");
      const env = { ...process.env, LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_LOCK_DIR: dir };
      // One helper keeps the step's environment and one starts from an empty
      // one; both are reparented away from the step's process tree.
      const script = `cat /proc/$$/cgroup > '${dir}/scope'; ( sleep 60 & echo $! > '${dir}/kept.pid' ) ; ( env -i sleep 60 & echo $! > '${dir}/bare.pid' ) ; touch '${dir}/ready'; sleep 60`;
      const slot = ["bash", path.join(root, "scripts/gate-slot.sh"), "bash", "-c", script];
      const command = wrapped ? ["bash", "-c", `"$@"; exit $?`, "step", ...slot] : slot;
      const started = performance.now();
      const error = await runSteps("pre-push", [{ name: "touched tests", command: [] }], { root, deadline: soon(4_000), logDir: dir, say: () => {},
        prepare: () => ({ command, env }) }).then(() => null, (caught: unknown) => caught);
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(existsSync(path.join(dir, "ready")), "the work started before the deadline").toBeTrue();
      expect(error).toBeInstanceOf(NoVerdict);
      const scope = readFileSync(path.join(dir, "scope"), "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
      // The work ran in a scope of its own, which is the case the cleanup must reach.
      expect(scope).toMatch(/\.scope$/);
      expect(scope).not.toBe(ownCgroup());
      for (const helper of ["kept", "bare"]) expect(alive(Number(readFileSync(path.join(dir, `${helper}.pid`), "utf8"))), `${helper}, wrapped: ${wrapped}`).toBeFalse();
      expect(scopeProcesses(scope)).toEqual([]);
      expect(alive(neighbour.pid)).toBeTrue();
    }
  } finally {
    neighbour.kill("SIGKILL");
    await neighbour.exited;
  }
}, 40_000);
test("a root that refuses the stop is reported within the cleanup allowance, and the hook exits without waiting for it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-refused-")); roots.push(dir);
  const harness = path.join(dir, "harness.ts"), output = path.join(dir, "stderr"), rootPid = path.join(dir, "root.pid");
  // The hook's own ending, with SIGKILL refused for the step's root alone: the
  // stand-in for a child stuck in uninterruptible I/O.
  writeFileSync(harness, `import { readFileSync } from "node:fs";
import { endHook, runSteps } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
const kill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  if (signal === "SIGKILL" && String(pid) === readFileSync(${JSON.stringify(rootPid)}, "utf8").trim()) throw Object.assign(new Error("refused"), { code: "EPERM" });
  return kill(pid, signal);
}) as typeof process.kill;
const startedAt = Date.now();
await runSteps("pre-push", [{ name: "touched tests", command: [] }], { root: ${JSON.stringify(dir)}, deadline: { at: startedAt + 300, startedAt }, logDir: ${JSON.stringify(dir)}, say: () => {},
  prepare: () => ({ command: ["bash", "-c", "echo $$ > ${rootPid}; exec sleep 9"], env: process.env }) }).catch((error: unknown) => endHook("pre-push", error));
`);
  const started = performance.now();
  const hook = Bun.spawn({ cmd: [process.execPath, harness], cwd: dir, stdio: ["ignore", "ignore", Bun.file(output)] });
  const code = await hook.exited;
  const elapsed = performance.now() - started;
  const pid = Number(readFileSync(rootPid, "utf8"));
  try {
    // The deadline, the three-second cleanup allowance and Bun's start-up; never the child's own nine seconds.
    expect(elapsed).toBeLessThan(5_500);
    expect(code).toBe(1);
    const said = readFileSync(output, "utf8");
    expect(said).toContain(`pre-push: "touched tests" was stopped at the push deadline, but 1 of its processes (${pid}) are still running; stop them before pushing again; gate failed`);
    // A refusal, never a hook the budget stopped: the publication must not retry beside the survivor.
    const { hookBudgetStop } = await import("../src/lib/pipelines/git");
    expect(hookBudgetStop(said)).toBeNull();
    expect(alive(pid), "the survivor really was left running").toBeTrue();
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}, 30_000);
test("a native Codex group names its unfinished or failed version, never a member that passed", async () => {
  const { hookBudgetStop, publicationFailureCause, publicationInterruptionCause } = await import("../src/lib/pipelines/git");
  const dir = mkdtempSync(path.join(tmpdir(), "hook-group-")); roots.push(dir);
  const hook = async (scripts: Record<string, string>, budgetMs: number) => {
    const lines: string[] = [];
    const startedAt = Date.now();
    const members = ["native Codex 0.154.0", "native Codex 0.159.0", "native Codex shared contracts"]
      .map((name): Step => ({ name, command: [], group: NATIVE_GROUP, ...(name.endsWith("contracts") ? { deferrable: true } : {}) }));
    await runSteps("pre-push", members, { root: dir, deadline: { at: startedAt + budgetMs, startedAt }, logDir: dir, say: (line) => lines.push(line),
      prepare: (step) => ({ command: ["bash", "-c", scripts[step.name]!], env: process.env }) }).catch((error: unknown) => lines.push(endingOf("pre-push", error).line));
    return lines.join("\n");
  };
  // 0.154.0 and the shared contracts finish; 0.159.0 is still running at the deadline.
  const stopped = await hook({ "native Codex 0.154.0": "true", "native Codex 0.159.0": "sleep 60", "native Codex shared contracts": "true" }, 2_000);
  const stop = hookBudgetStop(stopped)!;
  expect(stop.check).toBe("native Codex 0.159.0");
  const interrupted = { step: "publishing the pipeline branch", code: 75, signal: null, durationMs: 2_000, outputTail: stopped, hookBudgetMs: 840_000, hookStoppedCheck: stop.check };
  expect(publicationInterruptionCause(interrupted)).toBe("the pre-push hook's 14-minute budget ran out before its \"native Codex 0.159.0\" check reached a verdict, and the push did not reach the remote");
  // Without the retained check, the group is named, still never a member that passed.
  expect(publicationInterruptionCause({ ...interrupted, hookStoppedCheck: undefined })).toContain(`"${NATIVE_GROUP}" phase`);
  // 0.159.0 fails while the others pass.
  const failed = await hook({ "native Codex 0.154.0": "true", "native Codex 0.159.0": "echo '(fail) installed Codex: adapter pagination [3.00ms]'; exit 1", "native Codex shared contracts": "true" }, 60_000);
  expect(hookBudgetStop(failed)).toBeNull();
  expect(publicationFailureCause({ step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1_000, outputTail: failed }))
    .toBe("the repository's pre-push hook failed in its \"native Codex 0.159.0\" phase (exit 1, 1 failing test, first: installed Codex: adapter pagination)");
}, 30_000);
test("Viewer route and layout inputs select build and served-runtime verification", () => {
  for (const file of ["src/app/page.tsx", "src/app/layout.tsx", "src/components/Viewer.tsx"]) {
    const discovered = discover(root, "HEAD", [file]);
    expect(discovered.runtime).toBeTrue();
    const steps = plan("pre-push", [file], discovered);
    expect(steps.some(step => step.name === "Viewer build")).toBeTrue();
    expect(steps.some(step => step.name === "Viewer runtime")).toBeTrue();
  }
  const doc = ["CONTRIBUTING.md"] as const;
  expect(plan("pre-push", doc, discover(root, "HEAD", doc)).some(step => step.pinned)).toBeFalse();
});
test("deleting the built root route or layout still selects runtime verification", () => {
  const deletedRoot = mkdtempSync(path.join(tmpdir(), "deleted-viewer-input-")); roots.push(deletedRoot);
  symlinkSync(path.join(root, ".github"), path.join(deletedRoot, ".github"), "dir");
  symlinkSync(path.join(root, "scripts"), path.join(deletedRoot, "scripts"), "dir");
  for (const file of ["src/app/page.tsx", "src/app/layout.tsx"]) {
    const discovered = discover(deletedRoot, "HEAD", [file]);
    expect(discovered.existing.has(file)).toBeFalse();
    expect(discovered.runtime).toBeTrue();
    expect(plan("pre-push", [file], discovered).some(step => step.name === "Viewer runtime")).toBeTrue();
  }
});
test("dependency candidate installs the frozen graph before later verification", () => {
  const steps = plan("pre-push", ["package.json"], context());
  expect(steps[0]?.name).toBe("frozen install");
  expect(steps[0]?.command).toEqual(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
});
test("media skipping is explicit and still checks commits when the whole diff is media", () => {
  const steps = plan("pre-push", ["image.png"], context({ skippedMedia: ["image.png"] }));
  const privacy = steps.find(step => step.name === "privacy")!.command;
  expect(privacy).not.toContain("image.png"); expect(privacy).toContain("--check-commits");
  expect(privacy.slice(-2)).toEqual(["--paths", "package.json"]);
});
test("state isolation replaces inherited roots and removes the live owner claim", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "gate-env-")); roots.push(sandbox);
  const env = isolatedEnvironment(sandbox, { GIT_DIR: "operator", GIT_INDEX_FILE: "operator", GIT_WORK_TREE: "operator", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", XDG_RUNTIME_DIR: sandbox, NODE_ENV: "test", HOME: "operator", LLV_STATE_DIR: "operator", LLV_STATE_OWNER: "viewer", LLV_INBOX_DIR: "operator" });
  for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR", "CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    expect(env[key]).toStartWith(sandbox + path.sep); expect(existsSync(env[key]!)).toBeTrue();
  }
  expect(env.LLV_STATE_OWNER).toBeUndefined(); expect(env.LLV_INBOX_DIR).toBeUndefined();
  for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) expect(env[key]).toBeUndefined();
  expect(env.LLV_GATE_LOCK_DIR).toBe("/var/tmp");
  expect(isolatedEnvironment(sandbox, { NODE_ENV: "test", LLV_GATE_LOCK_DIR: sandbox }).LLV_GATE_LOCK_DIR).toBe(sandbox);
});
test("scope uses executed import closure and the workflow test lists", () => {
  const doc = discover(root, "HEAD", ["CONTRIBUTING.md"]);
  expect([doc.linux, doc.runtime, doc.native]).toEqual([false, false, false]);
  const host = discover(root, "HEAD", ["src/runtime-host/main.ts"]);
  expect(host.runtime).toBeTrue();
  const native = discover(root, "HEAD", ["src/lib/runtime/nativeCodexQueue.ts"]);
  expect(native.native).toBeTrue();
  const linux = discover(root, "HEAD", ["src/lib/proc/index.ts"]);
  expect(linux.linux).toBe(process.platform === "linux");
  expect(linux.linuxTests).toContain("src/runtime-host/runtimeHostFence.test.ts");
  expect(host.runtimeTests).toContain("src/runtime-host/hostRehearsalRun.test.ts");
  expect(pinnedBunVersion("RUN npm install -g bun@1.4.0\nRUN npm install -g bun@1.4.0")).toBe("1.4.0");
  expect(() => pinnedBunVersion("bun@1.4.0")).toThrow();
  expect(() => pinnedBunVersion("npm install -g bun@1.4.0\nnpm install -g bun@1.3.3")).toThrow();
});

function hookFixture(realLint = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "hooks-e2e-")); roots.push(dir);
  for (const leaf of [".githooks", "scripts", "shims", ".github/workflows"]) mkdirSync(path.join(dir, leaf), { recursive: true });
  for (const hook of ["pre-commit", "pre-push"]) copyFileSync(path.join(root, ".githooks", hook), path.join(dir, ".githooks", hook));
  symlinkSync(path.join(root, "scripts/local-gate.ts"), path.join(dir, "scripts/local-gate.ts"));
  if (realLint) {
    symlinkSync(path.join(root, "scripts/eslint-changes.ts"), path.join(dir, "scripts/eslint-changes.ts"));
    symlinkSync(path.join(root, "eslint.config.mjs"), path.join(dir, "eslint.config.mjs"));
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  }
  for (const file of ["gate-slot.sh", "verify-native-codex-runtime.ts"]) copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  for (const file of ["platform-tests.yml", "bun-runtime.yml"]) copyFileSync(path.join(root, ".github/workflows", file), path.join(dir, ".github/workflows", file));
  const log = path.join(dir, "commands.jsonl");
  writeFileSync(path.join(dir, "record.ts"), `import { appendFileSync, mkdtempSync, rmSync } from "node:fs"; import { execFileSync } from "node:child_process"; import { tmpdir } from "node:os"; import path from "node:path"; const fixture = mkdtempSync(path.join(tmpdir(), "hook-child-git-")); try { execFileSync("git", ["init", "--bare", fixture], { stdio: "pipe" }); } finally { rmSync(fixture, { recursive: true, force: true }); } appendFileSync(process.env.HOOK_LOG!, JSON.stringify({ args: process.argv.slice(2), state: process.env.LLV_STATE_DIR, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, tmp: process.env.TMPDIR, known: process.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE, gitDir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, workTree: process.env.GIT_WORK_TREE, commonDir: process.env.GIT_COMMON_DIR, configCount: process.env.GIT_CONFIG_COUNT, configKey: process.env.GIT_CONFIG_KEY_0 }) + "\\n"); if (process.env.HOOK_FAIL && process.argv.includes(process.env.HOOK_FAIL)) process.exit(19);`);
  for (const name of ["bun", "bunx"]) {
    const shim = path.join(dir, "shims", name);
    writeFileSync(shim, '#!/bin/bash\nif [[ "$1" == scripts/local-gate.ts || ( "$1" == scripts/eslint-changes.ts && "$HOOK_REAL_LINT" == 1 ) ]]; then exec "$HOOK_BUN" "$@"; fi\nexec "$HOOK_BUN" "$HOOK_RECORD" "$@"\n'); chmodSync(shim, 0o755);
  }
  const env = { ...fixtureGitEnv(), PATH: `${path.join(dir, "shims")}:${process.env.PATH}`, HOOK_LOG: log, HOOK_RECORD: path.join(dir, "record.ts"), HOOK_BUN: process.execPath, LLV_GATE_LOCK_DIR: dir, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "noreply@example.invalid", LLV_SKIP_HOOKS: "0" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(dir, "package.json"), "{}"); writeFileSync(path.join(dir, "example.ts"), "export const value = 1;\n");
  writeFileSync(path.join(dir, "example.test.ts"), "// hook fixture\n"); git("add", "."); git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("config", "core.hooksPath", ".githooks");
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; state?: string; home?: string; config?: string; tmp?: string; known?: string; gitDir?: string; index?: string; workTree?: string; commonDir?: string; configCount?: string; configKey?: string });
  return { dir, env: { ...env, HOOK_REAL_LINT: realLint ? "1" : "0" }, git, calls };
}
for (const mode of ["pre-commit", "pre-push"] as const) test(`${mode} allows KanbanBoard baseline errors and rejects one added error by file/line`, () => {
  const f = hookFixture(true);
  const file = "src/components/kanban/KanbanBoard.tsx";
  mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true });
  const source = readFileSync(path.join(root, file), "utf8");
  writeFileSync(path.join(f.dir, file), source);
  f.git("add", file);
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "Kanban baseline"], { cwd: f.dir, env: f.env });
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}`);
  f.git("add", file);
  const run = () => spawnSync("bash", [`.githooks/${mode}`], { cwd: f.dir, env: f.env, encoding: "utf8" });
  const accepted = run();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toContain("0 errors introduced by this change");
  expect(accepted.stdout).toMatch(/[1-9]\d* errors already on the base in the changed files \(not blocking\)/);
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}\nexport const addedLintError: any = 1;\n`);
  f.git("add", file);
  const refused = run();
  expect(refused.status).not.toBe(0);
  expect(refused.stdout).toContain("1 errors introduced by this change");
  expect(refused.stderr).toMatch(/src\/components\/kanban\/KanbanBoard\.tsx:\d+:\d+ @typescript-eslint\/no-explicit-any/);
  writeFileSync(path.join(f.dir, file), `// Harmless line shift\n${source}`);
  f.git("add", file);
}, 120000);
test("real pre-commit hook checks staged source, stops failures, and supports the escape hatch", () => {
  const f = hookFixture(); writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts");
  const failed = spawnSync("git", ["commit", "-m", "blocked"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "scripts/eslint-changes.ts" }, encoding: "utf8" });
  expect(failed.status).not.toBe(0);
  expect(f.calls().some(call => call.args.includes("--paths") && call.args.includes("example.ts") && call.known?.endsWith("privacy-known-value-fingerprints.json"))).toBeTrue();
  expect(f.calls().some(call => call.args.includes("--check-commits"))).toBeFalse();
  f.git("commit", "-m", "accepted");
  writeFileSync(path.join(f.dir, "example.ts"), "export const value = 3;\n"); f.git("add", "example.ts");
  const skip = spawnSync("git", ["commit", "-m", "escape"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "scripts/eslint-changes.ts", LLV_SKIP_HOOKS: "1" } });
  expect(skip.status).toBe(0);
});
test("linked-worktree pre-commit clears Git selectors and preserves the complete shared config", () => {
  const f = hookFixture();
  const linkedRoot = mkdtempSync(path.join(tmpdir(), "linked-commit-")); roots.push(linkedRoot);
  const worktree = path.join(linkedRoot, "checkout");
  f.git("config", "core.bare", "false"); f.git("config", "core.worktree", f.dir); f.git("config", "core.hooksPath", ".githooks");
  f.git("worktree", "add", "-b", "linked-commit", worktree);
  const configPath = path.join(f.dir, ".git", "config");
  const before = readFileSync(configPath);
  writeFileSync(path.join(worktree, "example.ts"), "export const value = 2;\n");
  execFileSync("git", ["add", "example.ts"], { cwd: worktree, env: f.env });
  const linkedGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const linkedCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const adversarial = { ...f.env, GIT_DIR: linkedGitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: path.join(linkedGitDir, "index"), GIT_COMMON_DIR: linkedCommon, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "false" };
  const result = spawnSync("git", ["commit", "-m", "linked change"], { cwd: worktree, env: adversarial, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(readFileSync(configPath)).toEqual(before);
  const calls = f.calls();
  expect(calls.some(call => call.gitDir === undefined && call.index === undefined && call.workTree === undefined && call.commonDir === undefined && call.configCount === undefined && call.configKey === undefined)).toBeTrue();
});
test("pre-push hook resolves an explicit base and runs named touched tests in a sandbox", () => {
  const f = hookFixture(); writeFileSync(path.join(f.dir, "example.ts"), "export const value = 2;\n"); f.git("add", "example.ts"); f.git("commit", "-m", "change");
  expect(changedSinceBase(f.dir, "origin/main")).toEqual(["example.ts"]);
  const remote = mkdtempSync(path.join(tmpdir(), "hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe", env: f.env });
  execFileSync("git", ["--git-dir", remote, "fetch", f.dir, "origin/main:main"], { stdio: "pipe", env: f.env });
  f.git("remote", "add", "origin", remote);
  const result = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: f.dir, env: f.env, encoding: "utf8" });
  expect(result.status).toBe(0);
  const tests = f.calls().find(call => call.args[0] === "scripts/local-gate-tests.ts")!;
  expect(tests.args).toEqual(["scripts/local-gate-tests.ts", "--base", f.git("rev-parse", "HEAD^").toString().trim(), "./example.test.ts"]);
  expect(tests.gitDir).toBeUndefined(); expect(tests.index).toBeUndefined(); expect(tests.workTree).toBeUndefined(); expect(tests.commonDir).toBeUndefined();
  for (const key of ["state", "home", "config", "tmp"] as const) expect(tests[key]).toContain("delegatus-local-gate-");
  expect(existsSync(tests.state!)).toBeFalse();
  expect(f.calls().some(call => call.args.includes("--check-commits"))).toBeTrue();
  const rejected = spawnSync("git", ["push", "origin", "HEAD:blocked"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "tsc" }, encoding: "utf8" });
  expect(rejected.status).not.toBe(0);
});
test("linked-worktree pre-push clears Git selectors and preserves the complete shared config", () => {
  const f = hookFixture();
  const linkedRoot = mkdtempSync(path.join(tmpdir(), "linked-push-")); roots.push(linkedRoot);
  const worktree = path.join(linkedRoot, "checkout");
  f.git("config", "core.bare", "false"); f.git("config", "core.worktree", f.dir); f.git("config", "core.hooksPath", ".githooks");
  f.git("worktree", "add", "-b", "linked-push", worktree);
  const remote = mkdtempSync(path.join(tmpdir(), "linked-hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe", env: f.env });
  execFileSync("git", ["--git-dir", remote, "fetch", f.dir, "refs/heads/main:refs/heads/main"], { stdio: "pipe", env: f.env });
  f.git("remote", "add", "origin", remote);
  const configPath = path.join(f.dir, ".git", "config");
  const before = readFileSync(configPath);
  writeFileSync(path.join(worktree, "example.ts"), "export const value = 2;\n");
  execFileSync("git", ["add", "example.ts"], { cwd: worktree, env: f.env });
  execFileSync("git", ["commit", "-m", "linked push base"], { cwd: worktree, env: f.env, stdio: "pipe" });
  const linkedGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const linkedCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, env: f.env, encoding: "utf8" }).trim();
  const adversarial = { ...f.env, GIT_DIR: linkedGitDir, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: path.join(linkedGitDir, "index"), GIT_COMMON_DIR: linkedCommon, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "false" };
  const result = spawnSync("git", ["push", "origin", "HEAD:main"], { cwd: worktree, env: adversarial, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(readFileSync(configPath)).toEqual(before);
  expect(f.calls().some(call => call.gitDir === undefined && call.index === undefined && call.workTree === undefined && call.commonDir === undefined && call.configCount === undefined && call.configKey === undefined)).toBeTrue();
});

test("media deferral recognizes disguised raster magic without loading the privacy gate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-media-")); roots.push(dir);
  const disguised = path.join(dir, "capture.dat");
  writeFileSync(disguised, Buffer.from("89504e470d0a1a0a", "hex"));
  expect(requiresMediaTools(disguised)).toBeTrue();
  const text = path.join(dir, "note.md"); writeFileSync(text, "plain text");
  expect(requiresMediaTools(text)).toBeFalse();
});

test("the gate temp root cannot inherit a pipeline's operator scratch TMPDIR", () => {
  const original = process.env.TMPDIR;
  try {
    process.env.TMPDIR = path.join(tmpdir(), "operator-state", "scratch");
    expect(gateTemporaryRoot("linux")).toBe("/var/tmp");
    expect(gateTemporaryRoot("darwin")).toBe("/var/tmp");
  } finally {
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
  }
});
test("a push that changes nothing checks every pushed commit for privacy and runs no types or tests", () => {
  // Lane branch N commits behind main, stage changed nothing: the diff against
  // the merge base is empty whatever main has become since.
  const steps = plan("pre-push", [], context({ linux: true, runtime: true, native: true }));
  expect(steps.map(step => step.name)).toEqual(["privacy"]);
  expect(steps[0]!.command).toEqual(["bun", "scripts/privacy-publication-gate.ts", "--base", "base", "--require-known-values", "--check-commits"]);
  expect(discover(root, "HEAD", []).linux).toBeFalse();
});
test("a push that changes one document keeps privacy and leaves main's types and tests alone", () => {
  const existing = new Set(["docs/design/note.md"]);
  const steps = plan("pre-push", ["docs/design/note.md"], context({ existing }));
  expect(steps.map(step => step.name)).toEqual(["privacy"]);
  expect(steps[0]!.command).toContain("--check-commits");
  expect(discover(root, "HEAD", ["docs/design/note.md"]).linux).toBeFalse();
});
test("no changed code file skips types or its tests, alone or beside a document", () => {
  for (const files of [["src/example.ts"], ["docs/design/note.md", "src/example.ts"], ["src/example.test.ts"], ["package.json"], ["src/deleted.ts"]]) {
    const names = plan("pre-push", files, context({ existing: new Set([...context().existing, "docs/design/note.md"]) })).map(step => step.name);
    expect(names.slice(0, 2)).toEqual(files.includes("package.json") ? ["frozen install", "privacy"] : ["privacy", "types"]);
    expect(names).toContain("types");
    if (files.some(file => file.startsWith("src/example"))) expect(names).toContain("touched tests");
  }
});
test("platform tests are judged against the merge base, so a test main already fails never blocks", () => {
  const linux = plan("pre-push", ["src/example.ts"], context({ linux: true })).find(step => step.name === "Linux tests")!;
  expect(linux.command).toEqual(["bun", "scripts/local-gate-tests.ts", "--base", "base", "./src/platform.test.ts"]);
  expect(linux.isolated).toBeTrue();
});
test("gate checks never inherit the pushing Viewer's language, launcher handoff or token", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "gate-viewer-env-")); roots.push(sandbox);
  const env = isolatedEnvironment(sandbox, { NODE_ENV: "production", PATH: "/usr/bin", LLV_LANG: "uk", LLV_LAUNCHER_REEXEC: "1", LLV_LAUNCHER_CHECKOUT: "/checkout", LLV_TOKEN: "t", LLV_GATE_SLOTS: "2" });
  for (const key of ["LLV_LANG", "LLV_LAUNCHER_REEXEC", "LLV_LAUNCHER_CHECKOUT", "LLV_TOKEN"]) expect(env[key]).toBeUndefined();
  expect(env.LLV_GATE_SLOTS).toBe("2");
});
test("pre-push hook on a branch behind main that changed nothing runs privacy on the pushed commits and nothing else", () => {
  const f = hookFixture();
  const remote = mkdtempSync(path.join(tmpdir(), "hook-remote-")); roots.push(remote);
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe", env: f.env });
  f.git("remote", "add", "origin", remote);
  f.git("checkout", "-q", "-b", "lane");
  f.git("checkout", "-q", "main");
  for (const value of [2, 3]) { writeFileSync(path.join(f.dir, "example.ts"), `export const value = ${value};\n`); f.git("add", "example.ts"); f.git("-c", "core.hooksPath=/dev/null", "commit", "-m", `main ${value}`); }
  f.git("-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "main"); f.git("fetch", "-q", "origin", "main");
  f.git("checkout", "-q", "lane");
  expect(f.git("rev-list", "--count", "HEAD..origin/main").toString().trim()).toBe("2");
  // A types or test step would fail here: the recorder refuses tsc.
  const result = spawnSync("git", ["push", "origin", "HEAD:refs/heads/lane"], { cwd: f.dir, env: { ...f.env, HOOK_FAIL: "tsc" }, encoding: "utf8" });
  expect(result.stderr).toContain("pre-push: branch is 2 commit(s) behind origin/main");
  expect(result.stderr).toContain("pre-push: nothing changed since");
  expect(result.status).toBe(0);
  const calls = f.calls();
  expect(calls.map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(calls[0]!.args).toContain("--check-commits");
  expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/lane"], { encoding: "utf8", env: f.env }).trim()).toBe(f.git("rev-parse", "HEAD").toString().trim());
});
