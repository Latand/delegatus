import { projectLivenessEvents } from "./projector";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLivenessTranscriptEvidence } from "./transcript";
import { expect, test } from "bun:test";
import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";
import { agentLivenessSnapshot, type AgentLivenessSources } from "./liveness";
import type { LivenessTranscript } from "./transcript";

const now = Date.parse("2026-10-12T05:45:29Z");
const transcript = "/fixture/rollout-two.jsonl";
const row = { path: transcript, project: "fixture", title: "check", engine: "codex", kind: "session", mtime: (now - 17_482_029) / 1000, size: 100, activity: "stalled", activityReason: "jsonl_turn_stalled", conversationId: "conversation_one" } as FileEntry;
const described = { path: transcript, project: "fixture", title: "check", engine: "codex", mtimeMs: now - 17_482_029, sizeBytes: 100, conversationId: "conversation_one", activity: "stalled", activityReason: "jsonl_turn_stalled" } as LivenessTranscript;
function sources(overrides: Partial<AgentLivenessSources> = {}): AgentLivenessSources {
  return {
    now: () => now,
    workProcesses: () => [],
    probe: { now: () => now, pidAlive: () => true, processIdentity: () => "host-start" },
    registrySnapshot: () => ({ entries: { one: { key: { engine: "codex", sessionId: "one", accountId: null }, artifactPath: transcript, status: "live", structuredHost: { kind: "codex-app-server", process: { pid: 42, startIdentity: "host-start" }, pendingPermissions: [] } } }, conversations: {} }) as unknown as RegistryFile,
    pipelines: () => [],
    describeTranscript: async () => described,
    transcriptIdentity: async () => "same-file",
    transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now - 10_000 }),
    selectInventory: async () => {
      await Bun.sleep(850);
      return { entries: [row], scanned: 1, matched: 1, hostedSeen: new Set([transcript]), generation: 1, cacheStatus: "stale", freshScan: false, selectionMs: 850 };
    },
    ...overrides,
  };
}

test("false 4.8 h stall: a hosted tail is verified while a stale catalog spends the answer budget", async () => {
  let reads = 0;
  const snapshot = await agentLivenessSnapshot({ liveOnly: true, answerBudgetMs: 800 }, sources({
    transcriptEvidence: async () => { reads++; return { turn: "busy", lastRecordTs: now - 10_000 }; },
  }));
  expect(reads).toBe(1);
  expect(snapshot.conversations[0]).toMatchObject({ lifecycle: "running", verified: true, silentForMs: 10_000 });
  expect(snapshot.stalledCount).toBe(0);
});


test("a tail held beyond the budget carries no projected silence or stall", async () => {
  let release!: (value: null) => void;
  const held = new Promise<null>((resolve) => { release = resolve; });
  const snapshot = await agentLivenessSnapshot({ answerBudgetMs: 20 }, sources({ transcriptEvidence: () => held }));
  release(null);
  expect(snapshot.conversations[0]).toMatchObject({ lifecycle: "running", reason: "evidence_unverified", verified: false, silentForMs: null, stalledForMs: null });
  expect(snapshot.stalledCount).toBe(0);
});

test("an unreadable open-turn projection over a dead host is gone and unverified", async () => {
  const snapshot = await agentLivenessSnapshot({}, sources({
    selectInventory: undefined, listFiles: async () => [row],
    probe: { now: () => now, pidAlive: () => false, processIdentity: () => null },
    transcriptEvidence: async () => null,
  }));
  expect(snapshot.conversations[0]).toMatchObject({ lifecycle: "gone", reason: "host_gone_turn_unverified", verified: false, silentForMs: null });
});

for (const engine of ["codex", "claude"] as const) {
  test(`${engine === "codex" ? "rotated Codex rollout" : "resumed Claude session"}: one conversation uses the newest file even when its host names the old one`, async () => {
    const old = "/fixture/rollout-one.jsonl";
    const injected = sources({ selectInventory: undefined, listFiles: async () => [{ ...row, engine, path: old }, { ...row, engine, mtime: (now - 15_000) / 1000 }], describeTranscript: async p => ({ ...described, engine, path: p, mtimeMs: p === old ? now - 18_000_000 : now - 15_000 }), workProcesses: () => [] });
    const registry = injected.registrySnapshot();
    registry.entries.one.artifactPath = engine === "claude" ? old : transcript;
    registry.conversations = { conversation_one: { id: "conversation_one", generations: [{ path: old }, { path: transcript }], continuityPaths: [] } } as unknown as RegistryFile["conversations"];
    const snapshot = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.conversations[0]).toMatchObject({ transcriptPath: transcript, previousPaths: [old], lifecycle: "running", activity: { state: "working" } });
    const targeted = await agentLivenessSnapshot({ conversationId: "conversation_one" }, { ...injected, registrySnapshot: () => registry });
    expect(targeted.conversations[0].transcriptPath).toBe(transcript);
  });
}

for (const engine of ["codex", "claude"] as const) {
  test(`${engine} native tool records keep a long check running and a truly idle turn stalled`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-native-"));
    const file = path.join(dir, "one.jsonl");
    const stamp = (age: number) => new Date(now - age).toISOString();
    const records = engine === "codex" ? [
      { type: "event_msg", timestamp: stamp(900_000), payload: { type: "task_started", turn_id: "turn-one" } },
      { type: "response_item", timestamp: stamp(660_000), payload: { type: "function_call", name: "sleep", call_id: "wait-one", arguments: '{"duration_ms":50000}' } },
    ] : [
      { type: "user", timestamp: stamp(900_000), message: { content: "Run the checks" } },
      { type: "assistant", timestamp: stamp(660_000), message: { content: [{ type: "tool_use", id: "wait-one", name: "Bash", input: { command: "sleep 55 && gh pr checks 1 --watch" } }] } },
    ];
    try {
      fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join("\n")+"\n");
      const injected = sources({ selectInventory: undefined, listFiles: async () => [{ ...row, path: file, engine }], transcriptEvidence: (_engine, p) => readLivenessTranscriptEvidence(engine, p), workProcesses: () => [] });
      const registry = injected.registrySnapshot(); registry.entries.one.artifactPath = file;
      const checked = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
      expect(checked.conversations[0]).toMatchObject({ verified: true, lifecycle: "running", activity: { state: "checking" } });
      fs.writeFileSync(file, JSON.stringify(records[0])+"\n");
      const idle = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
      expect(idle.conversations[0]).toMatchObject({ verified: true, lifecycle: "stalled", activity: { state: "idle", idleForMs: 900_000 } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}


test("Claude background work survives beyond the bounded transcript tail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-background-"));
  const file = path.join(dir, "one.jsonl");
  const stamp = (age: number) => new Date(now-age).toISOString();
  const records = [
    { type: "user", timestamp: stamp(900_000), message: { content: "Run the long check" } },
    { type: "assistant", timestamp: stamp(850_000), message: { content: [{ type: "tool_use", id: "check-one", name: "Bash", input: { command: "bun test check.test.ts", description: "check tests", run_in_background: true } }] } },
    { type: "user", timestamp: stamp(840_000), toolUseResult: { backgroundTaskId: "background-one" }, message: { content: [{ type: "tool_result", tool_use_id: "check-one", content: "running" }] } },
    { type: "system", timestamp: stamp(700_000), content: "padding ".repeat(24_000) },
    { type: "assistant", timestamp: stamp(660_000), message: { content: [{ type: "tool_use", id: "short-one", name: "Bash", input: { command: "true" } }] } },
  ];
  try {
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n")+"\n");
    const injected = sources({ selectInventory: undefined, listFiles: async () => [{ ...row, path: file, engine: "claude" }], transcriptEvidence: (_engine, p) => readLivenessTranscriptEvidence("claude", p), workProcesses: () => [] });
    const registry = injected.registrySnapshot(); registry.entries.one.artifactPath = file;
    const result = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
    expect(result.conversations[0]).toMatchObject({ verified: true, lifecycle: "running", activity: { state: "checking" } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("incomplete background history cannot assert idle or retire an earlier stall", async () => {
  const result = await agentLivenessSnapshot({}, sources({ selectInventory: undefined, listFiles: async () => [row], transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now - 660_000, activityFacts: { lastRecordAt: now - 660_000, backgroundVerified: false } }) }));
  expect(result.conversations[0]).toMatchObject({ lifecycle: "running", reason: "evidence_unverified", verified: false, silentForMs: null });
  expect(projectLivenessEvents(result.conversations, new Map([["conversation_one", "stalled"]]))).toEqual([]);
});


test("a dead resumed host also resolves the newest file by stat when both catalog times are stale", async () => {
  const old = "/fixture/rollout-one.jsonl";
  const injected = sources({ selectInventory: undefined, listFiles: async () => [{ ...row, path: old }, row], describeTranscript: async p => ({ ...described, path: p, mtimeMs: p === old ? now - 18_000_000 : now - 15_000 }), transcriptEvidence: async (_engine, p) => ({ turn: "busy", lastRecordTs: p === old ? now - 18_000_000 : now - 15_000 }), probe: { now: () => now, pidAlive: () => false, processIdentity: () => null } });
  const registry = injected.registrySnapshot(); registry.entries.one.artifactPath = old;
  registry.conversations = { conversation_one: { id: "conversation_one", generations: [{ path: old }, { path: transcript }], continuityPaths: [] } } as unknown as RegistryFile["conversations"];
  const result = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
  expect(result.conversations).toHaveLength(1);
  expect(result.conversations[0]).toMatchObject({ transcriptPath: transcript, silentForMs: 15_000, previousPaths: [old], verified: true });
});


for (const verified of [true, false]) {
  test(`a current permission request keeps its waiting state with tail verification ${verified}`, async () => {
    const injected = sources({ selectInventory: undefined, listFiles: async () => [row], transcriptEvidence: async () => verified ? { turn: "busy", lastRecordTs: now - 660_000 } : null });
    const registry = injected.registrySnapshot();
    registry.entries.one.structuredHost!.pendingPermissions = [{ id: "permission-one", tool: "Bash", command: "run check", reason: "approve check", reasonType: "safetyCheck", since: new Date(now-660_000).toISOString() }];
    const result = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
    expect(result.conversations[0]).toMatchObject({ lifecycle: "waiting", reason: "permission_request", verified });
    expect(result.conversations[0]).not.toHaveProperty("activity");
  });
}
test("a provider retry has no idle activity even after eleven quiet minutes", async () => {
  const injected = sources({ selectInventory: undefined, listFiles: async () => [row], transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now-660_000 }) });
  const registry = injected.registrySnapshot();
  registry.entries.one.structuredHost!.providerRetry = { at: new Date(now-700_000).toISOString(), retryAt: new Date(now+60_000).toISOString(), status: 429, error: "rate_limit" };
  const result = await agentLivenessSnapshot({}, { ...injected, registrySnapshot: () => registry });
  expect(result.conversations[0]).toMatchObject({ lifecycle: "waiting", reason: "provider_throttled" });
  expect(result.conversations[0]).not.toHaveProperty("activity");
});


test("parallel hosted reads respect the requested project", async () => {
  const own = "/fixture/scoped-one.jsonl";
  const other = "/fixture/scoped-other.jsonl";
  const reads: string[] = [];
  const injected = sources({
    selectInventory: async () => ({ entries: [{ ...row, path: own, conversationId: "conversation_scope" }], scanned: 1, matched: 1, hostedSeen: new Set([own]), generation: 1, cacheStatus: "stale", freshScan: false, selectionMs: 0 }),
    describeTranscript: async path => ({ ...described, path, project: path === own ? "fixture" : "elsewhere", conversationId: path === own ? "conversation_scope" : "conversation_elsewhere" }),
    transcriptEvidence: async (_engine, path) => { reads.push(path); return { turn: "busy", lastRecordTs: now - 10_000 }; },
  });
  const registry = injected.registrySnapshot();
  registry.entries.one.artifactPath = own;
  registry.entries.two = { ...registry.entries.one, key: { ...registry.entries.one.key, sessionId: "two" }, artifactPath: other, structuredHost: { ...registry.entries.one.structuredHost!, process: { pid: 43, startIdentity: "host-start" } } };
  const result = await agentLivenessSnapshot({ project: "fixture", liveOnly: true, answerBudgetMs: 800 }, { ...injected, registrySnapshot: () => registry });
  expect(reads).toEqual([own]);
  expect(result.conversations).toHaveLength(1);
  expect(result.conversations[0]).toMatchObject({ transcriptPath: own, verified: true });
  reads.length = 0;
  const moved = await agentLivenessSnapshot({ project: "fixture", liveOnly: true, answerBudgetMs: 800 }, { ...injected, registrySnapshot: () => registry, describeTranscript: async path => ({ ...described, path, project: "elsewhere" }) });
  expect(reads).toEqual([]);
  expect(moved.conversations).toHaveLength(0);
});
