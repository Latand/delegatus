import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { lifecycleJournalPath, queryLifecycleEvents } from "@/lib/lifecycle/journal";
import * as journalModule from "@/lib/lifecycle/journal";
import { pollLifecycleDigest } from "@/lib/lifecycle/digest";
import type { FileEntry } from "@/lib/types";
import { nativeCodexFunctionCallMethod, observeCodexSubagentEvent, observeCodexSubagentTranscripts, recordCodexSubagentViolation } from "./codexSubagentDetection";
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

function launched(allowSubagents = false, accountLayout = false) {
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = randomUUID();
  const parentPath = path.join(root, ...(accountLayout ? ["account", "sessions"] : []), `rollout-${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(parentPath), { recursive: true });
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

test("v2 and Guardian activity are detected while permission-enabled and unrelated items stay clear", () => {
  for (const allowSubagents of [false, true]) {
    const { registry, parentPath, conversation } = launched(allowSubagents);
    for (const [seq, item] of [{ type: "subAgentActivity", id: "v2-fixture", content: "PRIVATE CHILD RESULT" },
      { type: "autoApprovalReview", id: "guardian-fixture", action: "PRIVATE GUARDIAN ACTION" },
      { type: "agentMessage", id: "message-fixture" }].entries()) {
      observeCodexSubagentEvent(registry, parentPath, { kind: "item", item, turnId: null, phase: "completed", seq });
    }
    const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
    expect(events).toHaveLength(allowSubagents ? 0 : 2);
    expect(JSON.stringify(events)).not.toContain("PRIVATE CHILD RESULT");
    expect(JSON.stringify(events)).not.toContain("PRIVATE GUARDIAN ACTION");
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

test("a same-path grant retains denied history for scanner discovery and durable replay", async () => {
  const { registry, parentPath, sessionId, conversation } = launched();
  const deniedAt = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const profile = emptyLaunchProfile({ cwd: root, title: "Exercise granted resume", allowSubagents: true });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, conversationId: conversation.id,
    purpose: "resume-successor", transport: "tmux", expectedArtifactPath: parentPath,
    origin: { kind: "successor" }, launchProfile: profile });
  if (begun.kind !== "created") throw new Error("expected resume receipt");
  registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId }, artifactPath: parentPath,
    cwd: root, accountId: null, launchProfile: profile, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  expect(registry.conversationForPath(parentPath)?.generations[0]?.launchProfile.allowSubagents).toBeTrue();
  const grantedAt = new Date().toISOString();
  const rows = [
    { timestamp: deniedAt, type: "response_item", payload: { type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", call_id: "denied-before-grant" } },
    { timestamp: grantedAt, type: "response_item", payload: { type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", call_id: "granted-after-resume" } },
  ];
  fs.appendFileSync(parentPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const entry = { engine: "codex", path: parentPath, size: fs.statSync(parentPath).size,
    mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
  observeCodexSubagentTranscripts(registry, [entry]);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(1);
  for (const [id, activityAt] of [["denied-ledger-before-grant", deniedAt], ["granted-after-resume", grantedAt]]) {
    observeCodexSubagentEvent(registry, parentPath, { kind: "item", turnId: null, phase: "completed", seq: 1,
      item: { type: "collabAgentToolCall", tool: "spawnAgent", id }, activityAt });
  }
  observeCodexSubagentTranscripts(registry, [entry]);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(2);
});

test.each([[false, "starting"], [false, "failed"], [true, "starting"], [true, "failed"]] as const)(
  "an unactuated resume leaves permission %j effective in state %s", async (allowed, state) => {
    const { registry, parentPath, conversation } = launched(allowed);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const profile = emptyLaunchProfile({ cwd: root, title: "Exercise unactuated resume", allowSubagents: !allowed });
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, conversationId: conversation.id,
      purpose: "resume-successor", transport: "tmux", expectedArtifactPath: parentPath,
      origin: { kind: "successor" }, launchProfile: profile });
    if (begun.kind !== "created") throw new Error("expected resume intent");
    if (state === "failed") registry.failSpawn(begun.receipt.launchId, "fixture failure before actuation");
    expect(registry.readOnlySnapshot().receipts[begun.receipt.launchId]?.key).toBeNull();
    const timestamp = new Date().toISOString();
    fs.appendFileSync(parentPath, JSON.stringify({ timestamp, type: "response_item", payload: {
      type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "still-running-native" } }) + "\n");
    const entry = { engine: "codex", path: parentPath, size: fs.statSync(parentPath).size,
      mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
    observeCodexSubagentTranscripts(registry, [entry]);
    observeCodexSubagentEvent(registry, parentPath, { kind: "item", turnId: null, phase: "completed", seq: 1,
      item: { type: "collabAgentToolCall", tool: "spawnAgent", id: "still-running-native" }, activityAt: timestamp });
    expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(allowed ? 0 : 1);
  },
);

test.each(["sub_agent_activity", "SubAgentActivity", "CollabAgentToolCall"])(
  "native rollout schema %s is shared by transcript detection and adoption time lookup", (schema) => {
    for (const route of ["scanner", "adoption"]) for (const allowed of [false, true]) {
      const { registry, parentPath, sessionId, conversation } = launched(allowed);
      const timestamp = new Date().toISOString();
      const activity = { id: "native-schema-fixture", kind: "completed", agent_thread_id: randomUUID(), agent_path: "/team/child" };
      const payload = schema === "sub_agent_activity"
        ? { type: schema, event_id: activity.id, kind: "started", agent_thread_id: activity.agent_thread_id,
          agent_path: activity.agent_path, occurred_at_ms: Date.parse(timestamp) }
        : { type: "item_completed", thread_id: sessionId, turn_id: "fixture-turn", started_at_ms: Date.parse(timestamp),
          completed_at_ms: Date.parse(timestamp), item: schema === "SubAgentActivity"
            ? { type: schema, ...activity }
            : { type: schema, id: activity.id, tool: "spawn_agent", status: "failed", sender_thread_id: sessionId,
              receiver_thread_ids: [], agents_states: {}, prompt: "PRIVATE NATIVE CONTENT" } };
      const historicMs = Date.parse("2000-01-01T00:00:00.000Z");
      const historic = schema === "sub_agent_activity" ? { ...payload, event_id: "historical-schema", occurred_at_ms: historicMs }
        : { ...payload, started_at_ms: historicMs, completed_at_ms: historicMs,
          item: { ...payload.item, id: "historical-schema" } };
      fs.appendFileSync(parentPath, [
        { timestamp, type: "event_msg", payload },
        // The file write time is later than the activity's own native time.
        { timestamp, type: "event_msg", payload: historic },
        { timestamp, type: "event_msg", payload: { type: "item_completed", item: {
          type: "McpToolCall", id: "mcp-fixture", name: "spawn_agent", server: "viewer" } } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      const item = schema === "CollabAgentToolCall" ? { type: "collabAgentToolCall", id: activity.id, tool: "spawnAgent" }
        : { type: "subAgentActivity", id: activity.id };
      const entry = { engine: "codex", path: parentPath, size: fs.statSync(parentPath).size,
        mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
      // Exercise each observer independently before checking cross-route deduplication.
      if (route === "scanner") observeCodexSubagentTranscripts(registry, [entry]);
      else observeCodexSubagentEvent(registry, parentPath, { kind: "item", turnId: null, phase: "completed", seq: 1, item, activityAt: null });
      expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(allowed ? 0 : 1);
      observeCodexSubagentEvent(registry, parentPath, { kind: "item", turnId: null, phase: "completed", seq: 1,
        item: { ...item, id: "historical-schema" }, activityAt: null });
      observeCodexSubagentTranscripts(registry, [entry]);
      observeCodexSubagentTranscripts(registry, [entry]);
      const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
      expect(events).toHaveLength(allowed ? 0 : 1);
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
    }
  },
);

test("native transcript calls alert without a child while prose, MCP calls and pre-admission history stay clear", () => {
  const { registry, parentPath, conversation } = launched();
  const timestamp = new Date().toISOString();
  const rows = [
    { timestamp, type: "response_item", payload: { type: "message", content: "spawn_agent PRIVATE TEXT" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "mcp__viewer", call_id: "tracked-fixture" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "send_message", namespace: "mcp__viewer", call_id: "message-fixture" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: "1", yield_time_ms: 1000, max_tokens: 100 }), call_id: "code-mode-fixture" } },
    { timestamp: "2000-01-01T00:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "historical-fixture" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "native-fixture", arguments: "PRIVATE TASK" } },
    { timestamp, type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "native-v1-fixture", arguments: "PRIVATE TASK" } },
    { timestamp, type: "event_msg", payload: { type: "guardian_assessment", id: "native-guardian-fixture", action: "PRIVATE GUARDIAN ACTION" } },
  ];
  fs.appendFileSync(parentPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const entry = { engine: "codex", path: parentPath, size: fs.statSync(parentPath).size, mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
  observeCodexSubagentTranscripts(registry, [entry]);
  observeCodexSubagentTranscripts(registry, [entry]);
  const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
  expect(events).toHaveLength(3);
  expect(events.some((event) => event.summary.includes("spawn_agent"))).toBe(true);
  expect(events.some((event) => event.summary.includes("autoApprovalReview"))).toBe(true);
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
});

test.each([
  ...["spawn_agent", "send_input", "resume_agent", "wait_agent", "close_agent"]
    .map((name) => ({ name, namespace: "multi_agent_v1" })),
  ...["spawn_agent", "followup_task", "send_message", "wait_agent", "interrupt_agent", "list_agents"]
    .map((name) => ({ name, namespace: undefined })),
])("native rollout call %j alerts once without a child only when denied", (method) => {
  for (const allowSubagents of [false, true]) {
    const { registry, parentPath, conversation } = launched(allowSubagents);
    const timestamp = new Date().toISOString();
    // Codex 0.159.3 writes v1's namespace separately, including a refused
    // spawn with {} arguments. Providers without namespace_tools flatten v2.
    const rows = [
      { timestamp, type: "response_item", payload: { type: "function_call", ...method, call_id: "native-rollout-fixture", arguments: "{}" } },
      { timestamp, type: "response_item", payload: { type: "function_call", ...method, namespace: "mcp__viewer", call_id: "mcp-rollout-fixture", arguments: "{}" } },
      { timestamp, type: "response_item", payload: { type: "function_call", name: "wait", call_id: "code-mode-rollout-fixture", arguments: JSON.stringify({ cell_id: "1", ids: ["fixture"] }) } },
      { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: "native-rollout-fixture", output: "PRIVATE TOOL RESULT" } },
    ];
    fs.appendFileSync(parentPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const entry = { engine: "codex", path: parentPath, size: fs.statSync(parentPath).size,
      mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
    observeCodexSubagentTranscripts(registry, [entry]);
    observeCodexSubagentTranscripts(registry, [entry]);
    // A fresh observer must retain journal deduplication too.
    const restarted = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    observeCodexSubagentTranscripts(restarted, [entry]);
    const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
    expect(events).toHaveLength(allowSubagents ? 0 : 1);
    if (!allowSubagents) expect(events[0]).toMatchObject({ type: "subagent_policy_violation",
      summary: `Native Codex sub-agent activity observed with sub-agents disabled: ${method.name}.` });
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  }
});

test("failed transcript writes retry children and tails, and settled children never reacquire the journal lock", () => {
  const { registry, parentPath, sessionId, conversation } = launched();
  const childPath = path.join(root, `rollout-${randomUUID()}.jsonl`);
  fs.writeFileSync(childPath, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: { parent_thread_id: sessionId } } } } }) + "\n");
  fs.appendFileSync(parentPath, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "retry-tail" } }) + "\n");
  const entries = [parentPath, childPath].map((pathname) => ({ engine: "codex", path: pathname,
    size: fs.statSync(pathname).size, mtime: fs.statSync(pathname).mtimeMs / 1000 } as FileEntry));
  const journal = lifecycleJournalPath();
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, "{");
  expect(() => observeCodexSubagentTranscripts(registry, entries)).not.toThrow();
  fs.unlinkSync(journal);
  observeCodexSubagentTranscripts(registry, entries);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(2);
  const persisted = fs.readFileSync(journal, "utf8");
  // A held transaction lock would block a replay, even when it is deduplicated.
  // A directory at the journal path makes any attempted transaction fail.
  fs.unlinkSync(journal);
  fs.mkdirSync(journal);
  const append = spyOn(journalModule, "appendLifecycleEvents");
  try {
    expect(() => observeCodexSubagentTranscripts(registry, entries)).not.toThrow();
    expect(append).not.toHaveBeenCalled();
  } finally { append.mockRestore(); fs.rmdirSync(journal); fs.writeFileSync(journal, persisted); }
  observeCodexSubagentTranscripts(registry, entries);
  expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(2);
});

test("function-call classification distinguishes native v1, v2, Code Mode and MCP namespaces", () => {
  for (const payload of [
    { name: "wait", arguments: JSON.stringify({ cell_id: "1", ids: ["fixture"] }) },
    { name: "wait", arguments: "{}" }, { name: "wait", arguments: "invalid" },
    { name: "spawn_agent", namespace: "mcp__viewer" },
    { name: "send_message", namespace: "mcp__viewer" },
    { name: "spawn_agent", namespace: "unconfigured" },
    { name: "followup_task", namespace: "multi_agent_v1" },
    { name: "send_input", namespace: "collaboration" },
    { name: "wait", namespace: "functions", arguments: JSON.stringify({ cell_id: "1" }) },
    { name: "collaboration.spawn_agent" }, { name: "mcp__viewer__spawn_agent" },
  ]) expect(nativeCodexFunctionCallMethod(payload)).toBeNull();
  for (const name of ["spawn_agent", "send_input", "resume_agent", "wait_agent", "close_agent"]) {
    expect(nativeCodexFunctionCallMethod({ name, namespace: "multi_agent_v1" })).toBe(name);
    expect(nativeCodexFunctionCallMethod({ name })).toBe(name);
  }
  for (const name of ["spawn_agent", "followup_task", "send_message", "wait_agent", "interrupt_agent", "list_agents"]) {
    expect(nativeCodexFunctionCallMethod({ name })).toBe(name);
    expect(nativeCodexFunctionCallMethod({ name, namespace: "collaboration" })).toBe(name);
  }
  expect(nativeCodexFunctionCallMethod({ name: "wait", arguments: JSON.stringify({ ids: ["fixture"], timeout_ms: 1000 }) })).toBe("wait");
  expect(nativeCodexFunctionCallMethod({ name: "spawn_agent" })).toBe("spawn_agent");
  expect(nativeCodexFunctionCallMethod({ name: "spawn_agent", namespace: "collaboration" })).toBe("spawn_agent");
});

test("a corrupt detection journal leaves the scanner pipeline tick running and retries after repair", async () => {
  const { registry, parentPath, sessionId, conversation } = launched();
  const childPath = path.join(root, `rollout-${randomUUID()}.jsonl`);
  fs.writeFileSync(childPath, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: { parent_thread_id: sessionId } } } } }) + "\n");
  const entries = [parentPath, childPath].map((pathname) => ({ engine: "codex", path: pathname,
    size: fs.statSync(pathname).size, mtime: fs.statSync(pathname).mtimeMs / 1000 } as FileEntry));
  const [registryModule, links, flows, pipelines, workflows, inbox, membership] = await Promise.all([
    import("@/lib/agent/registry"), import("@/lib/scanner/links"), import("@/lib/flows/engine"),
    import("@/lib/pipelines/engine"), import("@/lib/workflows/engine"),
    import("@/lib/tasks/inboxScanner"), import("@/lib/tasks/membership"),
  ]);
  const pipelineTick = spyOn(pipelines, "tickPipelines").mockResolvedValue({ pipelines: [], changed: false });
  const spies = [pipelineTick,
    spyOn(registryModule, "agentRegistry").mockReturnValue(registry),
    spyOn(links, "linkEntries").mockResolvedValue(undefined),
    spyOn(flows, "tickFlows").mockResolvedValue({ flows: [], changed: false }),
    spyOn(workflows, "tickWorkflows").mockResolvedValue({ workflows: [], changed: false }),
    spyOn(inbox, "tickTaskInbox").mockImplementation(() => {}),
    spyOn(membership, "admitScannedConversations").mockReturnValue(0),
  ];
  try {
    const { reconcileFileControllers } = await import("@/lib/scanner");
    const journal = lifecycleJournalPath();
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, "{");
    await reconcileFileControllers(entries);
    expect(pipelineTick).toHaveBeenCalledTimes(1);
    fs.unlinkSync(journal);
    await reconcileFileControllers(entries);
    await reconcileFileControllers(entries);
    expect(pipelineTick).toHaveBeenCalledTimes(3);
    expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(1);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test("a configured v2 namespace is recognized from the account or project while MCP stays clear", () => {
  for (const layer of ["account", "project"]) {
    const { registry, parentPath, conversation } = launched(false, layer === "account");
    const configDir = layer === "account" ? path.join(root, "account") : path.join(root, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.toml");
    fs.writeFileSync(configPath, '[features.multi_agent_v2]\nenabled=true\ntool_namespace="fixture_team"\n');
    const namespaces = new Set(["collaboration", "fixture_team"]);
    expect(nativeCodexFunctionCallMethod({ name: "spawn_agent", namespace: "fixture_team" }, namespaces)).toBe("spawn_agent");
    fs.appendFileSync(parentPath, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "fixture_team", call_id: "custom-native" } }) + "\n");
    const entry = { engine: "codex", path: parentPath, cwd: root, size: fs.statSync(parentPath).size,
      mtime: fs.statSync(parentPath).mtimeMs / 1000 } as FileEntry;
    observeCodexSubagentTranscripts(registry, [entry]);
    expect(queryLifecycleEvents({ conversationId: conversation.id }).events).toHaveLength(1);
    fs.unlinkSync(configPath);
  }
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
