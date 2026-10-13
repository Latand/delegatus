import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { completedFileScan, resetFilesRouteCacheForTests, setFileCatalogMembershipProbeForTests, setFileScanRunnerForTests } from "@/lib/scanner/scanCache";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools, type ViewerControlDependencies, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, SqliteMcpReceiptStore } from "./server";

afterEach(() => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(null);
  setFileCatalogMembershipProbeForTests(null);
  fs.rmSync(statePath("files-scan-snapshot.json"), { force: true });
});

test("MCP waits for catalog membership before treating a cached inventory as complete", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "initial");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: true }));
  await completedFileScan();
  setFileCatalogMembershipProbeForTests(async () => "changed");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  // An older snapshot cannot prove that a newly created project is absent.
  await expect(productionDomainDependencies.completedFileScan()).rejects.toMatchObject({
    details: { code: "scan_incomplete", retryable: true },
  });
});

test("an incomplete scan refuses a cross-project seat send retryably before claiming its key", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  let complete = false;
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete }));
  const registry = agentRegistry();
  const caller = registry.ensureConversation("codex", "/sessions/source.jsonl", null);
  const domain: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    registrySnapshot: () => registry.readOnlySnapshot(),
    authorizedSeats: () => [{ conversationId: caller.id, path: "/sessions/source.jsonl", project: "source-project" }],
    attentionAuthority: () => ({ kind: "worker" as const, conversationId: caller.id, role: "builder" }),
    callerAttribution: () => ({ kind: "agent", conversationId: caller.id, role: "orchestrator" }),
    recoveryPredecessors: () => [],
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scan-receipts-"));
  const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  let writes = 0;
  const control = {
    post: async () => { writes += 1; throw new Error("unexpected dispatch"); },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, {
    recovery: viewerMcpRecoverableTools(domain),
  });
  const args = { project: "unknown-project", text: "Synthetic status", clientRequestId: "cold-send" };
  try {
    const result = await service.callTool("send_message_to_orchestrator", args);
    expect(result).toMatchObject({
      ok: false, code: "scan_incomplete", retryable: true,
      details: { retryAfterSeconds: 5, outcome: "not-executed", nextAction: "retry-same-key", resend: "safe" },
    });
    expect("error" in result && result.error).toContain("still scanning, retry in 5 s");
    expect(receipts.lookup("send_message_to_orchestrator:cold-send")).toBeNull();
    expect(writes).toBe(0);
    // Ordinary admission preparation uses the same retryable contract.
    const create = await service.callTool("create_orchestrator", { project: "unknown-project", clientRequestId: "cold-create" });
    expect(create).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
    expect(receipts.lookup("create_orchestrator:cold-create")).toBeNull();
    complete = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await completedFileScan();
    // The same key reaches normal project validation after the scan completes.
    expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
      ok: false, code: "unknown_project", retryable: false,
    });
    expect(writes).toBe(0);
  } finally {
    receipts.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A seat caller of `source-project` addressing another project by its display
    name, with the control plane recorded instead of reached. */
function seatSendHarness() {
  const registry = agentRegistry();
  const caller = registry.ensureConversation("codex", "/sessions/source.jsonl", null);
  const domain: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    registrySnapshot: () => registry.readOnlySnapshot(),
    authorizedSeats: () => [{ conversationId: caller.id, path: "/sessions/source.jsonl", project: "source-project" }],
    attentionAuthority: () => ({ kind: "worker" as const, conversationId: caller.id, role: "builder" }),
    callerAttribution: () => ({ kind: "agent", conversationId: caller.id, role: "orchestrator" }),
    recoveryPredecessors: () => [],
  };
  const posts: { pathname: string; body: Record<string, unknown> }[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, body) => {
      posts.push({ pathname, body });
      return { ok: true, outcome: "delivered", operationId: "fixture-operation" };
    },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, control, domain), new MemoryMcpReceiptStore(), undefined, {
    recovery: viewerMcpRecoverableTools(domain),
  });
  return { posts, service };
}

function designateSeat(project: string, displayName: string, conversationId: string): void {
  expect(persistProjectAliases([{ source: `${project}-older-key`, target: project, displayName }])).toBe(true);
  const at = "2026-10-13T00:00:00.000Z";
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId: `seed-${project}`, mode: "spawn", promptVersion: null, now: at });
  completeOrchestratorSeatIntent({ project, clientRequestId: `seed-${project}`, conversationId, path: null, now: at });
}

test("a seat send by display name reaches the designated seat while the cold scan is still running", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const seated = "conversation_11111111-1111-4111-8111-111111111111";
  designateSeat("cold-target-project", "Cold target", seated);
  const { posts, service } = seatSendHarness();
  const args = { project: "Cold target", text: "Synthetic status", clientRequestId: "cold-named-send" };
  const result = await service.callTool("send_message_to_orchestrator", args);
  expect(result).toMatchObject({ ok: true, project: "cold-target-project", conversationId: seated, created: false });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    pathname: "/api/orchestrator/message",
    body: { project: "cold-target-project", conversationId: seated },
  });
  expect(orchestratorSeatFor("cold-target-project").active?.conversationId).toBe(seated);
  // The same key replays its receipt: the scan state never causes a second delivery.
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: true, replayed: true, conversationId: seated });
  expect(posts).toHaveLength(1);
});

test("a transcript born after a completed scan does not refuse a seat send by display name", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "initial");
  setFileScanRunnerForTests(async () => ({
    files: [], complete: true,
    projectCatalog: [{ project: "born-target-project", displayName: "Born target", smt: 1, conversations: 1 }],
  }));
  await completedFileScan();
  const seated = "conversation_22222222-2222-4222-8222-222222222222";
  designateSeat("born-target-project", "Born target", seated);
  // Every later birth changes the membership key before the trailing scan can bless it.
  let births = 0;
  setFileCatalogMembershipProbeForTests(async () => `birth-${births += 1}`);
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const { posts, service } = seatSendHarness();
  for (const attempt of [1, 2, 3]) {
    const result = await service.callTool("send_message_to_orchestrator", {
      project: "Born target", text: "Synthetic status", clientRequestId: `born-named-send-${attempt}`,
    });
    expect(result).toMatchObject({ ok: true, project: "born-target-project", conversationId: seated, created: false });
  }
  expect(posts.map((post) => post.body.conversationId)).toEqual([seated, seated, seated]);
});

test("a name another project of the last completed catalog shares still waits for the complete scan", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "initial");
  setFileScanRunnerForTests(async () => ({
    files: [], complete: true,
    projectCatalog: [{ project: "homonym-other-project", displayName: "Homonym target", smt: 1, conversations: 1 }],
  }));
  await completedFileScan();
  designateSeat("homonym-seated-project", "Homonym target", "conversation_33333333-3333-4333-8333-333333333333");
  setFileCatalogMembershipProbeForTests(async () => "changed");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const { posts, service } = seatSendHarness();
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Homonym target", text: "Synthetic status", clientRequestId: "homonym-named-send",
  })).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
  expect(posts).toHaveLength(0);
});

test("a known name without a designated seat designates nothing from a partial catalog", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  expect(persistProjectAliases([{ source: "seatless-older-key", target: "seatless-project", displayName: "Seatless target" }])).toBe(true);
  const { posts, service } = seatSendHarness();
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Seatless target", text: "Synthetic status", clientRequestId: "seatless-named-send",
  })).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
  expect(posts).toHaveLength(0);
  expect(orchestratorSeatFor("seatless-project").active).toBeNull();
});

for (const [tool, args] of [
  ["board_snapshot", {}],
  ["get_conversation", { transcriptPath: "/sessions/missing.jsonl" }],
  ["conversation_action", { action: "archive", targets: [{ transcriptPath: "/sessions/missing.jsonl" }] }],
] as const) {
  test(`${tool} refuses without consuming its key during an incomplete scan`, async () => {
    resetFilesRouteCacheForTests();
    setFileCatalogMembershipProbeForTests(async () => "fixture");
    setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scan-other-receipts-"));
    const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
    const service = createMcpToolService(viewerMcpBindings(), receipts);
    try {
      const key = `cold-${tool}`;
      const result = await service.callTool(tool, { ...args, clientRequestId: key });
      expect(result).toMatchObject({
        ok: false, code: "scan_incomplete", retryable: true,
        details: { outcome: "not-executed", nextAction: "retry-same-key", retryAfterSeconds: 5 },
      });
      expect(receipts.lookup(`${tool}:${key}`)).toBeNull();
    } finally {
      receipts.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("an archive batch resolves its unknown members before changing known members", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const registry = agentRegistry();
  const known = registry.ensureConversation("codex", "/sessions/known.jsonl", null);
  const snapshot = structuredClone(registry.readOnlySnapshot());
  snapshot.conversations[known.id]!.projectOwnership = {
    project: "synthetic-archive-project", source: "operator",
    setAt: "2026-01-01T00:00:00Z", operationId: "synthetic-ownership",
  };
  let boardReads = 0;
  const domain: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    registrySnapshot: () => snapshot,
    boardFor: () => { boardReads += 1; throw new Error("unexpected board access"); },
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain), new MemoryMcpReceiptStore());
  const result = await service.callTool("conversation_action", {
    clientRequestId: "cold-mixed-archive", action: "archive",
    targets: [{ conversationId: known.id }, { transcriptPath: "/sessions/missing.jsonl" }],
  });
  expect(boardReads).toBe(0);
  expect(result).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
});
