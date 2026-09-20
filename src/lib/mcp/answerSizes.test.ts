import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set roots before importing the service: even a refused call must be isolated.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sizes-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  process.env[key] = path.join(sandbox, key);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent-control.sock");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const bindingModule = process.env.MCP_SIZE_BINDINGS ?? "./bindings";
const { viewerMcpBindings } = await import(bindingModule);
const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("./server");
const { saveTasks, loadTasks, loadTasksForList, taskSelectionSource, mutateTasks } = await import("@/lib/tasks/store");
const { savePipelines, pipelineSelectionSource } = await import("@/lib/pipelines/store");
const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { defaultSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
type Args = Record<string, unknown>;

test("measure every tool through the MCP service and budget common board answers", async () => {
  const now = Date.parse("2026-09-20T09:00:00.000Z");
  const pipelines = pipelineCorpus(240, 2);
  for (const [i, pipeline] of pipelines.entries()) {
    pipeline.project = "size-board";
    pipeline.createdAt = new Date(now + i * 1000).toISOString();
    pipeline.state = i % 3 === 0 ? "running" : "completed";
    pipeline.taskIds = [`task-${i}`];
    pipeline.srcConversationId = `conversation-${i}`;
  }
  savePipelines(pipelines.map(pipeline => pipeline.state === "completed" ? { ...pipeline, cursor: null } : pipeline));
  saveTasks(Array.from({ length: 240 }, (_, i) => ({
    id: `task-${i}`, project: "size-board", text: `Board work ${i}\n${"Outcome and acceptance. ".repeat(25)}`,
    details: "Implementation context. ".repeat(300), status: i % 3 === 0 ? "assigned" : "done",
    placement: "unplaced", board: "hidden", createdAt: new Date(now + i * 1000).toISOString(),
    updatedAt: new Date(now + i * 1000).toISOString(),
    assignments: Array.from({ length: 8 }, (_, j) => ({ path: `sessions/agent-${i}-${j}.jsonl`, conversationId: `conversation-${i}-${j}`, panePid: null, state: "linked", error: null, at: new Date(now).toISOString() })),
  })) as never);
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: path.join(sandbox, `agent-${i}.jsonl`), conversationId: `conversation-${i}`, project: "size-board",
    engine: "codex", title: `Board worker ${i}`, kind: "session", root: "codex", name: `agent-${i}`,
    fmt: "jsonl", parent: null, mtime: (now - i * 86400000) / 1000, size: 1024,
    activity: "live", proc: null, pid: null,
  }));
  let settings = { ...defaultSeatTickSettings("size-board"), monitorPrompt: "Monitor open work. ".repeat(200) };
  const domain = {
    taskSelectionSource, pipelineSelectionSource,
    loadTasks, listTaskRecords: loadTasksForList, getPipelines: () => ({ pipelines }), listPipelineRecords: () => pipelines,
    getFlowsWithPresets: () => ({ flows: [], presets: [] }),
    callerAttribution: () => ({ kind: "unidentified", conversationId: null }),
    authorizedSeats: () => [], callerProject: () => null,
    readTickSettings: () => settings, writeTickSettings: (_project: string, value: typeof settings) => { settings = value; },
    patchPipeline: async () => ({ pipeline: pipelines[0] }),
    refreshLifecycleJournal: () => ({ appended: 0 }),
    livenessSources: () => ({
      now: () => now, probe: { now: () => now, pidAlive: () => false, processIdentity: () => null },
      registrySnapshot: () => ({ entries: {}, conversations: {} }), pipelines: () => [],
      listFiles: async () => files, describeTranscript: async () => null,
      transcriptEvidence: async () => ({ turn: "idle", lastRecordTs: now - 86400000, providerProgressAt: null }),
    }),
  };
  const bindings = viewerMcpBindings({ getPipelines: () => ({ pipelines }), mutateTasks, isoNow: () => new Date(now).toISOString() }, {
    get: async (url: string) => {
      if (!url.startsWith("/api/conversations?")) throw new Error("No external control fixture for this read");
      const params = new URL(url, "http://fixture").searchParams;
      return { items: files.slice(0, Number(params.get("limit") ?? 50)), total: files.length, nextCursor: "fixture-next" };
    },
    post: async () => { throw new Error("External control actions are unavailable in the isolated census"); },
  } as never, domain as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const cases: Array<[typeof MCP_TOOL_NAMES[number], string, Args]> = [
    ["list_tasks", "default", { project: "size-board" }],
    ["list_tasks", "limit=200", { project: "size-board", limit: 200 }],
    ["list_tasks", "openOnly", { project: "size-board", openOnly: true }],
    ["list_pipelines", "default", { project: "size-board" }],
    ["list_pipelines", "completed,limit=200", { project: "size-board", state: "completed", limit: 200 }],
    ["list_pipelines", "open,compact", { project: "size-board", state: "open", compact: true }],
    ["agent_activity", "liveOnly,compact", { project: "size-board", liveOnly: true, compact: true }],
    ["agent_activity", "default", { project: "size-board" }],
    ["create_task", "details", { project: "size-board", text: "New board work", details: "Context. ".repeat(600), board: "hidden" }],
    ["update_task", "status", { taskId: "task-0", status: "blocked" }],
    ["get_task", "default", { taskId: "task-0" }],
    ["get_pipeline", "default", { pipelineId: pipelines[0]!.id }],
    ["get_pipeline", "stageId", { pipelineId: pipelines[0]!.id, stageId: "build" }],
    ["get_pipeline", "compact", { pipelineId: pipelines[0]!.id, compact: true }],
    ["pipeline_action", "link-task", { pipelineId: pipelines[0]!.id, action: "link-task", taskId: "task-0" }],
    ["pipeline_action", "unlink-task", { pipelineId: pipelines[0]!.id, action: "unlink-task", taskId: "task-0" }],
    ["seat_tick_settings", "write-note", { project: "size-board", monitorPrompt: settings.monitorPrompt }],
    ["seat_tick_settings", "read", { project: "size-board" }],
    ["list_conversations", "default", { project: "size-board" }],
    ["link_task_to_pipeline", "assignment", { taskId: "task-1", pipelineId: pipelines[0]!.id }],
  ];
  const covered = new Set(cases.map(([tool]) => tool));
  for (const tool of MCP_TOOL_NAMES) if (!covered.has(tool)) cases.push([tool, "unconfigured census", {}]);
  const rows = [];
  const frequencySample = JSON.parse(fs.readFileSync(new URL("./answerSizes.frequency.json", import.meta.url), "utf8")) as { counts: Record<string, number>; scenarioCounts: Record<string, number> };
  const frequencies = frequencySample.counts;
  const budgets: Record<string, number> = { list_tasks: 26000, list_pipelines: 26000, agent_activity: 24000, create_task: 2000, update_task: 1200, get_task: 10000, get_pipeline: 150000, link_task_to_pipeline: 1800, pipeline_action: 1500, seat_tick_settings: 1800, list_conversations: 12000 };
  for (const [tool, scenario, args] of cases) {
    const result = await service.callTool(tool, { clientRequestId: `size-${rows.length}`, ...args });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const scenarioCalls = frequencySample.scenarioCounts[`${tool}|${scenario}`] ?? 0;
    rows.push({ tool, scenario, outcome: result.ok ? "success" : "refusal", bytes, observedCalls: frequencies[tool] ?? 0, observedScenarioCalls: scenarioCalls, weightedBytes: result.ok ? bytes * scenarioCalls : null });
    if (!process.env.MCP_SIZE_BASELINE && scenario === "unconfigured census") expect(bytes, `${tool} census response budget`).toBeLessThan(3000);
    if (scenario !== "unconfigured census") {
      expect(result.ok, `${tool}: ${JSON.stringify(result)}`).toBe(true);
      if (!process.env.MCP_SIZE_BASELINE) expect(bytes, `${tool} ${scenario} exceeded its default answer budget`).toBeLessThanOrEqual(budgets[tool]!);
    }
  }
  // Frequencies come from a bounded manager transcript sample; each scenario has its own matched call count.
  console.log(rows.map(row => `${row.tool} [${row.scenario}]: ${row.bytes} bytes (${row.outcome})`).join("\n"));
  if (process.env.MCP_SIZE_OUTPUT) fs.writeFileSync(process.env.MCP_SIZE_OUTPUT, "[\n" + rows.map(row => "  " + JSON.stringify(row)).join(",\n") + "\n]\n");
  expect(new Set(rows.map(row => row.tool)).size).toBe(MCP_TOOL_NAMES.length);

  if (process.env.MCP_SIZE_BASELINE) return;
  let sequence = 0;
  const call = (tool: typeof MCP_TOOL_NAMES[number], args: Args = {}) => service.callTool(tool, { clientRequestId: `behavior-${++sequence}`, ...args }) as Promise<any>;
  const first = await call("list_tasks", { project: "size-board", limit: 200 });
  expect(first.hasMore).toBe(true);
  // Updating task-0 above makes it the newest old task, regardless of creation order.
  expect(first.tasks.slice(0, 2).map((task: any) => task.id)).toContain("task-0");
  expect(first.tasks[0]).not.toHaveProperty("assignments");
  expect(first.tasks[0]).not.toHaveProperty("details");
  const ids = first.tasks.map((task: any) => task.id);
  let cursor = first.nextCursor;
  for (let page = 0; cursor && page < 30; page++) {
    const next = await call("list_tasks", { project: "size-board", cursor, limit: 200 });
    ids.push(...next.tasks.map((task: any) => task.id));
    cursor = next.nextCursor;
  }
  expect(cursor).toBeNull();
  expect(new Set(ids).size).toBe(241);
  expect(ids.length).toBe(241);
  const filtered = await call("list_tasks", { project: "size-board", status: ["done", "unknown"], ids: ["task-239", "task-238", "task-0"], query: "board work", updatedSince: new Date(now + 238000).toISOString() });
  expect(filtered.tasks.map((task: any) => task.id)).toEqual(["task-239", "task-238"]);
  const wrongCursor = await call("list_tasks", { project: "size-board", cursor: first.nextCursor, openOnly: true });
  expect(wrongCursor.cursorReset).toBe(true);
  expect(wrongCursor.tasks.every((task: any) => task.status !== "done")).toBe(true);
  const unclamped = await call("list_tasks", { project: "size-board", status: "unknown", placement: "unknown", limit: "999999", updatedSince: "nonsense" });
  expect(unclamped.ok).toBe(true);
  expect(unclamped.tasks.length).toBe(first.tasks.length);
  const detail = await call("get_task", { taskId: "task-0" });
  expect(detail.task.assignments.length).toBe(8);
  expect(detail.task.details.length).toBeGreaterThan(6000);
  const fullList = await call("list_tasks", { ids: ["task-0"], full: true });
  expect(fullList.tasks[0]).toEqual(detail.task);
  const fullWrite = await call("update_task", { taskId: "task-0", status: "assigned", full: true });
  expect(fullWrite.task.assignments.length).toBe(8);
  expect(fullWrite.revision).not.toBe(detail.task.revision);
  const latest = await call("list_tasks", { ids: ["task-0"] });
  expect(latest.tasks[0].status).toBe("assigned");
  expect(latest.tasks[0].revision).toBe(fullWrite.revision);
  const live = await call("agent_activity", { liveOnly: true, compact: true });
  expect(live.count).toBe(0);
  expect(live.excludedGoneCount).toBe(100);
  const gone = await call("agent_activity", { liveOnly: true, includeGone: true, full: true });
  expect(gone.count).toBe(100);
  expect(gone.conversations[0].lifecycle).toBe("gone");
  const note = await call("seat_tick_settings", { project: "size-board", verbose: true });
  expect(note.monitorPrompt).toBe(settings.monitorPrompt);
  const pipelinePage = await call("list_pipelines", { project: "size-board", state: "completed", limit: 200 });
  expect(pipelinePage.pipelines[0].id).toBe(pipelines[239]!.id);
  expect(pipelinePage.hasMore).toBe(true);
  const pipelineIds = pipelinePage.pipelines.map((pipeline: any) => pipeline.id);
  cursor = pipelinePage.nextCursor;
  while (cursor) {
    const page = await call("list_pipelines", { project: "size-board", state: "completed", limit: 200, cursor });
    pipelineIds.push(...page.pipelines.map((pipeline: any) => pipeline.id));
    cursor = page.nextCursor;
  }
  expect(new Set(pipelineIds).size).toBe(160);
  expect(pipelineIds.length).toBe(160);
  const fullPipeline = await call("list_pipelines", { ids: [pipelines[0]!.id], full: true });
  expect(fullPipeline.pipelines[0].spec).toBe(pipelines[0]!.spec);
  domain.patchPipeline = async (_id?: string, args?: any) => {
    if (args?.action === "set-position") pipelines[0]!.pos = args.pos;
    if (args?.action === "link-task") pipelines[0]!.taskIds.push(args.taskId);
    return { pipeline: pipelines[0] };
  };
  const position = await call("pipeline_action", { pipelineId: pipelines[0]!.id, action: "set-position", pos: { x: 1, y: 2 } });
  expect(position.changedFields).toEqual(["pos"]);
  const linked = await call("pipeline_action", { pipelineId: pipelines[0]!.id, action: "link-task", taskId: "task-0" });
  expect(linked.changedFields).toEqual(["taskIds"]);
  expect(linked.taskIds).toContain("task-0");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createViewerMcpServer } = await import("./server");
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "answer-budget", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const protocol = await client.callTool({ name: "list_tasks", arguments: { clientRequestId: "schema-additive", project: "size-board", status: ["blocked", "unknown"], limit: "999", full: true } });
    expect(protocol.isError).not.toBe(true);
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "list_tasks")?.description).toContain("compact by default");
  } finally { await client.close(); await server.close(); }
  const { persistProjectAliases } = await import("@/lib/projects/aliases");
  persistProjectAliases([{ source: "size-board", target: "size-board-successor", displayName: "Size board" }]);
  const successor = await call("list_tasks", { project: "size-board-successor", ids: ["task-0"] });
  expect(successor.count).toBe(1);
  expect(successor.tasks[0].project).toBe("size-board-successor");
});

test("liveOnly keeps live and starting hosts, excludes stale hosts, and includeGone restores idle history", async () => {
  const now = Date.now();
  const files = Array.from({ length: 101 }, (_, i) => ({
    path: `/fixtures/agent-${i}.jsonl`, conversationId: `conversation-${i}`, project: "activity-board",
    engine: "codex", title: `Worker ${i}`, kind: "session", root: "codex", name: `agent-${i}`,
    fmt: "jsonl", parent: null, mtime: now / 1000, size: 100, activity: "live", proc: null, pid: null,
  }));
  const entries = Object.fromEntries(files.map((file, i) => [`entry-${i}`, {
    key: { engine: "codex", accountId: null, sessionId: `session-${i}` }, artifactPath: file.path,
    status: i === 100 ? "starting" : "live", host: null, accountId: null,
    structuredHost: i === 100 ? null : { process: { pid: 1000 + i, startIdentity: `identity-${i}` } },
    updatedAt: new Date(now).toISOString(),
  }]));
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: () => ({
      now: () => now,
      probe: { now: () => now, pidAlive: (pid: number) => pid < 1010, processIdentity: (pid: number) => `identity-${pid - 1000}` },
      registrySnapshot: () => ({ entries, conversations: {} }), pipelines: () => [],
      listFiles: async () => files, describeTranscript: async () => null,
      transcriptEvidence: async () => ({ turn: "idle", lastRecordTs: now, providerProgressAt: null }),
    }), refreshLifecycleJournal: () => ({ appended: 0 }),
  } as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const live = await service.callTool("agent_activity", { clientRequestId: "mixed-live", liveOnly: true, limit: 200 }) as any;
  expect(live.count).toBe(11);
  expect(live.excludedGoneCount).toBe(90);
  expect(live.conversations.some((row: any) => row.lifecycle === "starting")).toBe(true);
  files[20]!.activity = "idle";
  const all = await service.callTool("agent_activity", { clientRequestId: "mixed-history", liveOnly: true, includeGone: true, limit: 200, full: true }) as any;
  expect(all.count).toBe(101);
  expect(all.conversations.some((row: any) => row.conversationId === "conversation-20")).toBe(true);
});

test("keyset pages survive insertions and deletions, cache warm filters, and yield to cancellation", async () => {
  const { listPage, listPageAsync } = await import("./listAnswers");
  const records = Array.from({ length: 600 }, (_, i) => ({ id: `row-${String(i).padStart(4, "0")}`, time: "same-time" }));
  let matched = 0;
  let projected = 0;
  const options = {
    scope: { query: "same" }, cursor: null as unknown, limit: 2, identity: (row: typeof records[number]) => row,
    matches: () => { matched++; return true; }, project: (row: typeof records[number]) => { projected++; return row; },
  };
  const first = listPage(records, options);
  expect(first.rows.map(row => row.id)).toEqual(["row-0599", "row-0598"]);
  const next = listPage(records, { ...options, cursor: first.nextCursor });
  expect(matched).toBe(600);
  expect(projected).toBe(4);
  expect(next.rows.map(row => row.id)).toEqual(["row-0597", "row-0596"]);
  const changed = [{ id: "newer", time: "z" }, ...records.filter(row => row.id !== "row-0598")];
  expect(listPage(changed, { ...options, cursor: first.nextCursor }).rows).toEqual(next.rows);
  let cancelled = false;
  const cancellation = setTimeout(() => { cancelled = true; }, 0);
  try {
    await expect(listPageAsync(records.slice(), options, () => { if (cancelled) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  } finally { clearTimeout(cancellation); }
});

test("acknowledgements name created and refined fields; a missing keyed pipeline never scans the store", async () => {
  const bindings = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => ({ kind: "agent", conversationId: "conversation-refiner" }),
    readPipelineRecord: () => null,
    getPipelines: () => { throw new Error("unexpected whole-store read"); },
    patchPipeline: async () => ({ error: "pipeline not found", status: 404 }),
  } as never);
  await expect(bindings.pipeline_action({ clientRequestId: "missing-keyed", pipelineId: "absent", action: "set-position", pos: { x: 1, y: 2 } })).rejects.toThrow("pipeline not found");
  const created = await bindings.create_task({ clientRequestId: "created-fields", project: "created-board", text: "Created fields", dueAt: "2027-01-01T00:00:00.000Z", dueTz: "UTC" }) as any;
  expect(created.changedFields).toContain("dueAt");
  expect(created.changedFields).toContain("dueTz");
  const tasks = loadTasks();
  tasks.push({
    id: "task-refine", project: "created-board", text: "Placeholder", status: "assigned", placement: "unplaced",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    origin: { kind: "conversation", key: "conversation-refiner", refinement: "pending" },
    assignments: [{ conversationId: "conversation-refiner", path: null, panePid: null, state: "linked", error: null, at: new Date().toISOString() }],
  });
  saveTasks(tasks);
  const refined = await bindings.update_task({ clientRequestId: "refine-once", taskId: "task-refine", refine: { text: "Name the owned task" } }) as any;
  expect(refined.changedFields).toContain("text");
  expect(refined.tasks[0].revision).toBeDefined();
  const repeated = await bindings.update_task({ clientRequestId: "refine-again", taskId: "task-refine", refine: { text: "Name the owned task" } }) as any;
  expect(repeated.changedFields).toEqual([]);
});


test("expired unhosted busy transcripts leave liveOnly while starting launches stay", async () => {
  const now = Date.now();
  const files = Array.from({ length: 102 }, (_, i) => ({
    path: `/fixtures/orphan-${i}.jsonl`, conversationId: `orphan-${i}`, project: "orphan-board",
    engine: "codex", title: `Worker ${i}`, kind: "session", root: "codex", name: `orphan-${i}`,
    fmt: "jsonl", parent: null, mtime: (i < 100 ? now - 86400000 : now) / 1000,
    size: 100, activity: "live", proc: null, pid: null,
  }));
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, {
    livenessSources: () => ({
      now: () => now,
      probe: { now: () => now, pidAlive: () => true, processIdentity: () => "live-identity" },
      registrySnapshot: () => ({ entries: { starting: {
        key: { engine: "codex", accountId: null, sessionId: "starting-session" }, artifactPath: files[100]!.path,
        status: "starting", host: null, accountId: null, structuredHost: null, updatedAt: new Date(now).toISOString(),
      }, live: {
        key: { engine: "codex", accountId: null, sessionId: "live-session" }, artifactPath: files[101]!.path,
        status: "live", host: null, accountId: null,
        structuredHost: { process: { pid: 1234, startIdentity: "live-identity" } }, updatedAt: new Date(now).toISOString(),
      } }, conversations: {} }), pipelines: () => [],
      listFiles: async () => files, describeTranscript: async () => null,
      transcriptEvidence: async (_engine: string, file: string) => ({ turn: "busy", lastRecordTs: file.includes("orphan-10") && /orphan-10[01]/.test(file) ? now : now - 86400000, providerProgressAt: null }),
    }), refreshLifecycleJournal: () => ({ appended: 0 }),
  } as never), new MemoryMcpReceiptStore());
  const live = await service.callTool("agent_activity", { clientRequestId: "orphans-live", liveOnly: true, limit: 200, full: true }) as any;
  expect(live.count).toBe(2);
  expect(live.excludedGoneCount).toBe(100);
  expect(live.conversations.some((row: any) => row.host.state === "alive")).toBe(true);
  const all = await service.callTool("agent_activity", { clientRequestId: "orphans-all", liveOnly: true, includeGone: true, limit: 200, full: true }) as any;
  expect(all.count).toBe(102);
});

test("multibyte titles and paths obey service byte budgets and paginate without loss", async () => {
  const now = Date.now();
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `/fixtures/${"довгий-шлях/".repeat(10)}worker-${i}.jsonl`, conversationId: `unicode-${i}`, project: "unicode-board",
    engine: "codex", title: `Перевірити відновлення розмови та продовження роботи після оновлення ${i} `.repeat(4), kind: "session", root: "codex", name: `worker-${i}`,
    fmt: "jsonl", parent: null, mtime: now / 1000, size: 100, activity: "live", proc: null, pid: null,
  }));
  const service = createMcpToolService(viewerMcpBindings(undefined, {
    get: async (url: string) => {
      const params = new URL(url, "http://fixture").searchParams;
      const offset = Number(params.get("cursor") || 0), limit = Number(params.get("limit") || 50);
      return { items: files.slice(offset, offset + limit), total: files.length, nextCursor: offset + limit < files.length ? String(offset + limit) : null };
    },
  } as never, {
    livenessSources: () => ({
      now: () => now, probe: { now: () => now, pidAlive: () => false, processIdentity: () => null },
      registrySnapshot: () => ({ entries: {}, conversations: {} }), pipelines: () => [],
      listFiles: async () => files, describeTranscript: async () => null,
      transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: now, providerProgressAt: null }),
    }), refreshLifecycleJournal: () => ({ appended: 0 }),
  } as never), new MemoryMcpReceiptStore());
  for (const [tool, budget] of [["list_conversations", 12000], ["agent_activity", 24000]] as const) {
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let page = 0; page < 20; page++) {
      const answer = await service.callTool(tool, { clientRequestId: `unicode-${tool}-${page}`, ...(cursor ? { cursor } : {}) }) as any;
      expect(answer.ok).toBe(true);
      console.log(`${tool} multibyte page ${page}: ${Buffer.byteLength(JSON.stringify(answer))} bytes`);
      if (process.env.MCP_SIZE_BASELINE) break;
      expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(budget);
      ids.push(...answer.conversations.map((row: any) => row.conversationId));
      cursor = answer.nextCursor;
      if (!cursor) break;
    }
    if (process.env.MCP_SIZE_BASELINE) continue;
    expect(cursor).toBeNull();
    expect(ids.length).toBe(100);
    expect(new Set(ids).size).toBe(100);
    const full = await service.callTool(tool, { clientRequestId: `unicode-full-${tool}`, full: true }) as any;
    expect(full.conversations[0].title).toBe(files[0]!.title);
  }
});


test("real service uses keyed reads and replays only changed selection rows on a 10000-card board", async () => {
  const { taskSelectionSource } = await import("@/lib/tasks/store");
  const { pipelineSelectionSource, buildPipeline, pipelineIdentity } = await import("@/lib/pipelines/store");
  const { boardSelection } = await import("./boardSelection");
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(sandbox, "indexed-state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  const taskFile = path.join(process.env.LLV_STATE_DIR, "tasks.json");
  try {
  const count = 10_000;
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `indexed-task-${i}`, project: "indexed-board", text: `Work item ${i}`,
    details: "Stored context", status: "inbox", placement: "unplaced", board: "hidden", assignments: [],
    createdAt: new Date(1700000000000 + i * 1000).toISOString(), updatedAt: new Date(1700000000000 + i * 1000).toISOString(),
  }));
  const pipelines = tasks.map((task, i) => buildPipeline({
    id: `indexed-pipeline-${i}`, project: task.project, task: task.text, repoDir: "/repo", stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null, effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "Build work" } }],
    srcPath: null, srcConversationId: null, now: task.createdAt,
  }));
  for (const [i, pipeline] of pipelines.entries()) pipeline.taskIds = [tasks[i]!.id];
  tasks[60]!.placement = "pinned"; // Supported legacy row without a usable position.
  tasks[60]!.text = "Legacy placement regression";
  saveTasks(tasks as never, taskFile); savePipelines(pipelines);
  const taskSource = taskSelectionSource(taskFile)!, pipelineSource = pipelineSelectionSource();
  let taskReads = 0, pipelineReads = 0;
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, {
    taskSelectionSource: () => ({ ...taskSource, read: (id: string) => { taskReads++; return taskSource.read(id); } }),
    pipelineSelectionSource: () => ({ ...pipelineSource, read: (id: string) => { pipelineReads++; return pipelineSource.read(id); } }),
    listTaskRecords: () => { throw new Error("whole task collection read"); },
    loadTasks: () => { throw new Error("whole task collection read"); },
    listPipelineRecords: () => { throw new Error("whole pipeline collection read"); },
    getPipelines: () => { throw new Error("whole pipeline collection read"); },
  } as never), new MemoryMcpReceiptStore());
  let sequence = 0;
  const call = (tool: "list_tasks" | "list_pipelines" | "get_task", args: Args) => service.callTool(tool, { clientRequestId: `indexed-${++sequence}`, ...args }) as Promise<any>;
  const taskIndex = boardSelection(taskSource.filename, "tasks"), pipelineIndex = boardSelection(pipelineSource.filename, "pipelines");
  const cold = await call("list_pipelines", { ids: [pipelines[10]!.id], limit: 1 });
  expect(cold.ok).toBe(true); expect(cold.count).toBe(1);
  expect(pipelineIndex.work.metadataRows).toBe(0);
  expect(pipelineReads).toBe(1);
  const first = await call("list_tasks", { ids: [tasks[10]!.id], limit: 1 });
  expect(first.ok).toBe(true); expect(first.count).toBe(1);
  expect(taskReads).toBe(1); expect(taskIndex.work.metadataRows).toBe(0);
  expect(first.tasks[0].pipelineIds).toEqual([pipelines[10]!.id]);
  const taskMetadata = taskIndex.work.metadataRows, pipelineMetadata = pipelineIndex.work.metadataRows;
  await call("list_tasks", { ids: [tasks[20]!.id], limit: 1 });
  await call("list_pipelines", { ids: [pipelines[20]!.id], limit: 1 });
  expect(taskReads).toBe(2); expect(pipelineReads).toBe(2);
  expect(taskIndex.work.metadataRows).toBe(taskMetadata); expect(pipelineIndex.work.metadataRows).toBe(pipelineMetadata);
  const newest = await call("list_tasks", { project: "indexed-board", limit: 1 });
  expect(newest.tasks[0].id).toBe(tasks[count - 1]!.id);
  expect(newest.total).toBe(count);
  const legacyPlacement = await call("list_tasks", { project: "indexed-board", placement: "unplaced", query: "Legacy placement regression", limit: 200 });
  expect(legacyPlacement.tasks.some((task: any) => task.id === tasks[60]!.id)).toBe(true);
  const pinned = await call("list_tasks", { project: "indexed-board", placement: "pinned", limit: 1 });
  expect(pinned.total).toBe(0);
  const beforeTasks = taskIndex.work.metadataRows, beforePipelines = pipelineIndex.work.metadataRows;
  tasks[50]!.text = "Updated unrelated record";
  pipelines[50]!.task = "Updated unrelated pipeline";
  Object.assign(pipelines[50]!, pipelineIdentity(pipelines[50]!.id, pipelines[50]!.task, "/repo"));
  pipelines[50]!.taskIds = [tasks[20]!.id];
  mutateTasks(current => {
    current.find(task => task.id === tasks[50]!.id)!.text = tasks[50]!.text;
    return { tasks: current, result: undefined };
  }, taskFile);
  savePipelines(pipelines);
  const changed = await call("list_tasks", { project: "indexed-board", query: "unrelated", limit: 1 });
  expect(changed.tasks[0].id).toBe(tasks[50]!.id);
  const changedPipeline = await call("list_pipelines", { project: "indexed-board", query: "unrelated", limit: 1 });
  expect(changedPipeline.pipelines[0].id).toBe(pipelines[50]!.id);
  expect(taskIndex.work.metadataRows - beforeTasks).toBe(1);
  expect(pipelineIndex.work.metadataRows - beforePipelines).toBe(1);
  const linked = await call("get_task", { taskId: tasks[20]!.id });
  expect(new Set(linked.task.pipelineIds)).toEqual(new Set([pipelines[20]!.id, pipelines[50]!.id]));
  const keyedReads = taskReads;
  await call("list_tasks", { ids: [tasks[30]!.id], limit: 1 });
  expect(taskReads - keyedReads).toBe(1);
  expect(taskIndex.work.metadataRows - beforeTasks).toBe(1);
  console.log(`Indexed 10000-card service: changed-ID reads=1, single task update metadata=1, single pipeline update metadata=1`);
  } finally { process.env.LLV_STATE_DIR = previousState; }
}, 30_000);
