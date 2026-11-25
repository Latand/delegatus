// destructive-code: fresh files under this test's own TMPDIR, head-only.
// The 3000 separate calls campaign is destructiveGuard.performanceSeparate.test.ts.
import { expect, test } from "bun:test";
import fs from "node:fs";
import { guardFixture } from "./destructiveGuard.fixture";
import { ensureDestructiveGuard } from "./destructiveGuard";
import { BUN_START_IDLE_MS, firstWithinBudget, overBudget, performanceCampaign, report, startBaseline, startFactor } from "./destructiveGuard.performance.fixture";

/** One start of the fast-path wrapper, which a single call pays once. */
const WRAPPER_START_MS = 30;

test("a phase's CPU factor follows its own Bun starts and never drops below the idle size", () => {
  expect(startFactor([1, 2, 3])).toBe(1);
  expect(startFactor([BUN_START_IDLE_MS * 4, BUN_START_IDLE_MS * 6, BUN_START_IDLE_MS * 40])).toBe(6);
  expect(startFactor([BUN_START_IDLE_MS * 3, BUN_START_IDLE_MS * 5, BUN_START_IDLE_MS * 7, BUN_START_IDLE_MS * 9])).toBe(5);
});

/** Fresh campaigns the gate may run before a budget counts as exceeded. */
const CAMPAIGNS = 3;

test("budgets pass when one fresh campaign meets them all and report every campaign otherwise", () => {
  expect(overBudget([["a", 5, 10], ["b", 10, 10]])).toEqual([]);
  expect(overBudget([["a", 12, 10], ["b", Number.NaN, 10]])).toEqual(["a: 12.00 > 10.00", "b: NaN > 10.00"]);
  const attempts: number[] = [];
  expect(firstWithinBudget(3, attempt => { attempts.push(attempt); return attempt < 1 ? ["spike"] : []; })).toEqual([]);
  expect(attempts).toEqual([0, 1]);
  expect(firstWithinBudget(3, attempt => [`over ${attempt}`])).toEqual([["over 0"], ["over 1"], ["over 2"]]);
});

// Five paired rounds per campaign include setup and their own rm processes,
// and three campaigns stay well inside the gate's five-minute file deadline.
test("five fresh runs measure wrapper cost for 3000 owned targets", () => {
  const f = guardFixture();
  try {
    const failures = firstWithinBudget(CAMPAIGNS, attempt => {
      const c = performanceCampaign(f);
      for (let round = 0; round < 5; round++) {
        for (const [batch, operation] of ["relative", "absolute", "find"].entries()) {
          // Both sides have identical data and path lengths before either runs.
          // Alternate their order deterministically to balance scheduling and IO.
          const pair = ["plain", "wrapped"].map((side, index) => {
            const directory = c.populate(`batch-${attempt}-${round}-${batch}-${index}`);
            return { kind: `${side}-${operation}`, directory, files: fs.readdirSync(directory) };
          });
          if (round % 2) pair.reverse();
          for (const { kind, directory, files } of pair) {
            const wrapped = kind.startsWith("wrapped");
            const env: NodeJS.ProcessEnv = { ...f.env, PATH: wrapped ? f.env.PATH : "/usr/bin:/bin", ...(kind === "wrapped-absolute" ? { LLV_DESTRUCTIVE_GUARD_FAST: "" } : {}) };
            c.measure(kind, () => {
              if (kind.endsWith("find")) c.execute([wrapped ? f.installed.directory + "/find" : "/usr/bin/find", directory, "-type", "f", "-delete"], f.cwd, env);
              else c.execute([wrapped ? f.installed.directory + "/rm" : "/bin/rm", "-f", ...files.map(file => kind.endsWith("relative") ? file : directory + "/" + file)], directory, env);
            });
            expect(fs.readdirSync(directory)).toHaveLength(0);
          }
        }
        const calls = [false, true].map(wrapped => ({ wrapped, directory: c.populate(`calls-${attempt}-${Number(wrapped)}-${round}`, 200) }));
        if (round % 2) calls.reverse();
        for (const { wrapped, directory } of calls) {
          c.measure(wrapped ? "wrapped-200" : "plain-200", () => c.execute(["/bin/bash", "-c", 'for file in "$1"/*; do rm -f "$file" || exit; done', "fixture", directory], f.cwd, { ...f.env, PATH: wrapped ? f.env.PATH : "/usr/bin:/bin", BASH_ENV: wrapped ? f.env.BASH_ENV : undefined }));
          expect(fs.readdirSync(directory)).toHaveLength(0);
        }
      }
      // The hook and the launch check are CPU-bound process work measured after
      // the rm rounds, so each takes its CPU factor from Bun starts interleaved
      // with its own calls; the rounds' host factor would miss a later load change.
      const hookTimes: number[] = [], hookBaseline: number[] = [];
      const hookCall = () => {
        const started = performance.now();
        const result = Bun.spawnSync([process.execPath, f.installed.program, "hook"], { cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify({ cwd: f.cwd, tool_name: "Bash", hook_event_name: "PreToolUse", tool_input: { command: "printf fixture" } })) });
        hookTimes.push(performance.now() - started);
        expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("");
      };
      for (let index = 0; index < 100; index++) {
        if (index % 2) { hookCall(); startBaseline(hookBaseline); } else { startBaseline(hookBaseline); hookCall(); }
      }
      const hook = { p95: [...hookTimes].sort((a, b) => a - b)[94]!, max: Math.max(...hookTimes) };
      ensureDestructiveGuard({ engine: "codex", home: f.env.CODEX_HOME!, source: f.env });
      const verifyBaseline: number[] = [];
      for (let round = 0; round < 5; round++) {
        startBaseline(verifyBaseline);
        c.measure("verify", () => { expect(ensureDestructiveGuard({ engine: "codex", home: f.env.CODEX_HOME!, source: f.env }).hook).toBe("account"); });
        startBaseline(verifyBaseline);
      }
      const summary = c.summary();
      const hostFactor = c.hostFactor();
      const hookFactor = Math.max(hostFactor, startFactor(hookBaseline)), verifyFactor = Math.max(hostFactor, startFactor(verifyBaseline));
      const conditions = c.conditions({ campaign: attempt + 1, campaigns: CAMPAIGNS, rounds: 5, pairOrder: "baseline first in even rounds; guarded first in odd rounds; both populated before timing",
        cpuBaseline: "bun -e 0 interleaved with each hook and launch-check call", hostFactor, hookFactor, verifyFactor });
      report("guard-performance", { conditions, hook, hookBaseline, verifyBaseline, summary });
      return overBudget([
        ["3000 relative targets, slowest run (ms, unscaled)", summary["wrapped-relative"]!.max, 1000],
        ["3000 absolute targets, slow path median (ms)", summary["wrapped-absolute"]!.median, 250 * hostFactor],
        ["find -delete over 3000 files, median (ms)", summary["wrapped-find"]!.median, summary["plain-find"]!.median + 60 * hostFactor],
        ["200 fast-path calls, added per call (ms)", (summary["wrapped-200"]!.median - summary["plain-200"]!.median) / 200, 2 * hostFactor],
        // One call pays one wrapper start, which a 24 ms baseline cannot absorb as a ratio.
        ["3000 relative targets, one call, median (ms)", summary["wrapped-relative"]!.median, summary["plain-relative"]!.median * 1.5 + WRAPPER_START_MS * hostFactor],
        ["hook p95 of 100 calls (ms)", hook.p95, 60 * hookFactor],
        ["launch-time verification median (ms)", summary.verify!.median, 20 * verifyFactor],
      ]);
    });
    expect(failures).toEqual([]);
  } finally { f.cleanup(); }
}, 280_000);
