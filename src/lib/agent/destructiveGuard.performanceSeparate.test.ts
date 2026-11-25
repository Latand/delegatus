// destructive-code: fresh files under this test's own TMPDIR, head-only.
// Section 9's 3000 separate calls: the longest campaign, in its own file so
// each file stays well inside the gate's five-minute file deadline.
import { expect, test } from "bun:test";
import fs from "node:fs";
import { guardFixture } from "./destructiveGuard.fixture";
import { performanceCampaign, report } from "./destructiveGuard.performance.fixture";

test("five fresh runs measure 3000 separate rm calls through the shell fast path", () => {
  const f = guardFixture();
  const c = performanceCampaign(f);
  try {
    for (let round = 0; round < 5; round++) {
      // The host factor's sample is taken in the same round as the pair it scales.
      c.plainRelative(`factor-${round}`);
      const pair = ["plain", "wrapped"].map((side, index) => ({ kind: `${side}-separate`, directory: c.populate(`separate-${round}-${index}`) }));
      if (round % 2) pair.reverse();
      for (const { kind, directory } of pair) {
        const wrapped = kind.startsWith("wrapped");
        c.measure(kind, () => c.execute(["/bin/bash", "-c", 'for file in "$1"/*; do rm -f "$file" || exit; done', "fixture", directory], f.cwd,
          { ...f.env, PATH: wrapped ? f.env.PATH : "/usr/bin:/bin", BASH_ENV: wrapped ? f.env.BASH_ENV : undefined }));
        expect(fs.readdirSync(directory)).toHaveLength(0);
      }
    }
    const summary = c.summary();
    const hostFactor = c.hostFactor();
    report("guard-performance-separate", { conditions: c.conditions({ rounds: 5, separateShell: "bash",
      separateFastPath: "same wrapper function parsed once through BASH_ENV",
      pairOrder: "baseline first in even rounds; guarded first in odd rounds; both populated before timing", hostFactor }), summary });
    expect((summary["wrapped-separate"]!.median - summary["plain-separate"]!.median) / 3000).toBeLessThan(2 * hostFactor);
  } finally { f.cleanup(); }
}, 270_000);
