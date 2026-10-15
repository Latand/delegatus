import { expect, test } from "bun:test";
import { releaseStages } from "./stages";
import { normalizeStages } from "@/lib/pipelines/engine";
import { pipelineRoleLookup, resolvePipelineRole } from "@/lib/pipelines/roles";
test("release template validates; capture and one-round visual and code reviews precede publishing", () => {
  const stages = releaseStages({ cut: "one", lastTag: "v1.0.0", changes: [], askBeforePublish: true });
  const normalized = normalizeStages(stages, pipelineRoleLookup);
  expect(normalized.error).toBeUndefined();
  expect(stages.map(s => s.id)).toEqual(["prepare", "capture", "shots", "shots-fix", "review", "fix", "publish"]);
  expect(stages.find(s => s.id === "shots")?.onFail).toEqual({ to: "shots-fix", maxRounds: 1, onExhausted: "advance" });
  expect(stages.find(s => s.id === "review")?.onFail).toEqual({ to: "fix", maxRounds: 1, onExhausted: "advance" });
  expect(stages.at(-1)?.prompt).toContain("needs_decision");
  expect(stages.at(-1)?.role?.roleId).toBe("deployer");
  expect(stages.at(-1)?.prompt).toContain("push-existing permits pushing only that matching local annotated tag object without retagging");
  expect(stages.at(-1)?.prompt).toContain("verify-remote means the remote tag already matches, so perform read-only verification and issue no push");
  expect(resolvePipelineRole({ role: { roleId: "deployer" } }, "run").error).toContain("not allowed");
});
test("each release reads current autonomy and asks when the effective approval gate is on", () => {
  for (let i = 0; i < 2; i++) {
    const prompt = releaseStages({ cut: "one", lastTag: "v1.0.0", changes: [], askBeforePublish: true }).at(-1)?.prompt;
    expect(prompt).toContain("When effectiveAskBeforePublish is true, ask before every tag");
    expect(prompt).toContain("Re-read autonomy immediately before any tag push: expiry or off restores askBeforePublish");
    expect(prompt).toContain("releases enabled and the gap, change-count and hold gates satisfied");
  }
  expect(releaseStages({ cut: "one", lastTag: "v1.0.0", changes: [], askBeforePublish: false, approval: "operator switched asking off" }).at(-1)?.prompt).toContain("operator switched asking off");
});
