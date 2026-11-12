import crypto from "node:crypto";
import path from "node:path";
import { normalizeRegistry, type RegistryFile } from "@/lib/agent/registry";
import type { ProcessIdentity } from "@/lib/processIdentity";

export const FIXTURE_NOW = Date.parse("2026-10-10T12:00:00Z");
export const FIXTURE_SESSION = ["01234567", "1234", "4123", "8123", "0123456789ab"].join("-");
export const FIXTURE_CONVERSATION = ["conversation", "central-state-fixture"].join("_") as `conversation_${string}`;
export const FIXTURE_TURN = "native-turn-one";
export const at = (offset: number) => new Date(FIXTURE_NOW + offset).toISOString();
export type FixtureEngine = "codex" | "claude" | "copilot";
export function fixtureRecords(engine: FixtureEngine) {
  if (engine === "codex") return {
    open: [{ type: "event_msg", timestamp: at(0), payload: { type: "task_started", turn_id: FIXTURE_TURN } },
      { type: "response_item", timestamp: at(100), payload: { type: "function_call", call_id: "historical-call" } }],
    close: [{ type: "event_msg", timestamp: at(1000), payload: { type: "task_complete", turn_id: FIXTURE_TURN } }],
  };
  if (engine === "claude") return {
    open: [{ type: "user", uuid: "native-prompt-one", timestamp: at(0), message: { role: "user", content: "fixture work" } }],
    close: [{ type: "assistant", timestamp: at(1000), message: { id: "native-answer-one", role: "assistant", model: "provider", stop_reason: "end_turn", content: [] } }],
  };
  return {
    open: [{ type: "user.message", id: "native-prompt-one", timestamp: at(0), data: { content: "fixture work" } },
      { type: "assistant.message", timestamp: at(100), data: { toolRequests: [{ toolCallId: "fixture-tool" }] } },
      { type: "assistant.turn_end", timestamp: at(200), data: {} }],
    close: [{ type: "tool.execution_complete", timestamp: at(500), data: { toolCallId: "fixture-tool" } },
      { type: "assistant.turn_start", timestamp: at(600), data: {} },
      { type: "assistant.message", timestamp: at(800), data: { content: "done", toolRequests: [] } },
      { type: "assistant.turn_end", timestamp: at(1000), data: {} }],
  };
}
export function fixtureRegistry(root: string, engine: FixtureEngine, native: ProcessIdentity, owner: ProcessIdentity | null): RegistryFile {
  const artifactPath = path.join(root, "native.jsonl");
  return normalizeRegistry({ version: 2, receipts: {},
    entries: { [`${engine}:${FIXTURE_SESSION}`]: { key: { engine, sessionId: FIXTURE_SESSION }, artifactPath, cwd: root,
      status: "live", pendingAction: null, structuredHostOperationId: "historical-launch", updatedAt: at(0), claimOwner: owner ? `structured-host:${JSON.stringify(owner)}` : null, claimEpoch: 1,
      structuredHost: { kind: engine === "codex" ? "codex-app-server" : engine === "claude" ? "claude-broker" : "copilot-acp",
        endpoint: `stdio:${native.pid}`, process: native, eventCursor: 0, writerClaimEpoch: 1,
        activeTurnRef: engine === "codex" ? FIXTURE_TURN : "local-prompt-ref", agentStateTurnStartedAt: FIXTURE_NOW,
        agentStateNativeTurnId: engine === "claude" ? "native-prompt-one" : null,
        agentStateNativePromptOrdinal: engine === "copilot" ? 1 : null,
        agentStateNativePromptAnchor: engine === "copilot" ? { device: null, inode: null, offset: 0, edgeHash: crypto.createHash("sha256").digest("hex") } : null, pendingAttention: [], activeFlags: [] } } },
    conversations: { [FIXTURE_CONVERSATION]: { id: FIXTURE_CONVERSATION, engine,
      turn: { state: "busy", source: "lifecycle", terminalAt: null, observedAt: at(0) },
      generations: [{ id: FIXTURE_SESSION, engine, path: artifactPath, launchProfile: { cwd: root } }], updatedAt: at(0) } } });
}
