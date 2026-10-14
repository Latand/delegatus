import { expect, test } from "bun:test";

import type { readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";

import { attentionSystemClears, retiredSeatConversations, type ReconcileFacts } from "./reconcile";
import { reconcileAttentionOnce, type AttentionReconcilePorts } from "./reconcileController";

/*
 * docs/design/attention-auto-resolve.md, acceptance 2: a wait clears itself
 * only on evidence about that exact wait. The 11:18Z panel had three asks
 * from ended seats that had been replaced; those clear. Hints that prove
 * nothing about the ask (a done task, an ended direct session, elapsed time,
 * a message to someone else) clear nothing.
 */

type OrchestratorSeatFile = NonNullable<ReturnType<typeof readOrchestratorSeatFileOrNull>>;
const now = Date.parse("2026-10-11T12:00:00Z") / 1000;
const at = new Date((now - 3600) * 1000).toISOString();

const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  root: "claude-projects", name, path: `/t/${name}.jsonl`, project: "project-a", title: name, kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 3600, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  conversationId: `conversation_${name}`, ...extra,
}) as FileEntry;
const ask = (id: string) => ({ id, messageAt: (now - 3600) * 1000, gist: "Shall I merge?", state: "open" }) as FileEntry["operatorAsk"];

function facts(extra: Partial<ReconcileFacts> = {}): ReconcileFacts {
  return { canonicalConversationId: (id) => id, retiredSeats: new Set(), operatorWroteAt: new Map(), pipeline: () => null, ...extra };
}

test("a replaced seat whose conversation ended clears every reason it raised", () => {
  const prose = file("old-seat-a", { proc: "done", operatorAsk: ask("ask-a") });
  const report = file("old-seat-b", { bridgeAsks: [{ id: "report-1", at, seq: 1, body: "Pick a release day" }, { id: "report-2", at, seq: 2, body: "Merge now?" }] as FileEntry["bridgeAsks"] });
  const live = file("old-seat-c", { proc: "running", activity: "live", operatorAsk: ask("ask-c") });
  const clears = attentionSystemClears([prose, report, live], now, facts({ retiredSeats: new Set(["conversation_old-seat-a", "conversation_old-seat-b", "conversation_old-seat-c"]) }));
  expect(clears).toEqual([
    { conversationId: "conversation_old-seat-a", path: "/t/old-seat-a.jsonl", reason: "ask", raisedAt: now - 3600, reasonId: null, rule: "retired-seat", title: "old-seat-a", project: "project-a" },
    { conversationId: "conversation_old-seat-b", path: "/t/old-seat-b.jsonl", reason: "decision", raisedAt: now - 3600, reasonId: null, rule: "retired-seat", title: "Merge now?", project: "project-a" },
  ]);
});

test("the seat that holds the project now, and a revoked seat that holds another, are not retired", () => {
  const seats = {
    seats: { "project-a": { conversationId: "conversation_current" }, "project-b": { conversationId: "conversation_moved" } },
    pending: {},
    revocations: [{ conversationId: "conversation_gone" }, { conversationId: "conversation_moved" }, { conversationId: "conversation_current" }],
  } as unknown as OrchestratorSeatFile;
  expect([...retiredSeatConversations(seats, (id) => id)]).toEqual(["conversation_gone"]);
  expect(retiredSeatConversations(null, (id) => id).size).toBe(0);
});

test("an operator message after a prose ask clears that ask; one before it, or to another conversation, does not", () => {
  const answered = file("answered", { operatorAsk: ask("ask-1") });
  const earlier = file("earlier", { operatorAsk: ask("ask-2") });
  const wrote = new Map([["conversation_answered", (now - 60) * 1000], ["conversation_earlier", (now - 7200) * 1000]]);
  expect(attentionSystemClears([answered, earlier], now, facts({ operatorWroteAt: wrote }))).toEqual([
    { conversationId: "conversation_answered", path: "/t/answered.jsonl", reason: "ask", raisedAt: now - 3600, reasonId: "ask-1", rule: "operator-replied", title: "answered", project: "project-a" },
  ]);
});

test("a turn after the memory kill clears the kill; an ended session with no turn since keeps it", () => {
  const memoryKill = { at, limit: "agent", limitBytes: 4 * 2 ** 30, fatal: true } as FileEntry["memoryKill"];
  const resumed = file("resumed", { memoryKill, lastTurn: { startedAt: (now - 60) * 1000, endedAt: null } as FileEntry["lastTurn"] });
  const idle = file("idle", { memoryKill, proc: "done", lastTurn: { startedAt: (now - 7200) * 1000, endedAt: (now - 7100) * 1000 } as FileEntry["lastTurn"] });
  expect(attentionSystemClears([resumed, idle], now, facts())).toEqual([
    { conversationId: "conversation_resumed", path: "/t/resumed.jsonl", reason: "memory", raisedAt: now - 3600, reasonId: `/t/resumed.jsonl:memory:${at}`, rule: "resumed", title: "resumed", project: "project-a" },
  ]);
});

test("a stage's wait clears once the attempt that asked settles; a running attempt keeps it", () => {
  const membership = { kind: "pipeline", containerId: "lane", role: "builder", slot: "s", stageId: "build", stageOrder: 0, round: null, parentConversationId: null };
  const stage = file("stage", { durableLineage: { kind: "spawn", role: "builder", depth: 0, parentConversationId: null, reviewsConversationId: null, memberships: [membership] } as FileEntry["durableLineage"],
    pendingPermission: { id: "perm-1", since: at, tool: "Bash", command: "make" } as FileEntry["pendingPermission"] });
  const settledAt = new Date((now - 600) * 1000).toISOString();
  const pipeline = (state: string, completedAt: string | null = state === "running" ? null : settledAt) => ({ id: "lane", runs: [{ stageId: "build", attempts: [{ n: 1, state, conversationId: "conversation_stage", agentPath: null, completedAt }] }] }) as unknown as Pipeline;
  expect(attentionSystemClears([stage], now, facts({ pipeline: () => pipeline("running") }))).toEqual([]);
  expect(attentionSystemClears([stage], now, facts({ pipeline: () => pipeline("needs_decision") }))).toEqual([
    { conversationId: "conversation_stage", path: "/t/stage.jsonl", reason: "permission", raisedAt: now - 3600, reasonId: "/t/stage.jsonl:permission:perm-1", rule: "stage-settled", title: "stage", project: "project-a" },
  ]);
  /* An unreadable lane proves nothing, and neither does a settled attempt
     whose settlement time is not recorded. */
  expect(attentionSystemClears([stage], now, facts())).toEqual([]);
  expect(attentionSystemClears([stage], now, facts({ pipeline: () => pipeline("passed", null) }))).toEqual([]);
});

test("a request raised after the stage attempt settled is newer than the settlement and stays; the attempt's own request still clears", () => {
  const membership = { kind: "pipeline", containerId: "lane", role: "builder", slot: "s", stageId: "build", stageOrder: 0, round: null, parentConversationId: null };
  const lineage = { kind: "spawn", role: "builder", depth: 0, parentConversationId: null, reviewsConversationId: null, memberships: [membership] } as FileEntry["durableLineage"];
  /* The attempt passed at 11:00; the same conversation was resumed and asked
     again at 11:50, in each of the forms a stage asks in. */
  const lane = { id: "lane", runs: [{ stageId: "build", attempts: [{ n: 1, state: "passed", conversationId: "conversation_stage", agentPath: null,
    startedAt: "2026-10-11T10:30:00.000Z", completedAt: "2026-10-11T11:00:00.000Z" }] }] } as unknown as Pipeline;
  const later = "2026-10-11T11:50:00.000Z";
  const newer = [
    file("stage", { durableLineage: lineage, pendingPermission: { id: "perm-2", since: later, tool: "Bash", command: "make" } as FileEntry["pendingPermission"] }),
    file("stage", { durableLineage: lineage, pendingQuestion: { kind: "question", toolUseId: "toolu_late", askedAt: later, questions: [] } as unknown as FileEntry["pendingQuestion"] }),
    file("stage", { durableLineage: lineage, operatorAsk: { id: "ask-late", messageAt: Date.parse(later), gist: "Merge it?", state: "open" } as FileEntry["operatorAsk"] }),
  ];
  for (const entry of newer) expect(attentionSystemClears([entry], now, facts({ pipeline: () => lane }))).toEqual([]);
  /* A reason whose time is only the transcript's mtime proves nothing either. */
  const unclocked = file("stage", { durableLineage: lineage, pendingPermission: { id: "perm-0", since: "", tool: "Bash", command: "make" } as FileEntry["pendingPermission"] });
  expect(attentionSystemClears([unclocked], now, facts({ pipeline: () => lane }))).toEqual([]);

  const obsolete = file("stage", { durableLineage: lineage, pendingPermission: { id: "perm-1", since: "2026-10-11T10:45:00.000Z", tool: "Bash", command: "make" } as FileEntry["pendingPermission"] });
  expect(attentionSystemClears([obsolete], now, facts({ pipeline: () => lane }))).toEqual([
    { conversationId: "conversation_stage", path: "/t/stage.jsonl", reason: "permission", raisedAt: Date.parse("2026-10-11T10:45:00.000Z") / 1000, reasonId: "/t/stage.jsonl:permission:perm-1", rule: "stage-settled", title: "stage", project: "project-a" },
  ]);
});

test("hints clear nothing: an ended direct session, a dismissed reason, an owed delivery and a failed launch stay", () => {
  const ended = file("ended", { proc: "done", operatorAsk: ask("ask-ended") });
  const dismissed = file("dismissed", { proc: "done", operatorAsk: ask("ask-dismissed"), attentionDismissal: { at, by: { kind: "operator" }, reasonId: "ask-dismissed" } });
  const delivery = file("delivery", { proc: "done", stuckDelivery: { state: "delivery-uncertain", since: at } as FileEntry["stuckDelivery"] });
  const retired = new Set(["conversation_delivery"]);
  expect(attentionSystemClears([ended, dismissed, delivery], now, facts({ retiredSeats: retired }))).toEqual([]);
});

test("one pass reads the board, writes what the rules prove and tells the board; a pass with nothing proven writes nothing", async () => {
  const writes: unknown[] = [];
  let announced = 0;
  const board = { files: [file("old-seat", { proc: "done", operatorAsk: ask("ask-a") })], pipelines: [] };
  const ports = (retired: string[]): AttentionReconcilePorts => ({
    now: () => new Date(now * 1000),
    board: async () => board,
    facts: () => facts({ retiredSeats: new Set(retired) }),
    write: (clears) => { writes.push(...clears); return [...clears]; },
    announce: async () => { announced += 1; },
  });
  expect(await reconcileAttentionOnce(ports([]))).toEqual([]);
  expect(writes).toEqual([]);
  expect(announced).toBe(0);
  expect(await reconcileAttentionOnce(ports(["conversation_old-seat"]))).toHaveLength(1);
  expect(announced).toBe(1);
});

test("failed launches clear only when their task is done or a different assignment superseded them", () => {
  const launch = file("launch", { path: "spawn:launch-a", spawn: { state: "failed", admittedAt: (now - 3600) * 1000 } as FileEntry["spawn"] });
  const assignment = { launchId: "launch-a", conversationId: launch.conversationId, path: launch.path, at, panePid: null, state: "failed" as const, error: null };
  const task = { id: "task-a", project: launch.project, status: "assigned", assignments: [assignment] } as unknown as BoardTask;
  const evaluate = (tasks?: BoardTask[]) => attentionSystemClears([launch], now, facts({ tasks }));
  expect(evaluate()).toEqual([]);
  expect(evaluate([task])).toEqual([]);
  const later = new Date((now - 60) * 1000).toISOString();
  // Recording the original assignment after admission is no relaunch.
  expect(evaluate([{ ...task, assignments: [{ ...assignment, at: later }] }])).toEqual([]);
  expect(evaluate([{ ...task, assignments: [assignment, { ...assignment, launchId: "launch-b", conversationId: "conversation_later", path: "/t/later.jsonl", at }] }])).toEqual([]);
  expect(evaluate([{ ...task, assignments: [assignment, { ...assignment, launchId: "launch-b", conversationId: "conversation_later", path: "/t/later.jsonl", at: later }] }])).toMatchObject([
    { path: launch.path, reason: "launch", reasonId: "spawn:launch-a:launch-failed", rule: "launch-relaunched" },
  ]);
  expect(evaluate([{ ...task, status: "done" }])).toMatchObject([
    { path: launch.path, reason: "launch", reasonId: "spawn:launch-a:launch-failed", rule: "launch-task-done" },
  ]);
  expect(evaluate([{ ...task, status: "done", assignments: [{ ...assignment, launchId: "unrelated", conversationId: "conversation_other", path: "/t/other.jsonl" }] }])).toEqual([]);
});
