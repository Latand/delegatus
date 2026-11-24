import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { emptyLaunchProfile, migrationSuccessorLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { RegistryFile } from "@/lib/agent/registry";
import { resetTeamStoreForTests, teamStore, teamStoreFile, TeamStore } from "@/lib/team/store";
import { createWorkspace, placeProject } from "@/lib/team/workspaces";
import { setWorkspaceDefaults } from "@/lib/team/workspaceDefaults";
import type { Member } from "@/lib/team/contract";
import { projectForCwd } from "@/lib/scanner/describe";
import { shortId } from "@/lib/shortIds";
import { buildPipeline } from "@/lib/pipelines/store";
import { conversationWorkspacePrincipal } from "@/lib/team/workspacePrincipal";
import { createPipelineFromRequest, defaultPipelinePorts, patchPipeline } from "@/lib/pipelines/engine";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, readOrchestratorSeatFile } from "@/lib/orchestrator/seats";
import { writeStoredSeatRecord } from "@/lib/orchestrator/seatStoreFixture";
import { queuePipelineCreation, admitQueuedPipelineCreations, queuedPipelineCreationStatus } from "@/lib/pipelines/creationQueue";
import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { POST as taskSendPOST } from "@/app/api/tasks/[id]/send/route";
import { POST as ghostPOST } from "@/app/api/orchestrator/ghost/route";
import * as deputyPorts from "@/lib/orchestrator/deputyCommandPorts";
import { askOrchestratorInParallel, type DeputyCommandPorts } from "@/lib/orchestrator/deputyCommand";
import { readDeputies, endDeputy, deputyMessageKey } from "@/lib/orchestrator/deputies";
import { NextRequest } from "next/server";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { installSpawnCapabilityResolver } from "@/lib/agent/callerClaims";
import { runAsMcpHttpCaller } from "./callerContext";
import { viewerMcpBindings, productionDomainDependencies, productionViewerControlDependencies, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, createProductionViewerMcpService, FileMcpReceiptStore, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolArgs, type McpToolService } from "./server";
import { withWorkspaceMcpFence } from "./workspaceFence";
import { nativeCallerRefusal } from "@/lib/attention/nativeCaller";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { conversationHostPOST } from "@/app/api/conversation-host/handlers";
import { setConversationHostDependenciesForTests } from "@/app/api/conversation-host/dependencies";

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
const formQuestions = [{ id: "choice", text: "Choose a path", options: [{ label: "First", recommended: true }, { label: "Second" }] }];

function fixtureAuthority(registry: AgentRegistry) {
  return spyOn(registry, "conversationAuthorityFacts").mockImplementation(id => {
    const row = snapshot.conversations[id];
    return row ? { id: row.id, superseded: Boolean(row.supersededBy), hasGeneration: row.generations.length > 0,
      project: row.projectOwnership?.project ?? null, directories: [] } : null;
  });
}

function designateCaller(workspace?: { memberId: string; workspaceId: string }) {
  beginOrchestratorSeatIntent({ project: own, mandate: "Run project work", clientRequestId: "regression-seat", mode: "existing",
    conversationId: "conversation_member", workspace, now: AT });
  completeOrchestratorSeatIntent({ project: own, clientRequestId: "regression-seat", conversationId: "conversation_member", path: "conversation_member.jsonl", now: AT });
  dependencies.authorizedSeats = () => [{ project: own, conversationId: "conversation_member", path: "conversation_member.jsonl" }];
}

test("#4112: member input never changes an installation seat's tool permissions", async () => {
  snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
  designateCaller();
  const calls: string[] = [];
  const fenced = withWorkspaceMcpFence({ callTool: async tool => {
    const toolName = MCP_TOOL_NAMES.find(name => name === tool);
    if (!toolName) throw new Error("unexpected fixture tool");
    calls.push(tool); return { ok: true, toolName, clientRequestId: null, replayed: false };
  } }, dependencies);
  for (const author of [null, member, owner, member]) {
    if (author) store.admitConversationMember("conversation_member", author.id);
    for (const tool of ["spawn_agent", "send_message_to_orchestrator", "relay_owner_history"]) {
      expect(await fenced.callTool(tool, { cwd: path.join(root, "other"), project: other })).toMatchObject({ ok: true });
    }
  }
  expect(calls).toHaveLength(12);
  // The same input on a conversation with no seat keeps the member fence.
  snapshot.conversations.conversation_worker = conversation("conversation_worker", own, false) as never;
  store.admitConversationMember("conversation_worker", member.id);
  dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: "conversation_worker", role: "builder" });
  expect(await fenced.callTool("relay_owner_history", {})).toMatchObject(REFUSED);
  expect(await fenced.callTool("spawn_agent", { cwd: path.join(root, "other") })).toMatchObject(REFUSED);
  expect(calls).toHaveLength(12);
});

for (const depth of [1, 2, 4]) test(`existing non-seat descendants retain project, account and installation fences at depth ${depth}`, async () => {
  snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
  designateCaller();
  store.admitConversationMember("conversation_member", member.id);
  await setWorkspaceDefaults(store, owner, W1, { accounts: { codex: ["account-a"] } });
  let parent = "conversation_member";
  for (let index = 1; index <= depth; index++) {
    const id = `conversation_descendant_${index}`;
    const child = conversation(id, own, false);
    child.generations[0]!.launchProfile.parentConversationId = parent as `conversation_${string}`;
    snapshot.conversations[id] = child as never;
    parent = id;
  }
  dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: parent, role: "builder" });
  expect(await call("get_task", { taskId: "task_0" })).toMatchObject({ ok: true });
  expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
  expect(await call("account_limits")).toMatchObject({ ...REFUSED, details: { check: "tool" } });
  expect(await call("spawn_agent", { cwd: root, engine: "codex", accountId: "account-b" })).toMatchObject(REFUSED);
  expect(await call("conversation_migration", { conversationId: parent, action: "select-account", accountId: "account-a" })).toMatchObject({ ok: true });
  store.removeWorkspaceMember(W1, member.id);
  expect(await call("get_task", { taskId: "task_0", clientRequestId: "after-revocation" })).toMatchObject({ ...REFUSED, details: { check: "caller-project" } });
});

test.each(["seat", "task"])("#3818: a refused transcript read leaves %s forms and their receipts usable", async target => {
  const taskId = target === "task" ? "task_0" : undefined;
  designateCaller({ memberId: member.id, workspaceId: W1 });
  let scopeCalls = 0, publications = 0;
  const control = {
    get: async () => ({}),
    post: async (url: string) => {
      if (url.endsWith("/scope")) { scopeCalls++; return { conversationId: "conversation_member", project: own, taskId: taskId ?? null }; }
      if (url.endsWith("/read")) return { rounds: [] };
      publications++; return { reviewId: "review-one", project: own };
    },
  };
  const receiptFile = path.join(root, "form-receipts.json");
  const reopen = () => withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(receiptFile)), dependencies);
  service = reopen();
  await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
    const args = { clientRequestId: "published-form", ...(taskId ? { taskId } : {}), title: "Choose", questions: formQuestions };
    const readArgs = taskId ? { taskId } : {};
    expect(await call("publish_prototype_review", args)).toMatchObject({ ok: true, replayed: false });
    expect(await call("conversation_messages", { transcriptPath: "conversation_foreign.jsonl" })).toMatchObject(REFUSED);
    expect(await call("read_prototype_review", readArgs)).toMatchObject({ ok: true });
    expect(await call("publish_prototype_review", { ...args, clientRequestId: "second-form" })).toMatchObject({ ok: true });
    const beforeReplay = scopeCalls;
    store.removeWorkspaceMember(W1, member.id);
    service = reopen();
    expect(await call("publish_prototype_review", args)).toMatchObject({ ok: true, replayed: true });
    expect(await call("read_prototype_review", readArgs)).toMatchObject({ ok: true, replayed: true });
    expect(await call("read_prototype_review", { ...readArgs, clientRequestId: "fresh-read" })).toMatchObject(REFUSED);
    expect(scopeCalls).toBe(beforeReplay);
    const script = `
      import { createMcpToolService, FileMcpReceiptStore } from ${JSON.stringify(path.resolve("src/lib/mcp/server.ts"))};
      import { viewerMcpBindings, productionDomainDependencies } from ${JSON.stringify(path.resolve("src/lib/mcp/bindings.ts"))};
      import { withWorkspaceMcpFence } from ${JSON.stringify(path.resolve("src/lib/mcp/workspaceFence.ts"))};
      const dependencies = { ...productionDomainDependencies,
        attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_member", role: "orchestrator" }),
        authorizedSeats: () => [{ conversationId: "conversation_member", project: ${JSON.stringify(own)}, path: null }],
        workspaceConversation: () => { throw new Error("replay reached workspace admission"); } };
      const control = { get: async () => { throw new Error("replay dispatched"); }, post: async () => { throw new Error("replay dispatched"); } };
      const service = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(${JSON.stringify(receiptFile)})), dependencies);
      console.log(JSON.stringify(await service.callTool("publish_prototype_review", ${JSON.stringify(args)})));
    `;
    const restarted = spawnSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8" });
    expect(restarted.status).toBe(0);
    expect(JSON.parse(restarted.stdout.trim())).toMatchObject({ ok: true, replayed: true, reviewId: "review-one" });
    expect(await call("publish_prototype_review", { ...args, title: "Changed" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(await call("publish_prototype_review", { ...args, clientRequestId: "new-after-revocation" })).toMatchObject(REFUSED);
    expect(publications).toBe(2);
    const durable = fs.readFileSync(receiptFile, "utf8");
    dependencies.authorizedSeats = () => [];
    expect(await call("publish_prototype_review", args)).toMatchObject(REFUSED);
    expect(fs.readFileSync(receiptFile, "utf8")).toBe(durable);
    expect(scopeCalls).toBe(beforeReplay);
  });
});

test.each((["read", "publish"] as const).flatMap(mode => ["caller", "designation", "task", "project", "missing-project", "ambiguous-project", "read-error"].map(change => [mode, change] as const)))("form replay rechecks identity after the receipt await: %s %s", async (mode, change) => {
  designateCaller({ memberId: member.id, workspaceId: W1 });
  const receiptFile = path.join(root, "race-receipts.json");
  const receipts = new FileMcpReceiptStore(receiptFile);
  let publications = 0;
  const bindings = viewerMcpBindings(undefined, { get: async () => ({}), post: async url => {
    if (url.endsWith("/scope")) return { conversationId: "conversation_member", project: own, taskId: null };
    publications++; return { reviewId: "original-form" };
  } }, dependencies);
  service = withWorkspaceMcpFence(createMcpToolService(bindings, receipts), dependencies);
  await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
    const tool = mode === "read" ? "read_prototype_review" : "publish_prototype_review";
    const args = { clientRequestId: "owned-form", ...(mode === "publish" ? { title: "Choose", questions: formQuestions } : {}) };
    expect(await call(tool, args)).toMatchObject({ ok: true });
    const durable = fs.readFileSync(receiptFile, "utf8");
    const lookup = receipts.lookup.bind(receipts);
    const read = spyOn(receipts, "lookup").mockImplementation(async key => {
      const record = await lookup(key);
      if (change === "read-error") throw new Error("receipt read failed");
      if (change === "caller") dependencies.attentionAuthority = () => ({ kind: "unidentified", admission: { reason: "capability-unresolved" } } as never);
      else if (change === "task") {
        const pipeline = dependencies.getPipelines().pipelines[0]!;
        pipeline.taskIds = ["task_0"];
        pipeline.runs.push({ stageId: "review", attempts: [{ n: 1, conversationId: "conversation_member" }] } as never);
      } else if (change === "project") dependencies.authorizedSeats = () => [{ conversationId: "conversation_member", project: other, path: null }];
      else if (change === "missing-project") dependencies.authorizedSeats = () => [{ conversationId: "conversation_member", project: null, path: null }];
      else if (change === "ambiguous-project") dependencies.authorizedSeats = () => [own, other].map(project => ({ conversationId: "conversation_member", project, path: null }));
      else dependencies.authorizedSeats = () => [];
      store.removeWorkspaceMember(W1, member.id);
      return record;
    });
    try {
      const answer = await call(tool, args);
      expect(answer).toMatchObject(change === "read-error" ? { ok: false, code: "receipt_unavailable", retryable: true, details: { check: "receipt-store" } } : REFUSED);
      expect(answer).not.toHaveProperty("reviewId");
      expect(publications).toBe(1);
      expect(fs.readFileSync(receiptFile, "utf8")).toBe(durable);
    } finally { read.mockRestore(); }
  });
});

test("workspace refusals identify the check without disclosing target identities", async () => {
  const answer = await call("conversation_messages", { transcriptPath: "conversation_foreign.jsonl" });
  expect(answer).toMatchObject({ ...REFUSED, details: { check: "argument:transcriptPath" } });
  expect(JSON.stringify(answer)).not.toContain(other);
  expect(await call("relay_owner_history")).toMatchObject({ ...REFUSED, details: { check: "tool" } });
});

test("HTTP workspace refusal codes and check names survive form receipt-scope resolution", async () => {
  const previousControl = process.env.LLV_VIEWER_CONTROL_URL;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({
    error: "workspace access denied (route-target)", code: "workspace_forbidden", check: "route-target",
  }, { status: 403 }) });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${server.port}`;
  try {
    const controls = productionViewerControlDependencies();
    service = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, controls, dependencies), new MemoryMcpReceiptStore()), dependencies);
    await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
      expect(await call("publish_prototype_review", { title: "Choose", questions: formQuestions }))
        .toMatchObject({ ...REFUSED, details: { check: "route-target" } });
    });
  } finally {
    await server.stop(true);
    if (previousControl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previousControl;
  }
});

test("#3818: HTTP form routes resolve taskless targets from the authenticated seat", async () => {
  designateCaller({ memberId: member.id, workspaceId: W1 });
  const registry = new AgentRegistry(path.join(root, "forms-registry.json"));
  snapshot.conversations.conversation_worker = conversation("conversation_worker", own) as never;
  const lookup = spyOn(registry, "conversation").mockImplementation(id => snapshot.conversations[id] ?? null);
  const facts = fixtureAuthority(registry);
  setAgentRegistryForTests(registry);
  installSpawnCapabilityResolver(() => "conversation_member");
  setCallerConversationResolverForTests(() => "conversation_member");
  let effects = 0;
  try {
    for (const route of ["/api/prototype-reviews", "/api/prototype-reviews/scope", "/api/prototype-reviews/read"]) {
      const handler = workspaceRoute(route, (_request: Request) => { effects++; return Response.json({ ok: true }); });
      const request = () => new NextRequest(`http://localhost${route}`, { method: "POST",
        headers: { host: "localhost", "content-type": "application/json", "x-llv-spawn-capability": "a".repeat(43) },
        body: JSON.stringify({ mode: "publish", clientRequestId: "form" }) });
      expect((await handler(request())).status).toBe(200);
      store.removeWorkspaceMember(W1, member.id);
      const refused = await handler(request());
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "workspace_forbidden", check: "route-target" });
      store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
      setCallerConversationResolverForTests(() => "conversation_worker");
      expect((await handler(request())).status).toBe(403);
      setCallerConversationResolverForTests(() => "conversation_member");
    }
    expect(effects).toBe(3);
  } finally {
    lookup.mockRestore(); facts.mockRestore(); installSpawnCapabilityResolver(null); setCallerConversationResolverForTests(null);
    setAgentRegistryForTests(null); registry.close();
  }
});

test("browser access cannot write a membership after its project moves during the login read", async () => {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const browserHome = path.join(root, "home");
  const filename = path.join(browserHome, ".local/share/delegatus-agent-login/state.json");
  const browser = person("m_browser", "member");
  const login = mintSession(store, browser.id, "claim", { surface: "desktop", browser: "chrome" });
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ cookies: [{ name: MEMBER_COOKIE, value: login.value, domain: "127.0.0.1", path: "/" }] }), { mode: 0o600 });
  dependencies.authorizedSeats = () => [{ conversationId: "conversation_member", project: own, path: null }];
  const bindings = viewerMcpBindings(undefined, undefined, dependencies);
  const grant = bindings.grant_agent_browser_access!;
  let dispatching = false, moved = false;
  bindings.grant_agent_browser_access = Object.assign((...args: Parameters<typeof grant>) => {
    dispatching = true;
    return grant(...args);
  }, grant);
  service = withWorkspaceMcpFence(createMcpToolService(bindings, new MemoryMcpReceiptStore()), dependencies);
  const open = fs.promises.open.bind(fs.promises);
  const reading = spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (dispatching && args[0] === filename && !moved) {
      moved = true;
      placeProject(store, owner, own, W2);
    }
    return handle;
  });
  process.env.HOME = browserHome;
  if (process.platform === "win32") process.env.USERPROFILE = browserHome;
  try {
    expect(await call("grant_agent_browser_access")).toMatchObject(REFUSED);
    expect(moved).toBe(true);
    expect(store.workspaceMemberships(browser.id)).toEqual([]);
    expect(store.events({ limit: 200 }).filter(event => event.detail?.source === "agent-browser-access")).toEqual([]);
  } finally {
    reading.mockRestore();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (process.platform === "win32") {
      if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    }
  }
});

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

test("full result identities refuse colliding foreign and Unassigned projects before compaction", async () => {
  const local = `dir-${"a".repeat(32)}`, foreign = `dir-${"a".repeat(8)}${"b".repeat(24)}`;
  placeProject(store, owner, local, W1);
  for (const workspace of [null, W2]) {
    placeProject(store, owner, foreign, workspace);
    for (const resolved of [own, foreign]) for (const full of [false, true]) {
      const items = resolved === own ? [{ project: local, snippet: "Our message" }, { project: foreign, snippet: "Foreign secret" }] : [];
      searchReply = { items,
        total: 2, strongTotal: 2, nextCursor: null, projectScope: { resolved },
        stats: { conversationsIndexed: 2, messagesIndexed: 2, fieldsSearched: [], tokenizer: "unicode" } };
      const answer = await call("search_transcripts", { query: "message", full, clientRequestId: `collision-${workspace}-${resolved}-${full}` });
      expect(answer).toMatchObject(REFUSED);
      expect(JSON.stringify(answer)).not.toContain("Foreign secret");
    }
  }
  placeProject(store, owner, foreign, null);
  searchReply = { items: [{ project: local, snippet: "Our message" }], total: 1, strongTotal: 1, nextCursor: null, projectScope: { resolved: own },
    stats: { conversationsIndexed: 1, messagesIndexed: 1, fieldsSearched: [], tokenizer: "unicode" } };
  expect(await call("search_transcripts", { query: "message", clientRequestId: "permitted-compact" }))
    .toMatchObject({ ok: true, items: [{ project: shortId(local), snippet: "Our message" }] });
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
    else {
      beginOrchestratorSeatIntent({ project: own, mandate: "Run installation work", clientRequestId: "installation-seat", mode: "existing", conversationId: id, now: AT });
      completeOrchestratorSeatIntent({ project: own, clientRequestId: "installation-seat", conversationId: id, path: `${id}.jsonl`, now: AT });
      dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: id, role: "orchestrator" });
    }
    rebuild();
    expect((await call("get_task", { taskId: "task_1" })).ok).toBe(true);
    const listed = await call("list_tasks", { full: true });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.tasks).toHaveLength(2);
  }
});

test("named launch and migration accounts cannot escape the workspace pool", async () => {
  await setWorkspaceDefaults(store, owner, W1, { accounts: { codex: ["account-a"] } });
  for (const key of ["accountId", "targetAccountId"]) {
    expect(await call("conversation_migration", { conversationId: "conversation_member", action: "select-account", [key]: "account-b" })).toMatchObject(REFUSED);
    for (const engine of ["claude", "copilot", "unknown"]) {
      expect(await call("conversation_migration", { conversationId: "conversation_member", action: "select-account", engine, [key]: "account-b" })).toMatchObject(REFUSED);
    }
  }
  expect(await call("spawn_agent", { cwd: root, engine: "codex", accountId: "account-b" })).toMatchObject(REFUSED);
  expect(dispatched).toEqual([]);
  expect((await call("conversation_migration", { conversationId: "conversation_member", action: "select-account", accountId: "account-a", clientRequestId: "allowed-migration" })).ok).toBe(true);
  expect(dispatched).toEqual(["/api/conversations/conversation_member/migration"]);
});

test("where the project has no account list, a member's agent cannot name an account in any tool", async () => {
  for (const account of ["account-a", "account-zzz"]) {
    for (const key of ["account", "accountId", "targetAccountId"]) {
      expect(await call("spawn_agent", { cwd: root, engine: "codex", [key]: account })).toMatchObject(REFUSED);
    }
    expect(await call("conversation_action", { conversationId: "conversation_member", action: "select-account", accountId: account })).toMatchObject(REFUSED);
    expect(await call("conversation_migration", { conversationId: "conversation_member", action: "select-account", accountId: account })).toMatchObject(REFUSED);
    expect(await call("agent_fleet", { project: own, engine: "codex", account })).toMatchObject(REFUSED);
  }
  expect(dispatched).toEqual([]);
  /* Naming no account stays allowed: Delegatus picks. */
  expect(await call("spawn_agent", { cwd: root, engine: "codex", title: "Inspect routing", ["prompt"]: "Inspect routing" })).not.toMatchObject(REFUSED);
  expect(dispatched).toEqual(["/api/spawn"]);
});

describe("a member's reconfigure of a running conversation through the browser route", () => {
  let registry: AgentRegistry;
  let controlled: string[];
  let id: string;
  const reconfigure = (accountId: unknown, actor: { kind: "member"; memberId: string }) => conversationHostPOST(new NextRequest("http://localhost/api/conversation-host", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: id, action: "reconfigure", model: "gpt-6.1-sol", effort: "high", ...(accountId === undefined ? {} : { accountId }) }),
  }), { actor });
  beforeEach(() => {
    registry = new AgentRegistry(path.join(root, "member-reconfigure.json"), undefined, undefined, { sqliteMode: "off" });
    registry.reconcileConversations([{ engine: "codex", path: path.join(root, "running.jsonl"), accountId: "account-a",
      launchProfile: emptyLaunchProfile({ cwd: root, project: own, title: "Running", role: "worker", model: "gpt-6.1-sol", effort: "high", fast: false }),
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: AT }]);
    id = registry.conversationForPath(path.join(root, "running.jsonl"))!.id;
    setAgentRegistryForTests(registry);
    controlled = [];
    setConversationHostDependenciesForTests({ dispatchStructuredControl: async input => {
      controlled.push(input.reconfiguration?.accountId ?? "");
      return { status: 200, body: { ok: true } } as never;
    } });
  });
  afterEach(() => { setConversationHostDependenciesForTests(null); setAgentRegistryForTests(null); registry.close(); });

  test("is refused outside the pool and where there is no pool, the same for an account that exists or not, and reaches no host", async () => {
    for (const pool of [null, ["account-a"]] as const) {
      if (pool) await setWorkspaceDefaults(store, owner, W1, { accounts: { codex: [...pool] } });
      const answers = [];
      for (const account of ["account-b", "account-zzz"]) {
        const response = await reconfigure(account, { kind: "member", memberId: member.id });
        answers.push({ status: response.status, body: await response.json() as unknown as { error: string; reason: string; code: string } });
      }
      const reason = pool ? "outside_account_list" : "no_account_list";
      expect(answers[0]).toMatchObject({ status: 409, body: { code: "project_account_refused", reason } });
      expect([answers[1]!.status, answers[1]!.body.reason]).toEqual([409, reason]);
      expect(answers[1]!.body.error.replaceAll("account-zzz", "account-b")).toBe(answers[0]!.body.error);
    }
    expect(controlled).toEqual([]);
  });

  test("keeps the account it already runs on, an account of the pool, a change without an account, and the owner", async () => {
    await setWorkspaceDefaults(store, owner, W1, { accounts: { codex: ["account-c"] } });
    expect((await reconfigure("account-a", { kind: "member", memberId: member.id })).status).toBe(200);
    expect((await reconfigure("account-c", { kind: "member", memberId: member.id })).status).toBe(200);
    expect((await reconfigure(undefined, { kind: "member", memberId: member.id })).status).toBe(200);
    expect((await reconfigure("account-b", { kind: "member", memberId: owner.id })).status).toBe(200);
    expect(controlled).toEqual(["account-a", "account-c", "", "account-b"]);
  });
});

test("an external caller without a capability keeps project reads while broken capabilities refuse", async () => {
  dependencies.attentionAuthority = () => ({ kind: "unidentified" });
  rebuild();
  expect((await call("list_tasks", { project: own })).ok).toBe(true);
  for (const reason of ["capability-unresolved", "capability-conflict"] as const) {
    dependencies.attentionAuthority = () => ({ kind: "unidentified", admission: nativeCallerRefusal(reason) });
    rebuild();
    expect(await call("list_tasks", { project: own })).toMatchObject(REFUSED);
    expect(await call("get_task", { taskId: "task_1", src: "conversation_member.jsonl", memberId: owner.id })).toMatchObject(REFUSED);
  }
});

for (const delivery of ["empty", "reused", "answer", "permission"] as const) {
  test(`a member's ${delivery} input fences an owner conversation before dispatch and after restart`, async () => {
    snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
    store.recordMessageAuthor({ clientMessageId: "reused-id", conversationId: "conversation_elsewhere", memberId: owner.id, at: AT, textDigest: null });
    let effects = 0;
    const assertFenced = async () => {
      effects++;
      expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
    };
    setConversationHostDependenciesForTests({
      completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
      recordOperatorRequest: () => null,
      collectImagePayloads: () => ({ images: [], error: null }),
      conversationActions: ["answer", "permission"],
      applyConversationAction: async () => { await assertFenced(); return { status: 200, body: { ok: true } } as never; },
      enqueueStructuredMessage: async () => { await assertFenced(); return { ok: true, structured: true, outcome: "queued", target: null, operationId: "member-delivery" } as never; },
      deliverConversationMessage: async () => { await assertFenced(); return { ok: true, outcome: "held", target: null }; },
    });
    try {
      expect((await call("get_task", { taskId: "task_1" })).ok).toBe(true);
      const body = { conversationId: "conversation_member", text: "workspace request",
        ...(delivery === "reused" ? { clientMessageId: "reused-id" } : {}),
        ...(["answer", "permission"].includes(delivery) ? { action: delivery, answer: {} } : {}) };
      const response = await conversationHostPOST(new NextRequest("http://localhost/api/conversation-host", {
        method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
      }), { actor: { kind: "member", memberId: member.id } });
      expect(response.status).toBe(200);
      expect(effects).toBe(1);
      store.pruneEvents(Date.parse("2028-10-20T09:00:00.000Z"));
      resetTeamStoreForTests(); store = teamStore();
      rebuild();
      expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
      expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
      const reader = `import { conversationWorkspacePrincipal } from ${JSON.stringify(path.resolve("src/lib/team/workspacePrincipal.ts"))}; console.log(JSON.stringify(conversationWorkspacePrincipal(${JSON.stringify(snapshot)}, "conversation_member")));`;
      const child = spawnSync(process.execPath, ["-e", reader], { env: process.env, encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toEqual({ memberId: member.id, workspaceId: W1 });
    } finally { setConversationHostDependenciesForTests(null); }
  });
}


for (const action of ["message", "answer", "permission"]) test(`a failed authority write refuses a member delivery before the host is called: ${action}`, async () => {
  let effects = 0;
  setConversationHostDependenciesForTests({
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
    recordOperatorRequest: () => null,
    conversationActions: ["answer", "permission"],
    applyConversationAction: async () => { effects++; return { status: 200, body: { ok: true } } as never; },
    collectImagePayloads: () => ({ images: [], error: null }),
    enqueueStructuredMessage: async () => { effects++; return null; },
    deliverConversationMessage: async () => { effects++; return { ok: true, outcome: "held", target: null }; },
  });
  const write = spyOn(TeamStore.prototype, "admitConversationMember").mockImplementation(() => { throw new Error("fixture write refused"); });
  try {
    const response = await conversationHostPOST(new NextRequest("http://localhost/api/conversation-host", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conversation_member", text: "workspace request", ...(action === "message" ? {} : { action }) }),
    }), { actor: { kind: "member", memberId: member.id } });
    expect(response.status).toBe(503);
    expect(effects).toBe(0);
  } finally { write.mockRestore(); setConversationHostDependenciesForTests(null); }
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

test("an unreadable seat file refuses an unbound caller without revealing foreign tasks", async () => {
  writeStoredSeatRecord("{");
  expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
  snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
  const result = await call("get_task", { taskId: "task_1" });
  expect(result).toMatchObject({ ok: false, code: "workspace_unavailable", retryable: true });
  expect(JSON.stringify(result)).not.toContain("Foreign secret");
});

test("expired author history retains legacy workspace authority across a fresh process", async () => {
  snapshot.conversations.conversation_member = conversation("conversation_member", own, false) as never;
  store.recordMessageAuthor({ clientMessageId: "legacy-older-owner", conversationId: "conversation_member", memberId: owner.id, at: AT, textDigest: null });
  store.recordMessageAuthor({ clientMessageId: "legacy-latest-member", conversationId: "conversation_member", memberId: member.id, at: AT, textDigest: null });
  store.recordMessageAuthor({ clientMessageId: "unbound-history", conversationId: null, memberId: member.id, at: AT, textDigest: null });
  store.pruneEvents(Date.parse("2028-10-20T09:00:00.000Z"));
  expect([...store.messageAuthors(["legacy-older-owner", "legacy-latest-member", "unbound-history"]).keys()]).toEqual(["legacy-latest-member"]);
  const reader = `import { conversationWorkspacePrincipal } from ${JSON.stringify(path.resolve("src/lib/team/workspacePrincipal.ts"))}; console.log(JSON.stringify(conversationWorkspacePrincipal(${JSON.stringify(snapshot)}, "conversation_member")));`;
  const child = spawnSync(process.execPath, ["-e", reader], { env: process.env, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual({ memberId: member.id, workspaceId: W1 });
  resetTeamStoreForTests(); store = teamStore();
  expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
  expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
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

test("revocation after raw result checks is rechecked before returning a compact answer", async () => {
  let checks = 0;
  const answer = await service.callTool("get_task", { taskId: "task_0" }, { assertResult() {
    checks++;
    queueMicrotask(() => store.removeWorkspaceMember(W1, member.id));
  } });
  expect(checks).toBe(1);
  expect(answer).toMatchObject(REFUSED);
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


for (const failure of [false, true, "revoke-after-first"] as const) test(`member task fan-out binds every target before delivery; authority failure=${failure}`, async () => {
  const registry = new AgentRegistry(path.join(root, "task-send-registry.json"));
  setAgentRegistryForTests(registry);
  const recipients = [1, 2].map(n => registry.ensureForkedConversation("codex", path.join(root, `recipient-${n}.jsonl`), null,
    emptyLaunchProfile({ cwd: root, project: own })));
  const task = { ...dependencies.loadTasks()[0]!, assignments: [] };
  const cookie = mintSession(store, member.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  let effects = 0;
  const admit = store.admitConversationMember.bind(store);
  const write = failure === true ? spyOn(TeamStore.prototype, "admitConversationMember").mockImplementation((id: string, memberId: string) => {
    if (id === recipients[1]!.id) throw new Error("authority write refused");
    // The first target can already be bound, but no target may dispatch yet.
    admit(id, memberId);
  }) : null;
  try {
    const response = await taskSendPOST.withDependencies(new NextRequest(`http://localhost/api/tasks/${task.id}/send`, {
      method: "POST", headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${cookie}` },
      body: JSON.stringify({ paths: recipients.map(row => row.generations.at(-1)!.path) }),
    }), { params: Promise.resolve({ id: task.id }) }, {
      loadTasks: () => [task],
      listFiles: async () => recipients.map(row => ({ path: row.generations.at(-1)!.path, project: own, engine: "codex", pid: null })) as never,
      deliverConversationMessage: async () => {
        effects++;
        for (const row of recipients) expect(store.latestConversationMember(row.id)).toBe(member.id);
        if (failure === "revoke-after-first") store.updateMember({ ...member, status: "revoked", revokedAt: AT });
        return { ok: true, outcome: "delivered-to-live", target: null };
      },
      mutateTasks: mutator => mutator([structuredClone(task)]).result,
    });
    expect(response.status).toBe(failure ? 503 : 200);
    expect(effects).toBe(failure === true ? 0 : failure === "revoke-after-first" ? 1 : 2);
    if (!failure) {
      dependencies.workspaceConversation = id => registry.conversation(id as `conversation_${string}`);
      for (const row of recipients) {
        dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: row.id, role: "builder" });
        rebuild();
        expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
        expect((await call("get_task", { taskId: "task_0" })).ok).toBe(true);
      }
    }
  } finally { write?.mockRestore(); setAgentRegistryForTests(null); registry.close(); }
});

for (const mode of ["member", "owner", "write-refused", "revoked-during-join", "revoked-before-register"] as const) test(`parallel ask keeps its authenticated human authority: ${mode}`, async () => {
  const registry = new AgentRegistry(path.join(root, "deputy-registry.json"));
  setAgentRegistryForTests(registry);
  const seatSessionId = ["0".repeat(8), "0".repeat(4), "4000", "8000", String(1).padStart(12, "0")].join("-");
  const seatPath = path.join(root, `${seatSessionId}.jsonl`);
  const seat = registry.ensureForkedConversation("claude", seatPath, null, emptyLaunchProfile({ cwd: root, project: own }));
  beginOrchestratorSeatIntent({ project: own, mandate: "Run work", mode: "existing", conversationId: seat.id, clientRequestId: "deputy-seat", now: AT });
  completeOrchestratorSeatIntent({ project: own, conversationId: seat.id, path: seatPath, clientRequestId: "deputy-seat", now: AT });
  const actor = mode === "owner" ? owner : member;
  const cookie = mintSession(store, actor.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  const realPorts = deputyPorts.productionDeputyCommandPorts({ registry });
  let effects = 0, deliveredId = "";
  const ports: DeputyCommandPorts = { ...realPorts, now: () => new Date(AT), seatBusy: async () => true,
    fork: input => ({ path: input.destination, records: 1 }),
    registerConversation: input => {
      if (mode === "revoked-before-register") store.removeWorkspaceMember(W1, member.id);
      return realPorts.registerConversation(input);
    },
    joinSeatTask: () => { if (mode === "revoked-during-join") store.removeWorkspaceMember(W1, member.id); },
    workContext: () => ({ openLanes: [], recentTasks: [] }), watch: () => {},
    deliver: async input => {
      effects++; deliveredId = input.conversationId;
      expect(store.latestConversationMember(input.conversationId)).toBe(actor.id);
      expect(conversationWorkspacePrincipal(id => registry.conversation(id as `conversation_${string}`), input.conversationId))
        .toEqual(mode === "owner" ? null : { memberId: member.id, workspaceId: W1 });
      return { ok: true };
    },
  };
  const factory = spyOn(deputyPorts, "productionDeputyCommandPorts").mockReturnValue(ports);
  const write = mode === "write-refused" ? spyOn(TeamStore.prototype, "admitConversationMember").mockImplementation(() => { throw new Error("authority write refused"); }) : null;
  try {
    const response = await ghostPOST(new NextRequest("http://localhost/api/orchestrator/ghost", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${cookie}` },
      body: JSON.stringify({ project: own, seatConversationId: seat.id, text: "Review workspace work", clientRequestId: "member-parallel" }),
    }));
    expect(response.status).toBe(mode === "write-refused" ? 503 : mode === "revoked-during-join" || mode === "revoked-before-register" ? 403 : 200);
    expect(effects).toBe(mode === "write-refused" || mode === "revoked-during-join" || mode === "revoked-before-register" ? 0 : 1);
    const saved = readDeputies()[0]!;
    expect(saved.ask.memberId).toBe(actor.id);
    expect(saved.workspace).toEqual(mode === "owner" ? undefined : { memberId: member.id, workspaceId: W1 });
    if (mode === "revoked-before-register") expect(saved.deputyConversationId).toBeNull();
    if (effects) {
      // Parent input changing later cannot erase the deputy's own binding.
      store.admitConversationMember(seat.id, mode === "owner" ? member.id : owner.id);
      const reader = `import { readDeputies } from ${JSON.stringify(path.resolve("src/lib/orchestrator/deputies.ts"))}; const row = readDeputies()[0]; console.log(JSON.stringify({memberId:row.ask.memberId,workspace:row.workspace??null}));`;
      const child = spawnSync(process.execPath, ["-e", reader], { env: process.env, encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toEqual({ memberId: actor.id, workspace: mode === "owner" ? null : { memberId: member.id, workspaceId: W1 } });
      dependencies.workspaceConversation = id => registry.conversation(id as `conversation_${string}`);
      dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: deliveredId, role: "builder" });
      rebuild();
      const foreign = await call("get_task", { taskId: "task_1" });
      if (mode === "owner") expect(foreign.ok).toBe(true); else expect(foreign).toMatchObject(REFUSED);
      expect((await askOrchestratorInParallel({ project: own, text: "replacement", clientRequestId: "member-parallel", memberId: actor.id }, ports)).ok).toBe(true);
      expect(effects).toBe(1);
      endDeputy(saved.askId, { outcome: "failed", now: new Date(AT) });
      expect((await askOrchestratorInParallel({ retryAskId: saved.askId, clientRequestId: "retry-member-parallel" }, {
        ...ports, prepareRetry: async () => ({ ok: true }), reconcileRetryAnswer: () => null,
      })).ok).toBe(true);
      expect(effects).toBe(2);
      expect(store.latestConversationMember(deliveredId)).toBe(actor.id);
      if (mode === "member") {
        factory.mockImplementationOnce(() => { store.removeWorkspaceMember(W1, member.id); return ports; });
        const replay = await ghostPOST(new NextRequest("http://localhost/api/orchestrator/ghost", {
          method: "POST", headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${cookie}` },
          body: JSON.stringify({ project: own, clientRequestId: "member-parallel", text: "replay" }),
        }));
        expect(replay.status).toBe(403); expect(await replay.json()).not.toHaveProperty("deputy");
        expect(effects).toBe(2);
        store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
        endDeputy(saved.askId, { outcome: "failed", now: new Date(AT) });
        const ended = readDeputies()[0]!;
        const { RuntimeJournal } = await import("@/runtime-host/journal");
        const clientModule = await import("@/lib/runtime/client");
        const journal = new RuntimeJournal(path.join(root, "member-retry-journal.sqlite"));
        const operationId = "retry-member-operation", key = deputyMessageKey(saved.askId, ended.attempt ?? 0);
        const held = registry.holdDelivery(deliveredId as `conversation_${string}`, "Previous question", key, "text", [], null,
          { operationId }, { recoveryIntent: "reclaimed-host" });
        const generation = registry.conversation(deliveredId as `conversation_${string}`)!.generations.at(-1)!;
        registry.beginDeliveryAttempt(held.id, generation.id);
        journal.append({ scope: { type: "session", id: deliveredId }, kind: "session-status", payload: {
          conversationId: deliveredId, sessionKey: { engine: "claude", sessionId: generation.id },
          hostKind: "claude-broker", host: "hosted", turn: "idle", provenance: "structured", artifactPath: generation.path,
          capabilities: { steer: false, structuredAttention: true },
        } });
        journal.executeOperation({ kind: "send", conversationId: deliveredId, operationId, idempotencyKey: key, text: "Previous question", policy: "queue" });
        expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
        let cancellations = 0;
        const client = { readSession: async () => { store.removeWorkspaceMember(W1, member.id); return null; },
          operationStatus: async (id: string) => journal.operationResult(id),
          transitionOperation: async (id: string, status: Parameters<typeof journal.transitionOperation>[1], options: Parameters<typeof journal.transitionOperation>[2]) => {
            cancellations++; return journal.transitionOperation(id, status, options);
          },
        } as unknown as import("@/lib/runtime/client").RuntimeHostClient;
        const transport = spyOn(clientModule, "runtimeHostClient").mockReturnValue(client);
        try {
          await expect(askOrchestratorInParallel({ retryAskId: saved.askId, clientRequestId: "retry-revoked-reader" },
            { ...ports, prepareRetry: realPorts.prepareRetry })).rejects.toThrow("workspace access denied");
          expect(cancellations).toBe(0);
          expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
          expect(readDeputies()[0]!.attempt).toBe(ended.attempt);
        } finally { transport.mockRestore(); journal.close(); }
        store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
        factory.mockReturnValueOnce({ ...ports, prepareRetry: async () => {
          store.removeWorkspaceMember(W1, member.id);
          return { ok: true, completed: { ...ended, outcome: "done", result: { line: "Private answer", finalText: "Private workspace answer" } } };
        } });
        const completed = await ghostPOST(new NextRequest("http://localhost/api/orchestrator/ghost", {
          method: "POST", headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${cookie}` },
          body: JSON.stringify({ retryAskId: saved.askId, clientRequestId: "retry-revoked-answer" }),
        }));
        expect(completed.status).toBe(403);
        expect(JSON.stringify(await completed.json())).not.toContain("Private workspace answer");
        expect(readDeputies()[0]!.attempt).toBe(ended.attempt);
        store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
        resetTeamStoreForTests();
        fs.renameSync(teamStoreFile(), path.join(root, "deputy-saved-team.sqlite"));
        expect(await call("get_task", { taskId: "task_1" })).toMatchObject(REFUSED);
      }
    }
  } finally { write?.mockRestore(); factory.mockRestore(); setAgentRegistryForTests(null); registry.close(); }
});


for (const action of ["update-draft", "add-stage", "override-stage"] as const) test(`a member's ${action} binds an installation pipeline in the edit transaction`, async () => {
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  placeProject(store, owner, projectForCwd(root)!, W1);
  const created = await createPipelineFromRequest({ task: "Installation draft", repoDir: root, stages: [], autoStart: false }, undefined,
    { allowOperatorDraftWithoutLineage: true });
  const id = created.pipeline!.id;
  expect(findPipelineRecord(id)?.workspace).toBeUndefined();
  const stage = { id: "build", kind: "run" as const, role: { roleId: "builder" as const }, prompt: "Workspace work", next: null };
  if (action === "override-stage") expect((await patchPipeline(id, { action: "add-stage", stage })).pipeline).toBeDefined();
  const request = action === "update-draft" ? { action, task: "Member's work" }
    : action === "add-stage" ? { action, stage }
      : { action, stageId: "build", prompt: "Member's instructions" };
  const result = await patchPipeline(id, request, undefined, { kind: "operator" }, undefined, member.id);
  expect(result.error).toBeUndefined();
  expect(findPipelineRecord(id)?.workspace).toEqual({ memberId: member.id, workspaceId: W1 });
  store.removeWorkspaceMember(W1, member.id);
  await expect(patchPipeline(id, request, undefined, { kind: "operator" }, undefined, member.id)).rejects.toThrow("workspace access denied");
});


test("parallel request keys cannot expose another workspace's in-flight or saved deputy", async () => {
  const foreignMember = person("m_foreign", "member");
  store.putWorkspaceMember(W2, foreignMember.id, "member", owner.id, AT);
  const registry = new AgentRegistry(path.join(root, "parallel-key-registry.json"));
  setAgentRegistryForTests(registry);
  const seats = [own, other].map((project, index) => {
    const transcript = path.join(root, `00000000-0000-4000-8000-00000000000${index + 1}.jsonl`);
    const conversation = registry.ensureForkedConversation("claude", transcript, null, emptyLaunchProfile({ cwd: root, project }));
    const clientRequestId = `parallel-key-seat-${index}`;
    beginOrchestratorSeatIntent({ project, mandate: "Run work", mode: "existing", conversationId: conversation.id, clientRequestId, now: AT });
    completeOrchestratorSeatIntent({ project, conversationId: conversation.id, path: transcript, clientRequestId, now: AT });
    return conversation;
  });
  const started = Promise.withResolvers<void>(), recorded = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), secondEntered = Promise.withResolvers<void>();
  let deliveries = 0, commands = 0;
  const ports: DeputyCommandPorts = { ...deputyPorts.productionDeputyCommandPorts({ registry }),
    now: () => new Date(AT), seatBusy: async project => {
      if (project === own) { started.resolve(); await release.promise; }
      else await recorded.promise;
      return true;
    },
    fork: input => ({ path: input.destination, records: 1 }),
    joinSeatTask: () => { recorded.resolve(); },
    workContext: () => ({ openLanes: [], recentTasks: [] }), watch: () => {},
    deliver: async () => { deliveries++; return { ok: true }; },
  };
  const factory = spyOn(deputyPorts, "productionDeputyCommandPorts").mockImplementation(() => {
    if (++commands === 2) secondEntered.resolve();
    return ports;
  });
  const request = (index: number) => {
    const actor = index ? foreignMember : member;
    const cookie = mintSession(store, actor.id, "claim", { surface: "desktop", browser: "chrome" }).value;
    return new NextRequest("http://localhost/api/orchestrator/ghost", { method: "POST",
      headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${cookie}` },
      body: JSON.stringify({ project: index ? other : own, seatConversationId: seats[index]!.id,
        text: index ? "Beta question" : "Alpha private question", clientRequestId: "parallel-shared-request" }),
    });
  };
  let first: Promise<Response> | undefined, collision: Promise<Response> | undefined;
  try {
    first = ghostPOST(request(0));
    await Promise.race([started.promise, first.then(response => { throw new Error(`first ask ended before admission: ${response.status}`); })]);
    expect(readDeputies()).toEqual([]);
    collision = ghostPOST(request(1));
    await Promise.race([secondEntered.promise, collision.then(response => { throw new Error(`second ask never reached the command: ${response.status}`); })]);
    release.resolve();
    expect((await first).status).toBe(200);
    const refused = await collision;
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody).toMatchObject({ code: "invalid_request", admission: "refused" });
    expect(refusedBody).not.toHaveProperty("askId");
    expect(JSON.stringify(refusedBody)).not.toContain("Alpha private question");
    expect(deliveries).toBe(1);
    const saved = readDeputies()[0]!;
    endDeputy(saved.askId, { outcome: "done", result: { line: "Alpha answer", finalText: "Alpha private answer" }, now: new Date(AT) });
    const replay = await ghostPOST(request(1));
    expect(replay.status).toBe(403);
    expect(JSON.stringify(await replay.json())).not.toContain("Alpha private answer");
    expect(await askOrchestratorInParallel({ project: other, seatConversationId: seats[1]!.id, text: "Beta question",
      memberId: foreignMember.id, clientRequestId: "parallel-shared-request" }, ports))
      .toMatchObject({ ok: false, code: "invalid_request", status: 409 });
    expect(deliveries).toBe(1); expect(readDeputies()).toHaveLength(1);
  } finally { release.resolve(); recorded.resolve(); await Promise.allSettled([first, collision].filter(Boolean)); factory.mockRestore(); setAgentRegistryForTests(null); registry.close(); }
});

test("a fenced seat keeps the Telegram tools its record grants; no other fenced caller does", async () => {
  const seat = "conversation_seat";
  snapshot.conversations[seat] = conversation(seat, own, false) as never;
  dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: seat, role: "orchestrator" });
  rebuild();
  let requests = 0;
  const tools = (): Promise<{ ok: boolean }[]> => Promise.all([
    call("telegram_bot_chats", { clientRequestId: `telegram-${++requests}` }),
    call("telegram_bot_messages", { chat: "team", clientRequestId: `telegram-${++requests}` }),
    call("telegram_bot_send", { chat: "team", text: "status", clientRequestId: `telegram-${++requests}` }),
  ]);
  const refused = async () => { for (const answer of await tools()) expect(answer).toMatchObject(REFUSED); };
  const served = async () => { for (const answer of await tools()) expect(answer.ok).toBe(true); };
  const designate = (key: string, grant: boolean, workspace?: { memberId: string; workspaceId: string }) => {
    beginOrchestratorSeatIntent({ project: own, mandate: "Run this workspace", clientRequestId: key, mode: "existing", conversationId: seat,
      ...(workspace ? { workspace } : { workspace: { memberId: member.id, workspaceId: W1 }, workspaceFromMessage: true }), telegramGrant: grant, now: AT });
    completeOrchestratorSeatIntent({ project: own, clientRequestId: key, conversationId: seat, path: `${seat}.jsonl`, now: AT });
  };
  // A conversation a member wrote to that is no seat.
  store.admitConversationMember(seat, member.id);
  await refused();
  // A seat with persisted message authority keeps its Telegram grant.
  designate("seat-without-grant", false);
  await refused();
  designate("seat-with-grant", true);
  await served();
  // The grant covers the Telegram tools and no other installation-wide tool.
  expect(await call("deploy_exact_sha", { sha: "a".repeat(40) })).toMatchObject(REFUSED);
  expect(await call("account_limits")).toMatchObject(REFUSED);
  // The seat's worker holds no grant.
  dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: "conversation_member", role: "builder" });
  rebuild();
  await refused();
  dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: seat, role: "orchestrator" });
  rebuild();
  // A seat a person designated for the member stays without the tools.
  designate("member-seat", true, { memberId: member.id, workspaceId: W1 });
  await refused();
  designate("owner-seat-again", true);
  await served();
  // A conversation a member launched keeps its binding as the owner's seat, and gets no grant.
  snapshot.conversations[seat] = conversation(seat, own) as never;
  await refused();
  snapshot.conversations[seat] = conversation(seat, own, false) as never;
  await served();
  // An unreadable seat record and a lost project both end the grant.
  const saved = readOrchestratorSeatFile();
  writeStoredSeatRecord("{");
  for (const answer of await tools()) expect(answer.ok).toBe(false);
  writeStoredSeatRecord(saved);
  await served();
  store.removeWorkspaceMember(W1, member.id);
  await refused();
});

test("an agent author's project label never refuses a permitted transcript, and a foreign transcript stays refused", async () => {
  const records = [{ role: "user", text: "relayed", author: { kind: "agent", role: "reviewer", project: "Another Project", conversationId: "conversation_foreign" } }];
  const fenced = withWorkspaceMcpFence({ callTool: async (tool, _input, context) => {
    const answer = { ok: true, toolName: tool, clientRequestId: null, replayed: false, records } as never;
    context?.assertResult?.(answer);
    return answer;
  } } as McpToolService, dependencies);
  const permitted = await fenced.callTool("conversation_messages", { clientRequestId: "own-transcript", transcriptPath: "conversation_member.jsonl" });
  if (!permitted.ok) throw new Error(permitted.error);
  expect(permitted.records).toHaveLength(1);
  // The label of a project outside the caller's reach is withheld with its author.
  expect(JSON.stringify(permitted)).not.toContain("Another Project");
  expect(await fenced.callTool("conversation_messages", { clientRequestId: "foreign-transcript", transcriptPath: "conversation_foreign.jsonl" })).toMatchObject(REFUSED);
  expect(await fenced.callTool("conversation_messages", { clientRequestId: "foreign-id", conversationId: "conversation_foreign" })).toMatchObject(REFUSED);
  // A row that itself belongs to a foreign project still refuses the whole answer.
  const leaking = withWorkspaceMcpFence({ callTool: async (tool, _input, context) => {
    const answer = { ok: true, toolName: tool, clientRequestId: null, replayed: false, records: [{ role: "user", text: "x", project: other }] } as never;
    context?.assertResult?.(answer);
    return answer;
  } } as McpToolService, dependencies);
  expect(await leaking.callTool("conversation_messages", { clientRequestId: "leak", transcriptPath: "conversation_member.jsonl" })).toMatchObject(REFUSED);
});

test("a native MCP caller can cancel its bounded evidence preparation", async () => {
  const controller = new AbortController();
  let dispatched = false;
  let prepared = false;
  const fenced = withWorkspaceMcpFence({ callTool: async tool => {
    dispatched = true;
    return { ok: true, toolName: tool, clientRequestId: null, replayed: false };
  } } as McpToolService, { ...dependencies, attentionAuthority: () => ({ kind: "unidentified", conversationId: null }) },
  async signal => {
    expect(signal?.aborted).toBe(false);
    controller.abort(new Error("caller cancelled"));
    expect(signal?.aborted).toBe(true);
    prepared = true;
  });
  const call = runAsMcpHttpCaller({ nativePeer: {} as never }, () => fenced.callTool(
    "get_task", { nativeCallerProof: "a".repeat(43) }, { signal: controller.signal },
  ));
  const error = await call.then(() => null, reason => reason);
  expect(error).toBe(controller.signal.reason);
  expect(prepared).toBe(true);
  expect(dispatched).toBe(false);
});


test.each(["read", "publish"] as const)("implicit pipeline-task %s receipts replay before workspace admission", async mode => {
  designateCaller({ memberId: member.id, workspaceId: W1 });
  const { saveTasks } = await import("@/lib/tasks/store");
  const { savePipelines, loadPipelinesForList } = await import("@/lib/pipelines/store");
  saveTasks(dependencies.loadTasks().map(task => ({ ...task, assignments: [], sources: [] })));
  const effectiveRole = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "implicit-lane", project: own, task: "Review work", repoDir: root, taskIds: ["task_0"],
    stages: [{ id: "review", kind: "run", prompt: "Review work", next: null, effectiveRole }], srcPath: null, srcConversationId: null, now: AT });
  pipeline.runs[0]!.attempts.push({ n: 1, state: "running", conversationId: "conversation_member", startedAt: AT,
    effectiveRole, launchId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null });
  savePipelines([pipeline]);
  dependencies.listPipelineRecords = loadPipelinesForList;
  const { reviewScopePOST } = await import("@/lib/prototypeReview/http");
  const { prototypeWorld } = await import("@/lib/prototypeReview/world");
  const world = { ...prototypeWorld, caller: () => ({ conversationId: "conversation_member", project: own }),
    orchestrator: () => "conversation_member" };
  let scopeCalls = 0, effects = 0;
  const control = { get: async () => ({}), post: async (url: string, body: Record<string, unknown>) => {
    if (!url.endsWith("/scope")) { effects++; return { rounds: [], reviewId: "implicit-form" }; }
    scopeCalls++;
    const response = await reviewScopePOST(new NextRequest("http://localhost/api/prototype-reviews/scope", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json", "x-llv-spawn-capability": "a".repeat(43) }, body: JSON.stringify(body),
    }), world);
    const scope = await response.json();
    expect(response.status).toBe(200);
    expect(scope).toMatchObject({ conversationId: "conversation_member", taskId: "task_0" });
    return scope;
  } };
  setCallerConversationResolverForTests(() => "conversation_member");
  installSpawnCapabilityResolver(() => "conversation_member");
  const receiptFile = path.join(root, "implicit-form-receipts.json");
  const reopen = () => withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(receiptFile)), dependencies);
  try {
    service = reopen();
    await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
      const tool = mode === "read" ? "read_prototype_review" : "publish_prototype_review";
      const args = { clientRequestId: "implicit-task-form", ...(mode === "publish" ? { title: "Choose", questions: formQuestions } : {}) };
      expect(await call(tool, args)).toMatchObject({ ok: true, replayed: false });
      store.removeWorkspaceMember(W1, member.id);
      service = reopen();
      expect(await call(tool, args)).toMatchObject({ ok: true, replayed: true });
      expect(await call(tool, { ...args, taskId: "task_0" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
      expect(await call(tool, { ...args, clientRequestId: "fresh-implicit" })).toMatchObject(REFUSED);
      expect(scopeCalls).toBe(1); expect(effects).toBe(1);
      const durable = fs.readFileSync(receiptFile, "utf8");
      const script = `
        import { createMcpToolService, FileMcpReceiptStore } from ${JSON.stringify(path.resolve("src/lib/mcp/server.ts"))};
        import { viewerMcpBindings, productionDomainDependencies } from ${JSON.stringify(path.resolve("src/lib/mcp/bindings.ts"))};
        import { withWorkspaceMcpFence } from ${JSON.stringify(path.resolve("src/lib/mcp/workspaceFence.ts"))};
        const dependencies = { ...productionDomainDependencies,
          attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_member", role: "orchestrator" }),
          authorizedSeats: () => [{ conversationId: "conversation_member", project: ${JSON.stringify(own)}, path: null }],
          workspaceConversation: () => { throw new Error("replay reached workspace admission"); } };
        const control = { get: async () => { throw new Error("replay dispatched"); }, post: async () => { throw new Error("replay dispatched"); } };
        const service = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(${JSON.stringify(receiptFile)})), dependencies);
        console.log(JSON.stringify(await service.callTool(${JSON.stringify(tool)}, ${JSON.stringify(args)})));
      `;
      const restarted = spawnSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8" });
      expect(restarted.status).toBe(0);
      expect(JSON.parse(restarted.stdout.trim())).toMatchObject({ ok: true, replayed: true });
      // Another current seat selecting the same inferred task and key has no
      // right to this caller's receipt.
      pipeline.runs[0]!.attempts[0]!.conversationId = "conversation_second";
      savePipelines([pipeline]);
      snapshot.conversations.conversation_second = conversation("conversation_second", own) as never;
      dependencies.attentionAuthority = () => ({ kind: "worker", conversationId: "conversation_second", role: "orchestrator" });
      dependencies.authorizedSeats = () => [{ conversationId: "conversation_second", project: own, path: null }];
      expect(await call(tool, args)).toMatchObject(REFUSED);
      expect(fs.readFileSync(receiptFile, "utf8")).toBe(durable);
      expect(scopeCalls).toBe(1); expect(effects).toBe(1);
    });
  } finally { installSpawnCapabilityResolver(null); setCallerConversationResolverForTests(null); }
});


for (const mode of ["read", "publish"] as const) for (const legacy of [false, true]) test(`project-bound ${mode} receipts refuse a seat in another project after reopening (legacy=${legacy})`, async () => {
  const { saveTasks } = await import("@/lib/tasks/store");
  const { reviewScopePOST } = await import("@/lib/prototypeReview/http");
  const { prototypeWorld } = await import("@/lib/prototypeReview/world");
  const { authorizedManagerSeats } = await import("@/lib/orchestrator/authority");
  saveTasks(dependencies.loadTasks().map(task => ({ ...task, assignments: [], sources: [] })));
  designateCaller({ memberId: member.id, workspaceId: W1 });
  dependencies.authorizedSeats = () => authorizedManagerSeats({
    activeSeats: () => Object.values(readOrchestratorSeatFile().seats),
    revocations: () => readOrchestratorSeatFile().revocations,
    resolveAlias: id => id,
    conversationFacts: id => {
      const row = snapshot.conversations[id];
      return row ? { superseded: false, hasGeneration: row.generations.length > 0, project: row.projectOwnership?.project ?? null } : null;
    },
  });
  let reads = 0, scopes = 0;
  const world = { ...prototypeWorld, caller: () => ({ conversationId: "conversation_member", project: snapshot.conversations.conversation_member!.projectOwnership!.project }),
    stage: () => null, orchestrator: () => "conversation_member" };
  const controls = { get: async () => ({}), post: async (url: string, body: Record<string, unknown>) => {
    if (!url.endsWith("/scope")) { reads++; return { rounds: [{ title: "Project Alpha private answer" }] }; }
    scopes++;
    const response = await reviewScopePOST(new NextRequest("http://localhost/api/prototype-reviews/scope", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json", "x-llv-spawn-capability": "a".repeat(43) }, body: JSON.stringify(body),
    }), world);
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.error));
    return result;
  } };
  setCallerConversationResolverForTests(() => "conversation_member");
  installSpawnCapabilityResolver(() => "conversation_member");
  try {
    const receipts = new FileMcpReceiptStore(path.join(root, "project-change-receipts.json"));
    const bindings = viewerMcpBindings(undefined, controls, dependencies);
    const tool = mode === "read" ? "read_prototype_review" : "publish_prototype_review";
    if (legacy) {
      const admit = bindings[tool].receiptScope!;
      // Write through the real store using the previous scope encoding.
      bindings[tool].receiptScope = async (args, context) => { await admit(args, context); return "conversation_member\ntask_0"; };
    }
    service = withWorkspaceMcpFence(createMcpToolService(bindings, receipts), dependencies);
    await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
      const args = { taskId: "task_0", clientRequestId: "project-change-replay", ...(mode === "publish" ? { title: "Choose", questions: formQuestions } : {}) };
      expect(await call(tool, args)).toMatchObject({ ok: true, replayed: false });
      if (legacy) {
        const original = fs.readFileSync(path.join(root, "project-change-receipts.json"), "utf8");
        store.removeWorkspaceMember(W1, member.id);
        expect(await call(tool, args)).toMatchObject(REFUSED);
        expect(fs.readFileSync(path.join(root, "project-change-receipts.json"), "utf8")).toBe(original);
        store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
      }
      store.putWorkspaceMember(W2, member.id, "member", owner.id, AT);
      snapshot.conversations.conversation_member = conversation("conversation_member", other) as never;
      snapshot.conversations.conversation_member!.generations[0]!.launchProfile!.workspace = { memberId: member.id, workspaceId: W2 };
      const seats = readOrchestratorSeatFile();
      const oldSeat = seats.seats[own]!;
      delete seats.seats[own];
      seats.seats[other] = { ...oldSeat, project: other, seatEpoch: oldSeat.seatEpoch + 1, workspace: { memberId: member.id, workspaceId: W2 } };
      writeStoredSeatRecord(seats);
      expect(dependencies.authorizedSeats!()).toMatchObject([{ conversationId: "conversation_member", project: other }]);
      expect(conversationWorkspacePrincipal(snapshot, "conversation_member", store)).toEqual({ memberId: member.id, workspaceId: W2 });
      service = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, controls, dependencies), new FileMcpReceiptStore(path.join(root, "project-change-receipts.json"))), dependencies);
      const durable = fs.readFileSync(path.join(root, "project-change-receipts.json"), "utf8");
      const replay = await call(tool, args);
      expect(replay).toMatchObject({ ok: false, code: "tool_failed", error: "prototype access is limited to the caller\'s project" });
      expect(scopes).toBe(2);
      expect(JSON.stringify(replay)).not.toContain("Project Alpha private answer");
      expect(reads).toBe(1);
      expect(fs.readFileSync(path.join(root, "project-change-receipts.json"), "utf8")).toBe(durable);
      const script = `
        import { createMcpToolService, FileMcpReceiptStore } from ${JSON.stringify(path.resolve("src/lib/mcp/server.ts"))};
        import { viewerMcpBindings, productionDomainDependencies } from ${JSON.stringify(path.resolve("src/lib/mcp/bindings.ts"))};
        const dependencies = { ...productionDomainDependencies,
          attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_member", role: "orchestrator" }),
          authorizedSeats: () => [{ conversationId: "conversation_member", project: ${JSON.stringify(other)}, path: null }],
          listPipelineRecords: () => [] };
        const control = { get: async () => { throw new Error("replay dispatched"); }, post: async () => { throw new Error("replay dispatched"); } };
        const service = createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(${JSON.stringify(path.join(root, "project-change-receipts.json"))}));
        console.log(JSON.stringify(await service.replayTool(${JSON.stringify(tool)}, ${JSON.stringify(args)})));
      `;
      const restarted = spawnSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8" });
      expect(restarted.status).toBe(0);
      expect(JSON.parse(restarted.stdout.trim())).toBeNull();
    });
  } finally { installSpawnCapabilityResolver(null); setCallerConversationResolverForTests(null); }
});

for (const mode of ["read", "publish"] as const) for (const target of ["seat", "task"] as const) test(`unproven project refuses ${mode} ${target} form receipts before storage`, async () => {
  designateCaller({ memberId: member.id, workspaceId: W1 });
  let proven = false, effects = 0;
  const receipts = path.join(root, "unproven-project-receipts.json");
  const control = { get: async () => ({}), post: async (url: string) => {
    if (url.endsWith("/scope")) return { conversationId: "conversation_member", taskId: target === "task" ? "task_0" : null, ...(proven ? { project: own } : {}) };
    effects++; return { rounds: [], reviewId: "proven-form" };
  } };
  service = withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(receipts)), dependencies);
  await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
    const tool = mode === "read" ? "read_prototype_review" : "publish_prototype_review";
    const args = { clientRequestId: "unproven-project", ...(target === "task" ? { taskId: "task_0" } : {}), ...(mode === "publish" ? { title: "Choose", questions: formQuestions } : {}) };
    expect(await call(tool, args)).toMatchObject({ ok: false, code: "prototype_project_unavailable", retryable: true, details: { check: "prototype-project" } });
    expect(effects).toBe(0);
    expect(fs.existsSync(receipts)).toBe(false);
    proven = true;
    expect(await call(tool, args)).toMatchObject({ ok: true, replayed: false });
    expect(await call(tool, args)).toMatchObject({ ok: true, replayed: true });
    expect(effects).toBe(1);
  });
});

for (const mode of ["read", "publish"] as const) for (const changed of [false, true]) test(`fresh ${mode} receipts bind HTTP scope to dispatch (project changed=${changed})`, async () => {
  const { reviewScopePOST, reviewReadPOST, publishPOST } = await import("@/lib/prototypeReview/http");
  const { prototypeWorld } = await import("@/lib/prototypeReview/world");
  const { publishPrototype } = await import("@/lib/prototypeReview/store");
  const { loadSeatRounds } = await import("@/lib/prototypeReview/seatRounds");
  designateCaller({ memberId: member.id, workspaceId: W1 });
  let project = own;
  dependencies.authorizedSeats = () => [{ conversationId: "conversation_member", project, path: null }];
  await publishPrototype({ clientRequestId: "private-form", title: "Private project Beta answer", questions: formQuestions }, null, { conversationId: "conversation_private" }, other);
  const original = loadSeatRounds(other);
  const world = { ...prototypeWorld, caller: () => ({ conversationId: "conversation_member", project }), stage: () => null, orchestrator: () => "conversation_member" };
  const previousControl = process.env.LLV_VIEWER_CONTROL_URL;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(incoming) {
    const scope = new URL(incoming.url).pathname.endsWith("/scope");
    const handler = scope ? reviewScopePOST : mode === "read" ? reviewReadPOST : publishPOST;
    const response = await handler(new NextRequest(incoming), world);
    if (scope && changed) project = other;
    return response;
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${server.port}`;
  const control = productionViewerControlDependencies();
  const file = path.join(root, "fresh-project-receipts.json");
  const core = createMcpToolService(viewerMcpBindings(undefined, control, dependencies), new FileMcpReceiptStore(file));
  installSpawnCapabilityResolver(() => "conversation_member");
  setCallerConversationResolverForTests(() => "conversation_member");
  try {
    await runAsMcpHttpCaller({ capability: "a".repeat(43) }, async () => {
      const tool = mode === "read" ? "read_prototype_review" : "publish_prototype_review";
      const args = { clientRequestId: "scope-dispatch-project-change", ...(mode === "publish" ? { title: "Choose", questions: formQuestions } : {}) };
      const answer = await core.callTool(tool, args);
      expect(answer.ok).toBe(!changed);
      if (changed) expect(answer).toMatchObject({ ...REFUSED, error: expect.stringContaining("prototype receipt identity changed"), details: { check: "prototype-receipt-scope" } });
      expect(JSON.stringify(answer)).not.toContain("Private project Beta answer");
      expect(loadSeatRounds(other)).toEqual(original);
      project = own;
      const replay = await core.replayTool!(tool, args);
      expect(replay).toMatchObject(changed ? { ...REFUSED, replayed: true, details: { check: "prototype-receipt-scope" } } : { ok: true, replayed: true });
      expect(fs.readFileSync(file, "utf8")).not.toContain("Private project Beta answer");
    });
  } finally {
    await server.stop(true);
    if (previousControl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previousControl;
    installSpawnCapabilityResolver(null); setCallerConversationResolverForTests(null);
  }
});


for (const identity of ["valid", "superseded", "revoked", "conflicting-project", "missing-generation", "wrong-project"] as const)
  test(`taskless HTTP forms validate current seat authority: ${identity}`, async () => {
    const { authorizedManagerSeats } = await import("@/lib/orchestrator/authority");
    const { productionManagerAuthoritySources } = await import("@/lib/orchestrator/managerAuthoritySources");
    const { POST: publishPOST } = await import("@/app/api/prototype-reviews/route");
    const { POST: readPOST } = await import("@/app/api/prototype-reviews/read/route");
    const { POST: scopePOST } = await import("@/app/api/prototype-reviews/scope/route");
    const handlers = await import("@/lib/prototypeReview/http");
    const { publishPrototype } = await import("@/lib/prototypeReview/store");
    const { loadSeatRounds } = await import("@/lib/prototypeReview/seatRounds");
    designateCaller({ memberId: member.id, workspaceId: W1 });
    await publishPrototype({ clientRequestId: "private-round", title: "Private seat decision", questions: formQuestions },
      null, { conversationId: "conversation_member" }, own);
    if (identity === "superseded") snapshot.conversations.conversation_member!.supersededBy = {
      conversationId: "conversation_foreign", at: AT, reason: "replaced",
    } as never;
    if (identity === "missing-generation") snapshot.conversations.conversation_member!.generations = [];
    if (identity === "wrong-project") snapshot.conversations.conversation_member!.projectOwnership!.project = other;
    if (identity === "revoked" || identity === "conflicting-project") {
      const file = readOrchestratorSeatFile();
      const seat = file.seats[own]!;
      if (identity === "revoked") file.revocations.push({ project: own, conversationId: "conversation_member", seatEpoch: seat.seatEpoch, revokedAt: AT });
      else file.seats[other] = { ...seat, project: other, seatEpoch: seat.seatEpoch + 1 };
      writeStoredSeatRecord(file);
    }
    const registry = new AgentRegistry(path.join(root, "taskless-authority-registry.json"));
    const lookup = spyOn(registry, "conversation").mockImplementation(id => snapshot.conversations[id] ?? null);
    const read = spyOn(registry, "readOnlySnapshot").mockImplementation(() => snapshot);
    const facts = fixtureAuthority(registry);
    setAgentRegistryForTests(registry);
    installSpawnCapabilityResolver(() => "conversation_member");
    setCallerConversationResolverForTests(() => "conversation_member");
    const previousControl = process.env.LLV_VIEWER_CONTROL_URL;
    const valid = identity === "valid";
    const seats = () => authorizedManagerSeats(productionManagerAuthoritySources(registry));
    const routes = [
      { path: "/api/prototype-reviews", body: { title: "New seat question", questions: formQuestions }, route: publishPOST, handler: handlers.publishPOST },
      { path: "/api/prototype-reviews/scope", body: { mode: "publish" }, route: scopePOST, handler: handlers.reviewScopePOST },
      { path: "/api/prototype-reviews/scope", body: { mode: "read" }, route: scopePOST, handler: handlers.reviewScopePOST },
      { path: "/api/prototype-reviews/read", body: {}, route: readPOST, handler: handlers.reviewReadPOST },
    ];
    const request = (route: typeof routes[number], clientRequestId: string) => new NextRequest(`http://localhost${route.path}`, {
      method: "POST", headers: { host: "localhost", "content-type": "application/json", "x-llv-spawn-capability": "a".repeat(43) },
      body: JSON.stringify({ ...route.body, clientRequestId }),
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: incoming => {
      const route = routes.find(route => route.path === new URL(incoming.url).pathname);
      return route ? route.route(new NextRequest(incoming)) : new Response(null, { status: 404 });
    } });
    process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${server.port}`;
    try {
      expect(seats()).toHaveLength(valid ? 1 : 0);
      const before = loadSeatRounds();
      for (const [index, route] of routes.entries()) {
        const response = await route.route(request(route, `direct-${index}`));
        const body = await response.json();
        expect(response.status).toBe(valid ? 200 : 403);
        if (!valid) {
          expect(body).toMatchObject({ code: "workspace_forbidden", check: "route-target" });
          expect(JSON.stringify(body)).not.toContain("Private seat decision");
          // The handler also fences solo/owner fast paths without a workspace gate.
          const target = await route.handler(request(route, `handler-${index}`));
          expect(target.status).toBe(403);
          expect(await target.json()).toMatchObject({ code: "workspace_forbidden", check: "prototype-seat-authority" });
        } else if (route.path.endsWith("/read")) expect(JSON.stringify(body)).toContain("Private seat decision");
      }
      const domains = { ...dependencies, authorizedSeats: seats };
      const receipts = new MemoryMcpReceiptStore();
      const reopen = () => withWorkspaceMcpFence(createMcpToolService(viewerMcpBindings(undefined,
        productionViewerControlDependencies(), domains), receipts), domains);
      for (const tool of ["publish_prototype_review", "read_prototype_review"] as const) {
        const args = { clientRequestId: `mcp-${tool}`, ...(tool === "publish_prototype_review" ? { title: "MCP seat question", questions: formQuestions } : {}) };
        const answer = await runAsMcpHttpCaller({ capability: "a".repeat(43) }, () => reopen().callTool(tool, args));
        expect(answer.ok).toBe(valid);
        if (!valid) {
          expect(answer).toMatchObject({ ...REFUSED, details: { check: identity === "wrong-project" ? "caller-project" : "route-target" } });
          expect(JSON.stringify(answer)).not.toContain("Private seat decision");
        } else {
          if (tool === "read_prototype_review") expect(JSON.stringify(answer)).toContain("Private seat decision");
          store.removeWorkspaceMember(W1, member.id);
          const replay = await runAsMcpHttpCaller({ capability: "a".repeat(43) }, () => reopen().callTool(tool, args));
          expect(replay).toMatchObject({ ok: true, replayed: true });
          store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
        }
      }
      if (!valid) expect(loadSeatRounds()).toEqual(before);
    } finally {
      await server.stop(true);
      if (previousControl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = previousControl;
      lookup.mockRestore(); read.mockRestore(); facts.mockRestore();
      installSpawnCapabilityResolver(null); setCallerConversationResolverForTests(null); setAgentRegistryForTests(null); registry.close();
    }
  });
