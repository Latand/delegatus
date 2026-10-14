import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { PROJECT_RESOLUTION_VERSION, projectResolutionStateKey } from "@/lib/scanner/projectState";
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

test("an incomplete scan refuses an unknown project immediately before claiming its key", async () => {
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
      ok: false, code: "unknown_project", retryable: false,
      details: { outcome: "not-executed", nextAction: "new-request-permitted" },
    });
    expect("error" in result && result.error).toContain("no such project");
    expect(receipts.lookup("send_message_to_orchestrator:cold-send")).toBeNull();
    expect(writes).toBe(0);
    // Ordinary admission preparation refuses unknown projects before claiming too.
    const create = await service.callTool("create_orchestrator", { project: "unknown-project", clientRequestId: "cold-create" });
    expect(create).toMatchObject({ ok: false, code: "unknown_project", retryable: false });
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


/** Writes a Claude transcript with no working directory and returns its path. */
function listedTranscript(folder: string, name: string): string {
  const root = scanRootEntries().find(([rootName]) => rootName === "claude-projects")![1];
  const directory = path.join(root, folder);
  fs.mkdirSync(directory, { recursive: true });
  if (!bornPaths.includes(directory)) bornPaths.push(directory);
  const transcript = path.join(directory, `${name}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: name, message: { role: "user", content: "Synthetic" } })}\n`);
  return transcript;
}

/** A complete index record, as a scan persists it for these bytes under the
    current resolution state. */
function recordedMember(transcript: string, project: string, projectName: string) {
  const st = fs.statSync(transcript);
  return {
    summaryVersion: 4, rootName: "claude-projects", size: st.size, mtimeMs: st.mtimeMs, sidecarSize: null, sidecarMtimeMs: null,
    stateKey: projectResolutionStateKey(), project, projectName, projectRoot: null, kind: "session", cwd: null, sessionStartedAt: null,
    nativeParentThreadId: null, nativeForkSourceThreadId: null, title: "Synthetic", engine: "claude", fmt: "claude",
  };
}

test("a record written under an older resolution state is projected again", async () => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const seated = "conversation_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  designateSeat("stale-seated-project", "Stale name", seated);
  const listed = listedTranscript("-stale", "stale-session");
  catalogMembers([`claude-projects:${listed}`]);
  fs.mkdirSync(path.dirname(statePath("project-catalog.json")), { recursive: true });
  // The record claims the seat's name for another project, under a state key
  // that is no longer current: its claim is derived again and does not stand.
  fs.writeFileSync(statePath("project-catalog.json"), JSON.stringify({
    version: 2, resolutionVersion: PROJECT_RESOLUTION_VERSION,
    files: { [listed]: { ...recordedMember(listed, "stale-other-project", "Stale name"), stateKey: "older-state" } },
  }));
  const { posts, service } = seatSendHarness();
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Stale name", text: "Synthetic status", clientRequestId: "stale-record-send",
  })).toMatchObject({ ok: true, project: "stale-seated-project", conversationId: seated });
  expect(posts).toHaveLength(1);
});

test("a designated seat stays addressable when membership is ahead of the index", async () => {
  resetFilesRouteCacheForTests();
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  designateSeat("ahead-seated-project", "Ahead name", "conversation_88888888-8888-4888-8888-888888888888");
  catalogMembers(Array.from({ length: 257 }, (_, index) => `claude-projects:${listedTranscript("-ahead", String(index))}`));
  const { posts, service } = seatSendHarness();
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Ahead name", text: "Synthetic status", clientRequestId: "ahead-named-send",
  })).toMatchObject({ ok: true, project: "ahead-seated-project" });
  expect(posts).toHaveLength(1);
});

test("a shared name with two designated seats in the last completed catalog refuses immediately", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "initial");
  setFileScanRunnerForTests(async () => ({
    files: [], complete: true,
    projectCatalog: [{ project: "homonym-other-project", displayName: "Homonym target", smt: 1, conversations: 1 }],
  }));
  await completedFileScan();
  designateSeat("homonym-seated-project", "Homonym target", "conversation_33333333-3333-4333-8333-333333333333");
  designateSeat("homonym-other-project", "Homonym target", "conversation_homonym_other");
  setFileCatalogMembershipProbeForTests(async () => "changed");
  setFileScanRunnerForTests(async () => ({ files: [], projectCatalog: [], complete: false }));
  const { posts, service } = seatSendHarness();
  expect(await service.callTool("send_message_to_orchestrator", {
    project: "Homonym target", text: "Synthetic status", clientRequestId: "homonym-named-send",
  })).toMatchObject({ ok: false, code: "ambiguous_project", retryable: false });
  expect(posts).toHaveLength(0);
});

test("a known project without an active seat is refused before scan or dispatch", async () => {
  resetFilesRouteCacheForTests();
  setFileCatalogMembershipProbeForTests(async () => "fixture");
  let scans = 0;
  setFileScanRunnerForTests(async () => { scans += 1; return { files: [], projectCatalog: [], complete: false }; });
  expect(persistProjectAliases([{ source: "seatless-older-key", target: "seatless-project", displayName: "Seatless target" }])).toBe(true);
  const { posts, service } = seatSendHarness();
  const result = await service.callTool("send_message_to_orchestrator", {
    project: "Seatless target", text: "Synthetic status", clientRequestId: "seatless-named-send",
  });
  expect(result).toMatchObject({ ok: false, code: "unknown_project", retryable: false });
  expect("error" in result && result.error).toBe('no such project "Seatless target"; close matches: Seatless target (seatless-project)');
  expect(posts).toEqual([]);
  expect(scans).toBe(0);
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
