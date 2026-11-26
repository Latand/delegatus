import "./engineEnvironment.fixture";
import { expect, spyOn, test, crypto, fs, path, tickPipelines, loadPipelines, savePipelines, pipelineIdentity, realWorktreeLane } from "./engine.fixture";

for (const stallMs of [0, 27_000]) test(`refresh completion advances its parent through the controller after a ${stallMs}ms stall`, async () => {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => `${stallMs === 0 ? "10000000" : "20000000"}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const fixture = await realWorktreeLane("refresh-controller", [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Refresh", next: "review" },
    { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review resolution", next: null, onFail: { to: "build", maxRounds: 1 } },
  ]).finally(() => ids.mockRestore());
  try {
    const { h, id, worktree, git, base } = fixture;
    fs.writeFileSync(path.join(worktree, "resolution.txt"), "both sides preserved\n");
    await git(worktree, "add", "resolution.txt");
    await git(worktree, "commit", "-m", "Preserve the refresh resolution");
    const head = await git(worktree, "rev-parse", "HEAD");
    h.setConversationActive(false);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([], h.ports);
    const child = loadPipelines().find(lane => lane.id === id)!;
    child.delivery = { target: { repository: child.project, remote: "https://github.com/acme/widgets.git", branch: `refs/heads/${child.branch}`, pr: 11 },
      disposition: "owner", publish: "disabled", ownerId: id, epoch: 2, active: false, journal: [] };
    child.refreshOf = { pipelineId: "original", base };
    const parent = structuredClone(child);
    Object.assign(parent, { id: "original", state: "completed", cursor: null, closedAt: h.ports.now(), lastPassedCommit: base });
    Object.assign(parent, pipelineIdentity(parent.id, parent.task, parent.repoDir));
    delete parent.refreshOf;
    parent.runs.forEach(run => run.attempts.forEach(attempt => { attempt.state = "passed"; }));
    parent.delivery!.active = false;
    parent.delivery!.ownerId = parent.id;
    const { mergeAdmission, productionAutoMergePorts, sweepAutoMerge, resetAutoMergeForTests, MERGE_POLL_MS } = await import("@/lib/forge/autoMerge");
    const { FlowPipelineController } = await import("./controller");
    resetAutoMergeForTests();
    let clock = Date.parse(h.ports.now());
    const setting = () => ({ enabled: true, changedAt: new Date(0).toISOString(), changedBy: "operator" as const });
    const admitted = mergeAdmission(parent, clock, { setting, pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }) });
    if (!("merge" in admitted)) throw new Error(admitted.reason);
    parent.merge = admitted.merge;
    parent.merge.state = "refreshing";
    parent.merge.refresh = { attempt: 0, base, head: base, key: "controller-refresh", digest: "c".repeat(64), requestedAt: new Date(clock).toISOString(), pipelineId: id };
    const { isStoredPipeline } = await import("./store");
    expect({ parent: isStoredPipeline(parent), child: isStoredPipeline(child) }).toEqual({ parent: true, child: true });
    savePipelines([parent, child]);
    let merged = false, pending = false;
    const writes: string[][] = [];
    const ports = productionAutoMergePorts({ now: () => clock, loadPipelines, setting, cachedState: () => null, log: () => undefined,
      run: async args => {
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({
          state: merged ? "MERGED" : "OPEN", headRefOid: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: pending ? "IN_PROGRESS" : "COMPLETED", conclusion: pending ? "" : "SUCCESS" }],
          mergeCommit: merged ? { oid: "f".repeat(40) } : null, mergedAt: merged ? new Date(clock).toISOString() : null,
        });
        if (args[0] === "api" && args[1]?.includes("/reviews")) return "";
        if (args[0] === "api" && args[1]?.includes("/rules/branches/")) return "[]";
        if (args[0] === "api" && args[1]?.includes("/branches/")) return '["ci"]';
        if (args[0] === "repo") return '{"squashMergeAllowed":true}';
        throw new Error(`unexpected forge read ${args.join(" ")}`);
      },
      write: async args => { writes.push(args); merged = true; return ""; },
    });
    let events = [h.finish("/codex/stage-2.jsonl", "pass")];
    let sweep = Promise.resolve();
    const controller = new FlowPipelineController({ now: () => clock, monotonicNow: () => 0,
      tickPipelines: async () => {
        const entries = events; events = [];
        const result = await tickPipelines(entries, h.ports);
        // Model a Viewer stall after completion was persisted, before the global sweep.
        if (entries.length) clock += stallMs;
        return result;
      },
      sweepAutoMerge: () => { sweep = sweepAutoMerge(ports); },
    }, { maxPasses: 1 });
    const tick = async () => { await controller.tick(); await sweep; };
    pending = true;
    await tick();
    expect(loadPipelines().find(lane => lane.id === id)?.state).toBe("completed");
    await tick();
    expect(loadPipelines().find(lane => lane.id === "original")?.merge?.state).toBe("waiting-checks");
    expect(writes).toHaveLength(0);
    pending = false;
    for (let poll = 0; poll < 7; poll++) { clock += MERGE_POLL_MS; await tick(); }
    expect(loadPipelines().find(lane => lane.id === "original")?.merge).toMatchObject({ state: "merged", mergedHead: head });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(head);
  } finally {
    savePipelines([]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
