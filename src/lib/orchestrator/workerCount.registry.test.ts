import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { projectWorkerCounts } from "./workerCount";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "./seats";

test("a large SQLite registry reads only live host rows and their keyed lineage", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-registry-"));
  const file = path.join(directory, "agent-registry.json");
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  const entries: Record<string, unknown> = {}, conversations: Record<string, unknown> = {}, lineageEdges: Record<string, unknown> = {}, memberships: Record<string, unknown> = {};
  for (let index = 0; index < 10_000; index++) {
    const id = `conversation_child${index}`, sessionId = `session${index}`, artifactPath = `/sessions/child${index}.jsonl`;
    conversations[id] = { id, engine: "codex", generations: [{ id: sessionId, path: artifactPath, accountId: null }], agentRole: "builder" };
    entries[`codex:${sessionId}`] = { key: { engine: "codex", sessionId }, artifactPath, cwd: "/repo", accountId: null, status: index < 20 ? "idle" : "dead", host: null, structuredHost: { kind: "codex-app-server", endpoint: "/host", process: null, eventCursor: 0, protocolVersion: 1, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: "2026-10-12T00:00:00Z" };
    lineageEdges[id] = { childConversationId: id, parentConversationId: "conversation_seat", childSessionKey: { engine: "codex", sessionId }, parentSessionKey: null, childArtifactPath: artifactPath, parentArtifactPath: null, kind: "spawn", role: "builder", reviewsConversationId: null, source: "viewer-spawn", evidence: { launchId: null, clientAttemptId: null }, createdAt: "2026-10-12T00:00:00Z" };
    if (index === 0) memberships[id] = [{ conversationId: id, kind: "pipeline", containerId: "lane", role: "builder", slot: "build", stageId: "build", stageOrder: 0, round: null, parentConversationId: "conversation_seat", createdAt: "2026-10-12T00:00:00Z" }];
  }
  const seats = Array.from({ length: 10 }, (_, index) => ({ id: index === 0 ? "conversation_seat" : `conversation_seat${String.fromCharCode(97 + index)}`, project: index === 0 ? "one" : `project-${String.fromCharCode(97 + index)}` }));
  for (const seat of seats) conversations[seat.id] = { id: seat.id, engine: "codex", generations: [{ id: seat.id, path: `/sessions/${seat.id}.jsonl`, accountId: null, launchProfile: { cwd: directory } }], agentRole: "orchestrator" };
  fs.writeFileSync(file, JSON.stringify({ version: 2, entries, receipts: {}, conversations, lineageEdges, memberships, conversationAliases: { conversation_previous: "conversation_seat" } }));
  let snapshots = 0; let rows = 0;
  let registry: AgentRegistry | undefined;
  try {
    registry = new AgentRegistry(file, () => false, undefined, { sqliteMode: "sqlite", onSqliteSnapshotLoad: () => snapshots++, onSqliteRowPayloadRead: (_collection, count) => { rows += count; } });
    setAgentRegistryForTests(registry);
    for (const seat of seats) {
      beginOrchestratorSeatIntent({ project: seat.project, mandate: "Coordinate work", clientRequestId: seat.project, mode: "spawn" });
      completeOrchestratorSeatIntent({ project: seat.project, clientRequestId: seat.project, conversationId: seat.id === "conversation_seat" ? "conversation_previous" : seat.id, path: null });
    }
    const warmStart = performance.now();
    projectWorkerCounts({ pipelines: () => [{ project: "one", state: "running" }] });
    const warmMs = performance.now() - warmStart;
    snapshots = 0; rows = 0;
    const start = performance.now();
    const counts = projectWorkerCounts({ pipelines: () => [{ project: "one", state: "running" }] });
    const elapsedMs = performance.now() - start;
    console.info(`worker counter: ${elapsedMs.toFixed(2)} ms; first inventory ${warmMs.toFixed(2)} ms; ${rows} keyed rows; 10000 stored hosts`);
    expect(counts.machine).toBe(20);
    expect(snapshots).toBe(0);
    expect(rows).toBeLessThan(150);
    expect(rows).toBeGreaterThan(0);
  } finally {
    registry?.close(); setAgentRegistryForTests(null);
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("live children stay counted through seat rotation in JSON and SQLite registries", () => {
  for (const sqliteMode of ["off", "sqlite"] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-rotation-"));
    const previousState = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = directory;
    const file = path.join(directory, "agent-registry.json");
    const conversations = Object.fromEntries(["seat_old", "seat_new", "child_live"].map(id => [
      `conversation_${id}`, { id: `conversation_${id}`, engine: "codex", generations: [{ id: `session_${id}`, path: `/sessions/${id}.jsonl`, accountId: null, launchProfile: { cwd: directory } }], agentRole: id === "child_live" ? "builder" : "orchestrator" },
    ]));
    const childId = "conversation_child_live";
    const childSession = "session_child_live";
    fs.writeFileSync(file, JSON.stringify({ version: 2,
      entries: { [`codex:${childSession}`]: { key: { engine: "codex", sessionId: childSession }, artifactPath: `/sessions/child_live.jsonl`, cwd: directory, accountId: null, status: "idle", host: null,
        structuredHost: { kind: "codex-app-server", endpoint: "/host", process: null, eventCursor: 0, protocolVersion: "v2", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, claimEpoch: 0, claimOwner: null, pendingAction: null, updatedAt: "2026-10-12T00:00:00Z" } },
      receipts: {}, conversations,
      lineageEdges: { [childId]: { childConversationId: childId, parentConversationId: "conversation_seat_old", childSessionKey: { engine: "codex", sessionId: childSession }, parentSessionKey: null, childArtifactPath: "/sessions/child_live.jsonl", parentArtifactPath: null, kind: "spawn", role: "builder", reviewsConversationId: null, source: "viewer-spawn", evidence: { launchId: null, clientAttemptId: null }, createdAt: "2026-10-12T00:00:00Z" } },
      memberships: {}, conversationAliases: { conversation_previous: "conversation_seat_old" } }), "utf8");
    let registry: AgentRegistry | undefined;
    try {
      registry = new AgentRegistry(file, () => true, undefined, { sqliteMode });
      setAgentRegistryForTests(registry);
      beginOrchestratorSeatIntent({ project: "one", mandate: "Coordinate work", clientRequestId: `old-${sqliteMode}`, mode: "spawn" });
      completeOrchestratorSeatIntent({ project: "one", clientRequestId: `old-${sqliteMode}`, conversationId: "conversation_previous", path: null });
      expect(projectWorkerCounts({ pipelines: () => [] }).byProject.get("one")).toBe(1);
      beginOrchestratorSeatIntent({ project: "one", mandate: "Coordinate work", clientRequestId: `new-${sqliteMode}`, mode: "spawn" });
      completeOrchestratorSeatIntent({ project: "one", clientRequestId: `new-${sqliteMode}`, conversationId: "conversation_seat_new", path: null });
      expect(projectWorkerCounts({ pipelines: () => [] }).byProject.get("one")).toBe(1);
      const entry = registry.readOnlySnapshot().entries[`codex:${childSession}`]!;
      registry.upsert({ ...entry, status: "dead" });
      expect(projectWorkerCounts({ pipelines: () => [] }).machine).toBe(0);
    } finally {
      registry?.close(); setAgentRegistryForTests(null);
      if (previousState === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previousState;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
