import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexFixture, endingOf, fetchMain, NATIVE_GROUP, NoVerdict, runSteps, type Step } from "./local-gate";
import { fixtureGitEnv } from "./local-gate.fixture";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { recordFixtureIdentities, stepRunner, grouped, soon } = createGateTestFixtures(roots, owned);
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  expect((error as Error).message).toContain("native Codex 0.154.0");
  expect(runner.lines).toContain("(fail) installed Codex: adapter pagination [3.00ms]");
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: native Codex 0\.154\.0: failed \(1\)$/));
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

test("a successful grouped check retains its gate peak when ordinary output is hidden", async () => {
  const peak = "gate-slot: retained.service: pids.peak=37 pids.max=768 pids.events:max=0";
  const runner = stepRunner(null, () => ({ types: `echo ordinary-output; echo '${peak}' >&2` }));
  expect(await runner.run([grouped("types")])).toBeNull();
  expect(runner.lines.some(line => /^pre-push: types: passed in \d+ s; retained\.service: pids\.peak=37 pids\.max=768 pids\.events:max=0$/.test(line))).toBe(true);
  expect(runner.lines.join("\n")).not.toContain("ordinary-output");
});
test.skipIf(process.platform !== "linux")("a cold fixture install excludes CPU queue time and reaches its verdict after the original deadline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-cold-")); roots.push(dir);
  writeFileSync(path.join(dir, "pressure"), "some avg10=99.00 avg60=99.00 avg300=99.00 total=1\n");
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  const relative = `node_modules/@openai/codex-linux-${process.arch}/vendor/${process.arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl/bin`;
  writeFileSync(path.join(bin, "npm"), `#!/bin/bash\nwhile [[ "$1" != --prefix ]]; do shift; done\nshift\nmkdir -p "$1/${relative}"\nprintf fixture > "$1/${relative}/codex"\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DELEGATUS_CPU_PRESSURE: "on", DELEGATUS_AGENT_CPU: "off", LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_PSI_RELEASE_SECONDS: "0", LLV_GATE_LOCK_DIR: dir, LLV_GATE_POLL_SECONDS: "0.02" };
  const cache = path.join(dir, "cold-cache");
  const pending = runSteps("pre-push", [grouped("native Codex 0.154.0"), grouped("native Codex shared contracts", true)], {
    root, deadline: soon(1_500), logDir: dir, say: () => {},
    prepare: async (_step, until, cancel, waitEnv) => ({ command: ["true", await codexFixture(root, cache, "0.154.0", until, { ...env, LLV_CPU_WAIT_ROOTS: waitEnv!.LLV_CPU_WAIT_ROOTS }, cancel)], env }),
  });
  try {
    const { Database } = await import("bun:sqlite");
    let queued = false;
    for (let poll = 0; poll < 250 && !queued; poll++) {
      if (existsSync(path.join(dir, "admission.sqlite"))) {
        const db = new Database(path.join(dir, "admission.sqlite"), { readonly: true });
        try { queued = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tickets").get()!.n === 2; }
        catch { /* The waiting helper is still creating its queue schema. */ }
        finally { db.close(); }
      }
      if (!queued) await Bun.sleep(20);
    }
    expect(queued).toBe(true);
    await Bun.sleep(1_600);
    expect(existsSync(cache)).toBe(false);
    writeFileSync(path.join(dir, "pressure"), "some avg10=0.00 total=1\n");
    expect(await pending).toEqual([]);
    expect(processesNaming(cache)).toEqual([]);
  } finally { writeFileSync(path.join(dir, "pressure"), "some avg10=0.00 total=1\n"); await pending.catch(() => {}); }
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
  const neighbourDir = mkdtempSync(path.join(tmpdir(), "gate-neighbour-")); roots.push(neighbourDir);
  const neighbourFile = path.join(neighbourDir, "pid");
  // A scope launcher may expand dollars in argv before Bash sees them.
  const neighbourScript = path.join(neighbourDir, "run.sh");
  writeFileSync(neighbourScript, `echo $$ > '${neighbourFile}'; exec sleep 60`);
  const neighbour = Bun.spawn({ cmd: ["systemd-run", "--user", "--scope", "-q", "--collect", "--", "bash", neighbourScript], stdio: ["ignore", "ignore", "ignore"] });
  try {
    const [neighbourIdentity] = await recordFixtureIdentities([neighbourFile]);
    // Exercise actual transient scopes directly and below an intermediate.
    // gate-slot now owns a service; its lifetime is verified by owned-runner.
    for (const wrapped of [false, true]) {
      const dir = mkdtempSync(path.join(tmpdir(), "gate-scope-")); roots.push(dir);
      const env = { ...process.env };
      // One helper keeps the step's environment and one starts from an empty
      // one; both are reparented away from the step's process tree.
      const script = `echo $$ > '${dir}/root.pid'; cat /proc/$$/cgroup > '${dir}/scope'; ( sleep 60 & echo $! > '${dir}/kept.pid' ) ; ( env -i sleep 60 & echo $! > '${dir}/bare.pid' ) ; touch '${dir}/ready'; sleep 60`;
      const scriptFile = path.join(dir, "run.sh");
      writeFileSync(scriptFile, script);
      const scoped = ["systemd-run", "--user", "--scope", "-q", "--collect", "--", "bash", scriptFile];
      const command = wrapped ? ["bash", "-c", `"$@"; exit $?`, "step", ...scoped] : scoped;
      const started = performance.now();
      const pending = runSteps("pre-push", [{ name: "touched tests", command: [] }], { root, deadline: soon(4_000), logDir: dir, say: () => {},
        prepare: () => ({ command, env }) }).then(() => null, (caught: unknown) => caught);
      try { await recordFixtureIdentities(["root", "kept", "bare"].map(name => path.join(dir, `${name}.pid`))); }
      finally { await pending; }
      const error = await pending;
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
      expect(processIdentityStatus(neighbourIdentity!)).toBe("alive");
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
  const [identity] = await recordFixtureIdentities([rootPid]);
  const code = await hook.exited;
  const elapsed = performance.now() - started;
  const pid = identity!.pid;
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
    await stopFixtureIdentity(identity!);
  }
}, 30_000);
for (const budget of [null, 60_000]) test(`a group member that cannot be prepared stops the rest of its group before the hook exits (deadline: ${budget ?? "none"})`, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-prepare-")); roots.push(dir);
  const harness = path.join(dir, "harness.ts"), output = path.join(dir, "stderr");
  const pidFile = (name: string) => path.join(dir, `${name}.pid`);
  const helper = path.join(dir, "helper.ts"), helperExit = path.join(dir, "allow-helper-exit"), naturalExit = path.join(dir, "natural-exit");
  writeFileSync(helper, `import { existsSync, writeFileSync } from "node:fs";
    import { checkFixtureParent } from ${JSON.stringify(path.join(root, "src/lib/testing/fixtureLifetime.ts"))};
    while (!existsSync(${JSON.stringify(helperExit)})) { checkFixtureParent(); await Bun.sleep(20); }
    checkFixtureParent(); writeFileSync(${JSON.stringify(naturalExit)}, "released");`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = `echo $$ > ${quote(pidFile("root"))}; ${quote(process.execPath)} ${quote(helper)} & echo $! > ${quote(pidFile("helper"))}; wait`;
  // The helper can end only through cancellation or our supervising watchdog.
  writeFileSync(harness, `import { existsSync } from "node:fs";
import { NATIVE_GROUP, endHook, runSteps } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
const startedAt = Date.now(), budget = ${JSON.stringify(budget)};
const members = ["native Codex 0.154.0", "native Codex 0.159.0"].map(name => ({ name, command: [], group: NATIVE_GROUP }));
await runSteps("pre-push", members, { root: ${JSON.stringify(dir)}, deadline: budget === null ? null : { at: startedAt + budget, startedAt }, logDir: ${JSON.stringify(dir)},
  prepare: async step => {
    if (step.name.endsWith("0.154.0")) return { command: ["bash", "-c", ${JSON.stringify(command)}], env: process.env };
    while (!existsSync(${JSON.stringify(path.join(dir, "release"))})) await Bun.sleep(10);
    throw new Error("installing @openai/codex@0.159.0 failed (1)");
  } }).catch((error: unknown) => endHook("pre-push", error));
`);
  const hook = Bun.spawn({ cmd: [process.execPath, harness], cwd: dir, stdio: ["ignore", "ignore", Bun.file(output)] });
  const hookIdentity = captureProcessIdentity(hook.pid); owned.push(hookIdentity);
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    writeFileSync(helperExit, "supervising deadline");
    writeFileSync(path.join(dir, "release"), "ready");
  }, 20_000);
  let identities: ProcessIdentity[] = [];
  try {
    identities = await recordFixtureIdentities(["root", "helper"].map(pidFile), 20_000);
    writeFileSync(path.join(dir, "release"), "ready");
    const code = await hook.exited;
    const pids = identities.map(identity => identity.pid);
    expect(watchdogExpired).toBe(false);
    expect(existsSync(naturalExit), "cancellation ended the helper before its release").toBe(false);
    expect(code).toBe(1);
    // Nothing the running member started outlives the hook.
    for (const pid of pids) expect(alive(pid), String(pid)).toBeFalse();
    const said = readFileSync(output, "utf8");
    expect(said).toContain("pre-push: native Codex 0.159.0: failed (installing @openai/codex@0.159.0 failed (1))");
    expect(said).toContain('pre-push: native Codex 0.154.0: stopped when "native Codex 0.159.0" failed; nothing was judged');
    expect(said.trimEnd().split("\n").at(-1)).toBe('pre-push: "native Codex 0.159.0" failed: installing @openai/codex@0.159.0 failed (1); gate failed');
    // The publication names the member that failed, and reads a refusal, never a budget stop.
    const { hookBudgetStop, publicationFailurePhase } = await import("../src/lib/pipelines/git");
    expect(publicationFailurePhase({ step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1_000, outputTail: said })).toBe("native Codex 0.159.0");
    expect(hookBudgetStop(said)).toBeNull();
  } finally {
    clearTimeout(watchdog);
    writeFileSync(helperExit, "cleanup");
    writeFileSync(path.join(dir, "release"), "ready");
    await stopFixtureIdentity(hookIdentity);
    await hook.exited;
    for (const identity of identities) await stopFixtureIdentity(identity);
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
