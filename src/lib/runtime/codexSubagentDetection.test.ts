import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { lifecycleJournalPath, queryLifecycleEvents } from "@/lib/lifecycle/journal";
import { pollLifecycleDigest } from "@/lib/lifecycle/digest";
import type { FileEntry } from "@/lib/types";
import { observeCodexSubagentEvent, observeCodexSubagentTranscripts, recordCodexSubagentViolation } from "./codexSubagentDetection";
import { bindStructuredDeliveryQueue, type StructuredDeliveryHost } from "./structuredDeliveryController";
import type { RuntimeHostClient } from "./client";

let root: string;
let previousState: string | undefined;
beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-subagent-detection-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
});
afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});

function launched(allowSubagents = false) {
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = randomUUID();
  const parentPath = path.join(root, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(parentPath, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
  const profile = emptyLaunchProfile({ cwd: root, title: "Exercise native delegation policy", allowSubagents });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, origin: { kind: "operator" }, launchProfile: profile });
  if (begun.kind !== "created") throw new Error("expected launch receipt");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId }, artifactPath: parentPath, cwd: root, accountId: null,
    launchProfile: profile, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("expected settled launch");
  return { registry, parentPath, sessionId, conversation: settled.conversation };
}

test("denied native items persist once and appear immediately in the existing lifecycle digest", () => {
  const { registry, parentPath, conversation } = launched();
  const item = { type: "collabAgentToolCall", id: "native-spawn-fixture", tool: "spawnAgent", prompt: "PRIVATE TASK CONTENT" };
  for (const phase of ["started", "completed", "completed"] as const) {
    observeCodexSubagentEvent(registry, parentPath, { kind: "item", item, turnId: "fixture-turn", phase, seq: 1 });
  }
  const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "subagent_policy_violation", summary: "Native Codex sub-agent activity observed with sub-agents disabled: spawnAgent." });
  expect(JSON.stringify(events)).not.toContain("PRIVATE TASK CONTENT");
  const digest = pollLifecycleDigest({ subscriberId: "fixture-policy-reader", conversationId: conversation.id, acknowledge: false });
  expect(digest.relay?.reason).toBe("terminal");
  expect(digest.relay?.items[0]?.summary).toBe(events[0]?.summary);
  // A new registry instance and repeated durable ledger replay retain one fact.
  observeCodexSubagentEvent(new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" }), parentPath,
    { kind: "item", item, turnId: "fixture-turn", phase: "completed", seq: 20 });
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(1);
});

test("v2 activity is detected while permission-enabled and unrelated items stay clear", () => {
  for (const allowSubagents of [false, true]) {
    const { registry, parentPath, conversation } = launched(allowSubagents);
    for (const [seq, item] of [{ type: "subAgentActivity", id: "v2-fixture", content: "PRIVATE CHILD RESULT" }, { type: "agentMessage", id: "message-fixture" }].entries()) {
      observeCodexSubagentEvent(registry, parentPath, { kind: "item", item, turnId: null, phase: "completed", seq });
    }
    const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
    expect(events).toHaveLength(allowSubagents ? 0 : 1);
    expect(JSON.stringify(events)).not.toContain("PRIVATE CHILD RESULT");
  }
});

test("native child transcript headers detect CLI and exec bypasses without treating forks as children", () => {
  const { registry, parentPath, sessionId, conversation } = launched();
  const childPath = path.join(root, `rollout-${randomUUID()}.jsonl`);
  const forkPath = path.join(root, `rollout-${randomUUID()}.jsonl`);
  fs.writeFileSync(childPath, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: { parent_thread_id: sessionId } } } } }) + "\n");
  fs.writeFileSync(forkPath, JSON.stringify({ type: "session_meta", payload: { forked_from_id: sessionId } }) + "\n");
  const entries = [parentPath, childPath, forkPath].map((pathname) => ({
    engine: "codex", path: pathname, size: fs.statSync(pathname).size, mtime: fs.statSync(pathname).mtimeMs / 1000,
  } as FileEntry));
  entries[1]!.sessionStartedAt = "2000-01-01T00:00:00.000Z";
  observeCodexSubagentTranscripts(registry, entries);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(0);
  entries[1]!.sessionStartedAt = new Date().toISOString();
  observeCodexSubagentTranscripts(registry, entries);
  observeCodexSubagentTranscripts(registry, entries);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(1);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events[0]?.summary).toContain("thread_spawn");
});

test("an imported transcript with no Delegatus launch receipt produces no violation", () => {
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const parentPath = path.join(root, "imported.jsonl");
  registry.ensureConversation("codex", parentPath, null);
  observeCodexSubagentEvent(registry, parentPath, { kind: "item", item: { type: "subAgentActivity", id: "imported-item" }, turnId: null, phase: "completed", seq: 1 });
  expect(queryLifecycleEvents({}).events).toHaveLength(0);
});

test("child history uses the permission at activity time across denied and granted resumes", () => {
  const { registry, parentPath } = launched();
  const original = Object.values(registry.readOnlySnapshot().receipts)[0]!;
  const receipts = [
    { ...original, createdAt: "2000-01-01T00:00:00.000Z" },
    { ...original, createdAt: "2001-01-01T00:00:00.000Z", launchProfile: { ...original.launchProfile, allowSubagents: true } },
    { ...original, createdAt: "2002-01-01T00:00:00.000Z" },
  ];
  expect(recordCodexSubagentViolation(registry, parentPath, "permitted-child", "thread_spawn", undefined, undefined, receipts, "2001-06-01T00:00:00.000Z")).toBe(false);
  expect(recordCodexSubagentViolation(registry, parentPath, "denied-child", "thread_spawn", undefined, undefined, receipts, "2002-06-01T00:00:00.000Z")).toBe(true);
});

test("native transcript calls alert without a child while prose, MCP calls and pre-admission history stay clear", () => {
  const { registry, parentPath, conversation } = launched();
  const timestamp = new Date().toISOString();
  const rows = [
    { timestamp, type: "response_item", payload: { type: "message", content: "spawn_agent PRIVATE TEXT" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "mcp__viewer__spawn_agent", call_id: "tracked-fixture" } },
    { timestamp: "2000-01-01T00:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "historical-fixture" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "collaboration.spawn_agent", call_id: "native-fixture", arguments: "PRIVATE TASK" } },
  ];
  fs.appendFileSync(parentPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const entry = { engine: "codex", path: parentPath, size: fs.statSync(parentPath).size, mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
  observeCodexSubagentTranscripts(registry, [entry]);
  observeCodexSubagentTranscripts(registry, [entry]);
  const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
  expect(events).toHaveLength(1);
  expect(events[0]?.summary).toContain("spawn_agent");
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
});

test("the real controller pump retries a failed policy write before acknowledging the native item", async () => {
  const { registry, sessionId, conversation } = launched();
  const key = { engine: "codex" as const, sessionId };
  let emitted = false;
  let acknowledged = 0;
  const host: StructuredDeliveryHost["host"] = {
    health: async () => ({ status: "idle", sessionKey: sessionId, endpoint: "fixture", pid: null,
      processStartIdentity: null, eventCursor: 0, protocolVersion: "v2", activeTurnRef: null,
      pendingAttention: [], activeFlags: [], account: null }),
    onStateChange: () => () => {},
    send: async () => { throw new Error("unexpected fixture send"); },
    interrupt: async () => {}, answer: async () => {}, release: async () => {},
    async *attach() {
      emitted = true;
      yield { kind: "item" as const, item: { type: "subAgentActivity", id: "controller-policy-fixture" }, turnId: null, phase: "completed" as const, seq: 1 };
    },
  };
  const client = {
    snapshot: async () => ({ filesRevision: 0, sessions: [] }), producerCursor: async () => 0,
    effectBatch: async () => [], operationStatus: async () => null,
    append: async (event: { kind: string }) => { if (event.kind === "item") acknowledged++; },
  } as unknown as RuntimeHostClient;
  const journal = lifecycleJournalPath();
  fs.mkdirSync(journal, { recursive: true });
  try {
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
    expect(emitted).toBe(true);
    expect(acknowledged).toBe(0);
    fs.rmdirSync(journal);
    for (let attempts = 0; attempts < 200 && acknowledged === 0; attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acknowledged).toBe(1);
    expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
  }
});
