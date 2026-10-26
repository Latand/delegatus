import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { emptyLaunchProfile, migrationSuccessorLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryFile } from "@/lib/agent/registry";
import { resetTeamStoreForTests, teamStore, teamStoreFile, type TeamStore } from "@/lib/team/store";
import { createWorkspace, placeProject } from "@/lib/team/workspaces";
import { setWorkspaceDefaults } from "@/lib/team/workspaceDefaults";
import type { Member } from "@/lib/team/contract";
import { projectForCwd } from "@/lib/scanner/describe";
import { shortId } from "@/lib/shortIds";
import { buildPipeline } from "@/lib/pipelines/store";
import { conversationWorkspacePrincipal } from "@/lib/team/workspacePrincipal";
import { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } from "@/lib/pipelines/engine";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { queuePipelineCreation, admitQueuedPipelineCreations, queuedPipelineCreationStatus } from "@/lib/pipelines/creationQueue";
import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest } from "next/server";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { installSpawnCapabilityResolver } from "@/lib/agent/callerClaims";
import { runAsMcpHttpCaller } from "./callerContext";
import { viewerMcpBindings, productionDomainDependencies, productionViewerControlDependencies, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createProductionViewerMcpService, MemoryMcpReceiptStore, type McpToolArgs, type McpToolService } from "./server";
import { withWorkspaceMcpFence } from "./workspaceFence";

const W1 = `w_${"a".repeat(32)}`, W2 = `w_${"b".repeat(32)}`;
const AT = "2026-10-20T09:00:00.000Z";
let root: string, store: TeamStore, own: string, other: string;
let snapshot: RegistryFile, dependencies: ViewerMcpDomainDependencies;
let owner: Member, member: Member;
let service: McpToolService;
let dispatched: string[];
let searchReply: Record<string, unknown> | null;
const previous = process.env.LLV_STATE_DIR;

function person(id: string, role: Member["role"]): Member {
  const row: Member = { id, name: id, role, status: "active", color: "teal", telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(row); return row;
}
function conversation(id: string, project: string, bound = true) {
  return { id, engine: "codex", continuityPaths: [], projectOwnership: { project }, generations: [{ path: `${id}.jsonl`, launchProfile: emptyLaunchProfile({ cwd: root, project,
    ...(bound ? { workspace: { memberId: member.id, workspaceId: W1 } } : {}) }) }] };
}
function rebuild() {
  service = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, {
    get: async url => { dispatched.push(url); return searchReply ?? { items: [], total: 0 }; },
    post: async url => { dispatched.push(url); return {}; },
  }, dependencies), new MemoryMcpReceiptStore()), dependencies);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-mcp-"));
  process.env.LLV_STATE_DIR = path.join(root, "state"); resetTeamStoreForTests();
  fs.mkdirSync(path.join(root, "other"));
  own = projectForCwd(root)!; other = projectForCwd(path.join(root, "other"))!;
  store = teamStore(); owner = person("m_owner", "owner"); member = person("m_member", "member");
  createWorkspace(store, owner, { id: W1, name: "Alpha", projects: [own, "project-sibling"] });
  createWorkspace(store, owner, { id: W2, name: "Beta", projects: [other] });
  store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
  snapshot = { conversations: { conversation_member: conversation("conversation_member", own), conversation_foreign: conversation("conversation_foreign", other, false) },
    entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversationAliases: {} } as unknown as RegistryFile;
  const tasks = [own, other].map((project, i) => ({ id: `task_${i}`, project, text: i ? "Foreign secret" : "Our task", status: "inbox", placement: "pinned", createdAt: AT, updatedAt: AT, pipelineIds: [], linkedPipelineIds: [], taskIds: [] }));
  const pipelines = [own, other].map((project, i) => buildPipeline({ id: `pipe_${i}`, project, task: i ? "Foreign pipeline" : "Our pipeline", repoDir: root, stages: [], srcPath: null, srcConversationId: null, now: AT }));
  dependencies = { ...productionDomainDependencies,
    attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_member", role: "builder" }),
    callerAttribution: () => ({ kind: "agent", conversationId: "conversation_member", role: "builder" }),
    registrySnapshot: () => snapshot, workspaceConversation: undefined, workspaceProject: undefined,
    loadTasks: () => tasks, listTaskRecords: () => tasks, taskSelectionSource: undefined,
    getPipelines: () => ({ pipelines }), listPipelineRecords: () => pipelines, pipelineSelectionSource: undefined, readPipelineRecord: (id: string) => pipelines.find(row => row.id === id),
    completedFileScan: async () => ({ snapshot: { files: [] } }),
    boardFor: () => ({ prefs: { hidden: [] } }),
  } as unknown as ViewerMcpDomainDependencies;
  dispatched = []; searchReply = null; rebuild();
});
afterEach(() => {
  resetTeamStoreForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const call = (tool: string, args: McpToolArgs = {}) => service.callTool(tool, { clientRequestId: `case-${tool}`, ...args });
const REFUSED = { ok: false, code: "workspace_forbidden", retryable: false };

test("real MCP bindings refuse foreign reads and writes across each project tool family before dispatch", async () => {
  for (const [tool, args] of [
    ["list_tasks", { project: other }], ["get_task", { taskId: "task_1" }], ["update_task", { taskId: "task_1", text: "replace" }],
    ["create_task", { project: other, text: "create" }], ["link_task_to_pipeline", { taskId: "task_0", pipelineId: "pipe_1" }],
    ["list_pipelines", { project: other }], ["get_pipeline", { pipelineId: "pipe_1" }], ["pipeline_action", { pipelineId: "pipe_1", action: "pause" }],
    ["pipeline_checks", { pipelineId: "pipe_1" }], ["stage_report", { pipelineId: "pipe_1", verdict: "pass" }],
    ["get_conversation", { conversationId: "conversation_foreign" }], ["conversation_messages", { transcriptPath: "conversation_foreign.jsonl" }],
    ["get_conversation", { selectedContext: { version: 1, state: "selected", capturedAt: AT, conversationId: "conversation_foreign" } }],
    ["get_conversation", { selectedContext: { version: 1, state: "selected", capturedAt: AT, conversationId: "conversation_member", tasks: [{ id: "task_1", title: "Task" }] } }],
    ["send_message", { conversationId: "conversation_foreign", text: "hello" }], ["conversation_action", { conversationId: "conversation_foreign", action: "kill" }],
    ["spawn_agent", { cwd: path.join(root, "other"), prompt: "work", engine: "codex" }],
    ["create_pipeline", { repoDir: root, taskIds: ["task_1"], stages: [] }],
    ["get_orchestrator", { project: other }], ["rotate_orchestrator", { project: other }], ["send_message_to_orchestrator", { project: other, text: "hello", crossProjectRequest: "requested" }],
    ["create_orchestrator", { project: other }], ["ask_orchestrator_in_parallel", { project: other }],
    ["conversation_action", { targets: [{ conversationId: "conversation_member" }, { conversationId: "conversation_foreign" }], action: "hide" }],
    ["seat_tick_settings", { project: other }], ["board_snapshot", { project: other }], ["agent_fleet", { project: other }],
    ["search_transcripts", { project: other, query: "secret" }], ["search_memory", { project: other, query: "secret" }],
    ["operator_snapshot", {}], ["resources", {}], ["account_project_binding", { project: own, action: "bind" }],
  ] as [string, McpToolArgs][]) {
    const result = await call(tool, args);
    expect(result).toMatchObject(REFUSED);
    expect(JSON.stringify(result)).not.toContain("Foreign secret");
  }
  expect(dispatched).toEqual([]);
});

test("a session stays in its bound workspace when its member also belongs to another", async () => {
  store.putWorkspaceMember(W2, member.id, "manager", owner.id, AT);
  expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
  expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
});

test("malformed identity arguments cannot turn a scoped read into an installation-wide read", async () => {
  for (const value of [{}, [], [own], 1, true]) {
    for (const tool of ["list_tasks", "list_pipelines", "board_snapshot", "agent_fleet", "search_transcripts", "seat_tick_settings"]) {
      expect(await call(tool, { project: value })).toMatchObject(REFUSED);
    }
    expect(await call("get_conversation", { conversationId: value })).toMatchObject(REFUSED);
    expect(await call("get_task", { taskId: value })).toMatchObject(REFUSED);
    expect(await call("pipeline_action", { pipelineId: value, action: "pause" })).toMatchObject(REFUSED);
  }
  expect(dispatched).toEqual([]);
});

test("implicit stage and lesson targets cannot follow an assignment into a foreign project", async () => {
  const foreign = dependencies.getPipelines().pipelines[1]!;
  foreign.runs.push({ stageId: "build", attempts: [{ conversationId: "conversation_member" }] } as never);
  expect(await call("stage_report", { verdict: "pass" })).toMatchObject(REFUSED);
  expect(await call("leave_lesson", { none: "No reusable lesson from this stage." })).toMatchObject(REFUSED);
});

test("transcript search suppresses global fallback and cross-workspace duplicate metadata", async () => {
  const stats = { conversationsIndexed: 10, messagesIndexed: 20, fieldsSearched: [], tokenizer: "unicode" };
  searchReply = { items: [{ project: other, snippet: "Foreign secret" }], total: 1, strongTotal: 1, nextCursor: "foreign-cursor", stats, projectScope: { resolved: null } };
  const fallback = await call("search_transcripts", { query: "secret" });
  expect(fallback).toMatchObject({ ok: true, items: [], total: 0, strongTotal: 0, nextCursor: null });
  expect(JSON.stringify(fallback)).not.toContain("Foreign secret");
  searchReply = { items: [{ project: own, snippet: "Our message", alsoIn: { transcriptPaths: ["conversation_foreign.jsonl"] }, duplicateCount: 2 }],
    total: 1, strongTotal: 1, nextCursor: null, stats, projectScope: { resolved: own } };
  const scoped = await call("search_transcripts", { query: "message", clientRequestId: "search-scoped" });
  expect(scoped.ok).toBe(true);
  if (!scoped.ok) throw new Error(scoped.error);
  expect(scoped.items).toEqual([{ project: shortId(own), snippet: "Our message" }]);
  expect(scoped.stats).toBeUndefined();
});

test("compact project prefixes cannot disclose rows from a colliding foreign workspace", async () => {
  const local = `dir-${"a".repeat(32)}`, foreign = `dir-${"a".repeat(8)}${"b".repeat(24)}`;
  placeProject(store, owner, local, W1); placeProject(store, owner, foreign, W2);
  searchReply = { items: [{ project: local, snippet: "Our message" }, { project: foreign, snippet: "Foreign secret" }],
    total: 2, strongTotal: 2, nextCursor: null, projectScope: { resolved: own },
    stats: { conversationsIndexed: 2, messagesIndexed: 2, fieldsSearched: [], tokenizer: "unicode" } };
  const compact = await call("search_transcripts", { query: "message" });
  expect(compact).toMatchObject({ ok: true, items: [] });
  const full = await call("search_transcripts", { query: "message", full: true, clientRequestId: "search-full" });
  expect(full).toMatchObject({ ok: true, items: [{ project: local, snippet: "Our message" }] });
  expect(JSON.stringify(full)).not.toContain("Foreign secret");
});

test("member collection reads default to their project, and explicit sibling projects remain reachable", async () => {
  const tasks = await call("list_tasks", { full: true });
  expect(tasks.ok).toBe(true);
  if (!tasks.ok) throw new Error(tasks.error);
  expect((tasks.tasks as { project: string }[]).map(row => row.project)).toEqual([own]);
  expect(JSON.stringify(tasks)).not.toContain("Foreign secret");
  expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
  expect((await call("get_pipeline", { pipelineId: "pipe_0" })).ok).toBe(true);
  expect((await call("board_snapshot", { project: "project-sibling" })).ok).toBe(true);
  expect((await call("list_conversations")).ok).toBe(true);
  expect(dispatched[0]).toContain(encodeURIComponent(own));
});

test("owner and unscoped installation seat retain their existing reach", async () => {
  for (const role of ["owner", "seat"]) {
    const id = `conversation_${role}`;
    snapshot.conversations[id] = conversation(id, own, false) as never;
    dependencies.attentionAuthority = () => ({ kind: "root", conversationId: id });
    if (role === "owner") store.recordMessageAuthor({ clientMessageId: "owner-turn", conversationId: id, memberId: owner.id, at: AT, textDigest: null });
    else snapshot.conversations[id].agentRole = "orchestrator";
    rebuild();
    expect((await call("get_task", { taskId: "task_1" })).ok).toBe(true);
    const listed = await call("list_tasks", { full: true });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.tasks).toHaveLength(2);
  }
});

test("named launch and migration accounts cannot escape the workspace pool", async () => {
  setWorkspaceDefaults(store, owner, W1, { accounts: { codex: ["account-a"] } });
  for (const key of ["accountId", "targetAccountId"]) {
    expect(await call("conversation_migration", { conversationId: "conversation_member", action: "switch", [key]: "account-b" })).toMatchObject(REFUSED);
  }
  expect(await call("spawn_agent", { cwd: root, engine: "codex", accountId: "account-b" })).toMatchObject(REFUSED);
  expect(dispatched).toEqual([]);
});

test("an unidentified caller cannot use a forged source or member id to obtain installation reach", async () => {
  dependencies.attentionAuthority = () => ({ kind: "unidentified" });
  rebuild();
  expect(await call("get_task", { taskId: "task_1", src: "conversation_member.jsonl", memberId: owner.id })).toMatchObject(REFUSED);
});

test("the latest recorded member fences a legacy conversation when author timestamps tie", async () => {
  snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
  store.recordMessageAuthor({ clientMessageId: "z-earlier-owner", conversationId: "conversation_member", memberId: owner.id, at: AT, textDigest: null });
  expect((await call("get_task", { taskId: "task_1", clientRequestId: "legacy-owner-read" })).ok).toBe(true);
  store.recordMessageAuthor({ clientMessageId: "a-later-member", conversationId: "conversation_member", memberId: member.id, at: AT, textDigest: null });
  resetTeamStoreForTests(); store = teamStore();
  expect(store.latestConversationMember("conversation_member")).toBe(member.id);
  expect(await call("get_task", { taskId: "task_1", clientRequestId: "legacy-owner-read" })).toMatchObject(REFUSED);
  expect((await call("get_task", { taskId: "task_0", clientRequestId: "legacy-member-read" })).ok).toBe(true);
});

test("a durable member binding stays fenced when its authority store disappears", async () => {
  resetTeamStoreForTests();
  fs.renameSync(teamStoreFile(), path.join(root, "saved-team.sqlite"));
  expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
  expect(await call("get_task", { taskId: "task_0" })).toMatchObject(REFUSED);
  expect(dispatched).toEqual([]);
});

test("membership removal, revocation and project moves refuse saved receipts after reopening the store", async () => {
  expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
  store.removeWorkspaceMember(W1, member.id);
  resetTeamStoreForTests(); store = teamStore();
  expect(await call("get_task", { taskId: "task_0" })).toMatchObject(REFUSED);
  store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
  placeProject(store, owner, own, W2);
  expect(await call("get_task", { taskId: "task_0" })).toMatchObject(REFUSED);
  placeProject(store, owner, own, W1);
  store.updateMember({ ...member, status: "revoked", revokedAt: AT });
  resetTeamStoreForTests(); store = teamStore();
  expect(await call("get_task", { taskId: "task_0" })).toMatchObject(REFUSED);
});

test("an awaited read cannot disclose its result after membership changes", async () => {
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  dependencies.completedFileScan = async () => { ready(); await held; return { snapshot: { files: [] } } as never; };
  rebuild();
  const result = call("board_snapshot"); await started;
  store.removeWorkspaceMember(W1, member.id); release();
  expect(await result).toMatchObject(REFUSED);
});

test("the real control retry rechecks membership before another HTTP request", async () => {
  const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    store.removeWorkspaceMember(W1, member.id);
    return Response.json({}, { status: 503 });
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${server.port}`;
  try {
    const production = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), dependencies), new MemoryMcpReceiptStore()), dependencies);
    expect(await production.callTool("list_conversations", {}, { deadlineAt: Date.now() + 10_000 })).toMatchObject(REFUSED);
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
    if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
  }
});

test("a held page and caller-supplied identities cannot recover another workspace's data", async () => {
  const records = dependencies.listTaskRecords!() as ReturnType<ViewerMcpDomainDependencies["loadTasks"]>;
  records.push({ ...records[0]!, id: "task_2" });
  const first = await call("list_tasks", { full: true, limit: 1 });
  if (!first.ok) throw new Error(first.error);
  expect(typeof first.nextCursor).toBe("string");
  store.removeWorkspaceMember(W1, member.id);
  expect(await call("list_tasks", { cursor: first.nextCursor, full: true, limit: 1 })).toMatchObject(REFUSED);
  store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
  expect(await call("get_task", { taskId: "task_1", memberId: owner.id, workspaceId: W2 })).toMatchObject(REFUSED);
  for (const id of ["toString", "constructor", "__proto__"]) expect(await call("get_conversation", { conversationId: id })).toMatchObject(REFUSED);
});

test("a durable member binding follows delegation and migration profiles", () => {
  const profile = emptyLaunchProfile({ workspace: { memberId: member.id, workspaceId: W1 }, parentConversationId: "conversation_member" });
  const restored = JSON.parse(JSON.stringify(profile));
  expect(migrationSuccessorLaunchProfile(profile).workspace).toEqual(profile.workspace);
  snapshot.conversations.conversation_child = { ...conversation("conversation_child", own, false), generations: [{ launchProfile: restored }] } as never;
  expect(conversationWorkspacePrincipal(snapshot, "conversation_child")).toEqual({ memberId: member.id, workspaceId: W1 });
  delete restored.workspace;
  expect(conversationWorkspacePrincipal(snapshot, "conversation_child")).toEqual({ memberId: member.id, workspaceId: W1 });
});

test("a real resume preserves its durable workspace instead of accepting a replacement scope", () => {
  const filename = path.join(root, "resume-registry.json"), sqliteFilename = path.join(root, "resume-registry.sqlite");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename });
  const workspace = { memberId: member.id, workspaceId: W1 };
  const entry = (n: number) => {
    const sessionId = ["0".repeat(8), "0".repeat(4), `4${"0".repeat(3)}`, `8${"0".repeat(3)}`, String(n).padStart(12, "0")].join("-");
    return { key: { engine: "codex" as const, sessionId }, artifactPath: path.join(root, `${sessionId}.jsonl`), cwd: root,
      accountId: "account-a", status: "live" as const, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null };
  };
  let id: string;
  try {
    const first = registry.beginSpawnRequest({ engine: "codex", cwd: root, accountId: "account-a", launchProfile: emptyLaunchProfile({ cwd: root, workspace, title: "Resume workspace work" }) });
    if (first.kind !== "created") throw new Error("expected a fresh launch");
    id = first.receipt.conversationId;
    expect(registry.settleSpawn(first.receipt.launchId, entry(1)).kind).toBe("settled");
    const resumed = registry.beginSpawnRequest({ engine: "codex", cwd: root, accountId: "account-a", conversationId: id as `conversation_${string}`, purpose: "resume-successor",
      launchProfile: emptyLaunchProfile({ cwd: root, workspace: { memberId: owner.id, workspaceId: W2 } }) });
    if (resumed.kind !== "created") throw new Error("expected a resume launch");
    expect(resumed.receipt.launchProfile.workspace).toEqual(workspace);
    expect(registry.settleSpawn(resumed.receipt.launchId, entry(2)).kind).toBe("settled");
  } finally { registry.close(); }
  const reader = `import { AgentRegistry } from ${JSON.stringify(path.resolve("src/lib/agent/registry.ts"))}; const r = new AgentRegistry(${JSON.stringify(filename)}, undefined, undefined, {sqliteMode:"sqlite",sqliteFilename:${JSON.stringify(sqliteFilename)}}); console.log(JSON.stringify(r.conversation(${JSON.stringify(id)}).generations.at(-1).launchProfile.workspace)); r.close();`;
  const child = spawnSync(process.execPath, ["-e", reader], { env: process.env, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual(workspace);
});

test("the production dispatcher enforces the fence for an authenticated capability", async () => {
  const filename = path.join(root, "registry.json"), sqliteFilename = path.join(root, "registry.sqlite");
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename }).close();
  const capability = "a".repeat(43);
  const db = new Database(sqliteFilename);
  const insert = db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES (?, ?, ?, ?)");
  insert.run("conversations", "conversation_member", JSON.stringify({ ...conversation("conversation_member", own), engine: "codex", createdAt: AT, updatedAt: AT, continuityPaths: [] }), 0);
  insert.run("receipts", "workspace-launch", JSON.stringify({ launchId: "workspace-launch", conversationId: "conversation_member", spawnCapabilityDigest: createHash("sha256").update(capability).digest("hex") }), 0);
  db.close();
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename });
  setAgentRegistryForTests(registry);
  installSpawnCapabilityResolver(digest => registry.conversationIdForSpawnCapabilityDigest(digest));
  try {
    const production = await createProductionViewerMcpService(false, false, true);
    const read = (project: string) => runAsMcpHttpCaller({ capability }, () => production.callTool("list_tasks", { project }));
    expect(await read(other)).toMatchObject(REFUSED);
    expect((await read(own)).ok).toBe(true);
    let served = 0;
    const route = workspaceRoute("/api/tasks", (_request: Request) => { served++; return Response.json({ ok: true }); }, true);
    const request = (project: string) => new NextRequest(`http://localhost/api/tasks?project=${encodeURIComponent(project)}`, {
      headers: { host: "localhost", "x-llv-spawn-capability": capability },
    });
    expect((await route(request(other))).status).toBe(403);
    expect((await route(request(own))).status).toBe(200);
    expect(served).toBe(1);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    placeProject(store, owner, projectForCwd(root)!, W1);
    const created = await createPipelineFromRequest({ task: "Bound creator", repoDir: root, stages: [], autoStart: false, src: "owner.jsonl" },
      { ...defaultPipelinePorts(), sourcePathAllowed: () => true, conversationIdForPath: () => "conversation_owner" },
      { briefer: { kind: "agent", conversationId: "conversation_member" } });
    if (!created.pipeline) throw new Error(JSON.stringify(created));
    expect(created.pipeline?.workspace).toEqual({ memberId: member.id, workspaceId: W1 });
  } finally { installSpawnCapabilityResolver(null); setAgentRegistryForTests(null); registry.close(); }
});

test("a member-created pipeline retains its scope, refuses revoked stage launches and rechecks a held draft edit", async () => {
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  const project = projectForCwd(root)!;
  placeProject(store, owner, project, W1);
  const created = await createPipelineFromRequest({ task: "Workspace draft", repoDir: root, stages: [], autoStart: false }, undefined,
    { allowOperatorDraftWithoutLineage: true, workspaceMemberId: member.id });
  expect(created.pipeline).toBeDefined();
  const pipeline = created.pipeline!;
  const workspace = { memberId: member.id, workspaceId: W1 };
  expect(findPipelineRecord(pipeline.id)?.workspace).toEqual(workspace);
  const reader = `import { findPipelineRecord } from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))}; console.log(JSON.stringify(findPipelineRecord(${JSON.stringify(pipeline.id)}).workspace));`;
  const restored = spawnSync(process.execPath, ["-e", reader], { env: process.env, encoding: "utf8" });
  expect(restored.status).toBe(0);
  expect(JSON.parse(restored.stdout.trim())).toEqual(workspace);
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const ports = { ...defaultPipelinePorts(), exec: async () => { ready(); await held; return { code: 2, stdout: "", stderr: "no origin" }; } };
  dependencies.readPipelineRecord = findPipelineRecord;
  dependencies.patchPipeline = (id, request, _ports, actor, assertAuthority) => patchPipeline(id, request, ports, actor, assertAuthority);
  rebuild();
  const edit = call("pipeline_action", { pipelineId: pipeline.id, action: "update-draft", repoDir: root, task: "Rejected edit" });
  await Promise.race([entered, edit.then(result => { throw new Error(`draft edit ended before the held seam: ${JSON.stringify(result)}`); })]);
  store.removeWorkspaceMember(W1, member.id); release();
  expect(await edit).toMatchObject(REFUSED);
  expect(findPipelineRecord(pipeline.id)?.task).toBe("Workspace draft");
  let reserved = false;
  await expect(defaultPipelinePorts().spawnAgent({ workspace, project, creatorConversationId: null } as never,
    () => { reserved = true; })).rejects.toThrow("workspace access denied");
  expect(reserved).toBe(false);
  const queued = { ...pipeline, id: "workspace-queued", creationRequest: { key: "workspace-queue", digest: "workspace-queue" } };
  queuePipelineCreation(queued, { repository: project, remote: "", branch: "refs/heads/workspace-queued" }, false, "fixture handover", AT);
  expect(await admitQueuedPipelineCreations()).toEqual([]);
  expect(findPipelineRecord(queued.id)).toBeNull();
  expect(queuedPipelineCreationStatus(queued.id)).toMatchObject({ state: "refused" });
});

test("an existing conversation designated for a member keeps its seat scope across a fresh process", () => {
  const workspace = { memberId: member.id, workspaceId: W1 };
  snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
  beginOrchestratorSeatIntent({ project: own, mandate: "Run this workspace", clientRequestId: "workspace-seat", mode: "existing", conversationId: "conversation_member", workspace, now: AT });
  completeOrchestratorSeatIntent({ project: own, clientRequestId: "workspace-seat", conversationId: "conversation_member", path: "conversation_member.jsonl", now: AT });
  expect(conversationWorkspacePrincipal(snapshot, "conversation_member")).toEqual(workspace);
  const script = `import { orchestratorSeatFor } from ${JSON.stringify(path.resolve("src/lib/orchestrator/seats.ts"))}; console.log(JSON.stringify(orchestratorSeatFor(${JSON.stringify(own)}).active?.workspace));`;
  const child = spawnSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual(workspace);
  store.removeWorkspaceMember(W1, member.id);
  expect(() => beginOrchestratorSeatIntent({ project: own, mandate: "Refused", clientRequestId: "workspace-seat-refused", mode: "existing", conversationId: "conversation_member", workspace, now: AT })).toThrow("workspace access denied");
});
