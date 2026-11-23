import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";

// A machine without /proc (macOS): every read under it fails the way a
// missing path does, and `ps` can be taken away as well.
const real = { ...fs }, realChild = { ...childProcess };
const missing = (target: unknown) => typeof target === "string" && (target === "/proc" || target.startsWith("/proc/"));
const absent = (target: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), { code: "ENOENT" });
let psBroken = false;
let psAttempts: { timeout?: number; error?: string }[] | undefined;
// Lifetime authority reads the real machine, outside the missing-/proc fault
// injected into the gate. Capture synchronously while the reported child lives.
let lifetimeProbe = false;
mock.module("node:fs", () => ({
  ...real,
  readFileSync: (target: string, ...rest: unknown[]) => { if (!lifetimeProbe && missing(target)) throw absent(target); return (real.readFileSync as (...args: unknown[]) => unknown)(target, ...rest); },
  readdirSync: (target: string, ...rest: unknown[]) => { if (!lifetimeProbe && missing(target)) throw absent(target); return (real.readdirSync as (...args: unknown[]) => unknown)(target, ...rest); },
}));
mock.module("node:child_process", () => ({
  ...realChild,
  spawnSync: (command: string, ...rest: unknown[]) => {
    const gatePs = !lifetimeProbe && command === "ps";
    if (gatePs && psBroken) return { status: null, stdout: "", stderr: "", error: absent(command) };
    const result = (realChild.spawnSync as (...args: unknown[]) => ReturnType<typeof childProcess.spawnSync>)(command, ...rest);
    if (gatePs) psAttempts?.push({
      timeout: (rest[1] as childProcess.SpawnSyncOptions | undefined)?.timeout,
      error: (result.error as NodeJS.ErrnoException | undefined)?.code,
    });
    return result;
  },
}));
const { ContainmentFailed, NoVerdict, runSteps } = await import("./local-gate");

const roots: string[] = [], started: ProcessIdentity[] = [];
const spawn = Bun.spawn;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const child = Reflect.apply(spawn, Bun, args) as ReturnType<typeof Bun.spawn>;
    children.push(child);
    return child;
  }) as typeof Bun.spawn;
});
afterEach(async () => {
  Bun.spawn = spawn;
  psBroken = false;
  lifetimeProbe = true;
  try { for (const identity of started.splice(0)) await stopFixtureIdentity(identity); }
  finally { lifetimeProbe = false; }
  // A deadline stop with failed process-table evidence may unref its root.
  // Reap the original handle before the preload checks for surviving children.
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500);
    try {
      await Promise.race([child.exited, Bun.sleep(2_000).then(() => {
        throw new Error("owned deadline fixture did not reap its root");
      })]);
    } finally { clearTimeout(force); }
  }
  for (const dir of roots.splice(0)) real.rmSync(dir, { recursive: true, force: true });
});
/** Signal 0 and ps, the two things this machine still has. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const state = realChild.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
}
async function gone(pid: number): Promise<boolean> {
  for (let wait = 0; wait < 40 && running(pid); wait++) await Bun.sleep(50);
  return !running(pid);
}
async function stoppedStep(dir: string, cancel?: AbortController) {
  const at = performance.now();
  const startedAt = Date.now();
  const deadline = cancel ? null : { at: startedAt + 1_000, startedAt };
  // The root and a helper it started, which must go with it.
  const file = path.join(dir, "processes");
  const script = "sleep 60 & printf '%s %s\\n' \"$$\" \"$!\" > \"$1\"; wait";
  const pending = runSteps("pre-push", [{ name: "touched tests", command: [] }], { root: dir, deadline, cancel: cancel?.signal, logDir: dir, say: () => {},
    prepare: () => ({ command: ["bash", "-c", script, "gate-noproc-fixture", file], env: process.env }) }).then(() => null, (caught: unknown) => caught);
  const until = deadline?.at ?? startedAt + 20_000;
  let pids: number[] = [];
  try {
    let ready: RegExpExecArray | null = null;
    while (!ready && Date.now() < until) {
      if (real.existsSync(file)) ready = /^([1-9]\d*) ([1-9]\d*)\n$/.exec(real.readFileSync(file, "utf8"));
      if (!ready) await Bun.sleep(10);
    }
    if (!ready) throw new Error("fixture did not report both process identities");
    pids = [Number(ready[1]), Number(ready[2])];
    lifetimeProbe = true;
    try {
      for (const pid of pids) {
        const identity = captureProcessIdentity(pid);
        started.push(identity);
        expect(processIdentityStatus(identity), "fixture reported with live PID/start/boot identity").toBe("alive");
      }
    } finally { lifetimeProbe = false; }
  } finally {
    cancel?.abort();
    await pending;
  }
  const error = await pending;
  return { error, elapsed: performance.now() - at, pids };
}

test("without /proc a stopped step's root and helper are proven gone through signal 0 and ps", async () => {
  expect(() => fs.readdirSync("/proc")).toThrow("ENOENT");
  const dir = real.mkdtempSync(path.join(tmpdir(), "gate-noproc-")); roots.push(dir);
  const { error, elapsed, pids } = await stoppedStep(dir);
  // The deadline and the cleanup allowance, never the step's own sixty seconds.
  expect(elapsed).toBeLessThan(4_500);
  expect(error).toBeInstanceOf(NoVerdict);
  expect((error as Error).message).toMatch(/"touched tests" was still running after \d+ s and was stopped; nothing was judged$/);
  for (const pid of pids) expect(await gone(pid), String(pid)).toBeTrue();
}, 30_000);
test("without /proc cancellation finds a nested step token outside the process tree", async () => {
  const dir = real.mkdtempSync(path.join(tmpdir(), "gate-noproc-nested-")); roots.push(dir);
  const tokenFile = path.join(dir, "token");
  const cancel = new AbortController();
  const pending = runSteps("pre-push", [{ name: "touched tests", command: [] }], {
    root: dir, deadline: null, logDir: dir, say: () => {}, cancel: cancel.signal,
    prepare: () => ({ env: process.env, command: [
      "bash", "-c", 'printf "%s" "$LLV_GATE_STEP" > "$1.tmp"; mv "$1.tmp" "$1"; exec sleep 60', "step", tokenFile,
    ] }),
  });
  try {
    const readyBy = Date.now() + 5_000;
    while (!real.existsSync(tokenFile) && Date.now() < readyBy) await Bun.sleep(10);
    const inherited = real.readFileSync(tokenFile, "utf8");
    const helper = Bun.spawn(["sleep", "60"], {
      env: { ...process.env, LLV_GATE_STEP: `${inherited},nested-fixture` }, stdio: ["ignore", "ignore", "ignore"],
    });
    expect(running(helper.pid)).toBeTrue();
    cancel.abort();
    await pending;
    expect(await gone(helper.pid)).toBeTrue();
  } finally {
    cancel.abort();
    await pending;
  }
}, 30_000);
test("with neither /proc nor ps the stop says it could not find the step's processes, never that they stopped", async () => {
  psBroken = true;
  const dir = real.mkdtempSync(path.join(tmpdir(), "gate-noproc-")); roots.push(dir);
  const { error, elapsed } = await stoppedStep(dir);
  expect(elapsed).toBeLessThan(4_500);
  expect(error).toBeInstanceOf(ContainmentFailed);
  expect((error as Error).message).toBe('"touched tests" was stopped at the push deadline, but the processes it started could not be listed (no /proc, and ps failed), so they could not be proven stopped; stop them before pushing again');
}, 30_000);
test("a ps that answers slowly is cut off by the cleanup allowance, and the stop says what it could not prove", async () => {
  const dir = real.mkdtempSync(path.join(tmpdir(), "gate-noproc-")); roots.push(dir);
  // The ps shim itself is the slow process. Replacing it with sleep means
  // spawnSync's timeout owns and reaps it without leaving a shell descendant.
  const slow = path.join(dir, "bin"); real.mkdirSync(slow);
  real.writeFileSync(path.join(slow, "ps"), `#!/bin/sh\nexec ${Bun.which("sleep")} 60\n`, { mode: 0o755 });
  const searched = process.env.PATH;
  process.env.PATH = `${slow}${path.delimiter}${searched}`;
  const attempts: NonNullable<typeof psAttempts> = [];
  psAttempts = attempts;
  try {
    // Start cleanup after the owned children are ready. Verify the actual ps
    // timeout separately from how long the scheduler took to start the step.
    const { error } = await stoppedStep(dir, new AbortController());
    expect(attempts.some(attempt => attempt.error === "ETIMEDOUT")).toBeTrue();
    for (const { timeout } of attempts) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(3_000);
    }
    expect(error).toBeInstanceOf(ContainmentFailed);
    expect((error as Error).message).toContain("the processes it started could not be listed (no /proc, and ps did not answer within 3 s), so they could not be proven stopped; stop them before pushing again");
  } finally {
    psAttempts = undefined;
    process.env.PATH = searched;
  }
}, 30_000);
