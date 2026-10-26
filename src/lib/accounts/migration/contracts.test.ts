import { expect, spyOn, test } from "bun:test";

import * as processIdentity from "@/lib/processIdentity";
import { sameGenerationHostEvidence, type GenerationHostEvidence } from "./contracts";

function evidence(process: processIdentity.ProcessIdentity): GenerationHostEvidence {
  return {
    kind: "tmux", identity: "generation", epoch: 1, verifiedAt: "2026-10-01T00:00:00Z",
    tmuxHost: { kind: "tmux", endpoint: "socket", server: process, paneId: "%1",
      panePid: process, windowName: "window", agent: process, argv: ["agent"] },
  };
}

test("generation evidence delegates recorded equality with legacy expectations", () => {
  const compare = spyOn(processIdentity, "sameRecordedProcessIdentity");
  try {
    const current = { pid: 42, startIdentity: "start", bootEpoch: "boot-current" };
    const expected = { ...current, bootEpoch: "boot-earlier" };
    expect(sameGenerationHostEvidence(evidence(current), evidence(expected))).toBe(true);
    expect(compare).toHaveBeenCalledTimes(3);
    expect(compare).toHaveBeenCalledWith(current, { pid: 42, startIdentity: "start" });
  } finally {
    compare.mockRestore();
  }
});

test("generation evidence keeps the pid/start matrix and composite fences", () => {
  for (const startIdentity of [null, "start"]) {
    for (const bootEpoch of [undefined, null, "boot-current", "boot-earlier"]) {
      const current = evidence({ pid: 42, startIdentity, bootEpoch: "boot-current" });
      const expected = evidence({ pid: 42, startIdentity, bootEpoch });
      expect(sameGenerationHostEvidence(current, expected)).toBe(true);
      expect(sameGenerationHostEvidence(current, evidence({ pid: 43, startIdentity, bootEpoch }))).toBe(false);
      expect(sameGenerationHostEvidence(current, evidence({ pid: 42, startIdentity: "other", bootEpoch }))).toBe(false);
      expect(sameGenerationHostEvidence(current, { ...expected, epoch: 2 })).toBe(false);
      expect(sameGenerationHostEvidence(current, { ...expected, tmuxHost: { ...expected.tmuxHost!, endpoint: "other" } })).toBe(false);
    }
  }
});
