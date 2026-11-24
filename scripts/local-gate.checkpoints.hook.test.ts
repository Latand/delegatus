import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "./local-gate";
import { createHookFixture } from "./local-gate.fixture";

const roots: string[] = [];
let activeHook: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
afterEach(async () => {
  const hook = activeHook;
  activeHook = undefined;
  if (hook) {
    // The gate-slot owner stops its services and waits for their cleanup.
    if (hook.exitCode === null && hook.signalCode === null) hook.kill();
    await hook.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 20_000);
const serviceTest = test.skipIf(process.platform !== "linux"
  || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0);

serviceTest("native pre-push resumes only equivalent green files after its deadline", async () => {
  const project = path.resolve(import.meta.dir, "..");
  const f = createHookFixture(project, roots, false, true, "repo", true);
  const scratch = f.tempRoot;
  // Match the production hook parent's admission classification.
  mkdirSync(path.join(f.dir, "scripts/gate-runner"));
  const origin = path.join(scratch, "origin.git");
  f.git("clone", "--bare", "--shared", ".", origin);
  f.git("remote", "add", "origin", origin);
  const marker = path.join(scratch, "samples");
  const interrupt = path.join(scratch, "interrupt");
  const waiting = path.join(scratch, "waiting");
  const loseManager = path.join(scratch, "lose-manager");
  const trigger = path.join(scratch, "change-during-file");
  const changedManager = path.join(scratch, "changed-manager");
  const env = isolatedEnvironment(path.join(scratch, "caller"), f.env);
  const bin = path.join(scratch, "bin"); mkdirSync(bin);
  const runner = Bun.which("systemd-run")!, busctl = Bun.which("busctl")!;
  const runnerShim = path.join(bin, "systemd-run"), busShim = path.join(bin, "busctl");
  const delegate = (file: string, executable: string, comment = "") =>
    writeFileSync(file, `#!/bin/sh\n# ${comment}\nexec "${executable}" "$@"\n`, { mode: 0o700 });
  delegate(runnerShim, runner);
  writeFileSync(busShim, `#!/bin/sh
test ! -e "${loseManager}" || exit 1
if [ -e "${changedManager}" ] && [ "$7" = GetNameOwner ]; then
  echo 's ":1.999999999"'
  exit 0
fi
exec "${busctl}" "$@"
`, { mode: 0o700 });
  env.PATH = bin + path.delimiter + env.PATH;
  env.LLV_GATE_CHECK_ENV = "CHECKPOINT_STEP_INPUT,HOME,TMPDIR,XDG_STATE_HOME,XDG_RUNTIME_DIR,CLAUDE_CODE_TMPDIR";
  // Advance only the admitted hook's clock, after the real comparator logs a
  // completed file. Its workers and the outer containment keep real clocks.
  writeFileSync(env.HOOK_CLOCK!, `import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const now = Date.now.bind(Date);
let expired = false;
Date.now = () => {
  if (!expired && existsSync(${JSON.stringify(interrupt)})) {
    try {
      const runtime = readFileSync(${JSON.stringify(marker + "-hook")}, "utf8").trimEnd().split("\\n").at(-1)!;
      const log = readFileSync(path.join(path.dirname(runtime), "touched-tests.log"), "utf8");
      expired = /^touched-tests: head file a\\.test\\.ts: .*; 0 failures; complete;/m.test(log);
    } catch { /* The comparator has yet to open the log. */ }
  }
  return now() + (expired ? 600_000 : 0);
};
`);
  writeFileSync(path.join(f.dir, "shims/bun"), `#!/bin/sh
case "$1" in
  scripts/privacy-publication-gate.ts|scripts/eslint-changes.ts) exit 0 ;;
  scripts/local-gate-tests.ts) printf '%s\\n' "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" >> "${marker}-hook" ;;
esac
exec "$LLV_GATE_BUN" "$@"
`);
  writeFileSync(path.join(f.dir, "shims/bunx"), "#!/bin/sh\nexit 0\n");
  for (const name of ["a", "b"]) writeFileSync(path.join(f.dir, `${name}.test.ts`), `
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("fixture contract", async () => {
  const { XDG_STATE_HOME: state, XDG_RUNTIME_DIR: runtime, CHECKPOINT_STEP_INPUT: input } = process.env;
  expect(readdirSync(state)).toEqual([]);
  expect(readdirSync(runtime)).toEqual([]);
  const unit = readFileSync("/proc/self/cgroup", "utf8").match(/delegatus-gate-[a-f0-9-]+\\.service/)?.[0];
  expect(unit).toBeDefined();
  ${name === "b" ? `if (existsSync(${JSON.stringify(trigger)})) writeFileSync(${JSON.stringify(changedManager)}, "");` : ""}
  appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ file: "${name}", state, runtime, input, unit }) + "\\n");
  ${name === "a" ? `if (existsSync(${JSON.stringify(interrupt)})) {
    while (!existsSync(${JSON.stringify(waiting)})) await Bun.sleep(10);
  }` : `if (existsSync(${JSON.stringify(interrupt)})) {
    writeFileSync(${JSON.stringify(waiting)}, "");
    await Bun.sleep(60_000);
  }
  process.exit(124);`}
});
`);
  f.git("config", "core.hooksPath", "/dev/null");
  f.git("add", "."); f.git("commit", "-m", "Independent checkpoint fixtures");
  let invocation = 0;
  const run = async (input = "first", deadline = false) => {
    const pool = path.join(scratch, `admission-${++invocation}`);
    mkdirSync(pool);
    const admissionFile = path.join(pool, "check-admission.sqlite");
    // An outer wall timer can interrupt the hook while it is disposing of
    // nested services. Give the owner a bounded execution budget and join it.
    const child = activeHook = Bun.spawn(["bash", "scripts/gate-slot.sh", "bash", ".githooks/pre-push"], {
      cwd: f.dir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...env, CHECKPOINT_STEP_INPUT: input, LLV_GATE_LOCK_DIR: pool,
        ...(deadline ? { LLV_GATE_PUSH_DEADLINE: String(Date.now() + 120_000) } : {}),
        LLV_OWNED_RUN_TIMEOUT_MS: "60000",
        LLV_CHECK_ADMISSION_FILE: admissionFile, LLV_GATE_CHECK_ADMISSION_FILE: admissionFile },
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (activeHook !== child) throw new Error("checkpoint hook was stopped during fixture cleanup");
    activeHook = undefined;
    const output = stdout + stderr;
    expect(status, output).toBe(deadline ? 75 : 1);
    expect(output).toContain("CPU admission for publication checks");
    if (deadline) expect(output).toMatch(/"touched tests" was still running .* and was stopped/);
    else expect(output).toContain("NEW b.test.ts");
    expect(output).not.toContain("reused complete green head file b.test.ts");
    return output;
  };
  const receiptDir = path.join(f.dir, ".git/delegatus-gate/head-files");
  const checkpoint = "reused complete green head file a.test.ts";
  const readRows = () => readFileSync(marker, "utf8").trim().split("\n").map(line => JSON.parse(line) as {
    file: string; state: string; runtime: string; input: string; unit: string;
  });
  const verifyCleanup = (rows: ReturnType<typeof readRows>, hookRoots: string[]) => {
    for (const field of ["state", "runtime"] as const) {
      expect(new Set(rows.map(row => row[field])).size).toBe(rows.length);
    }
    expect(new Set(hookRoots).size).toBe(hookRoots.length);
    const directories = [...hookRoots, ...rows.flatMap(row => [row.state, row.runtime, path.dirname(path.dirname(row.state))])];
    expect(directories.filter(directory => existsSync(directory))).toEqual([]);
    expect(new Set(rows.map(row => row.unit)).size).toBe(rows.length);
    for (const { unit } of rows) {
      const state = spawnSync("systemctl", ["--user", "show", "--property=LoadState", "--value", unit], { env, encoding: "utf8" });
      expect(state.stdout.trim(), state.stderr).toBe("not-found");
    }
  };
  const readHookRoots = () => readFileSync(marker + "-hook", "utf8").trim().split("\n");
  const expire = async () => {
    writeFileSync(interrupt, "");
    const output = await run("first", true);
    rmSync(interrupt);
    rmSync(waiting);
    expect(output).not.toContain(checkpoint);
    expect(output).toContain("head selected 2 files with 2 file workers");
    expect(output).toMatch(/head file a\.test\.ts: .*; 0 failures; complete/);
    expect(output).not.toContain("head file b.test.ts:");
    verifyCleanup(readRows().slice(-2), readHookRoots().slice(-2));
  };
  await expire();
  const [retained] = readdirSync(receiptDir);
  expect(readdirSync(receiptDir)).toEqual([retained!]);
  const bytes = readFileSync(path.join(receiptDir, retained!), "utf8");
  expect(JSON.parse(bytes).value.completed).toEqual(["a.test.ts"]);
  const warm = await run();
  expect(warm).toContain(checkpoint);
  expect(warm).toContain("head selected 1 files with 1 file workers");
  expect(readdirSync(receiptDir)).toEqual([retained!]);
  expect(readFileSync(path.join(receiptDir, retained!), "utf8")).toBe(bytes);
  expect(await run("second")).not.toContain(checkpoint);
  delegate(runnerShim, runner, "replacement executable bytes");
  expect(await run()).not.toContain(checkpoint);
  expect(await run()).toContain(checkpoint);
  const certified = readdirSync(receiptDir).sort();
  expect(certified).toHaveLength(3);
  // The worker still uses the real manager. An identity probe that cannot
  // verify the manager makes both reads and writes cold.
  writeFileSync(loseManager, "");
  expect(await run()).not.toContain(checkpoint);
  expect(readdirSync(receiptDir).sort()).toEqual(certified);
  rmSync(loseManager);
  // Keep tool bytes and transport identical while changing the observed
  // manager after the only fresh file starts.
  writeFileSync(trigger, "");
  const drift = await run();
  expect(drift).toContain(checkpoint);
  expect(drift).toContain("head checkpoint inputs changed during this run; fresh checks required");
  expect(readdirSync(receiptDir).sort()).toEqual(certified);

  // A cold file that finishes after the manager changes may report its test
  // result. A deadline during that invocation must leave no reusable receipt.
  rmSync(changedManager);
  rmSync(receiptDir, { recursive: true });
  await expire();
  expect(existsSync(receiptDir)).toBeFalse();
  rmSync(changedManager);
  rmSync(trigger);
  expect(await run()).not.toContain(checkpoint);

  const rows = readRows();
  expect(rows.filter(row => row.file === "a").map(row => row.input)).toEqual(["first", "second", "first", "first", "first", "first"]);
  expect(rows.filter(row => row.file === "b").map(row => row.input)).toEqual(["first", "first", "second", "first", "first", "first", "first", "first", "first"]);
  const hookRoots = readHookRoots();
  expect(hookRoots).toHaveLength(18);
  verifyCleanup(rows, hookRoots);
}, 240_000);
serviceTest.each(["declared gate variable", "BASH_ENV bytes"])("native pre-push rejects stale step passes after changing %s", input => {
  const project = path.resolve(import.meta.dir, "..");
  const f = createHookFixture(project, roots, false, false, "repo", true);
  const scratch = f.tempRoot;
  mkdirSync(path.join(f.dir, "scripts/gate-runner"));
  const origin = path.join(scratch, "origin.git");
  f.git("clone", "--bare", "--shared", ".", origin);
  f.git("remote", "add", "origin", origin);
  const marker = path.join(scratch, "samples");
  const startup = path.join(scratch, "startup.sh");
  const temporary = path.join(scratch, "tmp"); mkdirSync(temporary);
  const fromShell = input === "BASH_ENV bytes";
  const names = `${fromShell ? "BASH_ENV" : "LLV_GATE_REVIEW_MODE"},HOME,TMPDIR,XDG_STATE_HOME,XDG_RUNTIME_DIR`;
  writeFileSync(path.join(f.dir, "shims/bun"), `#!/bin/sh
case "$1" in scripts/privacy-publication-gate.ts|scripts/eslint-changes.ts) exit 0 ;; esac
exec "$LLV_GATE_BUN" "$@"
`);
  writeFileSync(path.join(f.dir, "shims/bunx"), "#!/bin/sh\nexit 0\n");
  for (const name of ["a", "b"]) writeFileSync(path.join(f.dir, `${name}.test.ts`), `
import { appendFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("fixture contract", () => {
  appendFileSync(${JSON.stringify(marker)}, "${name}\\n");
  ${name === "a" ? `expect(${fromShell ? "process.umask()" : "process.env.LLV_GATE_REVIEW_MODE"}).toBe(${fromShell ? '0o22' : '"green"'});` : ""}
});`);
  f.git("config", "core.hooksPath", "/dev/null");
  f.git("add", "."); f.git("commit", "-m", "Add whole-step checkpoint fixtures");

  let invocation = 0;
  const run = (mode: "green" | "red", freshCallerState = false) => {
    const caller = path.join(scratch, `caller-${++invocation}`);
    const env = isolatedEnvironment(caller, f.env);
    if (fromShell) writeFileSync(startup, mode === "green" ? "umask 022\n" : "umask 077\n");
    const admission = path.join(caller, "admission.sqlite");
    const result = spawnSync("bash", ["scripts/gate-slot.sh", "bash", ".githooks/pre-push"], {
      cwd: f.dir, encoding: "utf8", timeout: 45_000,
      env: { ...env, TMPDIR: temporary, LLV_GATE_CHECK_ENV: names,
        XDG_STATE_HOME: freshCallerState ? env.XDG_STATE_HOME : path.join(scratch, "state"),
        ...(fromShell ? { BASH_ENV: startup } : { LLV_GATE_REVIEW_MODE: mode }),
        LLV_GATE_LOCK_DIR: caller, LLV_CHECK_ADMISSION_FILE: admission, LLV_GATE_CHECK_ADMISSION_FILE: admission },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const samples = () => readFileSync(marker, "utf8").trim().split("\n").sort();
  const cold = run("red");
  expect(cold.status, cold.output).toBe(1);
  const failure = cold.output.split("\n").find(line => line.startsWith("NEW a.test.ts"));
  expect(failure).toBeDefined();

  const green = run("green"); expect(green.status, green.output).toBe(0);
  expect(green.output).toContain("head selected 2 files");
  const before = samples();
  const same = run("green"); expect(same.status, same.output).toBe(0);
  expect(same.output).toContain("touched tests: reused pass");
  expect(samples()).toEqual(before);

  const warm = run("red");
  expect(warm.status, warm.output).toBe(cold.status);
  expect(warm.output).toContain(failure!);
  expect(samples().filter(name => name === "a").length).toBeGreaterThan(before.filter(name => name === "a").length);

  const freshRoots = run("green", true);
  expect(freshRoots.status, freshRoots.output).toBe(0);
  expect(freshRoots.output).toContain("touched tests: reused pass");
}, 180_000);

serviceTest("local check-step invalidates warm and cold retries when BASH_ENV bytes change", () => {
  const project = path.resolve(import.meta.dir, "..");
  const f = createHookFixture(project, roots, false, false, "repo", true);
  const scratch = f.tempRoot;
  const origin = path.join(scratch, "origin.git");
  f.git("clone", "--bare", "--shared", ".", origin);
  f.git("remote", "add", "origin", origin);
  const marker = path.join(scratch, "samples");
  const startup = path.join(scratch, "external-bash-env");
  const env = isolatedEnvironment(path.join(scratch, "caller"), f.env);
  const bin = path.join(scratch, "bin"); mkdirSync(bin);
  const runner = Bun.which("systemd-run")!, busctl = Bun.which("busctl")!;
  const runnerShim = path.join(bin, "systemd-run"), busShim = path.join(bin, "busctl");
  writeFileSync(runnerShim, `#!/bin/sh\nexec "${runner}" "$@"\n`, { mode: 0o700 });
  writeFileSync(busShim, `#!/bin/sh\nexec "${busctl}" "$@"\n`, { mode: 0o700 });
  env.PATH = bin + path.delimiter + env.PATH;
  env.BASH_ENV = startup;
  env.LLV_GATE_CHECK_ENV = "BASH_ENV";
  writeFileSync(startup, "umask 022\n");
  writeFileSync(path.join(f.dir, "shims/bun"), '#!/bin/sh\nexec "$LLV_GATE_BUN" "$@"\n');
  writeFileSync(path.join(f.dir, "a.test.ts"), `
import { appendFileSync } from "node:fs";
import { expect, test } from "bun:test";
test("startup input affects this head file", () => {
  appendFileSync(${JSON.stringify(marker)}, "a:" + process.umask().toString(8) + "\\n");
});`);
  writeFileSync(path.join(f.dir, "b.test.ts"), `
import { appendFileSync } from "node:fs";
import { test } from "bun:test";
test("incomplete file", () => { appendFileSync(${JSON.stringify(marker)}, "b\\n"); process.exit(124); });`);
  f.git("config", "core.hooksPath", "/dev/null");
  f.git("add", "."); f.git("commit", "-m", "BASH_ENV checkpoint fixtures");
  const run = () => spawnSync(process.execPath, ["scripts/local-gate.ts", "check-step", "touched tests"], {
    cwd: f.dir, env, encoding: "utf8", timeout: 30_000,
  });
  const countA = () => readFileSync(marker, "utf8").split("\n").filter(value => value.startsWith("a:")).length;
  const first = run(); expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(readFileSync(marker, "utf8").split("\n").filter(value => value.startsWith("a:"))).toEqual(["a:22"]);
  const warm = run(); expect(warm.status, warm.stdout + warm.stderr).toBe(1);
  expect(warm.stdout + warm.stderr).toContain("reused complete green head file a.test.ts");
  expect(countA()).toBe(1);

  const beforeWarmChange = countA();
  writeFileSync(startup, "umask 077\n");
  const changedWarm = run(), changedOutput = changedWarm.stdout + changedWarm.stderr;
  expect(changedWarm.status, changedOutput).toBe(1);
  expect(changedOutput).not.toContain("reused complete green head file a.test.ts");
  expect(changedOutput).toContain("head file a.test.ts:");
  const afterWarmChange = countA();
  expect(afterWarmChange).toBeGreaterThan(beforeWarmChange);
  expect(readFileSync(marker, "utf8").split("\n").filter(value => value.startsWith("a:")).at(-1)).toBe("a:77");

  const cache = path.join(f.dir, ".git/delegatus-gate/head-files");
  rmSync(cache, { recursive: true, force: true });
  const beforeColdChange = countA();
  const changedCold = run(), coldOutput = changedCold.stdout + changedCold.stderr;
  expect(changedCold.status, coldOutput).toBe(1);
  expect(coldOutput).not.toContain("reused complete green head file");
  expect(coldOutput).toContain("head file a.test.ts:");
  expect(countA()).toBeGreaterThan(beforeColdChange);
  expect(readFileSync(marker, "utf8").split("\n").filter(value => value.startsWith("a:")).at(-1)).toBe("a:77");
}, 120_000);
