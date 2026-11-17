import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterAll, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";

import { orphanedHostNoticeContext, structuredHostOrphaned } from "./orphanedHost";
import { startupHostSnapshot } from "./startupSnapshot";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orphaned-host-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const child = () => ownFixtureTree(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
async function ended(): Promise<ProcessIdentity> {
  const process = child();
  const identity = captureProcessIdentity(process.pid!);
  await stopFixtureTree(process);
  return identity;
}
const host = (process: ProcessIdentity | null) => ({
  kind: "claude-broker" as const, endpoint: "stdio:fixture", process, eventCursor: 1, protocolVersion: "fixture",
  writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [],
});
const claim = (identity: ProcessIdentity) => `structured-host:${JSON.stringify(identity)}`;

test("only a proven-gone structured owner over a running engine is an orphan", async () => {
  const engine = child();
  const owner = child();
  try {
    const running = captureProcessIdentity(engine.pid!);
    const gone = await ended();
    expect(structuredHostOrphaned({ claimOwner: claim(gone), structuredHost: host(running) })).toBe(true);
    // A live owner, no owner, a legacy claim and a missing engine prove nothing.
    expect(structuredHostOrphaned({ claimOwner: claim(captureProcessIdentity(owner.pid!)), structuredHost: host(running) })).toBe(false);
    expect(structuredHostOrphaned({ claimOwner: null, structuredHost: host(running) })).toBe(false);
    expect(structuredHostOrphaned({ claimOwner: "structured-host:live", structuredHost: host(running) })).toBe(false);
    expect(structuredHostOrphaned({ claimOwner: "operation:legacy", structuredHost: host(running) })).toBe(false);
    expect(structuredHostOrphaned({ claimOwner: claim(gone), structuredHost: host(null) })).toBe(false);
    // Both gone is a dead host, which the reclaimed path already handles.
    expect(structuredHostOrphaned({ claimOwner: claim(gone), structuredHost: host(await ended()) })).toBe(false);
  } finally {
    await Promise.all([stopFixtureTree(engine), stopFixtureTree(owner)]);
  }
});

test("the notice context names the row's conversation from its row-scoped snapshot", async () => {
  const engine = child();
  const sessionId = crypto.randomUUID();
  const cwd = fs.mkdtempSync(path.join(sandbox, "notice-"));
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const key = { engine: "claude" as const, sessionId };
  try {
    const conversation = registry.ensureConversation("claude", artifactPath, "default");
    registry.upsert({ key, artifactPath, cwd, accountId: "default", launchProfile: emptyLaunchProfile({ cwd }),
      status: "idle", host: null, claimEpoch: 1, claimOwner: claim(await ended()), pendingAction: null,
      structuredHost: host(captureProcessIdentity(engine.pid!)) });
    expect(orphanedHostNoticeContext(startupHostSnapshot(registry, key), `claude:${sessionId}`))
      .toEqual({ orphaned: true, conversationIds: [conversation.id] });
  } finally {
    registry.close();
    await stopFixtureTree(engine);
  }
});
