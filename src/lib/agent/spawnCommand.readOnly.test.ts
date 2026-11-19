import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { NextRequest } from "next/server";

import { setCodexShellPolicyReaderForTest } from "@/lib/git/codexShellPolicy";
import { claimPass, patchPass } from "@/lib/memory/curation/store";
import { newRuleId, roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { launchMaintenanceConversation } from "@/lib/boardMaintenance/run";
import { projectForCwd } from "@/lib/scanner/describe";
import { reportSpawnHeaders } from "@/lib/telegram/reportSpawn";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { materializeStructuredHostAccess, structuredHostAccessPolicy, type StructuredSpawnInput } from "@/lib/runtime/structuredSpawn";
import { launchAutonomousConversation } from "./autonomousConversation";
import { setCodexFeatureReaderForTest } from "./codexSpawnPolicy";
import { ensureOperatorSpawnCapability } from "./operatorCapability";
import { AgentRegistry } from "./registry";
import { executeSpawnRequest, productionSpawnCommandDependencies, type SpawnCommandDependencies } from "./spawnCommand";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./spawnPolicy";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-launch-"));
const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
const workspace = path.join(root, "repository");
const accountHome = path.join(root, "account");
fs.mkdirSync(workspace);
fs.mkdirSync(accountHome);
const launchEnv = { LLV_SPAWN_TRANSPORT: "structured", LLV_STRUCTURED_HOSTS: "1", LLV_RUNTIME_EVENTS: "1",
  LLV_RUNTIME_HOST_SOCKET: path.join(root, "runtime.sock"), NEXT_PUBLIC_RUNTIME_UI: "1" };
const previousEnv = Object.fromEntries(Object.keys(launchEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, launchEnv);
afterAll(() => {
  registry.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function claimFixtureCuration(cwd: string) {
  const project = projectForCwd(cwd);
  if (!project) throw new Error("fixture curation directory has no project");
  const at = "2026-11-19T12:34:00.000Z";
  const scope = roleScope(project, "builder");
  roleMemoryCollection(true)!.boundedPatch(4, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope, state: "active", hints: [],
      rule: "Read the current scope before changing a stored rule.",
      why: "Preserve the guidance agreed for the scope.",
      source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder",
        fixRound: false, conversationId: "conversation_curator_fixture" },
      createdAt: at, changedAt: at });
    tx.put({ kind: "scope", scope, revision: 1, history: [], active: [id] });
  });
  const pass = claimPass({ project, repoDir: cwd, now: Date.parse(at) });
  if (!pass) throw new Error("fixture curation pass could not claim the machine");
  return pass;
}

async function launch(
  engine: "codex" | "claude",
  role: string,
  entry: "normal" | "maintenance" | "curation",
  overrides: Record<string, unknown> = {},
) {
  const cwd = entry === "curation" ? path.join(workspace, engine) : workspace;
  fs.mkdirSync(cwd, { recursive: true });
  const account = {
    engine, kind: "managed" as const, accountId: "fixture-account",
    home: accountHome, transcriptRoot: path.join(accountHome, "sessions"), env: { ...process.env },
  };
  const dispatched = Promise.withResolvers<StructuredSpawnInput>();
  const dependencies: SpawnCommandDependencies = {
    ...productionSpawnCommandDependencies,
    registry: () => registry,
    assertStructuredRuntime: () => {},
    preflightProtocol: async () => {},
    publishFilesRevision: async () => {},
    engineReadiness: () => "connected",
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    runtimeHostClient: () => ({} as RuntimeHostClient),
    storeImages: () => [],
    recordOperatorRequest: undefined,
    defer: callback => { void callback(); },
    spawnStructuredConversation: async input => {
      dispatched.resolve(input);
      return {
        ok: true, target: null, path: null, effectivePermissionMode: "default", launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId, launched: true, retrySafe: false, initialMessage: "delivered", state: "settled",
      };
    },
  };
  const pass = entry === "curation" ? claimFixtureCuration(cwd) : null;
  const clientAttemptId = `fixture_${role}_${engine}_${entry}`;
  const body = {
    role, engine, model: engine === "codex" ? "gpt-6.1-sol" : "opus", cwd,
    clientAttemptId, title: "Inspect a fixture repository", prompt: "Read the fixture tree.", mcpServers: ["viewer"],
    notifyLauncher: false,
    ...(pass ? { project: pass.project, clientAttemptId: pass.id } : {}),
    ...overrides,
  };
  const headers = reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER);
  const request = { headers, json: async () => body } as unknown as NextRequest;
  const original = { ...productionSpawnCommandDependencies };
  const restoreFeatures = setCodexFeatureReaderForTest(() => []);
  const restoreShellPolicy = setCodexShellPolicyReaderForTest(() => ({}));
  try {
    Object.assign(productionSpawnCommandDependencies, dependencies);
    const result = entry === "maintenance" ? await launchMaintenanceConversation(body)
      : entry === "curation" ? await launchAutonomousConversation(body, () => {})
      : await executeSpawnRequest(request, dependencies).then(async response => ({ status: response.status, body: await response.json() }));
    const input = result.status === 202 ? await dispatched.promise : null;
    if (result.status !== 202 && !overrides.allowSubagents && !overrides.clientAttemptId) throw new Error(JSON.stringify(result));
    return { ...result, input, receipt: registry.spawnReceiptForClientAttempt(body.clientAttemptId) };
  } finally {
    Object.assign(productionSpawnCommandDependencies, original);
    restoreFeatures();
    restoreShellPolicy();
    if (pass) patchPass(pass.id, { state: "failed", endedAt: pass.claimedAt });
  }
}

test.each(["codex", "claude"] as const)("normal and scheduled read-only launches retain the Viewer grant on %s", async engine => {
  for (const [entry, role] of [["normal", "issue-reporter"], ["maintenance", "maintainer"], ["curation", "curator"]] as const) {
    const result = await launch(engine, role, entry, { readOnly: false, sandbox: "full", permissionMode: "bypassPermissions" });
    expect(result.status).toBe(202);
    expect(result.receipt?.agentRole).toBe(role);
    const profile = result.receipt?.launchProfile;
    const expectedAccess = {
      readOnly: true, sandbox: "read-only", permissionMode: engine === "codex" ? "never" : "default",
      mcpServers: ["viewer"], allowSubagents: false,
    };
    expect(profile).toMatchObject(expectedAccess);
    expect(result.input?.spec.launchProfile).toMatchObject(expectedAccess);
    const access = materializeStructuredHostAccess(structuredHostAccessPolicy(profile), process.env, null, root);
    try {
      expect(access.host.standaloneReadOnly).toBeTrue();
      expect(access.codex.requireReadOnlySandbox).toBeTrue();
      expect(access.codex.permissionProfileConfig).toBe(
        `permissions.${access.codex.permissionProfile}={extends=":read-only",filesystem={${JSON.stringify(access.scratchDirectory)}="write",${JSON.stringify(access.env.LLV_EVIDENCE_DIR)}="write"}}`,
      );
      expect(access.codex.permissionProfileConfig).not.toContain(JSON.stringify(profile!.cwd));
    } finally { access.cleanup(); }
  }
});

test("write-capable launches keep their policy and read-only roles refuse native subagents", async () => {
  for (const engine of ["codex", "claude"] as const) {
    const writable = await launch(engine, "builder", "normal");
    expect(writable.status).toBe(202);
    expect(writable.receipt?.launchProfile).toMatchObject({ readOnly: false, sandbox: null, mcpServers: ["viewer"] });
    expect(structuredHostAccessPolicy(writable.receipt?.launchProfile)).toBeFalse();
  }

  const refused = await launch("claude", "architect", "normal", { allowSubagents: true, clientAttemptId: "fixture_refused_subagents" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toBe("read-only roles cannot enable subagents");
  expect(refused.receipt).toBeNull();
});

test("an old unrestricted attempt cannot be reused for a registered read-only role", async () => {
  const id = "fixture_old_unrestricted";
  const old = registry.beginSpawnRequest({ engine: "codex", cwd: workspace, clientAttemptId: id, role: "maintainer", origin: { kind: "operator" },
    launchProfile: { title: "Old unrestricted launch", readOnly: false } });
  expect(old.kind).toBe("created");
  const replay = await launch("codex", "maintainer", "maintenance", { clientAttemptId: id });
  expect(replay.status).toBe(409);
  expect(replay.body.error).toBe("read-only role cannot reuse an unrestricted launch");
  expect(replay.receipt?.launchId).toBe(old.receipt.launchId);
});
