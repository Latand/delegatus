import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { boardTask, defaultPipelinePorts, engineModule, harness, rawCreatePipelineFromRequest, realExec, realProvisioningRepo, fs } from "@/lib/pipelines/engine.fixture";
const { buildPipeline, findPipelineRecord, loadPipelines, savePipelines, withPipelineMutation } = await import("@/lib/pipelines/store");
const { loadTasks, saveTasks } = await import("@/lib/tasks/store");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
const { scheduleAutoMerge, resetAutoMergeForTests } = await import("./autoMerge");
const { recoveryRequest } = await import("./postMerge");
import type { Pipeline } from "@/lib/pipelines/types";

const at = "2026-10-30T12:00:00.000Z";
const host = globalThis as typeof globalThis & { __llvIssueDeliveryRunning?: Promise<void> | null; __llvPostMergeRunning?: Promise<void> | null; __llvAutoMergeRunning?: Promise<void> | null };
let cleanup: Array<() => void> = [];
beforeEach(() => { savePipelines([]); saveTasks([]); resetAutoMergeForTests(); });
afterEach(async () => {
  await host.__llvPostMergeRunning; await host.__llvIssueDeliveryRunning;
  await host.__llvAutoMergeRunning;
  for (const restore of cleanup.reverse()) restore();
  cleanup = [];
  setAgentRegistryForTests(null);
});

async function fixture(project = "viewer") {
  const { root, repo, git } = await realProvisioningRepo("recovery-membership");
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(repo, "commit", "--allow-empty", "-m", "Fixture baseline");
  await git(repo, "remote", "add", "origin", "https://github.com/example/recovery-fixture.git");
  const h = harness();
  const registryFile = path.join(root, "registry.json");
  let registry = new AgentRegistry(registryFile);
  setAgentRegistryForTests(registry);
  const ports = { ...h.ports, projectForCwd: () => project, exec: realExec, preflightRepo: defaultPipelinePorts().preflightRepo, spawnAgent: async () => { throw new Error("dispatch forbidden"); } };
  const factory = spyOn(engineModule, "createPipelineFromRequest").mockImplementation((request, _ports, options) => rawCreatePipelineFromRequest(request, ports, options));
  cleanup.push(() => factory.mockRestore());
  const role = { roleId: "builder", engine: "codex", model: "gpt-5.6-sol", effort: "high", access: "read-write", promptScaffold: "Fixture builder" } as const;
  const source = buildPipeline({ id: "source", task: "Deliver the outcome", taskIds: ["outcome-one", "outcome-two"], project, repoDir: repo,
    srcPath: null, srcConversationId: "conversation_source", now: at, stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, onFail: null, effectiveRole: role }] });
  source.state = "completed"; source.cursor = null;
  source.merge = { policyChangedAt: at, reviewedHead: "a".repeat(40), chain: [], updates: [], seenChecks: [], head: null, headSeenAt: null,
    lastChecks: null, readAt: null, nextReadAt: null, requestedAt: at, mergedHead: null, method: "squash", mergedAt: at, attempts: 1,
    reason: null, blockedAt: null, updatedAt: at, state: "merged", by: "auto-merge", postMergeWatch: true, repository: "example/recovery-fixture", prNumber: 7, mergeCommit: "a".repeat(40) };
  savePipelines([source]);
  const seatTask = boardTask("seat-done", project); seatTask.status = "done";
  seatTask.assignments.push({ conversationId: "conversation_seat", path: null, panePid: null, state: "linked", error: null, at });
  saveTasks([boardTask("outcome-one", project), boardTask("outcome-two", project), seatTask]);
  let now = Date.parse(at);
  const logs: string[] = [];
  const sweep = async (seat?: () => Promise<{ srcPath: null; srcConversationId: string } | null>) => {
    scheduleAutoMerge({ now: () => now, loadPipelines, mutate: async (id, change) => withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === id); if (!lane || !change(lane)) return false; await persist(); return true;
    }), setting: () => ({ enabled: false }) as never, prepareRead: async () => {},
    activeSeat: seat ?? (async () => ({ srcPath: null, srcConversationId: "conversation_seat" })),
    run: async args => {
      const route = args[1] ?? "";
      if (route.includes("/rules/")) return "[]";
      if (route.includes("/branches/")) return JSON.stringify(["ci"]);
      if (route.includes("check-runs")) return JSON.stringify({ name: "ci", status: "completed", conclusion: route.includes("parent") ? "success" : "failure", completed_at: at });
      if (route.includes("/status")) return "";
      if (route.includes("/commits/")) return JSON.stringify({ sha: route.endsWith("parent") ? "parent" : "a".repeat(40), parents: [{ sha: "parent" }] });
      throw new Error(`unexpected forge read: ${args.join(" ")}`);
    }, write: async () => { throw new Error("forge write forbidden"); }, log: (message, error) => { logs.push(`${message}: ${String(error ?? "")}`); } });
    await host.__llvPostMergeRunning; await host.__llvIssueDeliveryRunning; await host.__llvAutoMergeRunning;
    now += 60_000;
  };
  const current = () => findPipelineRecord("source")!;
  const repair = () => loadPipelines().find(row => row.id !== "source");
  const reserve = (lane: Pipeline, key: string, stageId = "fix") => registry.beginSpawnRequest({ engine: "codex", transport: "structured", cwd: repo,
    clientAttemptId: key, explicitProject: project, parentConversationId: "conversation_seat",
    origin: { kind: "container", container: "pipeline", containerId: lane.id, creatorConversationId: "conversation_seat" },
    memberships: [{ kind: "pipeline", containerId: lane.id, role: stageId === "review" ? "reviewer" : "builder", stageId, slot: key, stageOrder: 0, round: 1, parentConversationId: "conversation_seat" }],
    launchProfile: emptyLaunchProfile({ cwd: repo, title: "Repair the outcome" }) });
  return { source, current, repair, sweep, logs, factory, reserve, registry: () => registry,
    restartRegistry() { registry = new AgentRegistry(registryFile); setAgentRegistryForTests(registry); } };
}

test("fresh recovery binds every source outcome before reservation and retains it through review, retry and restart", async () => {
  const f = await fixture();
  const seatBefore = loadTasks().find(row => row.id === "seat-done");
  await f.sweep();
  const repair = f.repair();
  expect(f.logs.filter(line => line.includes("failed"))).toEqual([]);
  expect(repair?.taskIds).toEqual(["outcome-one", "outcome-two"]);
  expect(repair?.srcConversationId).toBe("conversation_seat");
  expect(repair?.runs.flatMap(row => row.attempts)).toEqual([]);
  expect(loadTasks().every(row => row.id === "seat-done" || row.assignments.length === 0)).toBe(true);
  const receipt = f.reserve(repair!, "fix-one");
  expect(receipt.kind).toBe("created");
  if (receipt.kind !== "created") throw new Error("expected reservation");
  expect(loadTasks().filter(row => row.assignments.some(a => a.conversationId === receipt.receipt.conversationId)).map(row => row.id)).toEqual(["outcome-one", "outcome-two"]);
  const heldReceipt = structuredClone(f.registry().spawnReceipt(receipt.receipt.launchId));
  for (const [key, stage] of [["review-one", "review"], ["fix-two", "fix"]]) {
    f.restartRegistry();
    const result = f.reserve(findPipelineRecord(repair!.id)!, key!, stage);
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected reservation");
    expect(loadTasks().filter(row => row.assignments.some(a => a.conversationId === result.receipt.conversationId)).map(row => row.id)).toEqual(["outcome-one", "outcome-two"]);
  }
  expect(loadTasks().find(row => row.id === "seat-done")).toEqual(seatBefore);
  f.restartRegistry();
  expect(f.reserve(repair!, "fix-one").kind).toBe("replay");
  expect(f.registry().spawnReceipt(receipt.receipt.launchId)).toEqual(heldReceipt);
  await f.sweep();
  expect(loadPipelines()).toHaveLength(2);
  expect(f.current().merge?.recovery?.fixPipelineId).toBe(repair!.id);
});

test.each(["empty", "deleted", "wrong-project", "unavailable"] as const)("fresh recovery refuses %s source membership and can retry after correction", async kind => {
  const f = await fixture();
  await f.sweep(async () => {
    const rows = loadPipelines();
    if (kind === "empty") rows[0]!.taskIds = [];
    if (kind === "unavailable") rows[0]!.project = "unavailable";
    savePipelines(rows);
    if (kind === "deleted") saveTasks(loadTasks().filter(row => row.id !== "outcome-two"));
    if (kind === "wrong-project") saveTasks(loadTasks().map(row => row.id === "outcome-two" ? { ...row, project: "foreign" } : row));
    return { srcPath: null, srcConversationId: "conversation_seat" };
  });
  expect(f.repair()).toBeUndefined();
  const reason = { empty: "source outcome has no tasks", deleted: "task not found", "wrong-project": "task project does not match", unavailable: "source outcome is unavailable" }[kind]!;
  expect(f.logs.join("\n")).toContain(reason);
  expect(f.current().merge?.recovery?.firstRedAt).toBe(at);
  expect(f.current().merge?.recovery?.fixPipelineId).toBeUndefined();
  const source = f.current(); source.project = "viewer"; source.taskIds = ["outcome-one", "outcome-two"]; savePipelines([source]);
  saveTasks([boardTask("outcome-one"), boardTask("outcome-two")]);
  await f.sweep();
  expect(f.repair()?.taskIds).toEqual(source.taskIds);
});

test("original recovery receipt replays before source validation and preserves manual task corrections", async () => {
  const f = await fixture(); await f.sweep();
  const repair = f.repair()!;
  const first = f.reserve(repair, "original-fix");
  if (first.kind !== "created") throw new Error("expected reservation");
  const assignments = loadTasks();
  // Supported task linking changes the lane; the old launch keeps its admitted targets.
  const linked = await engineModule.patchPipeline(repair.id, { action: "link-task", taskId: "seat-done" });
  expect(linked.error).toBeUndefined();
  const unlinked = await engineModule.patchPipeline(repair.id, { action: "unlink-task", taskId: "outcome-two" });
  expect(unlinked.error).toBeUndefined();
  const rows = loadPipelines(); const source = rows.find(row => row.id === "source")!;
  source.taskIds = []; delete source.merge!.recovery!.fixPipelineId;
  savePipelines(rows);
  saveTasks(loadTasks().filter(row => row.id !== "outcome-two"));
  const before = findPipelineRecord(repair.id);
  f.factory.mockClear();
  await f.sweep(async () => { throw new Error("receipt replay must precede seat lookup"); });
  expect(f.current().merge?.recovery?.fixPipelineId).toBe(repair.id);
  expect(findPipelineRecord(repair.id)).toEqual(before);
  expect(f.factory).not.toHaveBeenCalled();
  expect(loadTasks().find(row => row.id === "outcome-one")?.assignments).toEqual(assignments.find(row => row.id === "outcome-one")?.assignments);
  const originalReceipt = structuredClone(f.registry().spawnReceipt(first.receipt.launchId));
  let refusal: unknown;
  try { f.reserve(findPipelineRecord(repair.id)!, "original-fix"); } catch (error) { refusal = error; }
  expect(refusal).toMatchObject({ status: 409 });
  expect(f.registry().spawnReceipt(first.receipt.launchId)).toEqual(originalReceipt);
});

test("recovery request copies source tasks without modifying the original outcome", async () => {
  const f = await fixture(); await f.sweep();
  const source = f.current(); const request = recoveryRequest(source);
  request.taskIds!.push("other");
  expect(source.taskIds).toEqual(["outcome-one", "outcome-two"]);
});

test.each(["matching", "unrelated", "rejected"] as const)("fresh recovery retains proactive authority: %s", async mode => {
  const project = `recovery-${mode}`;
  const f = await fixture(project);
  const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
  const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
  const episodeNow = NOW + ["matching", "unrelated", "rejected"].indexOf(mode) * 60_000;
  const episode = new Date(episodeNow).toISOString();
  const { task } = await admitProactiveTask({ ...candidate(`recovery-${mode}`), project },
    { ...context(episode), project }, undefined, authority(episodeNow, episode));
  await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, () => new Date(NOW).toISOString());
  const owner = f.registry().beginSpawnRequest({ engine: "codex", transport: "structured", cwd: f.source.repoDir, explicitProject: project,
    taskIds: [task.id], clientAttemptId: `authority-${mode}`, origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: f.source.repoDir, title: "Maintain the outcome" }) });
  if (owner.kind !== "created") throw new Error("expected authority receipt");
  if (mode !== "unrelated") {
    const rows = loadPipelines(); rows[0]!.taskIds.push(task.id); savePipelines(rows);
  }
  if (mode === "rejected") await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task));
  await f.sweep(async () => ({ srcPath: null, srcConversationId: owner.receipt.conversationId }));
  if (mode === "matching") {
    expect(f.logs.filter(line => line.includes("failed"))).toEqual([]);
    expect(f.repair()?.taskIds).toEqual(["outcome-one", "outcome-two", task.id]);
    expect(f.repair()?.srcConversationId).toBe(owner.receipt.conversationId);
  } else {
    expect(f.repair()).toBeUndefined();
    expect(f.logs.join("\n")).toContain(mode === "unrelated" ? "authority requires tasks outside the source outcome" : "rejected");
  }
  expect(f.registry().spawnReceipt(owner.receipt.launchId)?.proactiveTaskIds).toEqual([task.id]);
});
