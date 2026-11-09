import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordNativeHook, nativeTranscriptCallProof } from "@/lib/attention/nativeCallProof";
import { nativeCallerRefusal } from "@/lib/attention/nativeCaller";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentRegistry, type RegistryConversation, type RegistryFile } from "@/lib/agent/registry";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { teamStore, resetTeamStoreForTests, type TeamStore } from "@/lib/team/store";
import { createWorkspace, placeProject } from "@/lib/team/workspaces";
import type { Member } from "@/lib/team/contract";
import { viewerMcpBindings, viewerReadTools, productionDomainDependencies, type ViewerMcpDomainDependencies } from "./bindings";
import { createViewerMcpServer, createMcpToolService, SqliteMcpReceiptStore, requestDigest, McpToolRefusal,
  type McpToolArgs, type McpToolService, type McpToolResult, type McpReceiptStore } from "./server";
import { withWorkspaceMcpFence } from "./workspaceFence";
import { McpPageCursorStore } from "./pageCursors";

const AT = "2026-11-06T12:00:00.000Z";
const OWN = "repo-11111111111111111111111111111111", FOREIGN = "repo-22222222222222222222222222222222";
const CALLER = "conversation_board_reader";
const W1 = `w_${"a".repeat(32)}`, W2 = `w_${"b".repeat(32)}`;
const TOOLS = ["list_tasks", "list_pipelines"] as const;
type Tool = typeof TOOLS[number];
let root: string;
let previousState: string | undefined;
const cursorStoreKey = Symbol.for("delegatus.mcp.pageCursors");
const cursorStores = globalThis as typeof globalThis & { [cursorStoreKey]?: McpPageCursorStore };
let previousCursorStore: McpPageCursorStore | undefined;
const close: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  setSystemTime(new Date(AT));
  previousCursorStore = cursorStores[cursorStoreKey];
  cursorStores[cursorStoreKey] = new McpPageCursorStore();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "board-project-"));
  previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  resetTeamStoreForTests();
});
afterEach(async () => {
  for (const release of close.splice(0).reverse()) await release();
  resetTeamStoreForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  cursorStores[cursorStoreKey] = previousCursorStore;
  setSystemTime();
  fs.rmSync(root, { recursive: true, force: true });
});

async function harness(workspace = false) {
  const folder = path.join(root, "WidgetsRepo"); fs.mkdirSync(folder);
  expect(persistProjectAliases([{ source: "legacy-board", target: OWN, displayName: "Example Board" },
    { source: "foreign-old", target: FOREIGN, displayName: "Foreign Canary Board" }])).toBe(true);
  const tasks: BoardTask[] = [OWN, FOREIGN].map((project, index) => ({ id: `task_${index}`, project,
    text: index ? "FOREIGN_PAYLOAD_CANARY" : "Own task", status: "inbox", placement: "unplaced", assignments: [], createdAt: AT, updatedAt: AT }));
  saveTasks(tasks);
  const pipelines = [OWN, FOREIGN].map((project, index) => buildPipeline({ id: `pipeline_${index}`, project,
    task: index ? "FOREIGN_PAYLOAD_CANARY" : "Own lane", repoDir: folder, stages: [], state: "draft", srcPath: null, srcConversationId: null, now: AT }));
  const registry = new AgentRegistry(path.join(root, "registry.json")); close.push(() => registry.close());
  const seed = registry.ensureConversation("codex", path.join(root, "caller.jsonl"), null);
  const reader: RegistryConversation = { ...seed, id: CALLER, projectOwnership: { project: OWN, source: "operator", setAt: AT, operationId: "fixture-project" },
    generations: seed.generations.map(row => ({ ...row, id: "board-generation", launchProfile: { ...row.launchProfile, project: OWN } })) };
  const snapshot: RegistryFile = { ...registry.readOnlySnapshot(), conversations: { [CALLER]: reader } };
  let mode: "manager" | "agent" | "gateway" = workspace ? "agent" : "manager";
  let seatProject: string | null = OWN, callerId: string = CALLER;
  let rows = pipelines;
  let onRows = () => {};
  let rowReads = 0;
  const domain: ViewerMcpDomainDependencies = { ...productionDomainDependencies,
    callerAttribution: () => ({ kind: mode, conversationId: callerId, role: "orchestrator" }),
    attentionAuthority: () => ({ kind: "worker", conversationId: callerId, role: "orchestrator" }),
    registrySnapshot: () => snapshot,
    workspaceConversation: undefined, workspaceProject: undefined,
    authorizedSeats: () => seatProject ? [{ conversationId: CALLER, path: null, project: seatProject }] : [],
    callerProject: () => OWN,
    lastCompletedCatalog: () => ({ files: [], projectCatalog: [
      { project: OWN, displayName: "Example Board", projectRoot: folder, smt: 1, conversations: 1 },
      { project: FOREIGN, displayName: "Foreign Canary Board", projectRoot: path.join(root, "OtherRepo"), smt: 1, conversations: 1 },
    ] }),
    completedFileScan: () => { throw new Error("unexpected scanner call"); },
    loadTasks, taskSelectionSource: undefined, pipelineSelectionSource: undefined,
    listTaskRecords: () => { rowReads++; onRows(); return loadTasks(); },
    listPipelineRecords: () => { rowReads++; onRows(); return rows; }, getPipelines: () => ({ pipelines: rows }),
  };
  let store: TeamStore | undefined, owner: Member | undefined;
  if (workspace) {
    store = teamStore();
    const person = (id: string, role: Member["role"]): Member => ({ id, name: id, role, status: "active", color: "teal", telegram: null,
      createdAt: AT, createdBy: "claim", revokedAt: null });
    owner = person("m_owner", "owner"); const member = person("m_reader", "member");
    store.insertMember(owner); store.insertMember(member);
    createWorkspace(store, owner, { id: W1, name: "First", projects: [OWN] });
    createWorkspace(store, owner, { id: W2, name: "Second", projects: [FOREIGN] });
    store.putWorkspaceMember(W1, member.id, "member", owner.id, AT);
    reader.generations[0]!.launchProfile.workspace = { memberId: member.id, workspaceId: W1 };
  }
  const filename = path.join(root, "receipts.sqlite");
  let receipts = new SqliteMcpReceiptStore(filename);
  close.push(() => receipts.close());
  const bindings = viewerMcpBindings(undefined, {
    post: async () => { throw new Error("unexpected control write"); }, get: async () => { throw new Error("unexpected control read"); },
  }, domain);
  const makeService = (storage: McpReceiptStore = receipts) => {
    const core = createMcpToolService(bindings, storage);
    return workspace ? withWorkspaceMcpFence(core, domain) : core;
  };
  let service = makeService();
  let atSdkReturn = () => {};
  const server = createViewerMcpServer({ async callTool(...args) {
    const result = await service.callTool(...args); atSdkReturn(); return result;
  } });
  const client = new Client({ name: "board-project-test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(s), client.connect(c)]);
  close.push(async () => { await client.close(); await server.close(); });
  let wire = "";
  const call = async (tool: Tool, args: McpToolArgs = {}) => {
    const result = await client.callTool({ name: tool, arguments: { full: true, ...args } });
    wire = JSON.stringify(result);
    const answer = result.structuredContent as McpToolResult;
    expect(result.content).toBeDefined();
    return answer;
  };
  return { call, client, domain, bindings, reader, snapshot, folder, filename, receipts, wire: () => wire,
    useStore: (storage: McpReceiptStore) => { service = makeService(storage); },
    service: () => service, rowReads: () => rowReads,
    mode: (value: typeof mode) => { mode = value; }, seat: (value: string | null) => { seatProject = value; },
    caller: (value: string) => { callerId = value; },
    indexed: () => { savePipelines(rows); domain.taskSelectionSource = productionDomainDependencies.taskSelectionSource; domain.pipelineSelectionSource = productionDomainDependencies.pipelineSelectionSource; },
    many: () => { rows = Array.from({ length: 251 }, (_, index) => ({ ...pipelines[0]!, id: `pipeline_${String(index).padStart(3, "0")}` })); },
    onRows: (fn: () => void) => { onRows = fn; }, atSdkReturn: (fn: () => void) => { atSdkReturn = fn; },
    replaceService: (fn: (original: McpToolService) => McpToolService) => { service = fn(service); },
    reopen: () => { receipts.close(); receipts = new SqliteMcpReceiptStore(filename); service = makeService(); },
    moveWorkspace: () => { if (!store || !owner) throw new Error("workspace required"); placeProject(store, owner, OWN, W2); },
    revokeMember: () => { if (!store) throw new Error("workspace required"); store.removeWorkspaceMember(W1, "m_reader"); },
  };
}

function refused(result: McpToolResult, code: string) {
  expect(result).toMatchObject({ ok: false, code, retryable: false });
  expect(JSON.stringify(result)).not.toContain("FOREIGN_PAYLOAD_CANARY");
  expect(result).not.toHaveProperty("tasks"); expect(result).not.toHaveProperty("pipelines"); expect(result).not.toHaveProperty("nextCursor");
  if (!result.ok && result.details) expect(result.details.retryable).toBe(false);
}

for (const tool of TOOLS) {
  test(`${tool}: SDK key/name/folder/alias and direct reads select identical own rows`, async () => {
    const h = await harness();
    const schema = (await h.client.listTools()).tools.find(row => row.name === tool)!;
    expect(schema.inputSchema.properties?.project).toMatchObject({ type: "string" });
    expect(schema.inputSchema.required ?? []).not.toContain("project");
    for (const mode of ["manager", "agent", "gateway"] as const) {
      h.mode(mode);
      const expected = await h.call(tool, { project: OWN });
      expect(expected).toMatchObject({ ok: true, total: 1 });
      for (const project of ["  eXaMpLe BoArD ", "wIDGETSrEPO", h.folder, "legacy-board", OWN.toUpperCase()]) {
        expect(await h.call(tool, { project })).toEqual(expected);
      }
      const direct = await viewerReadTools(h.domain)[tool]({ project: "Example Board", full: true });
      expect(direct.total).toBe(1);
    }
    h.mode("manager");
    expect(await h.call(tool)).toMatchObject({ ok: true, total: 1 });
    expect(await h.call(tool, { project: "  " })).toMatchObject({ ok: true, total: 1 });
    h.mode("agent"); h.seat(null);
    expect(await h.call(tool)).toMatchObject({ ok: true, total: 2 });
    // Prove the foreign canary is populated and reachable under existing worker policy.
    expect(JSON.stringify(await h.call(tool, { project: FOREIGN }))).toContain("FOREIGN_PAYLOAD_CANARY");
  });

  for (const scenario of ["unknown", "ambiguous", "collision", "foreign", "missing-designation"] as const) {
    test(`${tool}: keyed and unkeyed ${scenario} refusal before row access`, async () => {
      const h = await harness();
      let project = OWN, code = "project_scope_refused";
      if (scenario === "unknown") { project = "Missing Board"; code = "unknown_project"; }
      if (scenario === "foreign") { project = FOREIGN; code = "cross_project_refused"; }
      if (scenario === "ambiguous") {
        expect(persistProjectAliases([{ source: "ambiguous-old", target: FOREIGN, displayName: "Example Board" }])).toBe(true);
        h.domain.authorizedSeats = () => [{ conversationId: CALLER, project: OWN, path: null }, { conversationId: "conversation_other", project: FOREIGN, path: null }];
        project = "Example Board"; code = "ambiguous_project";
      }
      if (scenario === "collision") {
        expect(persistProjectAliases([{ source: "ambiguous-old", target: FOREIGN, displayName: OWN }])).toBe(true);
        h.domain.authorizedSeats = () => []; code = "ambiguous_project";
      }
      if (scenario === "missing-designation") h.seat(null);
      for (const keyed of [false, true]) refused(await h.call(tool, { project, ...(keyed ? { clientRequestId: "refused" } : {}) }), code);
      expect(h.rowReads()).toBe(0);
    });
  }

  test(`${tool}: ordinary reader refuses unknown input instead of an empty success`, async () => {
    const h = await harness(); h.mode("agent"); h.seat(null);
    refused(await h.call(tool, { project: "Missing Board" }), "unknown_project");
    expect(h.rowReads()).toBe(0);
  });

  test(`${tool}: retained evidence resolves without a catalog and unavailable directory refuses`, async () => {
    const h = await harness(); h.domain.lastCompletedCatalog = () => null;
    expect(await h.call(tool, { project: "Example Board" })).toMatchObject({ ok: true, total: 1 });
    h.domain.lastCompletedCatalog = () => { throw new Error("catalog unavailable"); };
    expect(await h.call(tool, { project: "Example Board" })).toMatchObject({ ok: false, retryable: true });
  });

  test(`${tool}: canonical replay rechecks designation, keeps past success and UNKNOWN bytes across reopen`, async () => {
    const h = await harness();
    const args = { project: OWN, full: true, clientRequestId: "same-read" };
    const digest = requestDigest(tool, args);
    const legacy = `${tool}:same-read`, unknown = `${tool}:unknown-read`;
    h.receipts.claim(legacy, digest, "bounded");
    h.receipts.complete(legacy, digest, { ok: true, toolName: tool, clientRequestId: "same-read", replayed: false, canary: "OLD_PAYLOAD_CANARY" }, "bounded");
    h.receipts.claim(unknown, requestDigest(tool, { ...args, clientRequestId: "unknown-read" }), "bounded");
    const db = new Database(h.filename);
    const bytes = () => JSON.stringify(db.query("SELECT * FROM mcp_receipts WHERE receipt_key IN (?, ?) ORDER BY receipt_key").all(legacy, unknown));
    const before = bytes();
    try {
      expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1, replayed: false });
      expect(await h.call(tool, { ...args, project: "Example Board" })).toMatchObject({ ok: true, total: 1, replayed: true });
      expect(await h.call(tool, { ...args, limit: 1 })).toMatchObject({ ok: false, code: "idempotency_conflict" });
      h.seat(FOREIGN);
      for (let reopen = 0; reopen < 2; reopen++) {
        for (const clientRequestId of ["same-read", "unknown-read"]) refused(await h.call(tool, { ...args, clientRequestId }), "cross_project_refused");
        expect(bytes()).toBe(before); h.reopen();
      }
      h.seat(OWN); expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1, replayed: true });
      expect(bytes()).toBe(before);
    } finally { db.close(); }
  });

  test(`${tool}: caller assertions and forged hints cannot widen the selected board`, async () => {
    const h = await harness();
    refused(await h.call(tool, { project: FOREIGN, conversationId: "conversation_foreign", workspaceId: W2, generation: "foreign", caller: { kind: "root" } }), "cross_project_refused");
    expect(await h.client.callTool({ name: tool, arguments: { project: OWN, nativeCallerProof: "invalid" } })).toMatchObject({ isError: true });
    expect(await h.service().callTool(tool, { project: OWN, nativeCallerProof: "invalid" })).toMatchObject({ ok: false, code: "invalid_request" });
    let checked = 0;
    const result = await h.service().callTool(tool, { project: OWN }, { assertCaller() { checked++; throw new McpToolRefusal("caller replaced", { code: "caller_changed", retryable: false }); } });
    refused(result, "caller_changed"); expect(checked).toBeGreaterThan(0); expect(h.rowReads()).toBe(0);
  });

  for (const change of ["caller", "generation", "designation", "alias", "unchanged"] as const) test(`${tool}: final SDK await checks ${change} on keyed, replayed and fresh responses`, async () => {
    const h = await harness();
    const original = structuredClone(h.reader.generations);
    const mutate = () => {
      if (change === "caller") h.caller("conversation_replacement");
      if (change === "generation") h.reader.generations[0]!.id = "replacement";
      if (change === "designation") h.seat(null);
      if (change === "alias") projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), current => ({ next: { ...current, aliases: { ...current.aliases, "legacy-board": FOREIGN } }, result: undefined }));
    };
    for (const form of ["fresh", "keyed", "replayed"] as const) {
      const args = { project: "legacy-board", ...(form !== "fresh" ? { clientRequestId: form } : {}) };
      if (form === "replayed") expect(await h.call(tool, args)).toMatchObject({ ok: true });
      h.atSdkReturn(mutate);
      const result = await h.call(tool, args);
      if (change === "unchanged") expect(result).toMatchObject({ ok: true, total: 1 });
      else { expect(result.ok).toBe(false); expect(result).not.toHaveProperty(tool === "list_tasks" ? "tasks" : "pipelines"); }
      h.atSdkReturn(() => {}); h.caller(CALLER); h.seat(OWN); h.reader.generations = structuredClone(original);
      projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), current => ({ next: { ...current, aliases: { ...current.aliases, "legacy-board": OWN } }, result: undefined }));
    }
  });

  test(`${tool}: workspace resolution, hidden candidates and final membership/project/principal changes`, async () => {
    const h = await harness(true);
    for (const project of [OWN, "Example Board", "WidgetsRepo", h.folder, "legacy-board", ""]) expect(await h.call(tool, { project })).toMatchObject({ ok: true, total: 1 });
    refused(await h.call(tool, { project: FOREIGN }), "workspace_forbidden");
    const unknown = await h.call(tool, { project: "Foreign Canary Boar" });
    refused(unknown, "unknown_project"); expect(JSON.stringify(unknown)).not.toContain("Foreign Canary Board"); expect(JSON.stringify(unknown)).not.toContain(FOREIGN);
    persistProjectAliases([{ source: "collision", target: FOREIGN, displayName: "Example Board" }]);
    h.domain.authorizedSeats = () => [];
    const ambiguous = await h.call(tool, { project: "Example Board" }); refused(ambiguous, "workspace_forbidden");
    expect(JSON.stringify(ambiguous)).not.toContain(FOREIGN);
    persistProjectAliases([{ source: "collision", target: FOREIGN, displayName: "Foreign Canary Board" }]);
    for (const change of ["project", "principal", "membership"] as const) {
      h.atSdkReturn(() => {
        if (change === "project") h.reader.projectOwnership = { project: FOREIGN, source: "operator", setAt: AT, operationId: "fixture-project" };
        if (change === "principal") h.reader.generations[0]!.launchProfile.workspace = { memberId: "m_reader", workspaceId: W2 };
        if (change === "membership") h.moveWorkspace();
      });
      refused(await h.call(tool, { project: OWN }), "workspace_forbidden");
      h.atSdkReturn(() => {}); h.reader.projectOwnership = { project: OWN, source: "operator", setAt: AT, operationId: "fixture-project" };
      h.reader.generations[0]!.launchProfile.workspace = { memberId: "m_reader", workspaceId: W1 };
    }
  });
}

test("pipeline async page yield refuses a designation switch and preserves unchanged pagination", async () => {
  const h = await harness(); h.many();
  const first = await h.call("list_pipelines", { project: OWN, limit: 1 });
  expect(first).toMatchObject({ ok: true, total: 251, hasMore: true });
  if (!first.ok) throw new Error(first.error);
  expect(await h.call("list_pipelines", { project: OWN, limit: 1, cursor: first.nextCursor })).toMatchObject({ ok: true, total: 251 });
  h.onRows(() => { queueMicrotask(() => h.seat(FOREIGN)); });
  refused(await h.call("list_pipelines", { project: OWN, limit: 1 }), "cross_project_refused");
});

function barrier() {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, async wait() { entered(); await held; } };
}

function setBoardAliases(aliases: Record<string, string>) {
  projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), current => ({
    next: { ...current, aliases: { ...current.aliases, ...aliases } }, result: undefined,
  }));
}

const SHORT_ALIAS_SOURCE = "repo-33333333333333333333333333333333";
function setBoardDisplayNames(displayNames: Record<string, string>) {
  projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), current => ({
    next: { ...current, displayNames: { ...current.displayNames, ...displayNames } }, result: undefined,
  }));
}

for (const tool of TOOLS) for (const workspace of [false, true]) {
  test(`${tool}: alias-chain proof allows unrelated alias changes workspace=${workspace}`, async () => {
    const h = await harness(workspace);
    setBoardAliases({ "outer-alias": "middle-alias", "middle-alias": OWN });
    h.atSdkReturn(() => setBoardAliases({ "unrelated-alias": FOREIGN }));
    expect(await h.call(tool, { project: "outer-alias" })).toMatchObject({ ok: true, total: 1 });
  });
  for (const spelling of ["outer-alias", "legacy_board", "repo-33333333", "Historic Board"]) {
    for (const form of ["fresh", "keyed", "replay"] as const) {
      for (const change of ["unchanged", "redirect", "revoke", "rewire"] as const) {
        test(`${tool}: alias-chain SDK return ${spelling} ${form} ${change} workspace=${workspace}`, async () => {
          const h = await harness(workspace);
          setBoardAliases({ "outer-alias": "middle-alias", "middle-alias": OWN, "legacy-board": "middle-alias",
            [SHORT_ALIAS_SOURCE]: "middle-alias", "other-middle": OWN });
          setBoardDisplayNames({ [SHORT_ALIAS_SOURCE]: "Historic Board" });
          const args = { project: spelling, ...(form === "fresh" ? {} : { clientRequestId: `chain-${form}` }) };
          if (form === "replay") expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1 });
          const db = new Database(h.filename);
          try {
            const receiptBytes = () => JSON.stringify(db.query("SELECT * FROM mcp_receipts ORDER BY receipt_key").all());
            const before = receiptBytes(), reads = h.rowReads();
            h.atSdkReturn(() => {
              if (change === "redirect") setBoardAliases({ "middle-alias": FOREIGN });
              if (change === "rewire") setBoardAliases({ "middle-alias": "other-middle" });
              if (change === "revoke") projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), current => {
                const aliases = { ...current.aliases }; delete aliases["middle-alias"];
                return { next: { ...current, aliases }, result: undefined };
              });
            });
            const result = await h.call(tool, args);
            if (change === "unchanged") expect(result).toMatchObject({ ok: true, total: 1, replayed: form === "replay" });
            else {
              refused(result, workspace ? "workspace_forbidden" : "project_scope_refused");
              expect(h.wire()).not.toContain("Own task"); expect(h.wire()).not.toContain("Own lane");
            }
            if (form === "replay") { expect(receiptBytes()).toBe(before); expect(h.rowReads()).toBe(reads); }
            h.atSdkReturn(() => {});
            setBoardAliases({ "middle-alias": OWN });
            h.reopen();
            expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1, replayed: form !== "fresh" });
          } finally { db.close(); }
        });
      }
    }
  }
}

for (const workspace of [false, true]) for (const spelling of ["outer-alias", "legacy_board", "repo-33333333", "Historic Board"]) {
  for (const changed of [false, true]) test(`list_pipelines: alias-chain page await ${spelling} changed=${changed} workspace=${workspace}`, async () => {
    const h = await harness(workspace); h.many();
    setBoardAliases({ "outer-alias": "middle-alias", "middle-alias": OWN, "legacy-board": "middle-alias",
      [SHORT_ALIAS_SOURCE]: "middle-alias" });
    setBoardDisplayNames({ [SHORT_ALIAS_SOURCE]: "Historic Board" });
    const first = await h.call("list_pipelines", { project: spelling, limit: 1 });
    expect(first).toMatchObject({ ok: true, total: 251, hasMore: true });
    h.onRows(() => { queueMicrotask(() => { if (changed) setBoardAliases({ "middle-alias": FOREIGN }); }); });
    const result = await h.call("list_pipelines", { project: spelling, limit: 1 });
    if (changed) refused(result, workspace ? "workspace_forbidden" : "project_scope_refused");
    else expect(result).toMatchObject({ ok: true, total: 251, hasMore: true });
  });
}

for (const tool of TOOLS) for (const workspace of [false, true]) for (const spelling of ["Catalog Widgets", "WidgetsRepo"])
  for (const form of ["fresh", "keyed", "replay"] as const) {
  test(`${tool}: catalog alias source is pinned for ${spelling} ${form} workspace=${workspace}`, async () => {
    const h = await harness(workspace);
    setBoardAliases({ "catalog-repo": "middle-alias", "middle-alias": OWN });
    h.domain.lastCompletedCatalog = () => ({ files: [], projectCatalog: [
      { project: "catalog-repo", displayName: "Catalog Widgets", projectRoot: h.folder, smt: 1, conversations: 1 },
      { project: FOREIGN, displayName: "Foreign Canary Board", projectRoot: path.join(root, "OtherRepo"), smt: 1, conversations: 1 },
    ] });
    const args = { project: spelling, limit: 1, ...(form === "fresh" ? {} : { clientRequestId: `catalog-${form}` }) };
    if (form === "replay") expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1 });
    const db = new Database(h.filename);
    try {
      const receipts = () => JSON.stringify(db.query("SELECT * FROM mcp_receipts ORDER BY receipt_key").all());
      const before = receipts(), reads = h.rowReads();
      const first = await h.call(tool, args);
      expect(first).toMatchObject({ ok: true, total: 1, replayed: form === "replay" });
      if (form === "replay") expect(h.rowReads()).toBe(reads);
      h.atSdkReturn(() => setBoardAliases({ "middle-alias": FOREIGN }));
      refused(await h.call(tool, args), workspace ? "workspace_forbidden" : "project_scope_refused");
      if (form === "replay") expect(receipts()).toBe(before);
    } finally { db.close(); }
  });
}

for (const workspace of [false, true]) for (const spelling of ["Catalog Widgets", "WidgetsRepo"]) {
  test(`list_pipelines: catalog alias source remains pinned after page await for ${spelling} workspace=${workspace}`, async () => {
    const h = await harness(workspace); h.many();
    setBoardAliases({ "catalog-repo": "middle-alias", "middle-alias": OWN });
    h.domain.lastCompletedCatalog = () => ({ files: [], projectCatalog: [
      { project: "catalog-repo", displayName: "Catalog Widgets", projectRoot: h.folder, smt: 1, conversations: 1 },
      { project: FOREIGN, displayName: "Foreign Canary Board", projectRoot: path.join(root, "OtherRepo"), smt: 1, conversations: 1 },
    ] });
    const first = await h.call("list_pipelines", { project: spelling, limit: 1 });
    expect(first).toMatchObject({ ok: true, total: 251, hasMore: true });
    h.onRows(() => queueMicrotask(() => setBoardAliases({ "middle-alias": FOREIGN })));
    refused(await h.call("list_pipelines", { project: spelling, limit: 1 }), workspace ? "workspace_forbidden" : "project_scope_refused");
  });
}

for (const tool of TOOLS) {
  for (const seam of ["authorization", "claim-before", "claim-after", "binding", "completion"] as const) {
    for (const changed of [false, true]) test(`${tool}: ${seam} await ${changed ? "refuses replaced authority" : "allows unchanged authority"}`, async () => {
      const h = await harness(); const gate = barrier();
      if (seam === "authorization") h.bindings[tool].authorizeReceipt = () => gate.wait();
      if (seam === "binding") {
        const read = h.bindings[tool];
        h.bindings[tool] = Object.assign(async (...args: Parameters<typeof read>) => {
          const payload = await read(...args); await gate.wait(); return payload;
        }, read);
      }
      h.useStore({
        async claim(...args) {
          if (seam === "claim-before") await gate.wait();
          const result = h.receipts.claim(...args);
          if (seam === "claim-after") await gate.wait();
          return result;
        },
        async complete(...args) { h.receipts.complete(...args); if (seam === "completion") await gate.wait(); },
      });
      const pending = h.call(tool, { project: OWN, clientRequestId: "held-read" });
      await gate.reached;
      if (changed) h.caller("conversation_replacement");
      gate.release();
      const result = await pending;
      if (changed) refused(result, "project_scope_refused"); else expect(result).toMatchObject({ ok: true, total: 1 });
      if (changed && ["authorization", "claim-before", "claim-after"].includes(seam)) expect(h.rowReads()).toBe(0);
      if (changed && seam === "claim-before") {
        const db = new Database(h.filename);
        try { expect(db.query("SELECT count(*) AS n FROM mcp_receipts").get()).toEqual({ n: 0 }); } finally { db.close(); }
      }
    });
  }

  test(`${tool}: an in-flight duplicate rechecks its own caller after joining`, async () => {
    const h = await harness(); const gate = barrier(), joined = barrier();
    const read = h.bindings[tool]; let authorizations = 0;
    h.bindings[tool] = Object.assign(async (...args: Parameters<typeof read>) => {
      const payload = await read(...args); await gate.wait(); return payload;
    }, read, { authorizeReceipt: async () => { if (++authorizations === 2) await joined.wait(); } });
    const args = { project: OWN, clientRequestId: "joined-read" };
    const first = h.call(tool, args); await gate.reached; const firstReads = h.rowReads();
    const second = h.call(tool, args); await joined.reached; joined.release();
    // Drain admitted microtasks so the duplicate joins the still-held binding.
    await new Promise<void>(resolve => setImmediate(resolve));
    h.caller("conversation_replacement"); gate.release();
    const results = await Promise.all([first, second]);
    for (const result of results) refused(result, "project_scope_refused");
    expect(h.rowReads()).toBe(firstReads);
  });

  test(`${tool}: captures scope before short-id normalization yields`, async () => {
    const h = await harness(); let queued = false;
    const bindings = h.bindings[tool];
    const capture = bindings.captureBoardRead;
    expect(capture).toBeFunction();
    bindings.captureBoardRead = (args, context) => {
      const read = capture!(args, context);
      queueMicrotask(() => { queued = true; h.seat(FOREIGN); });
      return read;
    };
    refused(await h.call(tool, { project: OWN.slice(0, 12) }), "cross_project_refused");
    expect(queued).toBe(true); expect(h.rowReads()).toBe(0);
  });

  for (const workspace of [false, true]) test(`${tool}: actual native hook proof survives SDK await and rejects an ended generation, workspace=${workspace}`, async () => {
    const h = await harness(workspace);
    const transcript = path.join(root, "native-board.jsonl");
    fs.writeFileSync(transcript, "");
    h.domain.attentionAuthority = () => {
      const proof = nativeTranscriptCallProof(process.pid, transcript);
      return proof ? { kind: "worker", conversationId: CALLER, role: "orchestrator", evidence: "native-session", nativeProof: proof }
        : { kind: "unidentified", admission: nativeCallerRefusal("capability-unresolved") };
    };
    for (const ended of [false, true]) {
      recordNativeHook(process.pid, "native-board", transcript, "SessionStart");
      const args = { project: OWN, full: true };
      const { token } = recordNativeHook(process.pid, "native-board", transcript, "PreToolUse", tool, args);
      h.atSdkReturn(() => { if (ended) recordNativeHook(process.pid, "native-board", transcript, "SessionEnd"); });
      const result = await h.call(tool, { ...args, nativeCallerProof: token });
      if (ended) refused(result, workspace ? "workspace_forbidden" : "caller_unidentified"); else expect(result).toMatchObject({ ok: true, total: 1 });
    }
  });

  test(`${tool}: durable seat replacement refuses the predecessor's cached read`, async () => {
    const h = await harness();
    beginOrchestratorSeatIntent({ project: OWN, mandate: "Read board", clientRequestId: "seat-first", mode: "existing", conversationId: CALLER });
    completeOrchestratorSeatIntent({ project: OWN, clientRequestId: "seat-first", conversationId: CALLER, path: null });
    const args = { project: OWN, clientRequestId: "before-revocation" };
    expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1 });
    beginOrchestratorSeatIntent({ project: OWN, mandate: "Read board", clientRequestId: "seat-second", mode: "existing", conversationId: "conversation_successor" });
    completeOrchestratorSeatIntent({ project: OWN, clientRequestId: "seat-second", conversationId: "conversation_successor", path: null });
    refused(await h.call(tool, args), "orchestrator_seat_revoked");
  });

  test(`${tool}: revoked workspace membership refuses cached results after reopening`, async () => {
    const h = await harness(true); const args = { project: OWN, clientRequestId: "member-read" };
    expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1 });
    h.revokeMember();
    refused(await h.call(tool, args), "workspace_forbidden");
    h.reopen(); refused(await h.call(tool, args), "workspace_forbidden");
  });
}

for (const tool of TOOLS) test(`${tool}: direct service rechecks after its page wrapper yields`, async () => {
  const h = await harness();
  const result = await h.service().callTool(tool, { project: OWN, full: true }, {
    assertResult(answer) { if (answer.ok) queueMicrotask(() => h.caller("conversation_replacement")); },
  });
  refused(result, "project_scope_refused");
});

test("direct pipeline reader checks authority after its real page await", async () => {
  const h = await harness(); h.many();
  h.onRows(() => { queueMicrotask(() => h.seat(FOREIGN)); });
  await expect(viewerReadTools(h.domain).list_pipelines({ project: OWN, limit: 1 })).rejects.toMatchObject({ details: { code: "cross_project_refused" } });
});

for (const tool of TOOLS) test(`${tool}: retained selection reads agree cold and warm for key/name/folder`, async () => {
  const h = await harness(); h.indexed();
  const expected = await h.call(tool, { project: OWN });
  expect(expected).toMatchObject({ ok: true, total: 1 });
  for (const project of ["Example Board", "WidgetsRepo", OWN]) expect(await h.call(tool, { project })).toEqual(expected);
});

for (const tool of TOOLS) {
  for (const source of ["admitted", "inherited", "owner-demotion"] as const) {
    for (const form of ["fresh", "keyed", "replay"] as const) test(`${tool}: final workspace ${source} change refuses ${form} disclosure`, async () => {
      const h = await harness(true), store = teamStore();
      delete h.reader.generations[0]!.launchProfile.workspace;
      const parent = "conversation_board_parent";
      if (source === "inherited") {
        h.snapshot.conversations[parent] = { ...structuredClone(h.reader), id: parent };
        h.reader.generations[0]!.launchProfile.parentConversationId = parent;
      }
      if (source === "owner-demotion") store.admitConversationMember(CALLER, "m_owner");
      const mutate = () => {
        if (source === "owner-demotion") {
          const owner = store.member("m_owner");
          if (!owner) throw new Error("owner required");
          store.updateMember({ ...owner, role: "member" });
        } else store.admitConversationMember(source === "inherited" ? parent : CALLER, "m_reader");
      };
      const args = { project: "Foreign Canary Board", ...(form === "fresh" ? {} : { clientRequestId: "principal-read" }) };
      // The unchanged caller can reach the populated foreign board and replay it.
      expect(JSON.stringify(await h.call(tool, form === "keyed" ? { project: args.project } : args))).toContain("FOREIGN_PAYLOAD_CANARY");
      if (form === "replay") expect(await h.call(tool, args)).toMatchObject({ ok: true, replayed: true });
      const db = new Database(h.filename);
      try {
        const receipts = () => db.query("SELECT * FROM mcp_receipts ORDER BY receipt_key").all();
        const before = receipts();
        h.atSdkReturn(mutate);
        refused(await h.call(tool, args), "workspace_forbidden");
        expect(h.wire()).not.toContain("FOREIGN_PAYLOAD_CANARY");
        expect(h.wire()).not.toContain(FOREIGN);
        if (form !== "keyed") expect(receipts()).toEqual(before);
        h.atSdkReturn(() => {});
        h.reopen();
        refused(await h.call(tool, args), "workspace_forbidden");
        if (form !== "keyed") expect(receipts()).toEqual(before);
      } finally { db.close(); }
    });
  }

  for (const resolution of ["unknown", "ambiguous"] as const) {
    for (const change of ["unchanged", "membership", "candidate-project", "caller", "principal", "principal-in-place", "admission"] as const) {
      test(`${tool}: early ${resolution} response checks ${change} at the SDK boundary`, async () => {
        const h = await harness(true), store = teamStore();
        const owner = store.member("m_owner");
        if (!owner) throw new Error("owner required");
        if (change === "admission") delete h.reader.generations[0]!.launchProfile.workspace;
        if (change === "principal-in-place") {
          const reader = store.member("m_reader");
          if (!reader) throw new Error("reader required");
          store.insertMember({ ...reader, id: "m_replacement" });
          store.putWorkspaceMember(W1, "m_replacement", "member", owner.id, AT);
        }
        if (resolution === "ambiguous") {
          placeProject(store, owner, FOREIGN, W1);
          expect(persistProjectAliases([{ source: "same-name", target: FOREIGN, displayName: "Example Board" }])).toBe(true);
          h.domain.authorizedSeats = () => [];
        }
        const args = { project: resolution === "unknown" ? "Example Boar" : "Example Board" };
        const before = await h.call(tool, args);
        refused(before, `${resolution}_project`);
        expect(h.wire()).toContain("Example Board");
        expect(h.wire()).toContain(OWN);
        h.atSdkReturn(() => {
          if (change === "membership") h.revokeMember();
          if (change === "candidate-project") placeProject(store, owner, resolution === "ambiguous" ? FOREIGN : OWN, W2);
          if (change === "caller") h.caller("conversation_replacement");
          if (change === "principal") h.reader.generations[0]!.launchProfile.workspace = { memberId: "m_reader", workspaceId: W2 };
          if (change === "principal-in-place") h.reader.generations[0]!.launchProfile.workspace!.memberId = "m_replacement";
          if (change === "admission") store.admitConversationMember(CALLER, "m_reader");
        });
        const answer = await h.call(tool, args);
        if (change === "unchanged") expect(answer).toEqual(before);
        else {
          refused(answer, "workspace_forbidden");
          for (const privateValue of ["Example Board", OWN, FOREIGN]) expect(h.wire()).not.toContain(privateValue);
          expect(answer).not.toHaveProperty("closeMatches");
          expect(answer).not.toHaveProperty("candidateNames");
        }
        expect(h.rowReads()).toBe(0);
      });
    }
  }
}

test("direct pipeline reader checks an inherited effective principal after the real page await", async () => {
  const h = await harness(true); h.many();
  delete h.reader.generations[0]!.launchProfile.workspace;
  const parent = "conversation_board_parent";
  h.snapshot.conversations[parent] = { ...structuredClone(h.reader), id: parent };
  h.reader.generations[0]!.launchProfile.parentConversationId = parent;
  expect(await viewerReadTools(h.domain).list_pipelines({ project: OWN, limit: 1 })).toMatchObject({ total: 251 });
  h.onRows(() => { queueMicrotask(() => teamStore().admitConversationMember(parent, "m_reader")); });
  await expect(viewerReadTools(h.domain).list_pipelines({ project: OWN, limit: 1 })).rejects.toMatchObject({ details: { code: "project_scope_refused" } });
});

for (const tool of TOOLS) for (const fence of ["direct", "unrestricted", "workspace"] as const) {
  for (const keyed of [false, true]) for (const change of ["unchanged", "revoked", "generation", "epoch"] as const) {
    test(`${tool}: early suggestions retain caller authority fence=${fence} keyed=${keyed} change=${change}`, async () => {
      const h = await harness(fence !== "direct");
      h.mode("manager");
      if (fence === "unrestricted") delete h.reader.generations[0]!.launchProfile.workspace;
      const designate = (key: string, conversationId: string) => {
        beginOrchestratorSeatIntent({ project: OWN, mandate: "Read board", clientRequestId: key, mode: "existing", conversationId });
        completeOrchestratorSeatIntent({ project: OWN, clientRequestId: key, conversationId, path: null });
      };
      designate("first", CALLER);
      h.atSdkReturn(() => {
        if (change === "revoked") designate("second", "conversation_successor");
        if (change === "epoch") designate("second", CALLER);
        if (change === "generation") h.reader.generations[0]!.id = "replacement";
      });
      const answer = await h.call(tool, { project: "Example Boar", ...(keyed ? { clientRequestId: "unknown-read" } : {}) });
      expect(answer.ok).toBe(false);
      if (change === "unchanged") {
        refused(answer, "unknown_project");
        expect(h.wire()).toContain("Example Board");
      } else {
        expect(answer).toMatchObject({ retryable: false });
        for (const value of [OWN, "Example Board"]) expect(h.wire()).not.toContain(value);
        for (const field of ["tasks", "pipelines", "nextCursor"]) expect(answer).not.toHaveProperty(field);
      }
      expect(h.rowReads()).toBe(0);
    });
  }
}

for (const tool of TOOLS) for (const workspace of [false, true]) {
  for (const spelling of ["unchanged", "key", "folder", "root", "alias"] as const) {
    test(`${tool}: equivalent continuation workspace=${workspace} spelling=${spelling}`, async () => {
      const h = await harness(workspace); h.many();
      const own = loadTasks().find(row => row.project === OWN);
      if (!own) throw new Error("own task required");
      saveTasks([...loadTasks(), { ...own, id: "task_another", text: "Second task" }]);
      const first = await h.call(tool, { project: "Example Board", limit: 1 });
      expect(first).toMatchObject({ ok: true, hasMore: true });
      if (!first.ok) throw new Error(first.error);
      const project = { unchanged: "Example Board", key: OWN, folder: "WidgetsRepo", root: h.folder, alias: "legacy-board" }[spelling];
      const second = await h.call(tool, { project, limit: 1, cursor: first.nextCursor });
      expect(second).toMatchObject({ ok: true });
      if (!second.ok) throw new Error(second.error);
      expect(second.cursorReset).not.toBe(true);
      const field = tool === "list_tasks" ? "tasks" : "pipelines";
      expect(second[field]).not.toEqual(first[field]);
      const foreign = await h.call(tool, { project: FOREIGN, limit: 1, cursor: first.nextCursor });
      refused(foreign, workspace ? "workspace_forbidden" : "cross_project_refused");
      setSystemTime(new Date(Date.parse(AT) + 300_001));
      expect(await h.call(tool, { project, limit: 1, cursor: first.nextCursor })).toMatchObject({ ok: true, cursorReset: true, [field]: first[field] });
    });
  }
}

for (const tool of TOOLS) test(`${tool}: serialized operator context cannot bypass native admission or name ambiguity`, async () => {
  const h = await harness();
  h.domain.attentionAuthority = () => ({ kind: "unidentified", admission: nativeCallerRefusal("capability-unresolved") });
  h.domain.callerAttribution = () => ({ kind: "gateway", conversationId: null, role: null });
  refused(await h.call(tool, { project: OWN, operatorBoardProject: OWN }), "caller_unidentified");
  h.domain.attentionAuthority = () => ({ kind: "worker", conversationId: CALLER, role: "orchestrator" });
  persistProjectAliases([{ source: "collision", target: FOREIGN, displayName: OWN }]);
  h.domain.authorizedSeats = () => [];
  refused(await h.call(tool, { project: OWN, operatorBoardProject: OWN }), "ambiguous_project");
});

for (const tool of TOOLS) {
  for (const keyed of [false, true]) test(`${tool}: workspace preserves resolved selection through a canonical-key name collision keyed=${keyed}`, async () => {
    const h = await harness(true); h.domain.authorizedSeats = () => [];
    expect(persistProjectAliases([{ source: "foreign-key-label", target: FOREIGN, displayName: OWN }])).toBe(true);
    const args = keyed ? { clientRequestId: "resolved-board" } : {};
    for (const project of ["Example Board", "WidgetsRepo", h.folder, "legacy-board"]) {
      const answer = await h.call(tool, { ...args, project });
      expect(h.wire()).not.toContain(FOREIGN);
      expect(h.wire()).not.toContain(FOREIGN.slice(0, 13));
      expect(answer).toMatchObject({ ok: true, total: 1 });
    }
    // A genuinely ambiguous wire argument still uses the complete directory.
    refused(await h.call(tool, { ...args, project: OWN, resolvedBoardProject: OWN }), "workspace_forbidden");
    expect(h.wire()).not.toContain(FOREIGN);
  });

  for (const workspace of [false, true]) test(`${tool}: early revoked caller stays terminal before replay workspace=${workspace}`, async () => {
    const h = await harness(true);
    if (!workspace) delete h.reader.generations[0]!.launchProfile.workspace;
    const designate = (key: string, conversationId: string) => {
      beginOrchestratorSeatIntent({ project: OWN, mandate: "Read board", clientRequestId: key, mode: "existing", conversationId });
      completeOrchestratorSeatIntent({ project: OWN, clientRequestId: key, conversationId, path: null });
    };
    designate("first", CALLER);
    const args = { project: OWN, clientRequestId: "read-before-revoke" };
    expect(await h.call(tool, args)).toMatchObject({ ok: true, total: 1 });
    const unknown = `${tool}:unknown-read`;
    h.receipts.claim(unknown, requestDigest(tool, { project: OWN, clientRequestId: "unknown-read" }), "bounded");
    const db = new Database(h.filename);
    try {
      const bytes = () => JSON.stringify(db.query("SELECT * FROM mcp_receipts ORDER BY receipt_key").all());
      const before = bytes(), reads = h.rowReads();
      designate("second", "conversation_successor"); h.mode("agent");
      for (let reopen = 0; reopen < 2; reopen++) {
        for (const clientRequestId of [undefined, "read-before-revoke", "unknown-read"]) {
          refused(await h.call(tool, { project: OWN, ...(clientRequestId ? { clientRequestId } : {}) }), "orchestrator_seat_revoked");
          expect(h.wire()).not.toContain("Own task"); expect(h.wire()).not.toContain("Own lane");
        }
        expect(h.rowReads()).toBe(reads); expect(bytes()).toBe(before); h.reopen();
      }
    } finally { db.close(); }
  });

  test(`${tool}: unavailable workspace authority remains transient`, async () => {
    const h = await harness(true);
    h.domain.attentionAuthority = () => { throw new Error("AUTHORITY_STORE_CANARY"); };
    for (const args of [{}, { clientRequestId: "unavailable-board" }]) {
      expect(await h.call(tool, { ...args, project: OWN })).toMatchObject({ ok: false, code: "workspace_unavailable", retryable: true });
      expect(h.wire()).not.toContain("AUTHORITY_STORE_CANARY");
    }
    expect(h.rowReads()).toBe(0);
  });

  test(`${tool}: unreadable durable revocations retain a retryable authority refusal`, async () => {
    const h = await harness(true);
    expect(await h.call(tool, { project: OWN })).toMatchObject({ ok: true, total: 1 });
    const reads = h.rowReads();
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"), "{");
    for (const args of [{}, { clientRequestId: "unreadable-revocations" }]) {
      expect(await h.call(tool, { ...args, project: OWN })).toMatchObject({ ok: false,
        code: "orchestrator_seat_authority_unavailable", retryable: true,
        details: { code: "orchestrator_seat_authority_unavailable", retryable: true } });
      expect(h.wire()).not.toContain("Own task"); expect(h.wire()).not.toContain("Own lane");
    }
    expect(h.rowReads()).toBe(reads);
  });

  for (const code of ["unknown_project", "ambiguous_project"]) {
    for (const foreign of [false, true]) test(`${tool}: downstream ${code} filters workspace candidates foreign=${foreign}`, async () => {
      const h = await harness(true);
      const names = [{ project: OWN, name: "Example Board" }, ...(foreign ? [{ project: FOREIGN, name: "FOREIGN_LABEL_CANARY" }] : [])];
      const read = h.bindings[tool];
      h.bindings[tool] = Object.assign(async () => {
        throw new McpToolRefusal(names.map(row => `${row.project}: ${row.name}`).join(", "), {
          code, retryable: false, ...(code === "unknown_project" ? { closeMatches: names } : { candidates: names.map(row => row.project), candidateNames: names }),
        });
      }, read);
      for (const full of [false, true]) for (const keyed of [false, true]) {
        const result = await h.call(tool, { project: "Example Board", full, ...(keyed ? { clientRequestId: `downstream-refusal-${full}` } : {}) });
        refused(result, code === "ambiguous_project" && foreign ? "workspace_forbidden" : code);
        for (const value of [FOREIGN, FOREIGN.slice(0, 13), "FOREIGN_LABEL_CANARY"]) expect(h.wire()).not.toContain(value);
        if (!foreign || code === "unknown_project") expect(h.wire()).toContain("Example Board");
      }
    });
  }
}
