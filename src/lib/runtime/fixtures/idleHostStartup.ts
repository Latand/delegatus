import fs from "node:fs";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { structuredStartupAdoptionFilter } from "../startup";

const [directory, engine, mode] = process.argv.slice(2);
if (!directory || !["codex", "claude", "copilot"].includes(engine!) || !["seed", "observe"].includes(mode!)) {
  throw new Error("invalid startup fixture arguments");
}
const nativeEngine = engine as "codex" | "claude" | "copilot";
const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
const transcript = path.join(directory, "transcript.jsonl");
try {
  if (mode === "seed") {
    fs.writeFileSync(transcript, "");
    const conversation = registry.ensureConversation(nativeEngine, transcript, null);
    const key = { engine: nativeEngine, sessionId: conversation.generations[0]!.id };
    registry.upsert({ key, artifactPath: transcript, cwd: directory, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory }), status: "idle", host: null,
      structuredHost: { kind: engine === "codex" ? "codex-app-server" : engine === "claude" ? "claude-broker" : "copilot-acp",
        endpoint: "fixture:host", process: { pid: 1234567, startIdentity: "retained-native-start", bootEpoch: "fixture-boot" },
        eventCursor: 0, protocolVersion: "test", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    console.log(JSON.stringify({ seeded: true }));
  } else {
    const conversation = registry.conversationForPath(transcript)!;
    const key = { engine: nativeEngine, sessionId: conversation.generations[0]!.id };
    const entry = registry.hostEntry(key)!;
    const signals = { hostedRunningConversationIds: new Set<string>(), pendingOperationConversationIds: new Set<string>(),
      pendingCodexContinuationConversationIds: new Set<string>(), admittedMessages: new Map() };
    const skipped = await structuredStartupAdoptionFilter(registry, signals, undefined, new Map(), () => []);
    const idleSelected = skipped(entry);
    signals.pendingOperationConversationIds.add(conversation.id);
    const owed = await structuredStartupAdoptionFilter(registry, signals, undefined, new Map(), () => []);
    console.log(JSON.stringify({ idleSelected, owedSelected: owed(entry), pendingWork: owed.pendingWork(entry),
      retainedStart: registry.hostEntry(key)!.structuredHost!.process!.startIdentity }));
  }
} finally { registry.close(); }
