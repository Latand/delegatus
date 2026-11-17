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

import { conversationDeliverabilityFromRecord } from "./deliverability";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deliverability-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function idleChild() {
  return ownFixtureTree(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
}

/** An identity this test captured from its own child and then ended. */
async function endedIdentity(): Promise<ProcessIdentity> {
  const child = idleChild();
  const identity = captureProcessIdentity(child.pid!);
  await stopFixtureTree(child);
  return identity;
}

function recordHost(engine: "claude" | "codex", host: ProcessIdentity, owner: ProcessIdentity) {
  const sessionId = crypto.randomUUID();
  const cwd = fs.mkdtempSync(path.join(sandbox, `${engine}-`));
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation(engine, artifactPath, "default");
  registry.upsert({
    key: { engine, sessionId }, artifactPath, cwd, accountId: "default", launchProfile: emptyLaunchProfile({ cwd }),
    status: "idle", host: null, claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(owner)}`, pendingAction: null,
    structuredHost: {
      kind: engine === "claude" ? "claude-broker" : "codex-app-server",
      endpoint: engine === "claude" ? "stdio:fixture" : "codex-unix:/nonexistent/fixture.sock",
      process: host, eventCursor: 3, protocolVersion: "fixture", writerClaimEpoch: 1,
      activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
  });
  return { registry, conversation };
}

test.each(["claude", "codex"] as const)("a %s host whose recorded owner process is gone is orphaned, never deliverable", async engine => {
  const host = idleChild();
  const { registry, conversation } = recordHost(engine, captureProcessIdentity(host.pid!), await endedIdentity());
  try {
    const result = await conversationDeliverabilityFromRecord(registry.snapshot(), { conversationId: conversation.id });
    expect(result).toMatchObject({
      conversationId: conversation.id,
      deliverable: false,
      condition: "orphaned",
      resumeRequired: true,
      processRecorded: true,
    });
    expect(result.reason).toContain("owner process is gone");
  } finally {
    registry.close();
    await stopFixtureTree(host);
  }
});

test.each(["claude", "codex"] as const)("a %s host whose recorded owner process runs stays deliverable", async engine => {
  const host = idleChild();
  const owner = idleChild();
  const { registry, conversation } = recordHost(engine, captureProcessIdentity(host.pid!), captureProcessIdentity(owner.pid!));
  try {
    expect(await conversationDeliverabilityFromRecord(registry.snapshot(), { conversationId: conversation.id })).toMatchObject({
      deliverable: true,
      condition: "deliverable",
    });
  } finally {
    registry.close();
    await Promise.all([stopFixtureTree(host), stopFixtureTree(owner)]);
  }
});
