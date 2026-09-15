/** Synthetic populated-corpus CPU profile; run under an isolated test home. */
import { claimedReviewerPaths } from "../src/components/flows/flowModel";
import type { Flow } from "../src/lib/flows/types";
import type { FileEntry } from "../src/lib/types";

let files: FileEntry[] = [];
const flows: Flow[] = [];
for (let i = 0; i < 321; i++) {
  const id = `flow-${i}`;
  flows.push({ id, rounds: [{ n: 1, reviewerBindingId: `binding-${i}-2`, reviewerPath: `/repo/review-${i}-2.jsonl` }] } as Flow);
  for (let j = 0; j < 3; j++) files.push({
    path: `/repo/review-${i}-${j}.jsonl`, conversationId: `conversation-${i}-${j}`,
    durableLineage: { memberships: [{ kind: "flow", role: "reviewer", containerId: id, round: 1, slot: `reviewer:1:binding-${i}-${j}` }] },
  } as FileEntry);
}
const measure = (label: string) => {
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const claimed = claimedReviewerPaths(flows, files);
    if (claimed.size !== files.length) throw new Error("historical membership lost");
    samples.push(performance.now() - start);
  }
  return { label, samplesMs: samples, maxMs: Math.max(...samples) };
};
console.log(JSON.stringify({ files: files.length, flows: flows.length, results: [measure("same-revision"), (() => {
  files = files.map((file, i) => i === 0 ? { ...file, title: "updated" } : file);
  return measure("updated-file");
})()] }, null, 2));
