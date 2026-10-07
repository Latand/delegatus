import { afterEach, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A machine without /proc (macOS): every read under it fails the way a
// missing path does, and `ps` can be taken away as well.
const real = { ...fs }, realChild = { ...childProcess };
const missing = (target: unknown) => typeof target === "string" && (target === "/proc" || target.startsWith("/proc/"));
const absent = (target: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), { code: "ENOENT" });
let psBroken = false;
mock.module("node:fs", () => ({
  ...real,
  readFileSync: (target: string, ...rest: unknown[]) => { if (missing(target)) throw absent(target); return (real.readFileSync as (...args: unknown[]) => unknown)(target, ...rest); },
  readdirSync: (target: string, ...rest: unknown[]) => { if (missing(target)) throw absent(target); return (real.readdirSync as (...args: unknown[]) => unknown)(target, ...rest); },
}));
mock.module("node:child_process", () => ({
  ...realChild,
  spawnSync: (command: string, ...rest: unknown[]) => psBroken && command === "ps"
    ? { status: null, stdout: "", stderr: "", error: absent(command) }
    : (realChild.spawnSync as (...args: unknown[]) => unknown)(command, ...rest),
}));
const { ContainmentFailed, NoVerdict, runSteps } = await import("./local-gate");

const roots: string[] = [], started: number[] = [];
afterEach(() => {
  psBroken = false;
  // Only the processes these tests started, each by the PID it recorded.
  for (const pid of started.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
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
async function stoppedStep(dir: string) {
  const at = performance.now();
  // The root and a helper it started, which must go with it.
  const script = `echo $$ > '${dir}/root.pid'; sleep 60 & echo $! > '${dir}/helper.pid'; wait`;
  const error = await runSteps("pre-push", [{ name: "touched tests", command: [] }], { root: dir, deadline: { at: Date.now() + 1_000, startedAt: Date.now() }, logDir: dir, say: () => {},
    prepare: () => ({ command: ["bash", "-c", script], env: process.env }) }).then(() => null, (caught: unknown) => caught);
  const pids = ["root", "helper"].map(name => Number(real.readFileSync(path.join(dir, `${name}.pid`), "utf8")));
  started.push(...pids);
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
  expect((error as Error).message).toBe('"touched tests" was stopped at the push deadline, but the processes it started could not be listed (no /proc, and ps failed), so they may still be running; stop them before pushing again');
}, 30_000);
