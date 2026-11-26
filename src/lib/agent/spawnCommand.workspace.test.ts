import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { projectForCwd } from "@/lib/scanner/describe";
import type { Member } from "@/lib/team/contract";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import type { WorkspacePrincipal } from "@/lib/team/workspacePrincipal";
import { createWorkspace } from "@/lib/team/workspaces";

import { defaultModelFor } from "./models";
import { AgentRegistry } from "./registry";
import { beginLegacySpawnFixture } from "./registryTestFixtures";
import { executeSpawnRequest, type SpawnCommandDependencies } from "./spawnCommand";

/**
 * The workspace binding a seat launch records, through the real spawn
 * admission and the in-process request the seat command sends. The seat command
 * has already decided the binding, and admission records exactly that decision:
 * none, or a member with the marker that says the fence came from a message.
 */

const AT = "2026-11-11T08:00:00.000Z";
const W = `w_${"e".repeat(32)}`;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-workspace-spawn-"));
const ENV = { LLV_STATE_DIR: path.join(sandbox, "state"), LLV_SPAWN_TRANSPORT: "structured", LLV_RUNTIME_HOST_SOCKET: path.join(sandbox, "fixture.sock"),
  LLV_STRUCTURED_HOSTS: "1", LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1" };
const previous = Object.fromEntries(Object.keys(ENV).map(name => [name, process.env[name]]));
Object.assign(process.env, ENV);
resetTeamStoreForTests();
afterAll(() => {
  registry.close();
  resetTeamStoreForTests();
  for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const cwd = path.join(sandbox, "repo");
fs.mkdirSync(cwd, { recursive: true });
const registry = new AgentRegistry(path.join(sandbox, "registry.json"), undefined, undefined, { sqliteMode: "off" });
const store = teamStore();
const person = (id: string, role: Member["role"]): Member => {
  const row: Member = { id, name: id, role, status: "active", color: "teal", telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(row);
  return row;
};
const owner = person("m_owner", "owner");
const member = person("m_member", "member");
createWorkspace(store, owner, { id: W, name: "Alpha", projects: [projectForCwd(cwd)!] });
store.putWorkspaceMember(W, member.id, "member", owner.id, AT);
const scope: WorkspacePrincipal = { memberId: member.id, workspaceId: W };

/** The transcript of a settled conversation a member last wrote to. */
function fencedParent(): string {
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd, role: "orchestrator", origin: { kind: "operator" }, launchProfile: { mcpServers: ["viewer"] } });
  if (begun.kind !== "created") throw new Error("parent reservation failed");
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(sandbox, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "{}\n");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "claude", sessionId }, artifactPath, cwd, accountId: "parent-account",
    status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("parent settlement failed");
  store.admitConversationMember(settled.conversation.id, member.id);
  return artifactPath;
}

async function launch(src: string, overrides: Partial<SpawnCommandDependencies>) {
  const clientAttemptId = `workspace_${crypto.randomUUID()}`;
  const account = { engine: "claude" as const, accountId: "claude-test", kind: "managed" as const,
    home: path.join(sandbox, "claude"), transcriptRoot: path.join(sandbox, "claude", "sessions"), env: { NODE_ENV: "test" as const } };
  // The request the seat command sends in-process, on the Viewer's own authority.
  const request = { headers: new Headers({ host: "127.0.0.1", ...internalServiceHeaders("orchestrator"), [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability() }),
    json: async () => ({ clientAttemptId, title: "Workspace binding", engine: "claude", model: defaultModelFor("claude"), role: "builder", cwd, prompt: "inspect", src }) } as unknown as NextRequest;
  const response = await executeSpawnRequest(request, {
    registry: () => registry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: () => {},
    storeImages: () => [],
    spawnStructuredConversation: async () => { throw new Error("deferred launch is outside admission test"); },
    ...overrides,
  } as SpawnCommandDependencies);
  return { status: response.status, body: await response.json() as Record<string, unknown>, profile: registry.spawnReceiptForClientAttempt(clientAttemptId)?.launchProfile };
}

test("a caller's unbound decision launches unbound, whatever the parent's reach", async () => {
  const launched = await launch(fencedParent(), { workspacePrincipal: null });
  expect(launched).toMatchObject({ status: 202 });
  expect(launched.profile?.workspace).toBeUndefined();
});

test("a caller's message-authority decision is recorded with its marker", async () => {
  const launched = await launch(fencedParent(), { workspacePrincipal: { ...scope, fromMessage: true } });
  expect(launched).toMatchObject({ status: 202 });
  expect(launched.profile?.workspace).toEqual({ ...scope, fromMessage: true });
});
