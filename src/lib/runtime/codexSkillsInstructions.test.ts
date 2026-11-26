import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { freshSpecFor, resumeSpecForSession } from "@/lib/agent/cli";
import { AgentRegistry, identityMaterializationFence } from "@/lib/agent/registry";
import { resolveLaunchAttachCommand } from "@/lib/agent/attachCommand";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { setCodexShellPolicyReaderForTest } from "@/lib/git/codexShellPolicy";
import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { defaultStartHost } from "./structuredSpawn";
import type { RuntimeHostClient } from "./client";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skills-"));
const restoreFeatures = setCodexFeatureReaderForTest(() => []);
const restorePolicy = setCodexShellPolicyReaderForTest(() => ({}));
afterAll(() => {
  restoreFeatures();
  restorePolicy();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

for (const mode of ["off", "sqlite"] as const)
test.each([false, true])(`host launch recovers skills policy from durable profiles and legacy role receipts (${mode}, resume=%s)`, async (resumed) => {
  for (const [index, scenario] of [
    { role: null, omit: false, expected: false },
    { role: "builder", omit: false, expected: true },
    { role: "reviewer", omit: false, expected: true },
    { role: null, omit: true, expected: true },
  ].entries()) {
    const cwd = path.join(sandbox, `${mode}-${resumed}-${index}`);
    fs.mkdirSync(cwd);
    const filename = path.join(cwd, "registry.json");
    let registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    const spec = freshSpecFor("codex", cwd, { codexHome: cwd, title: "Observe Codex launch policy",
      omitSkillsInstructions: scenario.omit });
    const sourcePath = path.join(cwd, "source.jsonl");
    let sourceId: string | undefined;
    const origin = scenario.role === "reviewer"
      ? { kind: "container" as const, container: "pipeline" as const, containerId: "skills-policy", creatorConversationId: null }
      : { kind: "operator" as const };
    if (resumed) {
      const original = registry.beginSpawnRequest({ engine: "codex", cwd, role: scenario.role, origin,
        transport: "structured", accountId: "account-a", launchProfile: spec.launchProfile });
      if (original.kind !== "created") throw new Error("source fixture receipt missing");
      sourceId = original.receipt.conversationId;
      registry.completeSpawn(original.receipt.launchId, { key: { engine: "codex", sessionId: "skills-resume" },
        artifactPath: sourcePath, cwd, launchProfile: spec.launchProfile, accountId: "account-a", status: "dead", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null });
    }
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd, transport: "structured", accountId: "account-a",
      ...(sourceId ? { conversationId: sourceId as `conversation_${string}`, purpose: "resume-successor", resumeSourcePath: sourcePath } : {}),
      role: scenario.role, origin, launchProfile: spec.launchProfile });
    if (begun.kind !== "created") throw new Error("skills fixture receipt missing");
    registry.close();
    const reader = Bun.spawnSync([process.execPath, "-e", `
      import { AgentRegistry } from "./src/lib/agent/registry";
      const registry = new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: process.argv[3] as "off" | "sqlite" });
      const receipt = registry.readOnlySnapshot().receipts[process.argv[2]];
      process.stdout.write(JSON.stringify(receipt.launchProfile.omitSkillsInstructions === true));
      registry.close();
    `, filename, begun.receipt.launchId, mode], { cwd: process.cwd(), env: process.env, stdin: "ignore" });
    expect(reader.exitCode).toBe(0);
    expect(JSON.parse(reader.stdout.toString())).toBe(scenario.omit);
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    const receipt = registry.readOnlySnapshot().receipts[begun.receipt.launchId]!;
    expect(receipt.launchProfile.omitSkillsInstructions === true).toBe(scenario.omit);
    const seen: CodexAppServerHostOptions[] = [];
    const start = spyOn(CodexAppServerHost, "start").mockImplementation(async options => {
      seen.push(options);
      throw new Error("captured skills policy");
    });
    const adopt = spyOn(CodexAppServerHost, "adopt").mockImplementation(async (_id, options) => {
      seen.push(options);
      throw new Error("captured skills policy");
    });
    try {
      await expect(defaultStartHost({ engine: "codex", registry, receipt,
        spec: { ...spec, launchProfile: receipt.launchProfile },
        account: { engine: "codex", accountId: "account-a", kind: "managed", home: cwd,
          transcriptRoot: cwd, env: { NODE_ENV: "test" } },
        "prompt": "", client: {} as RuntimeHostClient }, "fixture-capability")).rejects.toThrow("captured skills policy");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.omitSkillsInstructions === true).toBe(scenario.expected);
      const sessionId = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
      const artifactPath = path.join(cwd, "rollout.jsonl");
      fs.writeFileSync(artifactPath, JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n");
      registry.completeSpawn(receipt.launchId, { key: { engine: "codex", sessionId }, artifactPath, cwd,
        accountId: "account-a", status: "live", host: null, claimEpoch: 1,
        claimOwner: "structured-host:skills-fixture", pendingAction: "spawn",
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:skills-fixture",
          process: { pid: 2147482500 + index, startIdentity: "skills-fixture" }, eventCursor: 0,
          protocolVersion: "0.162.1", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
      expect(registry.finalizeStructuredSpawn(receipt.launchId).kind).toBe("settled");
      const attached = resolveLaunchAttachCommand({ receipt: registry.spawnReceipt(receipt.launchId),
        materializationFence: identityMaterializationFence(), materializedPath: null,
        resolveByPath: () => ({ ok: false, error: "not scanned", status: 404 }),
        resumeSpecForSession, homeForAccount: () => cwd, accountLabelFor: () => "Account A" });
      expect(attached).toMatchObject({ ok: true });
      if (attached.ok) expect(attached.value.command.includes("skills.include_instructions=false")).toBe(scenario.expected);
    } finally { start.mockRestore(); adopt.mockRestore(); registry.close(); }
  }
});
