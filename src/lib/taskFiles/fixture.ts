import fs from "node:fs";
import path from "node:path";

import { createLaneRepo, LANE_BRANCH, type LaneRepo } from "@/lib/laneReview/gitFixture";
import type { Pipeline } from "@/lib/pipelines/types";
import type { ExecPort } from "@/lib/workflows/provision";
import { realExec } from "@/lib/workflows/provision";

/* A throw-away lane for the task file tests: the review fixture's repository
   plus the kinds of file the Files view has to tell apart. Everything is
   synthetic and written into a temporary directory. */

export const TASK = "task-fixture";
export const OTHER_TASK = "task-other";

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
export const PDF_HEAD = "%PDF-1.4\n";
export const SUMMARY_MD = "# Handoff summary\n\nThe agent changed the album.\n\n- one\n- two\n\n<script>alert(1)</script>\n";

export type TaskFixture = LaneRepo & {
  lane: () => Pipeline;
  otherLane: () => Pipeline;
  headSha: () => string;
};

export function createTaskFixture(options: { big?: boolean } = {}): TaskFixture {
  const repo = createLaneRepo();
  repo.git("checkout", "-q", LANE_BRANCH);
  repo.write("docs/handoff/summary.md", SUMMARY_MD);
  repo.write("docs/handoff/notes.md", "# Notes\n\nSecond declared document.\n");
  repo.write("docs/readme.md", "# Readme\n\nSee [the summary](handoff/summary.md).\n");
  repo.write("img/shot.png", PNG);
  repo.write("data/table.csv", "a,b\n1,2\n");
  repo.write("docs/binary.md", Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02]));
  repo.write(".env.local", "SYNTHETIC=1\n");
  repo.write("notes/no-extension", "plain\n");
  if (options.big) {
    repo.write("docs/big.md", "# Big\n\n" + "paragraph of synthetic text\n\n".repeat(55_000));
    repo.write("docs/report.pdf", Buffer.concat([Buffer.from(PDF_HEAD), Buffer.alloc(4 * 1024 * 1024, 0x20)]));
    repo.write("data/huge.txt", Buffer.alloc(9 * 1024 * 1024, 0x61));
  }
  fs.symlinkSync("docs/handoff/summary.md", path.join(repo.dir, "link.md"));
  /* The gitlink goes in after the staging: `git add -A` would drop an entry
     whose path is not in the work tree. */
  repo.git("add", "-A");
  repo.git("update-index", "--add", "--cacheinfo", `160000,${repo.git("rev-parse", "HEAD")},vendor/module.md`);
  repo.git("commit", "-q", "-m", "lane documents");
  repo.git("checkout", "-q", "--detach");
  const stage = (outputs: string[]) => [{ id: "design", name: "design", outputs }] as unknown as Pipeline["stages"];
  const lane = () => repo.pipeline({ id: "lane-fixture", taskIds: [TASK], project: "repo-fixture", stages: stage(["docs/handoff"]) });
  const otherLane = () => repo.pipeline({ id: "lane-other", taskIds: [OTHER_TASK], project: "repo-fixture", stages: [] });
  return { ...repo, lane, otherLane, headSha: () => repo.git("rev-parse", `refs/heads/${LANE_BRANCH}`) };
}

/** A lane with more changed files than the list shows. */
export function createBulkFixture(count = 250): TaskFixture {
  const repo = createLaneRepo();
  repo.git("checkout", "-q", LANE_BRANCH);
  for (let i = 0; i < count; i += 1) repo.write(`bulk/file-${String(i).padStart(3, "0")}.txt`, `${i}\n`);
  repo.write("zz/last.md", "# last\n");
  repo.write("outputs/answer.md", "# answer\n");
  repo.commit("many files");
  repo.git("checkout", "-q", "--detach");
  const lane = () => repo.pipeline({ id: "lane-bulk", taskIds: [TASK], project: "repo-fixture", stages: [{ id: "write", name: "write", outputs: ["outputs"] }] as unknown as Pipeline["stages"] });
  return { ...repo, lane, otherLane: lane, headSha: () => repo.git("rev-parse", `refs/heads/${LANE_BRANCH}`) };
}

/** An exec port that records every Git argument list it runs. */
export function spyExec(inner: ExecPort = realExec): { exec: ExecPort; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: (command, args, cwd, env, options) => { calls.push([command, ...args]); return inner(command, args, cwd, env, options); } };
}
