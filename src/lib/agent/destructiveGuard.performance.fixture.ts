// destructive-code: fresh files under the guard fixture's own TMPDIR only.
// Shared by the section 9 measurements (docs/design/destructive-operation-guard.md).
import { expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardFixture } from "./destructiveGuard.fixture";

/** Design section 9: plain `rm -f` of 3000 files, one call, idle host. */
export const PLAIN_3000_IDLE_MS = 24;
/** Design section 9: one `bun -e 0` start on an idle host. */
export const BUN_START_IDLE_MS = 5;

export type GuardFixture = ReturnType<typeof guardFixture>;
export interface Observed { median: number; max: number; runs: number[] }

const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor((times.length - 1) / 2)]!;

/** One measurement campaign over fresh files the fixture owns. */
export function performanceCampaign(f: GuardFixture) {
  const observations: Record<string, number[]> = {};
  const measure = (name: string, run: () => void) => {
    const started = performance.now(); run(); (observations[name] ??= []).push(performance.now() - started);
  };
  const populate = (name: string, count = 3000) => {
    const directory = path.join(f.cwd, name); fs.mkdirSync(directory);
    for (let n = 0; n < count; n++) fs.writeFileSync(path.join(directory, `file-${n}`), "fixture");
    f.assertOwned(directory); return directory;
  };
  const execute = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const result = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  /** Plain `rm -f` of 3000 owned files in one call: the host factor's sample. */
  const plainRelative = (name: string) => {
    const directory = populate(name);
    const files = fs.readdirSync(directory);
    measure("plain-relative", () => execute(["/bin/rm", "-f", ...files], directory, { ...f.env, PATH: "/usr/bin:/bin" }));
    expect(fs.readdirSync(directory)).toHaveLength(0);
  };
  const summary = (): Record<string, Observed> => Object.fromEntries(Object.entries(observations)
    .map(([name, runs]) => [name, { median: median(runs), max: Math.max(...runs), runs }]));
  /** Section 9 sized its budgets on an idle host. The gate runs these files
   * beside others under a CPU quota, so each budget scales with this run's own
   * plain rm, never below the idle size. */
  const hostFactor = () => Math.max(1, median(observations["plain-relative"] ?? [PLAIN_3000_IDLE_MS]) / PLAIN_3000_IDLE_MS);
  const conditions = (extra: Record<string, unknown>) => ({ runtime: Bun.version, platform: process.platform, arch: process.arch, targets: 3000,
    gateRunner: "local", admission: "owned gate slot", hostLoad: "uncontrolled", cpuQuota: process.env.LLV_OWNED_RUN_CPU_QUOTA ?? null,
    availableCpus: os.availableParallelism(), filesystemType: "0x" + fs.statfsSync(f.cwd).type.toString(16), rootPathLength: f.cwd.length,
    fileBytes: 7, sealedEntries: f.policy.sealed.length, ...extra });
  return { observations, measure, populate, execute, plainRelative, summary, hostFactor, conditions };
}

/** A CPU-bound process start next to each guarded start: a `bun -e 0`
 * baseline run interleaved with the measured calls, so a load change during
 * the phase reaches both sides. Returns the phase's own CPU factor. */
export function startBaseline(times: number[]) {
  const started = performance.now();
  const result = Bun.spawnSync([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  times.push(performance.now() - started);
  expect(result.exitCode).toBe(0);
}
export const startFactor = (times: number[]) => Math.max(1, median(times) / BUN_START_IDLE_MS);

let reportSerial = 0;
export function report(label: string, value: Record<string, unknown>) {
  console.log(`${label} ${JSON.stringify(value)}`);
  if (process.env.LLV_GUARD_PERFORMANCE_REPORT) {
    fs.writeFileSync(`${process.env.LLV_GUARD_PERFORMANCE_REPORT}.${label}.${process.pid}-${++reportSerial}.json`, JSON.stringify(value, null, 2), { flag: "wx" });
  }
}
