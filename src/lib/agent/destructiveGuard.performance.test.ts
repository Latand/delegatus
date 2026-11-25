// destructive-code: fresh files under this test's own TMPDIR, head-only.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { guardFixture } from "./destructiveGuard.fixture";
import { ensureDestructiveGuard } from "./destructiveGuard";
let reportSerial = 0;
/** Design section 9: plain `rm -f` of 3000 files, one call, idle host. */
const PLAIN_3000_IDLE_MS = 24;
/** One start of the fast-path wrapper, which a single call pays once. */
const WRAPPER_START_MS = 30;

// The five paired campaigns include setup and separate rm processes. Their
// harness budget stays below the gate's five-minute file deadline.
test("five fresh runs measure wrapper cost for 3000 owned targets", () => {
  const f = guardFixture();
  const observations: Record<string, number[]> = {};
  const measure = (name: string, run: () => void) => { const started = performance.now(); run(); (observations[name] ??= []).push(performance.now() - started); };
  const populate = (name: string, count = 3000) => {
    const directory = path.join(f.cwd, name); fs.mkdirSync(directory);
    for (let n = 0; n < count; n++) fs.writeFileSync(path.join(directory, `file-${n}`), "fixture");
    f.assertOwned(directory); return directory;
  };
  const execute = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const result = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  try {
    for (let round = 0; round < 5; round++) {
      for (const [batch, operation] of ["relative", "absolute", "find", "separate"].entries()) {
        // Both sides have identical data and path lengths before either runs.
        // Alternate their order deterministically to balance scheduling and IO.
        const pair = ["plain", "wrapped"].map((side, index) => {
          const directory = populate(`batch-${round}-${batch}-${index}`);
          return { kind: `${side}-${operation}`, directory, files: fs.readdirSync(directory) };
        });
        if (round % 2) pair.reverse();
        for (const { kind, directory, files } of pair) {
        const wrapped = kind.startsWith("wrapped");
        const env: NodeJS.ProcessEnv = { ...f.env, PATH: wrapped ? f.env.PATH : "/usr/bin:/bin", ...(kind === "wrapped-absolute" ? { LLV_DESTRUCTIVE_GUARD_FAST: "" } : {}) };
        measure(kind, () => {
          if (kind.endsWith("find")) execute([wrapped ? f.installed.directory + "/find" : "/usr/bin/find", directory, "-type", "f", "-delete"], f.cwd, env);
          else if (kind.endsWith("separate")) execute(["/bin/bash", "-c", 'for file in "$1"/*; do rm -f "$file" || exit; done', "fixture", directory], f.cwd, { ...env, BASH_ENV: wrapped ? env.BASH_ENV : undefined });
          else execute([wrapped ? f.installed.directory + "/rm" : "/bin/rm", "-f", ...files.map(file => kind.endsWith("relative") ? file : directory + "/" + file)], directory, env);
        });
        expect(fs.readdirSync(directory)).toHaveLength(0);
        }
      }
      const calls = [false, true].map(wrapped => ({ wrapped, directory: populate(`calls-${Number(wrapped)}-${round}`, 200) }));
      if (round % 2) calls.reverse();
      for (const { wrapped, directory } of calls) {
        measure(wrapped ? "wrapped-200" : "plain-200", () => execute(["/bin/bash", "-c", 'for file in "$1"/*; do rm -f "$file" || exit; done', "fixture", directory], f.cwd, { ...f.env, PATH: wrapped ? f.env.PATH : "/usr/bin:/bin", BASH_ENV: wrapped ? f.env.BASH_ENV : undefined }));
      }
    }
    const hookTimes: number[] = [];
    for (let index = 0; index < 100; index++) {
      const started = performance.now();
      const result = Bun.spawnSync([process.execPath, f.installed.program, "hook"], { cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ cwd: f.cwd, tool_name: "Bash", hook_event_name: "PreToolUse", tool_input: { command: "printf fixture" } })) });
      expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(""); hookTimes.push(performance.now() - started);
    }
    const hook = { p95: [...hookTimes].sort((a, b) => a - b)[94]!, max: Math.max(...hookTimes) };
    ensureDestructiveGuard({ engine: "codex", home: f.env.CODEX_HOME!, source: f.env });
    for (let round = 0; round < 5; round++) measure("verify", () => { expect(ensureDestructiveGuard({ engine: "codex", home: f.env.CODEX_HOME!, source: f.env }).hook).toBe("account"); });
    const summary = Object.fromEntries(Object.entries(observations).map(([name, times]) => [name, { median: [...times].sort((a, b) => a - b)[2]!, max: Math.max(...times), runs: times }]));
    // Section 9 sized its budgets on an idle host, where plain rm of 3000
    // files took 24 ms. The gate runs this file beside other files under a
    // CPU quota, so each time budget scales with this run's own plain rm.
    const hostFactor = Math.max(1, summary["plain-relative"]!.median / PLAIN_3000_IDLE_MS);
    const conditions = { runtime: Bun.version, platform: process.platform, arch: process.arch, targets: 3000, rounds: 5, separateShell: "bash",
      separateFastPath: "same wrapper function parsed once through BASH_ENV", pairOrder: "baseline first in even rounds; guarded first in odd rounds; both populated before timing", gateRunner: "local", admission: "owned gate slot", hostLoad: "uncontrolled",
      cpuQuota: process.env.LLV_OWNED_RUN_CPU_QUOTA ?? null, availableCpus: os.availableParallelism(), filesystemType: "0x" + fs.statfsSync(f.cwd).type.toString(16), rootPathLength: f.cwd.length, fileBytes: 7, sealedEntries: f.policy.sealed.length, hostFactor };
    console.log("guard-performance " + JSON.stringify({ conditions, hook, summary }));
    if (process.env.LLV_GUARD_PERFORMANCE_REPORT) fs.writeFileSync(`${process.env.LLV_GUARD_PERFORMANCE_REPORT}.${process.pid}-${++reportSerial}.json`, JSON.stringify({ summary, hook, conditions }, null, 2), { flag: "wx" });
    expect(summary["wrapped-relative"]!.max).toBeLessThan(1000);
    expect(summary["wrapped-absolute"]!.median).toBeLessThan(250 * hostFactor);
    expect(summary["wrapped-find"]!.median).toBeLessThan(summary["plain-find"]!.median + 60 * hostFactor);
    expect((summary["wrapped-200"]!.median - summary["plain-200"]!.median) / 200).toBeLessThan(2 * hostFactor);
    // One call pays one wrapper start, which a 24 ms baseline cannot absorb as a ratio.
    expect(summary["wrapped-relative"]!.median).toBeLessThanOrEqual(summary["plain-relative"]!.median * 1.5 + WRAPPER_START_MS * hostFactor);
    expect((summary["wrapped-separate"]!.median - summary["plain-separate"]!.median) / 3000).toBeLessThan(2 * hostFactor);
    expect(hook.p95).toBeLessThanOrEqual(60 * hostFactor); expect(summary.verify!.median).toBeLessThanOrEqual(20 * hostFactor);
  } finally { f.cleanup(); }
}, 270_000);
