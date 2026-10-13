import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { scanRootEntries } from "@/lib/scanner/roots";
import { completedFileScan, resetFilesRouteCacheForTests, setFileCatalogMembershipProbeForTests, setFileScanRunnerForTests } from "@/lib/scanner/scanCache";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools, type ViewerControlDependencies, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, SqliteMcpReceiptStore } from "./server";

afterEach(() => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(null);
  setFileCatalogMembershipProbeForTests(null);
  fs.rmSync(statePath("files-scan-snapshot.json"), { force: true });
  fs.rmSync(statePath("project-catalog.json"), { force: true });
  for (const created of bornPaths.splice(0)) fs.rmSync(created, { recursive: true, force: true });
});

const bornPaths: string[] = [];

/** Writes a Claude transcript started in a folder of that name and returns its
    catalog member key. A folder's name is its project's display name. */
function bornTranscript(folderName: string, session: string): string {
  const cwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "born-folder-")), folderName);
  fs.mkdirSync(cwd, { recursive: true });
  const root = scanRootEntries().find(([name]) => name === "claude-projects")![1];
  const directory = path.join(root, `-born-${session}`);
  fs.mkdirSync(directory, { recursive: true });
  const transcript = path.join(directory, `${session}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: "user", cwd, sessionId: session, timestamp: "2026-10-13T00:00:00.000Z", message: { role: "user", content: "Synthetic" },
  })}\n`);
  bornPaths.push(path.dirname(cwd), directory);
  return `claude-projects:${transcript}`;
}

/** The probe answers with these members, as the real one lists the roots. */
function catalogMembers(members: readonly string[]): void {
  setFileCatalogMembershipProbeForTests(async () => JSON.stringify([...members].sort()));
}

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
  catalogMembers([bornTranscript("Unrelated folder", "unrelated-session")]);
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
  catalogMembers([]);
  setFileScanRunnerForTests(async () => ({
    files: [], complete: true,
    projectCatalog: [{ project: "born-target-project", displayName: "Born target", smt: 1, conversations: 1 }],
  }));
  await completedFileScan();
  const seated = "conversation_22222222-2222-4222-8222-222222222222";
  designateSeat("born-target-project", "Born target", seated);
  // Every later birth changes the membership key before the trailing scan can bless it.
  const members: string[] = [];
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const { posts, service } = seatSendHarness();
  for (const attempt of [1, 2, 3]) {
    members.push(bornTranscript(`Born elsewhere ${attempt}`, `elsewhere-session-${attempt}`));
    catalogMembers(members);
    const result = await service.callTool("send_message_to_orchestrator", {
      project: "Born target", text: "Synthetic status", clientRequestId: `born-named-send-${attempt}`,
    });
    expect(result).toMatchObject({ ok: true, project: "born-target-project", conversationId: seated, created: false });
  }
  expect(posts.map((post) => post.body.conversationId)).toEqual([seated, seated, seated]);
});

test("a born transcript whose folder shares the name refuses it, and other seats stay addressable", async () => {
  resetFilesRouteCacheForTests();
  catalogMembers([]);
  setFileScanRunnerForTests(async () => ({
    files: [], complete: true,
    projectCatalog: [{ project: "shared-seated-project", displayName: "Shared name", smt: 1, conversations: 1 }],
  }));
  await completedFileScan();
  designateSeat("shared-seated-project", "Shared name", "conversation_55555555-5555-4555-8555-555555555555");
  const safe = "conversation_66666666-6666-4666-8666-666666666666";
  designateSeat("safe-seated-project", "Safe name", safe);
  // The pending generation is the first to list the second "Shared name" project.
  catalogMembers([bornTranscript("Shared name", "shared-session")]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  setFileScanRunnerForTests(async () => {
    await held;
    return {
      files: [], complete: true,
      projectCatalog: [
        { project: "shared-seated-project", displayName: "Shared name", smt: 1, conversations: 1 },
        { project: "shared-born-project", displayName: "Shared name", smt: 2, conversations: 1 },
      ],
    };
  });
  const { posts, service } = seatSendHarness();
  const args = { project: "Shared name", text: "Synthetic status", clientRequestId: "shared-name-send" };
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
    ok: false, code: "scan_incomplete", retryable: true,
  });
  expect(posts).toHaveLength(0);
  // The same membership proves the other name unique, so its seat is reached at once.
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Safe name", text: "Synthetic status", clientRequestId: "safe-name-send",
  })).toMatchObject({ ok: true, project: "safe-seated-project", conversationId: safe, created: false });
  expect(posts.map((post) => post.body.conversationId)).toEqual([safe]);
  release();
  await completedFileScan();
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
    ok: false, code: "ambiguous_project", retryable: false,
    details: { candidates: expect.arrayContaining(["shared-born-project", "shared-seated-project"]) },
  });
  expect(posts).toHaveLength(1);
});

/** A complete index record, as a scan persists it for a transcript it listed. */
function recordedMember(project: string, projectName: string) {
  return {
    summaryVersion: 4, rootName: "claude-projects", size: 1, mtimeMs: 1, sidecarSize: null, sidecarMtimeMs: null,
    stateKey: "fixture", project, projectName, projectRoot: null, kind: "session", cwd: null, sessionStartedAt: null,
    nativeParentThreadId: null, nativeForkSourceThreadId: null, title: "Synthetic", engine: "claude", fmt: "claude",
  };
}

test("the persisted index answers for the transcripts it listed", async () => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const seated = "conversation_77777777-7777-4777-8777-777777777777";
  designateSeat("indexed-seated-project", "Indexed name", seated);
  const root = scanRootEntries().find(([name]) => name === "claude-projects")![1];
  const listed = path.join(root, "-indexed", "indexed-session.jsonl");
  catalogMembers([`claude-projects:${listed}`]);
  const { posts, service } = seatSendHarness();
  const send = (clientRequestId: string) => service.callTool("send_message_to_orchestrator", {
    project: "Indexed name", text: "Synthetic status", clientRequestId,
  });
  fs.mkdirSync(path.dirname(statePath("project-catalog.json")), { recursive: true });
  const index = (projectName: string) => fs.writeFileSync(statePath("project-catalog.json"), JSON.stringify({
    version: 2, resolutionVersion: 0, files: { [listed]: recordedMember("indexed-other-project", projectName) },
  }));
  index("Indexed name");
  expect(await send("indexed-shared-send")).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
  expect(posts).toHaveLength(0);
  index("Another indexed name");
  expect(await send("indexed-unique-send")).toMatchObject({ ok: true, project: "indexed-seated-project", conversationId: seated });
  expect(posts).toHaveLength(1);
});

test("a membership too far ahead of the index proves nothing", async () => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  designateSeat("ahead-seated-project", "Ahead name", "conversation_88888888-8888-4888-8888-888888888888");
  const root = scanRootEntries().find(([name]) => name === "claude-projects")![1];
  catalogMembers(Array.from({ length: 257 }, (_, index) => `claude-projects:${path.join(root, "-ahead", `${index}.jsonl`)}`));
  const { posts, service } = seatSendHarness();
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Ahead name", text: "Synthetic status", clientRequestId: "ahead-named-send",
  })).toMatchObject({ ok: false, code: "scan_incomplete", retryable: true });
  expect(posts).toHaveLength(0);
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

test("a membership that cannot be attributed refuses a name with a homonym in the pending scan", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "initial");
  setFileScanRunnerForTests(async () => ({
    files: [], complete: true,
    projectCatalog: [{ project: "pending-seated-project", displayName: "Pending homonym", smt: 1, conversations: 1 }],
  }));
  await completedFileScan();
  designateSeat("pending-seated-project", "Pending homonym", "conversation_44444444-4444-4444-8444-444444444444");
  // The second project exists only in the generation that has not completed.
  setFileCatalogMembershipProbeForTests(async () => "changed");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  setFileScanRunnerForTests(async () => {
    await held;
    return {
      files: [], complete: true,
      projectCatalog: [
        { project: "pending-seated-project", displayName: "Pending homonym", smt: 1, conversations: 1 },
        { project: "pending-born-project", displayName: "Pending homonym", smt: 2, conversations: 1 },
      ],
    };
  });
  const { posts, service } = seatSendHarness();
  const args = { project: "Pending homonym", text: "Synthetic status", clientRequestId: "pending-homonym-send" };
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
    ok: false, code: "scan_incomplete", retryable: true,
  });
  expect(posts).toHaveLength(0);
  release();
  await completedFileScan();
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
    ok: false, code: "ambiguous_project", retryable: false,
    details: { candidates: ["pending-born-project", "pending-seated-project"] },
  });
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
