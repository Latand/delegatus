import { expect, test } from "bun:test";
import type { Pipeline } from "@/lib/pipelines/types";
import { sweepPostMerge, postMergeSeatSignals, openRevertPr, readPostMergeChecks, type PostMergePorts } from "./postMerge";

function fixture() {
  let now = 0;
  let main = "red";
  let inherited = false;
  let lane = { id: "landed", srcPath: null, srcConversationId: "conversation_fixture", project: "fixture", repoDir: ".", baseBranch: "main", taskIds: [],
    merge: { state: "merged", by: "auto-merge", postMergeWatch: true, repository: "example/project", prNumber: 7, mergeCommit: "abc" } } as unknown as Pipeline;
  let createCalls = 0;
  let revertCalls = 0;
  const lineages: unknown[] = [];
  const creates = new Map<string, string>();
  const reverts = new Set<string>();
  const ports: PostMergePorts = {
    now: () => now,
    loadPipelines: () => [structuredClone(lane)],
    mutate: async (_id, change) => change(lane),
    read: async (_lane, ref) => ({ sha: ref, required: ["types"], checks: [{ name: "types", verdict: ref === "abc^1" ? inherited ? "red" : "green" : ref === "main" ? main as "red" | "green" : "red", excerpt: "type mismatch" }] }),
    create: async (_request, receipt, lineage) => { lineages.push(lineage); createCalls++; creates.set(receipt.key, "fix"); return { id: "fix" }; },
    revert: async (_lane, key, reconcileOnly, claim) => {
      if (!reconcileOnly && await claim()) { revertCalls++; reverts.add(key); }
      return 8;
    },
  };
  return { ports, creates, reverts, lineages, calls: () => ({ createCalls, revertCalls }), restart() { lane = JSON.parse(JSON.stringify(lane)); }, clock(ms: number) { now = ms; }, green() { main = "green"; }, inherited() { inherited = true; }, lane: () => lane };
}

test("a red auto-merge opens one fix lane across restarts", async () => {
  const f = fixture();
  await sweepPostMerge(f.ports);
  f.restart(); f.clock(60_000);
  await sweepPostMerge(f.ports);
  expect(f.creates.size).toBe(1);
  expect(f.calls().createCalls).toBe(1);
  expect(f.lineages).toEqual([{ srcPath: null, srcConversationId: "conversation_fixture" }]);
  expect(f.lane().merge?.recovery?.failures[0]).toEqual({ name: "types", excerpt: "type mismatch" });
});
test("green main before sixty minutes cancels the pending revert permanently", async () => {
  const f = fixture();
  await sweepPostMerge(f.ports);
  f.clock(59 * 60_000); f.green();
  await sweepPostMerge(f.ports);
  f.restart(); f.clock(61 * 60_000);
  await sweepPostMerge(f.ports);
  expect(f.reverts.size).toBe(0);
  expect(f.lane().merge?.recovery?.resolvedAt).toBeDefined();
});
test("sixty minutes red opens one revert PR and one durable seat item", async () => {
  const f = fixture();
  await sweepPostMerge(f.ports);
  f.clock(60 * 60_000 - 1); await sweepPostMerge(f.ports);
  expect(f.reverts.size).toBe(0);
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  f.restart(); await sweepPostMerge(f.ports);
  expect(f.reverts.size).toBe(1);
  expect(f.calls().revertCalls).toBe(1);
  expect(postMergeSeatSignals([f.lane()], "fixture")).toHaveLength(1);
  expect(postMergeSeatSignals([f.lane()], "other")).toHaveLength(0);
  expect(postMergeSeatSignals([f.lane()], "canonical", key => key === "fixture" ? "canonical" : key)).toHaveLength(1);
  expect(f.lane().merge?.recovery?.revertPr).toBe(8);
});
test("a check already red on the first parent is not blamed on the merge", async () => {
  const f = fixture(); f.inherited();
  await sweepPostMerge(f.ports);
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(f.creates.size).toBe(0);
  expect(f.reverts.size).toBe(0);
  expect(f.lane().merge?.postMergeWatch).toBe(false);
});


test("a committed fix creation with a lost response replays the same durable key", async () => {
  const f = fixture();
  const create = f.ports.create;
  let lost = true;
  f.ports.create = async (request, receipt, lineage) => {
    const result = await create(request, receipt, lineage);
    if (lost) { lost = false; throw new Error("response lost"); }
    return result;
  };
  await sweepPostMerge(f.ports); f.restart(); f.clock(60_000); await sweepPostMerge(f.ports);
  expect(f.creates.size).toBe(1);
  expect(f.calls().createCalls).toBe(2);
  expect(f.lane().merge?.recovery?.fixPipelineId).toBe("fix");
});

test("missing required checks cannot cancel a pending revert", async () => {
  const f = fixture(); await sweepPostMerge(f.ports);
  const read = f.ports.read;
  f.ports.read = async (lane, ref) => ({ ...await read(lane, ref), checks: [] });
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(f.reverts.size).toBe(1);
});

test("green main closes an opened revert and clears its seat item", async () => {
  const f = fixture(); const closed: number[] = [];
  f.ports.closeRevert = async (_lane, number) => { closed.push(number); };
  await sweepPostMerge(f.ports); f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  f.green(); f.clock(61 * 60_000); await sweepPostMerge(f.ports); f.restart(); await sweepPostMerge(f.ports);
  expect(closed).toEqual([8]);
  expect(postMergeSeatSignals([f.lane()], "fixture")).toHaveLength(0);
});

test("revert reconciliation recovers a lost forge response without another mutation", async () => {
  const f = fixture(); let writes = 0; let created = false;
  const run = async (args: string[]) => args[1]?.includes("pulls?") ? created ? "8\n" : "" : JSON.stringify({ node_id: "PR_fixture" });
  const write = async () => { writes++; created = true; throw new Error("response lost"); };
  await expect(openRevertPr(f.lane(), "receipt", false, run, write)).rejects.toThrow("response lost");
  expect(await openRevertPr(f.lane(), "receipt", true, run, write)).toBe(8);
  expect(writes).toBe(1);
  created = false;
  expect(await openRevertPr(f.lane(), "receipt", true, run, write)).toBeNull();
  expect(writes).toBe(1);
});

test("commit evidence reads exact identities, required check output and legacy statuses", async () => {
  const f = fixture();
  const run = async (args: string[]) => {
    if (args[1]?.includes("check-runs")) return JSON.stringify({ name: "types", status: "completed", conclusion: "failure", output: { summary: "type mismatch" } });
    if (args[1]?.includes("/status")) return JSON.stringify({ context: "legacy", state: "success" });
    return JSON.stringify({ sha: "exact" });
  };
  const view = await readPostMergeChecks(f.lane(), "abc", ["types"], run);
  expect(view.sha).toBe("exact");
  expect(view.checks.find(check => check.name === "types")).toMatchObject({ verdict: "red", excerpt: "type mismatch" });
  expect(view.checks.find(check => check.name === "legacy")?.verdict).toBe("green");
});

test("failed fix admission does not delay the sixty-minute revert", async () => {
  const f = fixture();
  f.ports.create = async () => { throw new Error("busy"); };
  await sweepPostMerge(f.ports);
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(f.reverts.size).toBe(1);
});

test("a green observed immediately before submission cancels the revert", async () => {
  const f = fixture(); await sweepPostMerge(f.ports);
  const read = f.ports.read; let reads = 0;
  f.ports.read = async (lane, ref) => {
    if (ref === "main" && ++reads === 2) f.green();
    return read(lane, ref);
  };
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(f.reverts.size).toBe(0);
  expect(f.lane().merge?.recovery?.resolvedAt).toBeDefined();
});

test("green checks on the merge retire its watch before an unrelated red main", async () => {
  const f = fixture(); const read = f.ports.read;
  f.ports.read = async (lane, ref) => {
    const view = await read(lane, ref);
    return ref === "abc" ? { ...view, checks: [{ name: "types", verdict: "green" }] } : view;
  };
  await sweepPostMerge(f.ports);
  expect(f.lane().merge?.postMergeVerifiedAt).toBeDefined();
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(f.creates.size).toBe(0);
});

test("seat items deduplicate multiple lane records of the same merge", async () => {
  const f = fixture(); await sweepPostMerge(f.ports);
  f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(postMergeSeatSignals([f.lane(), { ...f.lane(), id: "duplicate" }], "fixture")).toHaveLength(1);
});

test("a lost post-merge read recovers the merge commit before watching checks", async () => {
  const f = fixture(); f.lane().merge!.mergeCommit = null;
  f.ports.resolveMergeCommit = async () => "abc";
  await sweepPostMerge(f.ports);
  expect(f.lane().merge?.mergeCommit).toBe("abc");
  expect(f.creates.size).toBe(1);
});

test("historic and externally merged PRs do not enroll in automatic recovery", async () => {
  const f = fixture(); delete f.lane().merge!.postMergeWatch;
  await sweepPostMerge(f.ports);
  expect(f.creates.size).toBe(0);
  f.lane().merge!.postMergeWatch = true; f.lane().merge!.by = "outside";
  await sweepPostMerge(f.ports);
  expect(f.creates.size).toBe(0);
});

test("green main reconciles and closes a revert whose creation response was lost", async () => {
  const f = fixture(); const closed: number[] = [];
  f.ports.closeRevert = async (_lane, number) => { closed.push(number); };
  const revert = f.ports.revert;
  f.ports.revert = async (lane, key, reconcileOnly, claim) => {
    const number = await revert(lane, key, reconcileOnly, claim);
    if (!reconcileOnly) throw new Error("response lost");
    return number;
  };
  await sweepPostMerge(f.ports); f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(f.lane().merge?.recovery?.revertPr).toBeUndefined();
  f.green(); f.restart(); f.clock(61 * 60_000); await sweepPostMerge(f.ports);
  expect(closed).toEqual([8]);
  expect(f.lane().merge?.recovery?.resolvedAt).toBeDefined();
  expect(f.calls().revertCalls).toBe(1);
});

test("parent evidence resolves the actual parent SHA before reading its checks", async () => {
  const f = fixture();
  const run = async (args: string[]) => {
    if (args[1]?.endsWith("/commits/abc")) return JSON.stringify({ sha: "abc", parents: [{ sha: "parent" }] });
    if (args[1]?.includes("/commits/parent/check-runs")) return JSON.stringify({ name: "types", status: "completed", conclusion: "success" });
    if (args[1]?.includes("/commits/parent/status")) return "";
    throw new Error("unexpected commit reference");
  };
  const view = await readPostMergeChecks(f.lane(), "abc^1", ["types"], run);
  expect(view.sha).toBe("parent");
  expect(view.checks[0]?.verdict).toBe("green");
});

test("rebase evidence walks past every rebased PR commit to the previous main", async () => {
  const f = fixture(); f.lane().merge!.method = "rebase";
  const run = async (args: string[]) => {
    if (args[1]?.endsWith("/pulls/7")) return JSON.stringify({ commits: 2 });
    if (args[1]?.endsWith("/commits/abc")) return JSON.stringify({ sha: "abc", parents: [{ sha: "middle" }] });
    if (args[1]?.endsWith("/commits/middle")) return JSON.stringify({ sha: "middle", parents: [{ sha: "parent" }] });
    if (args[1]?.includes("/commits/parent/check-runs")) return JSON.stringify({ name: "types", status: "completed", conclusion: "success" });
    if (args[1]?.includes("/commits/parent/status")) return "";
    throw new Error("unexpected commit reference");
  };
  expect((await readPostMergeChecks(f.lane(), "abc^1", ["types"], run)).sha).toBe("parent");
});

test("the public revert receipt carries no repository account identifier", async () => {
  const f = fixture(); let body = "";
  const run = async (args: string[]) => args[1]?.includes("pulls?") ? "" : JSON.stringify({ node_id: "PR_fixture" });
  const write = async (args: string[]) => {
    body = args.find(arg => arg.startsWith("body=")) ?? "";
    return JSON.stringify({ data: { revertPullRequest: { revertPullRequest: { number: 8 } } } });
  };
  f.ports.revert = (lane, key, reconcileOnly, claim) => openRevertPr(lane, key, reconcileOnly, run, write, claim);
  await sweepPostMerge(f.ports); f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  expect(body.length).toBeGreaterThan(0);
  expect(body).not.toContain(f.lane().merge!.repository);
});
