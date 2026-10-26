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
    read: async (_lane, ref) => ({ sha: ref, required: ["types"], checks: [{ name: "types", verdict: ref === "abc^1" ? inherited ? "red" : "green" : ref === "main" ? main as "red" | "green" : "red", excerpt: "type mismatch", failedAt: new Date(0).toISOString() }] }),
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

test("regression: the revert deadline uses the failed run's time across delayed observation and restart", async () => {
  for (const source of ["check", "status"] as const) {
    const f = fixture();
    const failedAt = new Date(5 * 60_000).toISOString();
    const run = async (args: string[]) => {
      const parent = args[1]?.includes("/parent/");
      if (args[1]?.includes("check-runs")) return source === "check" ? JSON.stringify({
        name: "types", status: "completed", conclusion: parent ? "success" : "failure",
        started_at: new Date(0).toISOString(), completed_at: failedAt,
      }) : "";
      if (args[1]?.includes("/status")) return [
        { context: "types", state: source === "status" ? "failure" : "success", created_at: new Date(60_000).toISOString() },
        { context: "types", state: parent || source === "check" ? "success" : "failure", created_at: failedAt },
      ].map(row => JSON.stringify(row)).join("\n");
      return JSON.stringify({ sha: "abc", parents: [{ sha: "parent" }] });
    };
    f.ports.read = (lane, ref) => readPostMergeChecks(lane, ref, ["types"], run);
    f.clock(64 * 60_000);
    await sweepPostMerge(f.ports);
    expect(f.lane().merge?.recovery?.firstRedAt).toBe(failedAt);
    expect(f.calls().revertCalls).toBe(0);
    f.restart(); f.clock(65 * 60_000);
    await sweepPostMerge(f.ports);
    expect(f.calls().revertCalls).toBe(1);
    f.restart(); f.clock(66 * 60_000);
    await sweepPostMerge(f.ports);
    expect(f.calls().revertCalls).toBe(1);
  }
  for (const failedAt of [undefined, "unavailable", new Date(70 * 60_000).toISOString()]) {
    const f = fixture(); const read = f.ports.read; const logs: string[] = [];
    f.ports.log = message => { logs.push(message); };
    f.ports.read = async (lane, ref) => ({ ...await read(lane, ref), checks: [{ name: "types", verdict: ref === "abc^1" ? "green" : "red", failedAt }] });
    f.clock(64 * 60_000);
    await sweepPostMerge(f.ports);
    expect(f.lane().merge?.recovery).toBeUndefined();
    expect(f.calls()).toEqual({ createCalls: 0, revertCalls: 0 });
    expect(logs).toHaveLength(1);
    f.ports.read = read; f.restart(); f.clock(65 * 60_000);
    await sweepPostMerge(f.ports);
    expect(f.lane().merge?.recovery?.firstRedAt).toBe(new Date(0).toISOString());
    expect(f.calls()).toEqual({ createCalls: 1, revertCalls: 1 });
  }
});

test("regression: cancelling a pending revert emits one durable seat wake", async () => {
  const f = fixture();
  await sweepPostMerge(f.ports);
  expect(postMergeSeatSignals([f.lane()], "fixture")).toEqual([]);
  f.green(); f.clock(59 * 60_000);
  await sweepPostMerge(f.ports);
  const signals = postMergeSeatSignals([f.lane(), { ...f.lane(), id: "duplicate" }], "fixture");
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({ actionable: true, label: expect.stringContaining("cancelled") });
  expect(postMergeSeatSignals([f.lane()], "other")).toEqual([]);
  f.restart(); f.clock(61 * 60_000);
  await sweepPostMerge(f.ports);
  expect(postMergeSeatSignals([f.lane()], "fixture")).toEqual(signals);
  expect(f.calls().revertCalls).toBe(0);
});

test("regression: the final green read reconciles a lost revert response before settling recovery", async () => {
  for (const outcome of ["closed", "missing", "close-refused", "close-unavailable"] as const) {
    const f = fixture();
    const closed: number[] = [];
    const logs: string[] = [];
    let reconciliations = 0;
    f.ports.log = message => { logs.push(message); };
    f.ports.closeRevert = async (_lane, number) => {
      if (outcome === "close-refused") throw new Error("close refused");
      closed.push(number);
    };
    if (outcome === "close-unavailable") delete f.ports.closeRevert;
    const revert = f.ports.revert;
    f.ports.revert = async (lane, key, reconcileOnly, claim) => {
      if (reconcileOnly) { reconciliations++; return outcome === "missing" ? null : 8; }
      await revert(lane, key, reconcileOnly, claim);
      throw new Error("response lost");
    };
    await sweepPostMerge(f.ports); f.clock(60 * 60_000); await sweepPostMerge(f.ports);
    expect(f.calls().revertCalls).toBe(1);
    expect(f.lane().merge?.recovery?.revertSubmittedAt).toBeDefined();
    expect(f.lane().merge?.recovery?.revertPr).toBeUndefined();
    f.restart(); f.clock(61 * 60_000);
    const read = f.ports.read; let mainReads = 0;
    f.ports.read = async (lane, ref) => {
      if (ref === "main" && ++mainReads === 2) f.green();
      return read(lane, ref);
    };
    logs.length = 0;
    await sweepPostMerge(f.ports);
    expect(mainReads).toBe(2);
    expect(reconciliations).toBe(1);
    expect(f.calls().revertCalls).toBe(1);
    if (outcome === "closed") {
      expect(closed).toEqual([8]);
      expect(f.lane().merge?.recovery).toMatchObject({ revertPr: 8, resolvedAt: new Date(61 * 60_000).toISOString() });
    } else {
      expect(closed).toEqual([]);
      expect(f.lane().merge?.recovery?.resolvedAt).toBeUndefined();
      expect(postMergeSeatSignals([f.lane()], "fixture")).toHaveLength(1);
      expect(logs.length).toBeGreaterThan(0);
      f.ports.revert = revert;
      f.ports.closeRevert = async (_lane, number) => { closed.push(number); };
      f.restart(); f.clock(62 * 60_000);
      await sweepPostMerge(f.ports);
      expect(closed).toEqual([8]);
      expect(f.lane().merge?.recovery?.resolvedAt).toBe(new Date(62 * 60_000).toISOString());
      expect(f.calls().revertCalls).toBe(1);
    }
  }
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

test("green main closes an opened revert and replaces its seat item with recovery", async () => {
  const f = fixture(); const closed: number[] = [];
  f.ports.closeRevert = async (_lane, number) => { closed.push(number); };
  await sweepPostMerge(f.ports); f.clock(60 * 60_000); await sweepPostMerge(f.ports);
  f.green(); f.clock(61 * 60_000); await sweepPostMerge(f.ports); f.restart(); await sweepPostMerge(f.ports);
  expect(closed).toEqual([8]);
  expect(postMergeSeatSignals([f.lane()], "fixture")).toMatchObject([{ id: expect.stringContaining(":recovered") }]);
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
