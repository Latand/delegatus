import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";
import type { FileEntry } from "@/lib/types";
import { viewerMcpBindings, viewerReadTools, type CallerAttribution, type ViewerMcpDomainDependencies } from "./bindings";
import { CompanionBoardReads } from "@/lib/voiceCompanion/boardReads";
import { createCompanionBoardReadPaths } from "@/lib/voiceCompanion/readPaths";
import { createMcpToolService, MemoryMcpReceiptStore } from "./server";
import { fleetEntry, fleetRegistry, fleetRow, FLEET_NOW } from "./agentFleet.fixture";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(count = 2) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-binding-")); directories.push(directory);
  const rows = Array.from({ length: count }, (_, i) => fleetRow(`fixture_${i}`, { project: i % 2 ? "project-two" : "project-one", host: { state: "alive", kind: "structured", pid: 100 + i } }));
  const registry = { ...new AgentRegistry(path.join(directory, "registry.json")).readOnlySnapshot(), ...fleetRegistry(rows) };
  for (const row of rows) registry.conversations[row.conversationId!] = {
    id: row.conversationId!, engine: row.engine, projectOwnership: { project: row.project }, continuityPaths: [], abandonedContinuityPaths: [],
    providerForkPaths: [], supersededBy: null,
    generations: [{ id: row.conversationId!, path: row.transcriptPath, accountId: "account-one", launchProfile: emptyLaunchProfile(),
      createdAt: new Date(FLEET_NOW).toISOString(), archivedAt: null, historyHash: null, host: null }],
  } as never;
  let caller: CallerAttribution = { kind: "gateway", conversationId: null, role: null }, journaled = 0, resourceReads = 0;
  const files = rows.map(row => ({ path: row.transcriptPath, conversationId: row.conversationId, project: row.project, engine: row.engine,
    title: row.title, mtime: FLEET_NOW / 1000, activity: "live", proc: "running", pid: row.host.pid, kind: "session", size: 1, root: "claude", fmt: "jsonl" })) as unknown as FileEntry[];
  const sources: AgentLivenessSources = { now: () => FLEET_NOW, listFiles: async () => files,
    registrySnapshot: () => registry, pipelines: () => [], describeTranscript: async selected => { const file = files.find(file => file.path === selected); return file ? { ...file, transcriptPath: file.path } as never : null; },
    transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: FLEET_NOW }), transcriptIdentity: async () => "fixture",
    probe: { now: () => FLEET_NOW, pidAlive: () => true, processIdentity: () => "fixture-start" }, readHostTurnRecord: () => ({ state: "absent" }) };
  const dependencies = {
    registrySnapshot: () => registry, callerAttribution: () => caller,
    authorizedSeats: () => [{ conversationId: rows[0].conversationId!, project: "project-one", path: null }],
    livenessSources: () => sources, listPipelineRecords: () => [],
    readFleetSessions: () => { resourceReads++; return { sessions: [], stale: false }; },
    refreshLifecycleJournal: () => { journaled++; throw new Error("Fleet must never journal"); },
    accountLimitsSource: () => ({ accounts: { claude: [], codex: [], copilot: [] }, active: { claude: null, codex: null, copilot: null },
      observations: { claude: {}, codex: {}, copilot: {} }, now: FLEET_NOW }),
  } as unknown as ViewerMcpDomainDependencies;
  const call = (args: Record<string, unknown> = {}, context = {}) => viewerReadTools(dependencies).agent_fleet(args, context);
  return { call, rows, files, registry, sources, dependencies, directory, setCaller: (value: CallerAttribution) => { caller = value; },
    journaled: () => journaled, resourceReads: () => resourceReads };
}

test("operator root sees both projects and can narrow; the read journals nothing", async () => {
  const f = fixture();
  expect(await f.call()).toMatchObject({ scope: "all", agents: { live: 2, running: 2 } });
  expect(await f.call({ project: "project-one" })).toMatchObject({ scope: { project: "project-one" }, agents: { live: 1 } });
  expect(await f.call({ detail: true })).toMatchObject({ agents: [{ project: "project-one" }, { project: "project-two" }] });
  expect(f.journaled()).toBe(0);
  expect(f.resourceReads()).toBe(1);
});

for (const kind of ["manager", "agent"] as const) test(`${kind} sees only its recorded project and refuses other projects`, async () => {
  const f = fixture(); f.setCaller({ kind, conversationId: f.rows[0].conversationId, role: "builder" });
  expect(await f.call()).toMatchObject({ scope: { project: "project-one" }, agents: { live: 1 } });
  await expect(f.call({ project: "project-two" })).rejects.toThrow("project_out_of_scope");
  expect(f.resourceReads()).toBe(0);
});

test("deputy attribution uses its seat's project and unidentified callers must specify one", async () => {
  const f = fixture();
  f.setCaller({ kind: "manager", conversationId: f.rows[0].conversationId, role: "orchestrator", via: { deputy: "conversation_deputy" } });
  expect(await f.call()).toMatchObject({ scope: { project: "project-one" }, agents: { live: 1 } });
  f.setCaller({ kind: "unidentified", conversationId: null, role: null });
  await expect(f.call()).rejects.toThrow("project_required");
  expect(await f.call({ project: "project-two" })).toMatchObject({ scope: { project: "project-two" }, agents: { live: 1 } });
  f.setCaller({ kind: "agent", conversationId: "conversation_missing", role: "builder" });
  await expect(f.call({ project: "project-two" })).rejects.toThrow("project_out_of_scope");
});

test("detail filters imply rows, redact before title clipping, and reveal no paths or messages", async () => {
  const f = fixture();
  const secret = "private-".repeat(20);
  f.files[0].title = secret + " Safe title";
  const answer = await f.call({ conversationId: f.rows[0].conversationId }, { redactText: (value: string) => value.replace(secret, "[redacted]") });
  expect(answer).toMatchObject({ summary: { agents: { live: 1 } }, agents: [{ title: "[redacted] Safe title", account: "account-one", model: "opus", effort: "high" }] });
  const encoded = JSON.stringify(answer);
  expect(encoded).not.toContain(secret.slice(0, 30));
  for (const field of ["transcriptPath", "cwd", "records", "message"]) expect(encoded).not.toContain(`"${field}"`);
});

test("fleet reads do not materialize archived registry history on initial or repeated reads", async () => {
  const f = fixture();
  const sqlitePath = path.join(f.directory, "fleet.sqlite");
  const initial = structuredClone(f.registry);
  for (let i = 0; i < 200; i++) {
    const row = fleetRow(`archived_${i}`, { lifecycle: "gone", host: { state: "gone", kind: "none", pid: null } });
    initial.entries[row.transcriptPath] = fleetEntry(row, { status: "dead", host: null, structuredHost: null,
      claimOwner: null, pendingAction: null });
  }
  const payloadReads = new Map<string, number>();
  const store = new SqliteAgentRegistryStore(sqlitePath, { initialSnapshot: initial, normalize: normalizeRegistry,
    onRowPayloadRead: (collection, count) => payloadReads.set(collection, (payloadReads.get(collection) ?? 0) + count) });
  try {
    expect(store.archiveInactive(1000)).toBeGreaterThanOrEqual(200);
    store.readOnlySnapshot(); // Warm the lazy registry projection before measuring tool work.
    const registrySnapshot = () => store.readOnlySnapshot().file;
    f.sources.registrySnapshot = registrySnapshot;
    f.dependencies.registrySnapshot = registrySnapshot;
    payloadReads.clear();

    const boundedReads = () => (payloadReads.get("entries") ?? 0) + (payloadReads.get("receipts") ?? 0);
    expect(await f.call()).toMatchObject({ agents: { live: 2, running: 2 } });
    expect(boundedReads()).toBeLessThanOrEqual(6);
    expect(await f.call({ detail: true })).toMatchObject({ agents: [
      { turn: "running" }, { turn: "running" },
    ] });
    payloadReads.clear();
    expect(await f.call()).toMatchObject({ agents: { live: 2, running: 2 } });
    expect(boundedReads()).toBeLessThanOrEqual(6);
  } finally { store.close(); }
});

test("fleet binding resolves aliases before durable generation fallback", async () => {
  const f = fixture(1);
  const oldId = f.rows[0].conversationId!;
  const currentId = "conversation_current";
  f.registry.entries[f.rows[0].transcriptPath].accountId = null;
  f.registry.entries[f.rows[0].transcriptPath].launchProfile = undefined;
  f.registry.conversationAliases[oldId] = currentId as never;
  f.registry.conversations = { [currentId]: { id: currentId, engine: "claude", continuityPaths: [], generations: [
    { id: currentId, accountId: "generation-account", launchProfile: emptyLaunchProfile({ model: "generation-model", effort: "high" }) },
  ] } as never };
  expect(await f.call({ detail: true })).toMatchObject({ agents: [{ conversationId: oldId, account: "generation-account", model: "generation-model", effort: "high" }] });
});

test("detail paging stays within 24 KB, covers every selected agent and binds scope on every continuation", async () => {
  const f = fixture(200);
  const ids: unknown[] = [];
  let cursor: unknown;
  let firstCursor: unknown;
  do {
    const answer = await f.call({ detail: true, limit: 200, ...(cursor ? { cursor } : {}) });
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(24_000);
    expect(answer).toMatchObject({ summary: { agents: { live: 200 } } });
    const agents = answer.agents as Record<string, unknown>[];
    ids.push(...agents.map(row => row.conversationId)); cursor = answer.nextCursor;
    firstCursor ??= cursor;
  } while (cursor);
  expect(ids).toHaveLength(200); expect(new Set(ids).size).toBe(200);
  expect(f.resourceReads()).toBe(1);
  f.setCaller({ kind: "agent", conversationId: f.rows[0].conversationId, role: "builder" });
  await expect(f.call({ detail: true, limit: 200, cursor: firstCursor })).rejects.toThrow("filters changed");
  await expect(f.call({ detail: true, limit: 200, cursor: firstCursor, project: "project-two" })).rejects.toThrow("project_out_of_scope");
});

test("partial inventory and pending evidence are declared and an injected source cannot widen a project", async () => {
  const f = fixture();
  f.sources.selectInventory = async () => ({ entries: f.files, scanned: 220, matched: 220, generation: 1,
    cacheStatus: "stale", freshScan: false, hostedSeen: new Set(f.files.map(row => row.path)) }) as never;
  f.setCaller({ kind: "manager", conversationId: f.rows[0].conversationId, role: "orchestrator" });
  expect(await f.call()).toMatchObject({ agents: { live: 1 }, coverage: { catalog: "stale", unselectedCount: 218 } });
});

test("voice detail budget remains bounded and held pages reject a changed redaction context", async () => {
  const f = fixture(20); f.dependencies.fleetDetailBudgetBytes = 3200;
  const redactText = (value: string) => value;
  const answer = await f.call({ detail: true, limit: 20 }, { redactText });
  expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(3200);
  expect(answer.nextCursor).toBeString();
  await expect(f.call({ detail: true, limit: 20, cursor: answer.nextCursor }, { redactText: (value: string) => value })).rejects.toThrow("filters changed");
});


test("receipt replay is scoped to the current caller and rechecks its project before disclosing an answer", async () => {
  const f = fixture();
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, f.dependencies), new MemoryMcpReceiptStore());
  const args = { clientRequestId: "fleet-replay-one" };
  expect(await service.callTool("agent_fleet", args)).toMatchObject({ ok: true, scope: "all", agents: { live: 2 } });
  f.setCaller({ kind: "agent", conversationId: f.rows[0].conversationId, role: "builder" });
  expect(await service.callTool("agent_fleet", args)).toMatchObject({ ok: true, scope: { project: "project-one" }, agents: { live: 1 }, replayed: false });
  expect(await service.callTool("agent_fleet", args)).toMatchObject({ ok: true, agents: { live: 1 }, replayed: true });
  f.setCaller({ kind: "gateway", conversationId: null, role: null });
  const narrowed = { clientRequestId: "fleet-replay-two", project: "project-two" };
  expect(await service.callTool("agent_fleet", narrowed)).toMatchObject({ ok: true, agents: { live: 1 } });
  f.setCaller({ kind: "agent", conversationId: f.rows[0].conversationId, role: "builder" });
  expect(await service.callTool("agent_fleet", narrowed)).toMatchObject({ ok: false, error: expect.stringContaining("project_out_of_scope") });
});


test("the real voice adapter retains its project and bounded detail cursor across reads", async () => {
  const f = fixture(40);
  const paths = createCompanionBoardReadPaths({domain:f.dependencies});
  const reads = new CompanionBoardReads({...paths, resolveProject: (current, requested) => {
    if (!current || requested && requested !== current) throw new Error("PROJECT_REFUSED"); return current;
  }});
  const compact = await reads.call("project-one", "agent_fleet", {});
  expect(compact.item).toMatchObject({scope:{project:"project-one"},agents:{live:20}});
  const ids: unknown[] = []; let cursor: string | null | undefined;
  do {
    const answer = await reads.call("project-one", "agent_fleet", {detail:true,...(cursor?{cursor}:{})});
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(4000);
    const rows = answer.rows as Record<string,unknown>[]; ids.push(...rows.map(row=>row.conversationId)); cursor=answer.nextCursor;
  } while(cursor);
  expect(ids).toHaveLength(20); expect(new Set(ids).size).toBe(20);
});
