import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-read-paths-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { saveTasks } = await import("@/lib/tasks/store");
const { savePipelines, buildPipeline } = await import("@/lib/pipelines/store");
const { createCompanionBoardReadPaths } = await import("./readPaths");
const { CompanionBoardReads } = await import("./boardReads");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("the six voice reads use task/pipeline persistence, liveness projection, and bounded transcript parsing", async () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const at = new Date(now).toISOString();
  saveTasks(["project-a", "project-b"].map(project => ({ id: `task-${project}`, project, text: project === "project-a" ? "Review export" : "Foreign task",
    status: "blocked", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at,
    note: { text: "Waiting for review", updatedAt: at, author: { kind: "operator" } },
    hold: { kind: "worker", note: "Reviewer must finish", since: at, by: "operator" }, steps: [{ id: "step", text: "Read the plan", state: "open" }] })));
  savePipelines(["project-a", "project-b"].map(project => buildPipeline({ id: `pipeline-${project}`, task: project === "project-a" ? "Review export pipeline" : "Foreign pipeline",
    project, repoDir: root, srcPath: null, srcConversationId: null, now: at, stages: [{ id: "review", kind: "run", prompt: "Review", next: null,
      effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-only", promptScaffold: null } }] })));
  const transcriptPath = path.join(root, "agent.jsonl");
  fs.writeFileSync(transcriptPath, Array.from({ length: 8 }, (_, index) => JSON.stringify({ type: "assistant", uuid: `message-${index}`, timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text: `Reply ${index} ${"x".repeat(500)}` }] } })).join("\n") + "\n");
  const entry: AgentRegistryEntry = { key: { engine: "claude", sessionId: "fixture-agent" }, artifactPath: transcriptPath, cwd: root, accountId: null,
    status: "live", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: at,
    structuredHost: { kind: "claude-broker", endpoint: "fixture", process: { pid: 4242, startIdentity: "fixture-process" }, eventCursor: 0,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } };
  const liveness: AgentLivenessSources = {
    now: () => now, probe: { now: () => now, pidAlive: () => true, processIdentity: () => "fixture-process" },
    listFiles: async () => [{ path: transcriptPath, project: "project-a", title: "Export reviewer", engine: "claude", root: "claude-projects", kind: "session",
      conversationId: "conversation_fixture", mtime: now / 1_000, size: fs.statSync(transcriptPath).size, activity: "live" } as FileEntry],
    describeTranscript: async () => null,
    registrySnapshot: () => ({ entries: { fixture: entry }, conversations: {} } as unknown as RegistryFile),
    pipelines: () => [], transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now }),
  };
  let opened = 0;
  const paths = createCompanionBoardReadPaths({ liveness, transcript: {
    selectedContext: { selectedConversation: () => ({ resolve: id => id === "conversation_fixture" ? { conversationId: id, engine: "claude", path: transcriptPath, project: "project-a" } : null,
      readTail: () => null }), pathAllowed: candidate => candidate === transcriptPath },
    pinnedTranscript: candidate => {
      expect(candidate).toBe(transcriptPath);
      opened++;
      const descriptor = fs.openSync(candidate, "r");
      return { descriptor, stat: fs.fstatSync(descriptor), rootName: "claude-projects", root, sameIdentity: () => true };
    },
  } });
  const reads = new CompanionBoardReads(paths);
  expect(await reads.call("project-a", "list_tasks", {})).toMatchObject({ total: 1, rows: [{ title: "Review export" }] });
  expect(await reads.call("project-a", "get_task", { taskId: "task-project-a" })).toMatchObject({ item: { note: "Waiting for review", hold: "Reviewer must finish", steps: [{ text: "Read the plan" }] } });
  expect(await reads.call("project-a", "list_pipelines", {})).toMatchObject({ total: 1, rows: [{ title: "Review export pipeline" }] });
  expect(await reads.call("project-a", "get_pipeline", { pipelineId: "pipeline-project-a" })).toMatchObject({ item: { stages: [{ state: "pending" }] } });
  expect(await reads.call("project-a", "agent_activity", {})).toMatchObject({ total: 1, rows: [{ state: "running", title: "Export reviewer" }] });
  const tail = await reads.call("project-a", "conversation_messages", { conversationId: "conversation_fixture" });
  expect(tail.rows).toHaveLength(4);
  expect(JSON.stringify(tail)).toContain("Reply 7");
  expect(JSON.stringify(tail)).not.toContain("Reply 0");
  expect(tail.speech.length).toBeLessThanOrEqual(1_600);
  expect(opened).toBe(1);
  await expect(reads.call("project-a", "get_task", { taskId: "task-project-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "get_pipeline", { pipelineId: "pipeline-project-b" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "conversation_messages", { conversationId: "conversation_foreign" })).rejects.toThrow("PROJECT_REFUSED");
  await expect(reads.call("project-a", "send_message", {})).rejects.toThrow("TOOL_NOT_ALLOWED");
  expect(opened).toBe(1);
});
