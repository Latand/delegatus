import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createLaneRepo, LANE_BRANCH, type LaneRepo } from "@/lib/laneReview/gitFixture";
import { numberRows } from "@/lib/laneReview/model";
import { realExec } from "@/lib/workflows/provision";
import { LANE_CHANGE_LIMITS, laneChangeSummary, laneFileDiff, laneReviewTarget, resolveLaneRevisions, type LaneChangeSummary } from "./laneChanges";
import type { Pipeline, PipelineStageAttempt } from "./types";

const repos: LaneRepo[] = [];
const repo = () => {
  const created = createLaneRepo();
  repos.push(created);
  return created;
};
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const summaryOf = async (pipeline: Pipeline): Promise<LaneChangeSummary> => {
  const summary = await laneChangeSummary(pipeline, realExec);
  if ("error" in summary) throw new Error(summary.error);
  return summary;
};

describe("laneChangeSummary", () => {
  test("lists each op against the merge base, with numstat counts and the binary file", async () => {
    const lane = repo();
    const summary = await summaryOf(lane.pipeline());
    expect(summary.base).toBe(lane.git("rev-parse", "refs/remotes/origin/main"));
    expect(summary.head).toBe(lane.git("rev-parse", `refs/heads/${LANE_BRANCH}`));
    expect(summary.baseSource).toBe("merge-base");
    expect(summary.headSource).toBe("branch");
    expect(summary.files).toEqual([
      { path: "assets/logo.bin", op: "update", added: 0, removed: 0, binary: true },
      { path: "src/added.ts", op: "add", added: 1, removed: 0, binary: false },
      { path: "src/app.ts", op: "update", added: 2, removed: 1, binary: false },
      { path: "src/gone.ts", op: "delete", added: 0, removed: 1, binary: false },
    ]);
    expect(summary).toMatchObject({ total: 4, truncated: false, uncommitted: 0, branch: LANE_BRANCH, baseBranch: "main" });
  });

  test(`cuts the list at ${LANE_CHANGE_LIMITS.files} files and keeps the real total`, async () => {
    const lane = repo();
    lane.git("checkout", "-q", LANE_BRANCH);
    for (let i = 0; i < 201; i += 1) lane.write(`many/f${String(i).padStart(3, "0")}.txt`, `${i}\n`);
    lane.commit("many files");
    const summary = await summaryOf(lane.pipeline());
    expect(summary.total).toBe(205);
    expect(summary.files.length).toBe(200);
    expect(summary.truncated).toBe(true);
  });

  test("the base follows the merge base after main is merged into the lane", async () => {
    const lane = repo();
    lane.git("checkout", "-q", "main");
    lane.write("README.md", "main moved\n");
    const mainHead = lane.commit("main moves");
    lane.git("update-ref", "refs/remotes/origin/main", mainHead);
    lane.git("checkout", "-q", LANE_BRANCH);
    lane.git("merge", "-q", "--no-edit", "main");
    const summary = await summaryOf(lane.pipeline());
    expect(summary.base).toBe(mainHead);
    expect(summary.files.map((file) => file.path)).not.toContain("README.md");
  });

  test("a deleted branch falls back to the last passed commit", async () => {
    const lane = repo();
    const tip = lane.git("rev-parse", `refs/heads/${LANE_BRANCH}`);
    lane.git("branch", "-D", LANE_BRANCH);
    const revisions = await resolveLaneRevisions(lane.pipeline({ lastPassedCommit: tip }), realExec);
    expect(revisions).toMatchObject({ head: tip, headSource: "last-passed", baseSource: "merge-base" });
    expect(await resolveLaneRevisions(lane.pipeline(), realExec)).toMatchObject({ code: "head_unavailable" });
  });

  test("with no fetched base branch the base is baseRef", async () => {
    const lane = repo();
    lane.git("update-ref", "-d", "refs/remotes/origin/main");
    const pipeline = lane.pipeline();
    expect(await resolveLaneRevisions(pipeline, realExec)).toMatchObject({ base: pipeline.baseRef, baseSource: "base-ref" });
    expect(await resolveLaneRevisions(lane.pipeline({ baseRef: "no-such-ref" }), realExec)).toMatchObject({ code: "base_unavailable" });
  });

  test("counts uncommitted paths in a worktree that still exists, and lists none of them", async () => {
    const lane = repo();
    lane.git("checkout", "-q", LANE_BRANCH);
    lane.write("scratch.txt", "not committed\n");
    const summary = await summaryOf(lane.pipeline({ worktreeDir: lane.dir }));
    expect(summary.uncommitted).toBe(1);
    expect(summary.files.map((file) => file.path)).not.toContain("scratch.txt");
  });
});

describe("laneFileDiff", () => {
  test("reads one file over exactly the pair, numbered from git's hunk headers", async () => {
    const lane = repo();
    const { base, head } = await summaryOf(lane.pipeline());
    const diff = await laneFileDiff(lane.pipeline(), base, head, "src/app.ts", realExec);
    if ("error" in diff) throw new Error(diff.error);
    expect(diff.hunks.map((hunk) => hunk.header)).toEqual(["-2,7 +2,7 @@ line 1", "-23,6 +23,7 @@ line 22"]);
    expect({ added: diff.added, removed: diff.removed, op: diff.op, binary: diff.binary }).toEqual({ added: 2, removed: 1, op: "update", binary: false });
    const rows = numberRows(diff.hunks);
    const numbers = (text: string) => {
      const row = rows.find((candidate) => candidate.line.text === text);
      return [row?.line.t, row?.old ?? null, row?.new ?? null];
    };
    expect(numbers("line 5")).toEqual(["-", 5, null]);
    expect(numbers("line five")).toEqual(["+", null, 5]);
    expect(numbers("line 25b")).toEqual(["+", null, 26]);
    expect(numbers("line 26")).toEqual([" ", 26, 27]);
  });

  test("a binary file has no rows", async () => {
    const lane = repo();
    const { base, head } = await summaryOf(lane.pipeline());
    expect(await laneFileDiff(lane.pipeline(), base, head, "assets/logo.bin", realExec)).toMatchObject({ binary: true, hunks: [] });
  });

  test("refuses a path the pair does not change, including pathspec magic and a parent path", async () => {
    const lane = repo();
    const { base, head } = await summaryOf(lane.pipeline());
    fs.writeFileSync(path.join(lane.dir, "..", `${path.basename(lane.dir)}-outside`), "outside\n");
    try {
      for (const hostile of [":(glob)*", "*", "../x", `../${path.basename(lane.dir)}-outside`, "src", "README.md"]) {
        expect(await laneFileDiff(lane.pipeline(), base, head, hostile, realExec)).toMatchObject({ code: "path_not_changed" });
      }
    } finally {
      fs.rmSync(path.join(lane.dir, "..", `${path.basename(lane.dir)}-outside`), { force: true });
    }
  });

  test("refuses a pair that is not two full commit ids", async () => {
    const lane = repo();
    const { head } = await summaryOf(lane.pipeline());
    expect(await laneFileDiff(lane.pipeline(), "HEAD~1", head, "src/app.ts", realExec)).toMatchObject({ code: "git_failed" });
  });
});

describe("laneReviewTarget", () => {
  const attempt = (n: number, startedAt: string, extra: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt => ({
    n, startedAt, conversationId: `conversation-${n}`, effectiveRole: { access: "read-write", engine: "claude" }, ...extra,
  }) as PipelineStageAttempt;
  const lane = (runs: Pipeline["runs"]) => ({ runs, stages: [] }) as Pick<Pipeline, "runs" | "stages">;

  test("is the newest writer with a conversation, running or finished", () => {
    expect(laneReviewTarget(lane([
      { stageId: "build", attempts: [attempt(1, "2026-10-23T08:00:00.000Z")] },
      { stageId: "review", attempts: [attempt(2, "2026-10-23T09:00:00.000Z", { effectiveRole: { access: "read-only", engine: "codex" } as PipelineStageAttempt["effectiveRole"] })] },
      { stageId: "fix", attempts: [attempt(3, "2026-10-23T10:00:00.000Z", { effectiveRole: { access: "read-write", engine: "codex" } as PipelineStageAttempt["effectiveRole"] })] },
    ]))).toEqual({ conversationId: "conversation-3", stageId: "fix", attempt: 3, stageName: "fix", engine: "codex" });
  });

  test("skips historical attempts and attempts without a conversation; none left is null", () => {
    expect(laneReviewTarget(lane([
      { stageId: "build", attempts: [attempt(1, "2026-10-23T08:00:00.000Z"), attempt(2, "2026-10-23T11:00:00.000Z", { historical: true }), attempt(3, "2026-10-23T12:00:00.000Z", { conversationId: null })] },
    ]))?.conversationId).toBe("conversation-1");
    expect(laneReviewTarget(lane([{ stageId: "review", attempts: [attempt(1, "2026-10-23T08:00:00.000Z", { effectiveRole: { access: "read-only" } as PipelineStageAttempt["effectiveRole"] })] }]))).toBeNull();
  });
});
