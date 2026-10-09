import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { readAttentionDismissals, type DismissalPorts } from "@/lib/attention/dismissals";
import type { DismissedBy } from "@/lib/attention/dismissalTypes";
import { resetLegacyDocumentStoresForTests } from "@/lib/state/legacyDocumentStore";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { callerAttributionFrom, viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, type McpToolResult } from "./server";

/*
 * `dismiss_attention` (docs/design/needs-attention.md §5): an agent clears a
 * needs-you flag through the same service a card's click uses. Who may is
 * `request_attention`'s gate: the operator's own root session, or the target
 * project's designated seat. A worker is refused with nothing written, so a
 * stage agent cannot clear its own question off the operator's board. The
 * real store writes into a sandboxed state directory; the registry, the task
 * store and the engine are stood in for.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-dismiss-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  resetLegacyDocumentStoresForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const PROJECT = "viewer";
const SEAT = "conversation_seat";
const MANAGER: AttentionCallerAuthority = { kind: "worker", conversationId: SEAT, role: "orchestrator" };
const WORKER: AttentionCallerAuthority = { kind: "worker", conversationId: "conversation_worker", role: "builder" };
const ROOT: AttentionCallerAuthority = { kind: "root", conversationId: "conversation_root" };
const OTHER_SEAT: AttentionCallerAuthority = { kind: "worker", conversationId: "conversation_other_seat", role: "orchestrator" };
const SEATS = [
  { conversationId: SEAT, path: "/seat.jsonl", project: PROJECT },
  { conversationId: "conversation_other_seat", path: "/other-seat.jsonl", project: "elsewhere" },
];

const TASK = { id: "task-1", project: PROJECT, assignments: [{ path: "/t/asker.jsonl", conversationId: "conversation_asker", state: "delivered" }] } as unknown as BoardTask;
const ASKER = { path: "/t/asker.jsonl", conversationId: "conversation_asker", project: PROJECT, title: "Asker", engine: "claude" } as unknown as FileEntry;

interface World {
  lanes: Map<string, Pipeline>;
  writes: Array<{ pipelineId: string; dismiss: boolean; by: DismissedBy }>;
}

function world(): World {
  const parked = {
    id: "lane-1",
    project: PROJECT,
    state: "needs_decision",
    taskIds: ["task-1"],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", startedAt: "2026-09-24T09:00:00.000Z", completedAt: "2026-09-24T09:30:00.000Z" }] }],
  } as unknown as Pipeline;
  const running = { ...parked, id: "lane-running", state: "running" } as Pipeline;
  return { lanes: new Map([[parked.id, parked], [running.id, running]]), writes: [] };
}

function ports(state: World): DismissalPorts {
  return {
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    resolveConversation: (ref) => (ref.conversationId === "conversation_asker" || ref.path === ASKER.path ? { conversationId: "conversation_asker", path: ASKER.path } : null),
    task: (taskId) => (taskId === TASK.id ? TASK : null),
    pipelines: () => [...state.lanes.values()],
    pipeline: (pipelineId) => state.lanes.get(pipelineId) ?? null,
    setPipelineDismissal: async (pipelineId, dismiss, by) => {
      state.writes.push({ pipelineId, dismiss, by });
      const next = { ...state.lanes.get(pipelineId)!, dismissedAt: dismiss ? "2026-09-24T10:00:00.000Z" : null, dismissedBy: dismiss ? by : undefined } as Pipeline;
      state.lanes.set(pipelineId, next);
      return { pipeline: next };
    },
    resolveReports: () => ({ resolved: [], alreadyClear: [], unknown: [] }),
  };
}

function serviceAs(authority: AttentionCallerAuthority, state: World = world(), receipts = new MemoryMcpReceiptStore(), overrides: object = {}, control?: import("./bindings").ViewerControlDependencies) {
  return createMcpToolService(
    viewerMcpBindings(undefined, control, {
      attentionAuthority: () => authority,
      authorizedSeats: () => SEATS,
      callerAttribution: () => callerAttributionFrom(authority, (conversationId) => SEATS.some((seat) => seat.conversationId === conversationId)),
      getPipelines: () => ({ pipelines: [...state.lanes.values()] }),
      readPipelineRecord: (pipelineId: string) => state.lanes.get(pipelineId) ?? null,
      loadTasks: () => [TASK],
      completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
      listFiles: async () => [ASKER],
      registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {} }),
      dismissalPorts: ports(state),
      ...overrides,
    } as never),
    receipts,
  );
}

type Answer = McpToolResult & { dismissed?: unknown[]; alreadyClear?: unknown[]; by?: DismissedBy; details?: { code?: string; refusedAs?: string } };

test("the tool is on the published surface and takes the three target kinds", () => {
  expect(MCP_TOOL_NAMES).toContain("dismiss_attention");
  const schema = TOOL_INPUT_SCHEMAS.dismiss_attention;
  expect(schema.safeParse({ clientRequestId: "d", target: { kind: "conversation", conversationId: "conversation_asker" } }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "d", target: { kind: "pipeline", pipelineId: "lane-1" }, undo: true }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "d", target: { kind: "task", taskId: "task-1" } }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "d", target: { kind: "region" } }).success).toBe(false);
  expect(schema.safeParse({ target: { kind: "task", taskId: "task-1" } }).success).toBe(false);
});

test("the designated seat clears its project's lane, attributed on the server", async () => {
  const state = world();
  const result = await serviceAs(MANAGER, state).callTool("dismiss_attention", { clientRequestId: "d-seat", target: { kind: "pipeline", pipelineId: "lane-1" } }) as Answer;
  expect(result.ok).toBe(true);
  expect(result.dismissed).toEqual([{ kind: "pipeline", pipelineId: "lane-1" }]);
  expect(state.writes).toEqual([{ pipelineId: "lane-1", dismiss: true, by: { kind: "manager", conversationId: SEAT, role: "orchestrator" } }]);
});

test("the operator's root session clears a conversation, and the record says so", async () => {
  const result = await serviceAs(ROOT).callTool("dismiss_attention", { clientRequestId: "d-root", target: { kind: "conversation", path: ASKER.path } }) as Answer;
  expect(result.ok).toBe(true);
  expect(result.dismissed).toEqual([{ kind: "conversation", conversationId: "conversation_asker" }]);
  expect(readAttentionDismissals().records).toMatchObject([
    { subject: "conversation_asker", by: { kind: "gateway", conversationId: "conversation_root", role: null } },
  ]);
});

test("a worker is refused, and nothing is written", async () => {
  const state = world();
  const result = await serviceAs(WORKER, state).callTool("dismiss_attention", { clientRequestId: "d-worker", target: { kind: "task", taskId: "task-1" } }) as Answer;
  expect(result.ok).toBe(false);
  expect(result.details).toMatchObject({ code: "DISMISS_NOT_PERMITTED", refusedAs: "worker" });
  expect(readAttentionDismissals().records).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("a seat of another project is refused for this project's target", async () => {
  const state = world();
  const result = await serviceAs(OTHER_SEAT, state).callTool("dismiss_attention", { clientRequestId: "d-cross", target: { kind: "pipeline", pipelineId: "lane-1" } }) as Answer;
  expect(result.ok).toBe(false);
  expect(result.details).toMatchObject({ code: "DISMISS_NOT_PERMITTED", refusedAs: "cross-project" });
  expect(state.writes).toEqual([]);
});

test("a replay of the same clientRequestId answers the first result and writes one record", async () => {
  const state = world();
  const receipts = new MemoryMcpReceiptStore();
  const service = serviceAs(MANAGER, state, receipts);
  const first = await service.callTool("dismiss_attention", { clientRequestId: "d-replay", target: { kind: "task", taskId: "task-1" } }) as Answer;
  const revision = readAttentionDismissals().revision;
  const second = await service.callTool("dismiss_attention", { clientRequestId: "d-replay", target: { kind: "task", taskId: "task-1" } }) as Answer;
  expect(second.ok).toBe(true);
  expect(second.replayed).toBe(true);
  expect(second.dismissed).toEqual(first.dismissed);
  expect(readAttentionDismissals().records).toHaveLength(1);
  expect(readAttentionDismissals().revision).toBe(revision);
  expect(state.writes).toHaveLength(1);
});

test("a lane that asks nothing is already clear, not an error", async () => {
  const state = world();
  const result = await serviceAs(ROOT, state).callTool("dismiss_attention", { clientRequestId: "d-clear", target: { kind: "pipeline", pipelineId: "lane-running" } }) as Answer;
  expect(result.ok).toBe(true);
  expect(result.dismissed).toEqual([]);
  expect(result.alreadyClear).toEqual([{ kind: "pipeline", pipelineId: "lane-running" }]);
  expect(state.writes).toEqual([]);
});

test("pipeline_action dismiss is the same write, behind the same gate", async () => {
  const state = world();
  const refused = await serviceAs(WORKER, state).callTool("pipeline_action", { clientRequestId: "p-worker", pipelineId: "lane-1", action: "dismiss" }) as Answer;
  expect(refused.ok).toBe(false);
  expect(refused.details).toMatchObject({ code: "DISMISS_NOT_PERMITTED" });
  expect(state.writes).toEqual([]);

  const done = await serviceAs(MANAGER, state).callTool("pipeline_action", { clientRequestId: "p-seat", pipelineId: "lane-1", action: "dismiss" }) as McpToolResult & { dismissal?: { dismissed: boolean; by: DismissedBy }; changedFields?: string[] };
  expect(done.ok).toBe(true);
  expect(done.dismissal).toMatchObject({ dismissed: true, by: { kind: "manager", conversationId: SEAT } });
  expect(done.changedFields).toContain("dismissedAt");
  expect(state.writes).toEqual([{ pipelineId: "lane-1", dismiss: true, by: { kind: "manager", conversationId: SEAT, role: "orchestrator" } }]);
});


test("read without target accepts the schema; change fields still require a target", async () => {
  expect(TOOL_INPUT_SCHEMAS.dismiss_attention.safeParse({ clientRequestId: "read", project: PROJECT }).success).toBe(true);
  for (const field of [{ undo: false }, { reason: "Done" }]) {
    const result = await serviceAs(ROOT).callTool("dismiss_attention", { clientRequestId: `read-${Object.keys(field)[0]}`, project: PROJECT, ...field });
    expect(result.ok).toBe(false);
    expect(result.details).toMatchObject({ code: "INVALID_TARGET" });
  }
});

test("each prototype target clears only its round, and read returns the reason and server attribution", async () => {
  const task = { ...TASK, text: "Layout", assignments: [], prototypeReview: { latestReviewId: "round-a", waitingReviewId: "round-a", title: "Layout", rounds: 1, createdAt: "2026-09-24T09:00:00Z" } } as BoardTask;
  const { withPrototypeReviewSummaries } = await import("@/lib/prototypeReview/read");
  const { needsYouAnswer } = await import("@/lib/attention/needsYouRead");
  const state = world();
  const dismissalPorts = { ...ports(state), task: (id: string) => id === task.id ? task : null };
  const service = createMcpToolService(viewerMcpBindings(undefined, { post: async (path, body) => {
    expect(path).toBe("/api/attention/needs-you");
    expect(body).toMatchObject({ project: PROJECT });
    const files = { files: [], pipelines: [], tasks: withPrototypeReviewSummaries([task]) };
    return needsYouAnswer(files, null, Date.parse("2026-09-24T10:00:00Z") / 1000, PROJECT, { tasks: [task], pipelines: [], dismissals: readAttentionDismissals().records, admissions: [], reports: null, unavailable: [] }) as unknown as Record<string, unknown>;
  } }, {
    attentionAuthority: () => MANAGER, authorizedSeats: () => SEATS,
    callerAttribution: () => callerAttributionFrom(MANAGER, () => true), loadTasks: () => [task],
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, memberships: {}, receipts: {}, lineageEdges: {} }), dismissalPorts,
  } as never), new MemoryMcpReceiptStore());
  const call = (id: string, extra: object = {}) => service.callTool("dismiss_attention", { clientRequestId: id, ...extra });
  expect(await call("before")).toMatchObject({ ok: true, count: 1 });
  const target = { kind: "prototype", taskId: task.id, reviewId: "round-a" };
  expect(await call("clear", { target, reason: "The publishing lane moved on" })).toMatchObject({ ok: true, dismissed: [target] });
  const cleared = await call("after");
  expect(cleared).toMatchObject({ count: 0, cleared: [{ cleared: { note: "The publishing lane moved on", by: { kind: "manager", conversationId: SEAT } } }] });
  expect(await call("undo", { target, undo: true })).toMatchObject({ ok: true });
  expect(await call("restored")).toMatchObject({ count: 1, cleared: [] });
  expect(await call("task-clear", { target: { kind: "task", taskId: task.id }, reason: "Done" })).toMatchObject({ ok: true, dismissed: expect.arrayContaining([target]) });
  task.prototypeReview = { ...task.prototypeReview!, latestReviewId: "round-b", waitingReviewId: "round-b" };
  expect(await call("newer")).toMatchObject({ count: 1 });
});

test("reasons reject multiple lines before any record is written", async () => {
  const result = await serviceAs(ROOT).callTool("dismiss_attention", { clientRequestId: "bad-reason", target: { kind: "conversation", path: ASKER.path }, reason: "Done\nwith work" });
  expect(result).toMatchObject({ ok: false, details: { code: "INVALID_REASON" } });
  expect(readAttentionDismissals().records).toEqual([]);
});


test("a failed launch absent from the scanner resolves its project from the receipt and is clearable", async () => {
  const state = world();
  const path = "spawn:launch-failed";
  const service = serviceAs(ROOT, state, new MemoryMcpReceiptStore(), {
    listFiles: async () => [],
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: { "launch-failed": { launchProfile: { cwd: "/fixture/launch-project" } } } }),
    dismissalPorts: { ...ports(state), resolveConversation: () => ({ conversationId: null, path }) },
  });
  expect(await service.callTool("dismiss_attention", { clientRequestId: "launch-clear", target: { kind: "conversation", path, reasonId: `${path}:launch-failed` }, reason: "A later launch succeeded" })).toMatchObject({ ok: true });
  expect(readAttentionDismissals().records).toMatchObject([{ path, reasonId: `${path}:launch-failed`, note: "A later launch succeeded" }]);
});

test("clearing one report resolves it in the log and leaves the seat's other question readable; undo restores it", async () => {
  const { appendBridgeReports, readBridgeReportLog, resolveBridgeAsks } = await import("@/lib/bridge/store");
  const { openBridgeAsks } = await import("@/lib/bridge/asks");
  const { needsYouAnswer } = await import("@/lib/attention/needsYouRead");
  appendBridgeReports([1,2].map(n => ({ key: `question-${n}`, class: "question" as const, at: "2026-09-24T09:45:00Z", body: `Choose ${n}`, project: PROJECT, targetSeatConversationId: SEAT })));
  const state = world();
  const service = serviceAs(MANAGER, state, new MemoryMcpReceiptStore(), {
    attentionReportProject: (seq: number) => readBridgeReportLog().reports.find(r => r.seq === seq)?.project ?? null,
    dismissalPorts: { ...ports(state), resolveReports: (seqs: number[], resolve: boolean, by: DismissedBy, at: string, project: string, note?: string) => resolveBridgeAsks(seqs, { by, at, undo: !resolve, note, inProject: p => p === project }) },
  }, { post: async () => {
    const log = readBridgeReportLog();
    const asks = openBridgeAsks(log, { now: new Date("2026-09-24T10:00:00Z") }).get(SEAT) ?? [];
    const file = { ...ASKER, path: "/seat.jsonl", conversationId: SEAT, mtime: Date.parse("2026-09-24T09:45:00Z") / 1000, bridgeAsks: asks, bridgeAsk: asks.at(-1) };
    return needsYouAnswer({ files: [file], pipelines: [], tasks: [] }, null, Date.parse("2026-09-24T10:00:00Z") / 1000, PROJECT, { tasks: [], pipelines: [], reports: log, dismissals: [], admissions: [], unavailable: [] }) as unknown as Record<string, unknown>;
  } });
  const first = readBridgeReportLog().reports[0]!.seq;
  expect(await service.callTool("dismiss_attention", { clientRequestId: "reports-before" })).toMatchObject({ count: 2 });
  expect(await service.callTool("dismiss_attention", { clientRequestId: "report-clear", target: { kind: "report", seq: first }, reason: "The later turn answered this" })).toMatchObject({ ok: true });
  expect(await service.callTool("dismiss_attention", { clientRequestId: "reports-after" })).toMatchObject({ count: 1, cleared: [{ undo: { kind: "report", seq: first }, cleared: { note: "The later turn answered this" } }] });
  expect(readBridgeReportLog().resolvedAsks).toMatchObject([{ seq: first }]);
  expect(await service.callTool("dismiss_attention", { clientRequestId: "report-undo", target: { kind: "report", seq: first }, undo: true })).toMatchObject({ ok: true });
  expect(await service.callTool("dismiss_attention", { clientRequestId: "reports-restored" })).toMatchObject({ count: 2, cleared: [] });
});

test("a worker, another project's seat and an unidentified maintainer cannot read or dismiss this project's rows", async () => {
  for (const authority of [WORKER, OTHER_SEAT, { kind: "worker", conversationId: "conversation_maintainer", role: "maintainer" } as AttentionCallerAuthority]) {
    let posts = 0;
    const service = serviceAs(authority, world(), new MemoryMcpReceiptStore(), {}, { post: async () => { posts++; return {}; } });
    expect(await service.callTool("dismiss_attention", { clientRequestId: "forbidden-read", project: PROJECT })).toMatchObject({ ok: false, details: { code: "NEEDS_YOU_READ_NOT_PERMITTED" } });
    expect(await service.callTool("dismiss_attention", { clientRequestId: "forbidden-write", target: { kind: "task", taskId: TASK.id } })).toMatchObject({ ok: false, details: { code: "DISMISS_NOT_PERMITTED" } });
    expect(posts).toBe(0);
    expect(readAttentionDismissals().records).toEqual([]);
  }
});


test("update decisions stay answer-only, and a one-line reason on a conversation round-trips redacted", async () => {
  const update = await serviceAs(ROOT).callTool("dismiss_attention", { clientRequestId: "update-refused", target: { kind: "update", decisionId: "decision-a" } });
  expect(update).toMatchObject({ ok: false, details: { code: "UPDATE_NEEDS_ANSWER" } });
  const credentialShape = ["sk", "abcdefghijklmnop0123456789"].join("-");
  const result = await serviceAs(ROOT).callTool("dismiss_attention", { clientRequestId: "redacted-reason", target: { kind: "conversation", path: ASKER.path }, reason: `Later answer; credential ${credentialShape}` });
  expect(result.ok).toBe(true);
  const record = readAttentionDismissals().records[0]!;
  expect(record.note).not.toContain(credentialShape);
  expect(record.note).toContain("Later answer");
});


test("a conversation id from another project cannot borrow this project's path for admission", async () => {
  const foreign = { ...ASKER, path: "/other/foreign.jsonl", conversationId: "conversation_foreign", project: "elsewhere" };
  let writes = 0;
  const state = world();
  const service = serviceAs(MANAGER, state, new MemoryMcpReceiptStore(), {
    listFiles: async () => [ASKER, foreign],
    registrySnapshot: () => ({ conversations: { conversation_foreign: { id: "conversation_foreign", continuityPaths: [], generations: [{ path: foreign.path }] } }, conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {} }),
    dismissalPorts: { ...ports(state), resolveConversation: () => { writes++; return { conversationId: foreign.conversationId, path: foreign.path }; } },
  });
  expect(await service.callTool("dismiss_attention", { clientRequestId: "mixed-ref", target: { kind: "conversation", conversationId: foreign.conversationId, path: ASKER.path } })).toMatchObject({ ok: false, details: { code: "DISMISS_NOT_PERMITTED" } });
  expect(writes).toBe(0);
});


test("the scoped maintainer reads through the binding with its capability, and still cannot clear", async () => {
  const id = "conversation_maintainer";
  const authority: AttentionCallerAuthority = { kind: "worker", conversationId: id, role: "maintainer" };
  const oldCapability = process.env.LLV_SPAWN_CAPABILITY;
  const capability = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  process.env.LLV_SPAWN_CAPABILITY = capability;
  try {
    let posts = 0;
    const service = serviceAs(authority, world(), new MemoryMcpReceiptStore(), {
      registrySnapshot: () => ({ conversations: { [id]: { id, agentRole: "maintainer", continuityPaths: [], generations: [], projectOwnership: { project: PROJECT } } }, conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {} }),
    }, { post: async (path, body, headers) => {
      posts++;
      expect(path).toBe("/api/attention/needs-you");
      expect(body).toMatchObject({ project: PROJECT });
      expect(headers?.["x-llv-spawn-capability"]).toBe(capability);
      return { project: PROJECT, count: 0, rows: [] };
    } });
    expect(await service.callTool("dismiss_attention", { clientRequestId: "maint-read" })).toMatchObject({ ok: true, count: 0 });
    expect(await service.callTool("dismiss_attention", { clientRequestId: "maint-write", target: { kind: "task", taskId: TASK.id } })).toMatchObject({ ok: false, details: { code: "DISMISS_NOT_PERMITTED" } });
    expect(await service.callTool("dismiss_attention", { clientRequestId: "maint-foreign", project: "elsewhere" })).toMatchObject({ ok: false, details: { code: "NEEDS_YOU_READ_NOT_PERMITTED" } });
    expect(posts).toBe(1);
  } finally {
    if (oldCapability === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
    else process.env.LLV_SPAWN_CAPABILITY = oldCapability;
  }
});
