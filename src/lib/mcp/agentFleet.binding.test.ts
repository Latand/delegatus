import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { productionLivenessSources, type AgentLivenessSources } from "@/lib/lifecycle/liveness";
import type { FileEntry } from "@/lib/types";
import { viewerMcpBindings, viewerReadTools, type CallerAttribution, type ViewerMcpDomainDependencies } from "./bindings";
import { CompanionBoardReads } from "@/lib/voiceCompanion/boardReads";
import { createCompanionBoardReadPaths } from "@/lib/voiceCompanion/readPaths";
import { createMcpToolService, MemoryMcpReceiptStore, type McpToolResult } from "./server";
import { fleetEntry, fleetRegistry, fleetRow, FLEET_NOW } from "./agentFleet.fixture";
import { retainedTerminatedHost, retainedWriterPathMove } from "@/lib/lifecycle/liveness.retained.fixture";
import { retainedMcpFixture } from "./agentFleet.retained.fixture";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateSandbox, isolatedEnvironment } from "../../../scripts/local-gate";
import { checkEnvironment } from "../../../scripts/gate-cache";

for (const tool of ["agent_fleet", "agent_activity"] as const) {
  test(`retained registry: HTTP SDK ${tool} shares its real deadline with blocked subprocess preparation`, async () => {
    const root = createGateSandbox();
    directories.push(root);
    const messages = new Map<string, (value: Record<string, unknown>) => void>();
    const message = (kind: string) => new Promise<Record<string, unknown>>(resolve => { messages.set(kind, resolve); });
    const ready = message("ready");
    const script = `
      import fs from "node:fs";
      import { retainedMcpFixture } from ${JSON.stringify(path.join(import.meta.dir, "agentFleet.retained.fixture.ts"))};
      import { loadPipelines, savePipelines } from "@/lib/pipelines/store";
      const fixture = retainedMcpFixture();
      const { f } = fixture;
      const select = f.sources.selectInventory;
      let armed = false;
      f.sources.selectInventory = async (...args) => {
        const result = await select(...args);
        if (armed) {
          armed = false;
          f.pipeline.runs[0].attempts[0].state = "passed";
          f.pipeline.state = "completed";
          f.pipeline.cursor = null;
          savePipelines(loadPipelines().map(row => row.id === f.pipeline.id ? f.pipeline : row));
          process.send({ kind: "preparing" });
          // Block the serving event loop until the independent caller releases it.
          const byte = Buffer.alloc(1);
          if (fs.readSync(0, byte, 0, 1, null) !== 1) throw new Error("preparation barrier closed");
          process.send({ kind: "released" });
        }
        return result;
      };
      process.on("message", message => {
        if (message === "arm") { armed = true; process.send({ kind: "armed" }); }
        if (message === "stop") { fixture.close(); process.disconnect(); }
      });
      process.send({ kind: "ready", url: fixture.listener.url.href, capability: fixture.capability });
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: isolatedEnvironment(root, checkEnvironment(process.env)),
      stdin: "pipe", stdout: "ignore", stderr: "pipe",
      ipc(value) { const data = value as Record<string, unknown>; messages.get(String(data.kind))?.(data); },
    });
    const stderr = new Response(child.stderr).text();
    const client = new Client({ name: "retained-deadline", version: "1" });
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    const deadline = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill(9);
        reject(new Error("retained deadline subprocess watchdog expired"));
      }, 15_000);
    });
    const within = <T,>(work: Promise<T>) => Promise.race([work, deadline]);
    try {
      const config = await within(Promise.race([ready, child.exited.then(async exit => {
        throw new Error(`fixture exited ${exit}: ${await stderr}`);
      })]));
      await within(client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", String(config.url)), {
        requestInit: { headers: { "x-llv-spawn-capability": String(config.capability) } },
      })));
      const call = (key: string) => client.callTool({ name: tool,
        arguments: { liveOnly: true, compact: false, limit: 200, clientRequestId: key } });
      const current = await within(call("subprocess-current"));
      expect(current.isError).not.toBe(true);
      expect(current.structuredContent).toMatchObject(tool === "agent_activity"
        ? { ok: true, selection: { unreadable: 0, budget: "complete" }, conversations: [{ verified: true }] }
        : { ok: true, agents: { live: 1 } });
      const armed = message("armed"); child.send("arm"); await within(armed);
      const preparing = message("preparing");
      const released = message("released");
      let settled = false;
      const pending = call("subprocess-expired").finally(() => { settled = true; });
      await within(preparing);
      // The parent clock and timer continue while the serving process is blocked.
      await within(new Promise<void>(resolve => { releaseTimer = setTimeout(resolve, 900); }));
      expect(settled).toBe(false);
      child.stdin.write("r"); child.stdin.flush();
      await within(released);
      const refused = await within(pending);
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ ok: false, code: "tool_failed", retryable: true });
      expect(JSON.stringify(refused.structuredContent)).toContain("history projection preparation exceeded its deadline");
      const guard = spawnSync("python3", ["-c",
        "import json,runpy,sys; runpy.run_path('scripts/deploy-checkout.py')['complete_activity'](json.load(sys.stdin))"],
      { input: JSON.stringify(refused.structuredContent), encoding: "utf8", timeout: 10_000 });
      expect(guard.status).not.toBe(0);
      const retry = await within(call("subprocess-retry"));
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent).toMatchObject({ ok: true });
      await within(client.close());
      child.send("stop");
      expect(await within(child.exited)).toBe(0);
      expect(watchdogFired).toBe(false);
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer);
      if (watchdog) clearTimeout(watchdog);
      if (child.exitCode === null) child.kill(9);
      await child.exited;
      await client.close();
      console.log(JSON.stringify({ deadlineFixture: tool, pid: child.pid, exit: child.exitCode,
        reaped: true, watchdogFired, stderr: await stderr }));
    }
  }, 25_000);
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

for (const tool of ["agent_fleet", "agent_activity"] as const) {
  test(`retained registry: HTTP SDK ${tool} excludes terminated hosts and retains requested exit evidence`, async () => {
    const { f, capability, listener, close } = retainedMcpFixture();
    const client = new Client({ name: "retained-terminal", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
        requestInit: { headers: { "x-llv-spawn-capability": capability } },
      }));
      let sequence = 0;
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: tool, arguments: {
          liveOnly: true, compact: false, limit: 200, ...args, clientRequestId: `terminal-${sequence++}`,
        } });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true });
        return result.structuredContent;
      };
      // The same route and filter must admit the live owner before termination.
      expect(await call({})).toMatchObject(tool === "agent_activity"
        ? { count: 1, conversations: [{ host: { state: "alive" } }] } : { agents: { live: 1 } });
      const exits = retainedTerminatedHost(f);
      f.payloadReads.clear();
      for (const args of [{}, { conversationId: f.conversationId }, ...(tool === "agent_activity" ? [{ transcriptPath: f.worker.transcript }] : [])]) {
        const filtered = await call(args);
        if (tool === "agent_activity") {
          expect(filtered).toMatchObject({ count: 0, conversations: [], excludedGoneCount: 1,
            selection: { budget: "complete", unreadable: 0, projected: 0 } });
          expect(await call({ ...args, includeGone: true })).toMatchObject({ count: 1,
            conversations: [{ conversationId: f.conversationId, host: { state: "gone" }, ...exits }] });
        } else expect(filtered).toMatchObject("conversationId" in args
          ? { summary: { agents: { live: 0 } }, agents: [] } : { agents: { live: 0 } });
      }
      expect(f.payloadReads.get("entries") ?? 0).toBeLessThanOrEqual(16);
      expect(f.payloadReads.get("conversations") ?? 0).toBeLessThanOrEqual(16);
    } finally { await client.close(); close(); }
  });
}

for (const tool of ["agent_fleet", "agent_activity"] as const) {
  test(`retained registry: HTTP SDK ${tool} returns actual coverage across peer path replacement`, async () => {
    const { f, capability, listener, close } = retainedMcpFixture();
    const client = new Client({ name: "retained-liveness", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
        requestInit: { headers: { "x-llv-spawn-capability": capability } },
      }));
      const args = { liveOnly: true, compact: false, limit: 200 };
      const call = async (key: string) => {
        const response = await client.callTool({ name: tool, arguments: { ...args, clientRequestId: key } });
        return { response, answer: response.structuredContent as McpToolResult };
      };
      f.payloadReads.clear();
      const current = await call("retained-current");
      expect(current.response.isError).not.toBe(true);
      expect(current.answer.ok).toBe(true);
      if (!current.answer.ok) throw new Error("expected current coverage");
      if (tool === "agent_activity") {
        expect(current.answer).toMatchObject({ unselectedCount: 0, selection: { matched: 1, selected: 1,
          cacheStatus: "hit", projected: 0, unreadable: 0, recoveryPending: 0, recoveryTruncated: false },
          conversations: [{ conversationId: f.conversationId, evidenceSource: "transcript" }] });
        expect(current.answer).not.toHaveProperty("evidence");
      } else {
        expect(current.answer).toMatchObject({ agents: { live: 1 } });
        expect(current.answer.coverage ?? {}).toEqual({});
      }
      expect(f.payloadReads.get("conversations") ?? 0).toBeLessThanOrEqual(12);
      expect(f.payloadReads.get("entries") ?? 0).toBeLessThanOrEqual(12);
      expect((await call("retained-current")).answer).toMatchObject({ replayed: true });

      const deployAccepts = (answer: McpToolResult) => spawnSync("python3", ["-c",
        "import json,runpy,sys; runpy.run_path('scripts/deploy-checkout.py')['complete_activity'](json.load(sys.stdin))"],
      { input: JSON.stringify(answer), encoding: "utf8", timeout: 10_000 }).status === 0;
      if (tool === "agent_activity") expect(deployAccepts(current.answer)).toBe(true);

      f.setCacheStatus("stale");
      const stale = (await call("retained-stale")).answer;
      if (tool === "agent_activity") {
        expect(stale).toMatchObject({ catalog: "stale", selection: { cacheStatus: "stale" } });
        expect(deployAccepts(stale)).toBe(false);
      }
      else expect(stale).toMatchObject({ coverage: { catalog: "stale" } });

      f.setCacheStatus("hit");
      const selectCurrent = f.sources.selectInventory;
      const generation = await f.completedFileScan();
      let releaseGeneration!: (value: typeof generation) => void;
      const heldGeneration = new Promise<typeof generation>(resolve => { releaseGeneration = resolve; });
      f.sources.selectInventory = productionLivenessSources({ completedFileScan: () => heldGeneration, catalogBudgetMs: 0 }).selectInventory;
      try {
        const pending = (await call("retained-pending")).answer;
        if (tool === "agent_activity") {
          expect(pending).toMatchObject({ catalog: "pending", selection: { cacheStatus: "pending" } });
          expect(deployAccepts(pending)).toBe(false);
        } else expect(pending).toMatchObject({ coverage: { catalog: "pending" } });
      } finally { releaseGeneration(generation); f.sources.selectInventory = selectCurrent; }
      const evidence = f.sources.transcriptEvidence;
      f.sources.transcriptEvidence = async () => null;
      const partial = (await call("retained-unverified")).answer;
      if (tool === "agent_activity") {
        expect(partial).toMatchObject({ selection: { unreadable: 1 },
          conversations: [{ verified: false, evidenceSource: "unreadable" }] });
        expect(deployAccepts(partial)).toBe(false);
      } else expect(partial).toMatchObject({ coverage: { evidence: "pending", unverifiedCount: 1 } });
      f.sources.transcriptEvidence = evidence;

      const move = retainedWriterPathMove(f, true);
      const held = (await call("retained-peer-path")).answer;
      expect(move.changed()).toBe(true);
      if (tool === "agent_activity") {
        expect(held).toMatchObject({ selection: { unreadable: 1 },
          conversations: [{ verified: false, evidenceSource: "unreadable" }] });
        expect(deployAccepts(held)).toBe(false);
      } else expect(held).toMatchObject({ coverage: { evidence: "pending", unverifiedCount: 1 } });
      const fresh = (await call("retained-peer-fresh")).answer;
      if (tool === "agent_activity") {
        expect(fresh).toMatchObject({ selection: { unreadable: 0 }, conversations: [{ verified: true }] });
        expect(deployAccepts(fresh), JSON.stringify(fresh)).toBe(true);
      } else expect(fresh).toMatchObject({ agents: { live: 1 } });
    } finally {
      await client.close(); close();
    }
  });
}

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
