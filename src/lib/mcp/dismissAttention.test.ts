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
  };
}

function serviceAs(authority: AttentionCallerAuthority, state: World = world(), receipts = new MemoryMcpReceiptStore()) {
  return createMcpToolService(
    viewerMcpBindings(undefined, undefined, {
      attentionAuthority: () => authority,
      authorizedSeats: () => SEATS,
      callerAttribution: () => callerAttributionFrom(authority, (conversationId) => SEATS.some((seat) => seat.conversationId === conversationId)),
      getPipelines: () => ({ pipelines: [...state.lanes.values()] }),
      readPipelineRecord: (pipelineId: string) => state.lanes.get(pipelineId) ?? null,
      loadTasks: () => [TASK],
      completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
      listFiles: async () => [ASKER],
      registrySnapshot: () => ({ conversations: {}, aliases: {} }),
      dismissalPorts: ports(state),
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
