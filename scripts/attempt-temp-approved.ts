import "../src/lib/state/owner/tool";
import { WorktreeSweepWorker } from "../src/lib/pipelines/worktreeSweepWorker";

// Local operations entry: the helper reads a separately installed approval
// binding and the primary operator decision. It accepts no caller authority,
// cap override, removal callback or expanded directory selection.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--review" || args[2] !== "--manifest")
  throw new Error("usage: bun scripts/attempt-temp-approved.ts --review <full-review-id> --manifest <retained-json>");
const worker = new WorktreeSweepWorker();
try {
  const report = await worker.approvedAttemptTemp({ reviewId: args[1]!, manifest: args[3]! });
  process.stdout.write(JSON.stringify(report) + "\n");
  if (!report.complete) process.exitCode = 2;
} finally { await worker.close(); }
