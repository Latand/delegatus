import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { structuredStartupAdoptionFilter } from "./startup";

for (const engine of ["codex", "claude", "copilot"] as const) test(`startup selection leaves idle ${engine} hosts unadopted and retains owed work`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-idle-"));
  const registryPath = path.join(directory, "registry.json");
  let registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
  try {
    const transcript = path.join(directory, "transcript.jsonl");
    fs.writeFileSync(transcript, "");
    const conversation = registry.ensureConversation(engine, transcript, null);
    const key = { engine, sessionId: conversation.generations[0]!.id };
    registry.upsert({ key, artifactPath: transcript, cwd: directory, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory }), status: "idle", host: null,
      structuredHost: { kind: engine === "codex" ? "codex-app-server" : engine === "claude" ? "claude-broker" : "copilot-acp",
        endpoint: "fixture:host", process: null, eventCursor: 0, protocolVersion: "test",
        writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    registry.close();
    registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
    const entry = registry.hostEntry(key)!;
    const signals = { hostedRunningConversationIds: new Set<string>(), pendingOperationConversationIds: new Set<string>(),
      pendingCodexContinuationConversationIds: new Set<string>(), admittedMessages: new Map() };
    const skipped = await structuredStartupAdoptionFilter(registry, signals, undefined, new Map(), () => []);
    expect(skipped(entry)).toBeFalse();
    signals.pendingOperationConversationIds.add(conversation.id);
    const owed = await structuredStartupAdoptionFilter(registry, signals, undefined, new Map(), () => []);
    expect(owed(entry)).toBeTrue();
    expect(owed.pendingWork(entry)).toBeTrue();
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
