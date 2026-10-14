import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { BoardTask } from "@/lib/tasks/types";

/**
 * The launch boundary against the real registry and the real task store
 * (#1586): a dedicated task launch joins its task and nothing else, a resume
 * successor keeps its conversation's task, and a queued pinned receipt that is
 * recovered for its first execution passes the membership prerequisite before
 * anything is actuated — an unavailable store fails the launch instead.
 */

const previousStateDir = process.env.LLV_STATE_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-launch-membership-"));
process.env.LLV_STATE_DIR = stateDir;
const { AgentRegistry } = await import("@/lib/agent/registry");
const { loadTasks, saveTasks, TASKS_FILE } = await import("@/lib/tasks/store");
const { terminalizeStaleStructuredSpawns } = await import("@/lib/runtime/structuredSpawn");
const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const now = "2026-09-09T12:00:00.000Z";
const project = "fixture-project";
function task(id: string, text: string, assignments: BoardTask["assignments"] = []): BoardTask {
  return { id, project, status: "inbox", text, placement: "unplaced", assignments, createdAt: now, updatedAt: now };
}
function registryAt(name: string) {
  return new AgentRegistry(path.join(stateDir, `${name}.json`), undefined, undefined, { sqliteMode: "off" });
}
const holders = (conversationId: string) => loadTasks().filter((candidate) => candidate.assignments.some((assignment) => assignment.conversationId === conversationId)).map((candidate) => candidate.id);

test("a read-only launch has a named, described task before its first turn, including failure and replay", () => {
  saveTasks([]);
  const registry = registryAt("named-read-only");
  const request = {
    engine: "codex" as const, cwd: stateDir, explicitProject: project, transport: "structured" as const,
    clientAttemptId: "named_read_only", origin: { kind: "operator" as const }, role: "verifier",
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Verify export retries" }),
    launchDisplay: { prompt: "Check that failed exports retry safely.\nReturn the verification evidence.", images: 0, echo: "Private role scaffold" },
  };
  const reserved = registry.beginSpawnRequest(request);
  if (reserved.kind !== "created") throw new Error("expected reservation");
  expect(loadTasks()).toHaveLength(1);
  const [named] = loadTasks();
  expect(named!.text).toBe("Verify export retries\nCheck that failed exports retry safely.");
  expect(named!.origin).toEqual({ kind: "launch", key: request.clientAttemptId, refinement: "titled" });
  expect(named!.assignments.map(row => [row.conversationId, row.launchId])).toEqual([[reserved.receipt.conversationId, reserved.receipt.launchId]]);
  registry.failStructuredSpawn(reserved.receipt.launchId, "host unavailable before first turn");
  expect(registry.beginSpawnRequest(request).kind).toBe("replay");
  expect(loadTasks()).toHaveLength(1);
  expect(loadTasks()[0]!.text).toBe(named!.text);
  expect(loadTasks()[0]!.origin?.refinement).toBe("titled");
  expect(loadTasks()[0]!.assignments).toHaveLength(1);
});

test("a task-less pipeline reviewer joins its source's work at reservation", () => {
  saveTasks([task("reviewed-work", "Keep this task title")]);
  const registry = registryAt("pipeline-inheritance");
  const owner = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "structured", clientAttemptId: "reviewed_owner", origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Implement the work" }), taskIds: ["reviewed-work"] });
  if (owner.kind !== "created") throw new Error("expected owner");
  const reviewer = registry.beginSpawnRequest({ engine: "codex", cwd: stateDir, explicitProject: project, transport: "structured", clientAttemptId: "pipeline_review", role: "reviewer", parentConversationId: owner.receipt.conversationId,
    origin: { kind: "container", container: "pipeline", containerId: "review-lane", creatorConversationId: null },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Review the work" }) });
  if (reviewer.kind !== "created") throw new Error("expected reviewer");
  expect(holders(reviewer.receipt.conversationId)).toEqual(["reviewed-work"]);
  expect(loadTasks()).toHaveLength(1);
  expect(loadTasks()[0]!.text).toBe("Keep this task title");
});

test("a task-less pipeline is described from its spec before a read-only launch fails, and retries reuse its card", () => {
  saveTasks([]);
  savePipelines([buildPipeline({ id: "described-lane", task: "Restore export retries", taskIds: [],
    spec: "---\nRestore retries after transient export failures.\nKeep completed exports unchanged.",
    project, repoDir: stateDir, stages: [{ id: "verify", kind: "run", prompt: "Verify export retries", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now })]);
  try {
    const registry = registryAt("pipeline-description");
    const request = { engine: "codex" as const, cwd: stateDir, explicitProject: project, transport: "structured" as const,
      clientAttemptId: "described_pipeline_verify", role: "verifier",
      origin: { kind: "container" as const, container: "pipeline" as const, containerId: "described-lane", creatorConversationId: null },
      launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Restore export retries · verify", readOnly: true }) };
    const first = registry.beginSpawnRequest(request);
    if (first.kind !== "created") throw new Error("expected reservation");
    const [card] = loadTasks();
    expect(card!.text).toBe("Restore export retries · verify\nRestore retries after transient export failures.");
    expect(card!.origin?.refinement).toBe("titled");
    expect(card!.assignments).toHaveLength(1);
    registry.failStructuredSpawn(first.receipt.launchId, "host unavailable before first turn");
    expect(registry.beginSpawnRequest(request)).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId } });
    const retry = registry.beginSpawnRequest({ ...request, clientAttemptId: "described_pipeline_verify_retry" });
    expect(retry.kind).toBe("created");
    expect(loadTasks()).toHaveLength(1);
    expect(loadTasks()[0]!.id).toBe(card!.id);
    expect(loadTasks()[0]!.text).toBe(card!.text);
    expect(loadTasks()[0]!.assignments).toHaveLength(2);
  } finally {
    savePipelines([]);
  }
});

test("replay without a title retains the operator's title, receipt, task and assignment while an explicit change conflicts", () => {
  saveTasks([]);
  const registry = registryAt("operator-title-replay");
  const request = { engine: "codex" as const, cwd: stateDir, explicitProject: project, transport: "structured" as const,
    clientAttemptId: "operator_title_replay", origin: { kind: "operator" as const },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Operator-chosen export audit" }),
    launchDisplay: { prompt: "Inspect export retry ownership.", images: 0, echo: "Role scaffold" } };
  const first = registry.beginSpawnRequest(request);
  expect(first.kind).toBe("created");
  const cards = loadTasks();
  const restarted = registryAt("operator-title-replay");
  const replay = restarted.beginSpawnRequest({ ...request, launchProfile: undefined });
  expect(replay).toEqual({ kind: "replay", receipt: first.receipt });
  expect(loadTasks()).toEqual(cards);
  expect(restarted.beginSpawnRequest({ ...request, launchProfile: { title: "Another export audit" } }).kind).toBe("conflict");
  expect(loadTasks()).toEqual(cards);
});

test("a prompt-only reservation derives its title and description before recovery can execute it", async () => {
  saveTasks([]);
  const registry = registryAt("prompt-only");
  const request = {
    engine: "claude" as const, cwd: stateDir, explicitProject: project, transport: "structured" as const,
    clientAttemptId: "prompt_only", origin: { kind: "operator" as const }, role: "architect",
    launchDisplay: { prompt: "---\nInspect export retry ownership.\nReport the unsafe transitions.", images: 0, echo: "Role scaffold" },
  };
  const reserved = registry.beginSpawnRequest(request);
  if (reserved.kind !== "created") throw new Error("expected reservation");
  expect(loadTasks()[0]!.text).toBe("Inspect export retry ownership.\nInspect export retry ownership.");
  expect(loadTasks()[0]!.origin?.refinement).toBe("titled");
  expect(reserved.receipt.launchProfile.title).toBe("Inspect export retry ownership.");
  const { admitRecoveredLaunch } = await import("./launchMembership");
  const recovered = admitRecoveredLaunch(reserved.receipt);
  expect(recovered.ok && recovered.created).toEqual([]);
  expect(registry.beginSpawnRequest(request).kind).toBe("replay");
  expect(loadTasks()).toHaveLength(1);
  expect(loadTasks()[0]!.assignments).toHaveLength(1);
});

test("reviewers, fixers, merge helpers and maintenance join existing work; an unowned launch gets one placeholder", () => {
  saveTasks([task("served-work", "An operator's work", [])]);
  const registry = registryAt("service-membership");
  const owner = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "structured", clientAttemptId: "service_owner", origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Implement the work" }), taskIds: ["served-work"] });
  if (owner.kind !== "created") throw new Error("expected owner");
  for (const [name, role] of [["reviewer", "reviewer"], ["fixer", "builder"], ["merge-helper", "builder"], ["maintenance", "maintainer"]]) {
    const request = { engine: "codex" as const, cwd: stateDir, transport: "structured" as const, clientAttemptId: `service_${name}`, role,
      origin: { kind: "operator" as const }, parentConversationId: owner.receipt.conversationId,
      ...(role === "reviewer" ? { reviewsConversationId: owner.receipt.conversationId } : {}),
      launchProfile: emptyLaunchProfile({ cwd: stateDir, title: `Serve the work: ${name}` }) };
    const reserved = registry.beginSpawnRequest(request);
    if (reserved.kind !== "created") throw new Error("expected service reservation");
    expect(holders(reserved.receipt.conversationId)).toEqual(["served-work"]);
    expect(registry.beginSpawnRequest(request).kind).toBe("replay");
    expect(loadTasks()).toHaveLength(1);
    expect(loadTasks()[0]!.text).toBe("An operator's work");
  }
  const request = { engine: "claude" as const, cwd: stateDir, transport: "structured" as const, clientAttemptId: "unowned_work", origin: { kind: "operator" as const },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Work without an owner" }) };
  const unowned = registry.beginSpawnRequest(request);
  if (unowned.kind !== "created") throw new Error("expected unowned reservation");
  expect(registry.beginSpawnRequest(request).kind).toBe("replay");
  expect(loadTasks()).toHaveLength(2);
  expect(holders(unowned.receipt.conversationId)).toHaveLength(1);
  expect(loadTasks().find(t => t.id !== "served-work")!.origin?.refinement).toBe("titled");
});

test("a dedicated task launch joins exactly its task at the reservation; the replay and the resume successor stay there", () => {
  saveTasks([task("dedicated", "Dedicated task")]);
  const registry = registryAt("dedicated");
  const begun = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "task_dedicated_attempt_1", requestDigest: "a".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }), taskIds: ["dedicated"] });
  if (begun.kind !== "created") throw new Error("expected a fresh reservation");
  expect(loadTasks().length).toBe(1);
  expect(holders(begun.receipt.conversationId)).toEqual(["dedicated"]);
  expect(loadTasks()[0]!.assignments).toEqual([expect.objectContaining({ launchId: begun.receipt.launchId, clientAttemptId: "task_dedicated_attempt_1", conversationId: begun.receipt.conversationId, state: "linked" })]);

  const replay = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "task_dedicated_attempt_1", requestDigest: "a".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }), taskIds: ["dedicated"] });
  expect(replay.kind).toBe("replay");
  expect(loadTasks().length).toBe(1);

  /* The conversation settles, then resumes with a fresh launch id. */
  const settled = registry.ensureConversation("claude", path.join(stateDir, "dedicated.jsonl"), null);
  saveTasks([task("dedicated", "Dedicated task", [{ launchId: begun.receipt.launchId, clientAttemptId: "task_dedicated_attempt_1", path: path.join(stateDir, "dedicated.jsonl"), conversationId: settled.id, panePid: null, state: "delivered", error: null, at: now }])]);
  const resumed = registry.beginSpawnRequest({ engine: "claude", cwd: path.join(stateDir, "another-checkout"), transport: "structured", conversationId: settled.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }) });
  if (resumed.kind !== "created") throw new Error("expected the resume reservation");
  expect(resumed.receipt.conversationId).toBe(settled.id);
  expect(loadTasks().length).toBe(1);
  expect(holders(settled.id)).toEqual(["dedicated"]);
  expect(loadTasks()[0]!.assignments).toEqual([expect.objectContaining({ launchId: begun.receipt.launchId, conversationId: settled.id, state: "delivered" })]);

  /* A missing target aborts the reservation: no receipt survives, no task is minted. */
  expect(() => registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "task_dedicated_attempt_2", requestDigest: "b".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Dedicated task" }), taskIds: ["deleted-task"] })).toThrow("task deleted-task is not available");
  expect(registry.spawnReceiptForClientAttempt("task_dedicated_attempt_2")).toMatchObject({ state: "failed" });
  expect(loadTasks().length).toBe(1);
});

function queuedTmuxReceipt(registry: InstanceType<typeof AgentRegistry>, attempt: string, retryAt: string, taskIds?: string[]) {
  const begun = registry.beginSpawnRequest({
    engine: "claude",
    cwd: stateDir,
    transport: "tmux",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: attempt,
    requestDigest: "c".repeat(64),
    origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Queued work" }),
    launchDisplay: { prompt: "Continue the queued work", images: 0, echo: "Continue the queued work" },
    ...(taskIds ? { taskIds } : {}),
  });
  if (begun.kind !== "created") throw new Error("expected queued receipt creation");
  registry.queuePinnedSpawn(begun.receipt.launchId, {
    version: 1,
    retryAt,
    accountId: "account-a",
    locale: "en",
    spec: { engine: "claude", command: "claude", cwd: stateDir, windowName: "queued-pin", launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Queued work" }) },
    ["prompt"]: "Continue the queued work",
    imageRefs: [],
    parentArtifactPath: null,
    pipelineSourceConversationId: null,
  }, `Pinned account quota is exhausted — queued until ${retryAt}`);
  return begun.receipt;
}

const account = { engine: "claude" as const, accountId: "account-a", kind: "managed" as const, home: path.join(stateDir, "account-a"), transcriptRoot: path.join(stateDir, "account-a", "projects"), env: { NODE_ENV: "test" as const } };

test("a queued pinned launch recovered for its first execution keeps the membership recorded at reservation, and a deleted target is replaced before actuation", async () => {
  saveTasks([task("queued-target", "Target of a queued launch")]);
  const registry = registryAt("queued");
  const retryAt = new Date(Date.now() - 1_000).toISOString();
  const kept = queuedTmuxReceipt(registry, "queued_kept_attempt", retryAt, ["queued-target"]);
  const orphaned = queuedTmuxReceipt(registry, "queued_orphaned_attempt", retryAt, ["queued-target"]);
  expect(holders(kept.conversationId)).toEqual(["queued-target"]);
  /* The second launch loses its membership row while it waits in the queue
     (its target deleted, or its write lost); the first keeps its row. */
  saveTasks(loadTasks().map((candidate) => ({ ...candidate, assignments: candidate.assignments.filter((assignment) => assignment.conversationId !== orphaned.conversationId) })));
  const spawned: string[] = [];
  const restarted = registryAt("queued");
  const tick = await terminalizeStaleStructuredSpawns(restarted, null, {
    now: () => Date.now(),
    resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    spawnTmuxAgent: async (_spec, _prompt, receipt) => {
      spawned.push(receipt?.launchId ?? "unknown");
      throw new Error("stop at the actuation seam");
    },
  });
  expect(tick.examined).toBe(2);
  expect(spawned.sort()).toEqual([kept.launchId, orphaned.launchId].sort());
  expect(loadTasks().length).toBe(2);
  expect(holders(kept.conversationId)).toEqual(["queued-target"]);
  const replacement = loadTasks().find((candidate) => candidate.id !== "queued-target")!;
  expect(replacement.origin).toEqual({ kind: "launch", key: "queued_orphaned_attempt", refinement: "titled" });
  expect(holders(orphaned.conversationId)).toEqual([replacement.id]);
});

test("an unavailable task store keeps a recovered queued launch from executing: the receipt fails and no agent is started", async () => {
  saveTasks([]);
  const registry = registryAt("queued-unavailable");
  const receipt = queuedTmuxReceipt(registry, "queued_unavailable_attempt", new Date(Date.now() - 1_000).toISOString());
  expect(loadTasks().length).toBe(1);
  /* The store becomes unreadable between reservation and recovery: a
     malformed row lands under a new collection revision (#1870). */
  const database = path.join(path.dirname(TASKS_FILE), "state.sqlite");
  const corrupt = (sql: string) => {
    const { Database } = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(database);
    try {
      db.exec(sql);
      db.exec("UPDATE state_collections SET revision = revision + 1 WHERE collection = 'tasks'");
    } finally {
      db.close();
    }
  };
  corrupt(`INSERT INTO state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)
    VALUES ('tasks', 't:broken', '{"id":"broken","status":"inbox"}', 1000000, 0, 1)`);
  try {
    const spawned: string[] = [];
    const restarted = registryAt("queued-unavailable");
    const tick = await terminalizeStaleStructuredSpawns(restarted, null, {
      now: () => Date.now(),
      resolveSpawnAccount: () => account,
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async (_spec, _prompt, claimed) => {
        spawned.push(claimed?.launchId ?? "unknown");
        throw new Error("an agent must not start outside every task");
      },
    });
    expect(tick).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
    expect(spawned).toEqual([]);
    const failed = restarted.snapshot().receipts[receipt.launchId]!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("task membership could not be recorded");
  } finally {
    corrupt("DELETE FROM state_rows WHERE collection = 'tasks' AND row_key = 't:broken'");
  }
});

test("a fresh launch that fails before it runs leaves its task in Inbox with the failed launch on it; a failed resume keeps its conversation's row", () => {
  saveTasks([task("inbox-task", "Task the launch was for")]);
  const registry = registryAt("failed-fresh");
  const begun = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "structured", accountId: "default", accountPin: true, clientAttemptId: "failed_fresh_attempt", requestDigest: "d".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Task the launch was for" }), taskIds: ["inbox-task"] });
  if (begun.kind !== "created") throw new Error("expected a fresh reservation");
  /* Admission links the launch before anything runs, which moves the task. */
  expect(loadTasks()[0]).toMatchObject({ status: "assigned" });

  registry.failStructuredSpawn(begun.receipt.launchId, "No healthy Claude account is available. Re-login Main in Accounts and retry.");
  const [settled] = loadTasks();
  expect(settled!.status).toBe("inbox");
  expect(settled!.assignments).toEqual([expect.objectContaining({
    launchId: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    state: "failed",
    error: "No healthy Claude account is available. Re-login Main in Accounts and retry.",
  })]);

  /* The tmux path settles the same way. */
  saveTasks([task("tmux-task", "Tmux launch target")]);
  const tmux = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "tmux", clientAttemptId: "failed_tmux_attempt", requestDigest: "e".repeat(64), origin: { kind: "operator" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Tmux launch target" }), taskIds: ["tmux-task"] });
  if (tmux.kind !== "created") throw new Error("expected a fresh reservation");
  registry.failSpawn(tmux.receipt.launchId, "spawn failed before pane binding");
  expect(loadTasks()[0]).toMatchObject({ status: "inbox", assignments: [expect.objectContaining({ state: "failed", error: "spawn failed before pane binding" })] });

  /* A resume successor continues a conversation whose row predates it. */
  const live = registry.ensureConversation("claude", path.join(stateDir, "resumed.jsonl"), null);
  saveTasks([{ ...task("resumed-task", "Resumed work", [{ path: path.join(stateDir, "resumed.jsonl"), conversationId: live.id, panePid: null, state: "linked", error: null, at: now }]), status: "assigned" }]);
  const resumed = registry.beginSpawnRequest({ engine: "claude", cwd: stateDir, transport: "structured", conversationId: live.id, purpose: "resume-successor", origin: { kind: "successor" }, launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Resumed work" }) });
  if (resumed.kind !== "created") throw new Error("expected the resume reservation");
  registry.failStructuredSpawn(resumed.receipt.launchId, "resume failed");
  expect(loadTasks()[0]).toMatchObject({ status: "assigned", assignments: [expect.objectContaining({ conversationId: live.id, state: "linked" })] });
});


test.each(["sync", "off-loop"] as const)("a lost seat launch reports once and preserves the task's pre-launch status (%s)", async mode => {
  const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
  const { pendingSpawnNotices } = await import("@/lib/spawnNotice/store");
  saveTasks([{ ...task("assigned-loss", "Already assigned work"), status: "assigned" }, task("inbox-loss", "Inbox work")]);
  const registry = registryAt(`seat-loss-${mode}`);
  const request = {
    engine: "codex" as const, cwd: stateDir, explicitProject: project, transport: "structured" as const,
    clientAttemptId: `seat_loss_${mode}`, role: "builder", taskIds: ["assigned-loss", "inbox-loss"],
    launcher: { conversationId: "conversation_fixture_seat" as const, notify: false },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Restore lost work" }),
  };
  const begun = registry.beginSpawnRequest(request);
  if (begun.kind !== "created") throw new Error("expected launch");
  const reason = "no rollout found for thread id";
  if (mode === "sync") registry.failStructuredSpawn(begun.receipt.launchId, reason);
  else await registry.failStructuredSpawnOffLoop(begun.receipt.launchId, reason);
  expect(registry.spawnReceiptForClientAttempt(request.clientAttemptId)).toMatchObject({ state: "failed", error: reason });
  expect(loadTasks().map(t => [t.id, t.status, t.assignments[0]!.state])).toEqual([
    ["assigned-loss", "assigned", "failed"], ["inbox-loss", "inbox", "failed"],
  ]);
  const events = () => queryLifecycleEvents({ conversationId: begun.receipt.conversationId }).events;
  const notices = () => pendingSpawnNotices().filter(row => row.childConversationId === begun.receipt.conversationId);
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({ type: "spawn_failed", state: "failed", project, conversationId: begun.receipt.conversationId, role: "builder" });
  expect(events()[0]!.summary).toContain("Restore lost work");
  expect(events()[0]!.summary).toContain(reason);
  expect(notices()).toHaveLength(1);
  expect(notices()[0]).toMatchObject({ outcome: "lost", launcherConversationId: request.launcher.conversationId,
    turnId: `launch:${begun.receipt.launchId}`, lost: { launchId: begun.receipt.launchId, title: "Restore lost work", reason,
      tasks: [{ taskId: "assigned-loss", from: "assigned", to: "assigned" }, { taskId: "inbox-loss", from: "assigned", to: "inbox" }] } });
  registry.failStructuredSpawn(begun.receipt.launchId, "duplicate failure");
  expect(registry.beginSpawnRequest(request).kind).toBe("replay");
  expect(events()).toHaveLength(1);
  expect(notices()).toHaveLength(1);
});


test.each(["refusal", "rejection", "resume", "materialized", "root", "self"] as const)("failed launch announcements exclude %s", async guard => {
  const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
  const { pendingSpawnNotices } = await import("@/lib/spawnNotice/store");
  const { settleFailedLaunch } = await import("./launchMembership");
  const registry = registryAt(`loss-guard-${guard}`);
  saveTasks([task("guard-target", "Failure guard")]);
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: stateDir, explicitProject: project,
    transport: "structured", clientAttemptId: `loss_guard_${guard}`, taskIds: ["guard-target"],
    launcher: guard === "root" ? null : { conversationId: "conversation_fixture_seat", notify: true },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Guarded launch" }),
  });
  if (begun.kind !== "created") throw new Error("expected launch");
  if (guard === "refusal") {
    registry.failStructuredSpawn(begun.receipt.launchId, "synchronous refusal", { announce: false });
  } else if (guard === "root") {
    registry.failStructuredSpawn(begun.receipt.launchId, "root failure");
  } else {
    settleFailedLaunch({ ...begun.receipt, error: "guarded failure",
      ...(guard === "rejection" ? { rejection: { guidance: "refused" } } : {}),
      ...(guard === "resume" ? { purpose: "resume-successor" } : {}),
      ...(guard === "materialized" ? { artifactLifecycle: "materialized" } : {}),
      ...(guard === "self" ? { launcher: { conversationId: begun.receipt.conversationId, notify: true } } : {}),
    });
  }
  expect(queryLifecycleEvents({ conversationId: begun.receipt.conversationId }).events).toEqual([]);
  expect(pendingSpawnNotices().filter(row => row.childConversationId === begun.receipt.conversationId)).toEqual([]);
});

test.each(["journal", "notice"] as const)("a failed receipt repairs its refused %s report after a reaper restart", async refused => {
  const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
  const { pendingSpawnNotices } = await import("@/lib/spawnNotice/store");
  const { settleFailedLaunch } = await import("./launchMembership");
  const registry = registryAt(`report-retry-${refused}`);
  saveTasks([task(`report-${refused}`, "Recover the report")]);
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: stateDir, explicitProject: "child-project",
    transport: "structured", clientAttemptId: `report_retry_${refused}`, taskIds: [`report-${refused}`],
    launcher: { conversationId: "conversation_fixture_launcher", notify: true },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Recover the report" }) });
  if (begun.kind !== "created") throw new Error("expected launch");
  registry.rememberMembership("conversation_fixture_launcher", { kind: "orchestrator", containerId: "launcher-project",
    role: "orchestrator", slot: "seat", stageId: null, stageOrder: null, round: null, parentConversationId: null });
  registry.failStructuredSpawn(begun.receipt.launchId, "host vanished", { announce: false });
  const failOnce = () => { throw new Error("temporary transaction refusal"); };
  settleFailedLaunch(registry.snapshot().receipts[begun.receipt.launchId]!, undefined, {
    launcherProject: "launcher-project",
    ...(refused === "journal" ? { appendLifecycleEvents: failOnce } : { recordSpawnNoticeObligation: failOnce }),
  });

  const restarted = registryAt(`report-retry-${refused}`);
  await terminalizeStaleStructuredSpawns(restarted, null);
  const events = queryLifecycleEvents({ conversationId: begun.receipt.conversationId }).events;
  const notices = pendingSpawnNotices().filter(row => row.childConversationId === begun.receipt.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "spawn_failed", project: "launcher-project" });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ launcherConversationId: "conversation_fixture_launcher", outcome: "lost",
    lost: { tasks: [{ taskId: `report-${refused}`, from: "inbox", to: "inbox" }] } });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]!.state).toBe("failed");
});

test("a failed child in another project writes its wake event into the launching seat's project", async () => {
  const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
  const { settleFailedLaunch } = await import("./launchMembership");
  const registry = registryAt("cross-project-report");
  saveTasks([task("cross-project-task", "Work in another project")]);
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: stateDir, explicitProject: "child-project",
    transport: "structured", clientAttemptId: "cross_project_report", taskIds: ["cross-project-task"],
    launcher: { conversationId: "conversation_fixture_launcher", notify: true },
    launchProfile: emptyLaunchProfile({ cwd: stateDir, title: "Cross project launch" }) });
  if (begun.kind !== "created") throw new Error("expected launch");
  registry.rememberMembership("conversation_fixture_launcher", { kind: "orchestrator", containerId: "launcher-project",
    role: "orchestrator", slot: "seat", stageId: null, stageOrder: null, round: null, parentConversationId: null });
  registry.failStructuredSpawn(begun.receipt.launchId, "host vanished", { announce: false });
  settleFailedLaunch(registry.snapshot().receipts[begun.receipt.launchId]!, undefined, { launcherProject: "launcher-project" });
  expect(queryLifecycleEvents({ project: "launcher-project", conversationId: begun.receipt.conversationId, type: "spawn_failed" }).events)
    .toEqual([expect.objectContaining({ conversationId: begun.receipt.conversationId })]);
  expect(queryLifecycleEvents({ project: "child-project", conversationId: begun.receipt.conversationId, type: "spawn_failed" }).events).toEqual([]);
});
