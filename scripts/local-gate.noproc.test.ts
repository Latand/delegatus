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
  spawnSync: (command: string, ...rest: unknown[]) => !lifetimeProbe && psBroken && command === "ps"
    ? { status: null, stdout: "", stderr: "", error: absent(command) }
    : (realChild.spawnSync as (...args: unknown[]) => unknown)(command, ...rest),
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
async function stoppedStep(dir: string, budgetMs = 1_000) {
  const at = performance.now();
  // The root and a helper it started, which must go with it.
  const script = `echo $$ > '${dir}/root.pid'; sleep 60 & echo $! > '${dir}/helper.pid'; wait`;
  const pending = runSteps("pre-push", [{ name: "touched tests", command: [] }], { root: dir, deadline: { at: Date.now() + budgetMs, startedAt: Date.now() }, logDir: dir, say: () => {},
    prepare: () => ({ command: ["bash", "-c", script], env: process.env }) }).then(() => null, (caught: unknown) => caught);
  const until = Date.now() + budgetMs;
  const pids: number[] = [];
  try {
    for (const name of ["root", "helper"]) {
      const file = path.join(dir, `${name}.pid`);
      while (!real.existsSync(file) && Date.now() < until) await Bun.sleep(10);
      const pid = Number(real.readFileSync(file, "utf8"));
      lifetimeProbe = true;
      try {
        const identity = captureProcessIdentity(pid);
        started.push(identity);
        expect(processIdentityStatus(identity), "fixture reported with live PID/start/boot identity").toBe("alive");
      } finally { lifetimeProbe = false; }
      pids.push(pid);
    }
  } finally { await pending; }
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
  // Every query takes two seconds before the real ps answers.
  const slow = path.join(dir, "bin"); real.mkdirSync(slow);
  real.writeFileSync(path.join(slow, "ps"), `#!/bin/sh\nsleep 2\nexec ${Bun.which("ps")} "$@"\n`, { mode: 0o755 });
  const searched = process.env.PATH;
  process.env.PATH = `${slow}${path.delimiter}${searched}`;
  try {
    const { error, elapsed } = await stoppedStep(dir, 500);
    // The deadline and the three-second cleanup allowance, whatever ps does.
    expect(elapsed).toBeLessThan(500 + 3_000 + 1_000);
    expect(error).toBeInstanceOf(ContainmentFailed);
    expect((error as Error).message).toContain("the processes it started could not be listed (no /proc, and ps did not answer within 3 s), so they could not be proven stopped; stop them before pushing again");
  } finally { process.env.PATH = searched; }
}, 30_000);
