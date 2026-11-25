import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "./local-gate";
import { createHookFixture } from "./local-gate.fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const serviceTest = test.skipIf(process.platform !== "linux"
  || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0);

serviceTest.each(["declared gate variable", "BASH_ENV bytes"])("native pre-push rejects stale step passes after changing %s", input => {
  const project = path.resolve(import.meta.dir, "..");
  // The fixture confines its writes to the root it allocates; the
  // repository's siblings (origin, samples, caller state) share that root.
  const f = createHookFixture(project, roots, false, false, "repo");
  const scratch = path.dirname(f.dir);
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
  symlinkSync(path.join(import.meta.dir, "local-gate-tests.ts"), path.join(f.dir, "scripts/local-gate-tests.ts"));
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
  // The fixture confines its writes to the root it allocates; the
  // repository's siblings (origin, samples, caller state) share that root.
  const f = createHookFixture(project, roots, false, false, "repo");
  const scratch = path.dirname(f.dir);
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
  symlinkSync(path.join(import.meta.dir, "local-gate-tests.ts"), path.join(f.dir, "scripts/local-gate-tests.ts"));
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
