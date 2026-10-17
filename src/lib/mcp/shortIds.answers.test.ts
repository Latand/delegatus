import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
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
afterEach(() => setSystemTime());

const bindingModule = process.env.MCP_SIZE_BINDINGS ?? "./bindings";
const { persistProjectAliases } = await import("@/lib/projects/aliases");
expect(persistProjectAliases([
  { source: "size-board-fixture-old", target: "repo-1234567890abcdef1234567890abcdef", displayName: "repo-1234567890abcdef1234567890abcdef" },
  { source: "created-board-fixture-old", target: "created-board", displayName: "created-board" },
])).toBe(true);
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
for (const project of ["repo-1234567890abcdef1234567890abcdef", "created-board"]) {
  const clientRequestId = `size-seat-${project}`;
  const conversationId = `conversation-${project}`;
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId, mode: "existing", conversationId });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null });
}
const { viewerMcpBindings } = await import(bindingModule);
const { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES } = await import("./server");
const { saveTasks, loadTasks, loadTasksForList, taskSelectionSource, mutateTasks } = await import("@/lib/tasks/store");
const { savePipelines, pipelineSelectionSource } = await import("@/lib/pipelines/store");
const { pipelineCorpus } = await import("@/lib/pipelines/fixtures/corpus");
const { defaultSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
const { saveFlows, loadFlows, flowSelectionSource } = await import("@/lib/flows/store");
type Args = Record<string, unknown>;

function flowCorpus(count: number, now: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `size-flow-${i}`, template: "implement-review-loop" as const, project: "repo-1234567890abcdef1234567890abcdef",
    cwd: "/repo", implementerPath: `sessions/implementer-${i}.jsonl`,
    roles: { implementer: { engine: "codex" as const, model: null, effort: null }, reviewer: { engine: "claude" as const, model: null, effort: null } },
    baseRef: "base", baseMode: "head" as const, mode: "auto" as const, reviewerMode: "headless" as const,
    roundLimit: 5, state: "waiting_ready" as const, stateDetail: null, rounds: [],
    spec: `Flow work ${i}\n${"s".repeat(6000)}`, createdAt: new Date(now + i * 1000).toISOString(), closedAt: null,
  }));
}

test("default answers contain short ids, with a repeatable service size census", async () => {
  const now = Date.parse("2026-09-20T09:00:00.000Z");
  setSystemTime(now);
  const pipelines = pipelineCorpus(24, 2);
  saveFlows(flowCorpus(24, now));
  for (const [i, pipeline] of pipelines.entries()) {
    pipeline.project = "repo-1234567890abcdef1234567890abcdef";
    pipeline.createdAt = new Date(now + i * 1000).toISOString();
    pipeline.state = i % 3 === 0 ? "running" : "completed";
    pipeline.taskIds = [`task-${i}`];
    pipeline.srcConversationId = `conversation-${i}`;
    pipeline.baseRef = "12345678" + "a".repeat(32);
    pipeline.lastPassedCommit = "23456789" + "b".repeat(32);
    pipeline.stateDetail = `accepted head ${pipeline.lastPassedCommit}`;
    const original = pipeline.stages.map(stage => structuredClone(stage));
    pipeline.stages = [...original, ...original.map((stage, n) => ({ ...stage, id: `extra-${n}`, kind: "run" as const }))];
    const originalRuns = structuredClone(pipeline.runs);
    pipeline.runs = pipeline.stages.map((stage, n) => ({ ...structuredClone(originalRuns[n % originalRuns.length]!), stageId: stage.id }));
    pipeline.stages.forEach((stage, n) => { stage.next = pipeline.stages[n + 1]?.id ?? null; });
    for (const run of pipeline.runs) for (const attempt of run.attempts) {
      attempt.reviewHeadSha = pipeline.lastPassedCommit;
      attempt.error = `head ${pipeline.lastPassedCommit}`;
      attempt.startedAt = attempt.completedAt = new Date(now).toISOString();
    }
    pipeline.delivery = { target: { repository: pipeline.project, remote: "https://example.invalid/repo.git", branch: `refs/heads/${pipeline.branch}` },
      disposition: "owner", publish: "enabled", ownerId: pipeline.id, epoch: 1, active: true, journal: [],
      operation: { id: "operation-fixture", epoch: 1, sha: pipeline.lastPassedCommit, state: "settled", result: { ok: true, sha: pipeline.lastPassedCommit, remote: "published" } } } as never;
  }
  savePipelines(pipelines.map(pipeline => pipeline.state === "completed" ? { ...pipeline, cursor: null } : pipeline));
  saveTasks(Array.from({ length: 24 }, (_, i) => ({
    id: `task-${i}`, project: "repo-1234567890abcdef1234567890abcdef", text: `Board work ${i}\n${"Outcome and acceptance. ".repeat(25)}`,
    details: "Implementation context. ".repeat(300), status: i % 3 === 0 ? "assigned" : "done",
    placement: "unplaced", board: "hidden", createdAt: new Date(now + i * 1000).toISOString(),
    updatedAt: new Date(now + i * 1000).toISOString(),
    assignments: Array.from({ length: 8 }, (_, j) => ({ path: `sessions/agent-${i}-${j}.jsonl`, conversationId: `conversation-${i}-${j}`, panePid: null, state: "linked", error: null, at: new Date(now).toISOString() })),
  })) as never);
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `/fixture/conversations/agent-${i}.jsonl`, conversationId: `conversation-${i}`, project: "repo-1234567890abcdef1234567890abcdef",
    engine: "codex", title: `Board worker ${i}`, kind: "session", root: "codex", name: `agent-${i}`,
    fmt: "jsonl", parent: null, mtime: (now - i * 86400000) / 1000, size: 1024,
    activity: "live", proc: null, pid: null,
  }));
  let settings = { ...defaultSeatTickSettings("repo-1234567890abcdef1234567890abcdef"), autoRotate: { enabled: true, thresholdPercent: 60, updatedAt: new Date(now).toISOString(),
    setBy: { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null }, why: null }, monitorPrompt: "Monitor open work. ".repeat(200) };
  const domain = {
    registrySnapshot: () => ({ conversations: {} }),
    completedFileScan: async () => ({ snapshot: { files, projectCatalog: [{ project: "repo-1234567890abcdef1234567890abcdef", displayName: "Example board", smt: 1, conversations: files.length }], complete: true } }),
    taskSelectionSource, pipelineSelectionSource, flowSelectionSource,
    loadTasks, listTaskRecords: loadTasksForList, getPipelines: () => ({ pipelines }), listPipelineRecords: () => pipelines,
    getFlowsWithPresets: () => ({ flows: loadFlows(), presets: [] }),
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
  const { pipelineAcknowledgement, stageReportAcknowledgement } = await import("./compactAnswers");
  const hash = "3456789a" + "c".repeat(56);
  const head = pipelines[0]!.lastPassedCommit;
  // These writes normally cross the authenticated Viewer-control seam. Keep
  // its observed receipt shapes fixed, exercising the same service boundary.
  bindings.create_pipeline = async () => pipelineAcknowledgement(pipelines[0]!);
  bindings.spawn_agent = async () => ({ launchId: ["00000000", "0000", "4000", "8000", "000000000001"].join("-"), conversationId: "conversation_fixture", state: "accepted" });
  bindings.stage_report = async () => stageReportAcknowledgement({ seq: 1, at: new Date(now).toISOString(), verdict: { status: "pass", findings: [] }, provenance: { head, uncommitted: [], outputs: [] }, summary: "Checked" } as never);
  bindings.deployment_status = async () => ({ state: "succeeded", revision: head, sha: head });
  bindings.bridge_report = async () => ({ seq: 1, reportId: `rpt_${hash.slice(0,24)}` });
  bindings.lifecycle_events = async () => ({ events: [{ id: `evt_${hash.slice(0,24)}`, at: new Date(now).toISOString() }] });
  bindings.issue_report = async () => ({ digest: hash, approvalForm: { issueReport: hash } });
  bindings.publish_prototype_review = async () => ({ reviewId: `pr_${hash.slice(0,32)}`, project: pipelines[0]!.project });
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const cases: Array<[typeof MCP_TOOL_NAMES[number], string, Args]> = [
    ["create_pipeline", "default", {}],
    ["spawn_agent", "default", {}],
    ["stage_report", "default", {}],
    ["deployment_status", "default", {}],
    ["bridge_report", "default", {}],
    ["lifecycle_events", "default", {}],
    ["issue_report", "default", {}],
    ["publish_prototype_review", "default", {}],
    ["list_flows", "default", { project: "repo-1234567890abcdef1234567890abcdef" }],
    ["list_flows", "limit=200", { project: "repo-1234567890abcdef1234567890abcdef", limit: 200 }],
    ["list_flows", "compact", { project: "repo-1234567890abcdef1234567890abcdef", compact: true }],
    ["list_tasks", "default", { project: "repo-1234567890abcdef1234567890abcdef" }],
    ["list_tasks", "limit=200", { project: "repo-1234567890abcdef1234567890abcdef", limit: 200 }],
    ["list_tasks", "openOnly", { project: "repo-1234567890abcdef1234567890abcdef", openOnly: true }],
    ["list_pipelines", "default", { project: "repo-1234567890abcdef1234567890abcdef" }],
    ["list_pipelines", "completed,limit=200", { project: "repo-1234567890abcdef1234567890abcdef", state: "completed", limit: 200 }],
    ["list_pipelines", "open,compact", { project: "repo-1234567890abcdef1234567890abcdef", state: "open", compact: true }],
    ["agent_activity", "liveOnly,compact", { project: "repo-1234567890abcdef1234567890abcdef", liveOnly: true, compact: true }],
    ["agent_activity", "default", { project: "repo-1234567890abcdef1234567890abcdef" }],
    ["create_task", "details", { project: "repo-1234567890abcdef1234567890abcdef", text: "New board work", details: "Context. ".repeat(600), board: "hidden" }],
    ["update_task", "status", { taskId: "task-0", status: "blocked" }],
    ["get_task", "default", { taskId: "task-0" }],
    ["get_pipeline", "default", { pipelineId: pipelines[0]!.id }],
    ["get_pipeline", "stageId", { pipelineId: pipelines[0]!.id, stageId: "build" }],
    ["get_pipeline", "compact", { pipelineId: pipelines[0]!.id, compact: true }],
    ["pipeline_action", "link-task", { pipelineId: pipelines[0]!.id, action: "link-task", taskId: "task-0" }],
    ["pipeline_action", "unlink-task", { pipelineId: pipelines[0]!.id, action: "unlink-task", taskId: "task-0" }],
    ["seat_tick_settings", "write-note", { project: "repo-1234567890abcdef1234567890abcdef", monitorPrompt: settings.monitorPrompt }],
    ["seat_tick_settings", "read", { project: "repo-1234567890abcdef1234567890abcdef" }],
    ["list_conversations", "default", { project: "repo-1234567890abcdef1234567890abcdef" }],
    ["link_task_to_pipeline", "assignment", { taskId: "task-1", pipelineId: pipelines[0]!.id }],
  ];
  const covered = new Set(cases.map(([tool]) => tool));
  for (const tool of MCP_TOOL_NAMES) if (!covered.has(tool)) cases.push([tool, "unconfigured census", {}]);
  const rows = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createViewerMcpServer } = await import("./server");
  const server = createViewerMcpServer(service), client = new Client({ name: "short-id-census", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const listed = JSON.stringify(await client.listTools());
    const hashChars = (listed.match(/[a-f0-9]{20,}/gi) ?? []).reduce((sum, value) => sum + value.length, 0);
    if (!process.env.MCP_SIZE_OUTPUT) expect(listed, "tools/list exposes a long hash").not.toMatch(/[a-f0-9]{20,}|task-v1:[a-f0-9]{9,}/i);
    rows.push({ tool: "tools/list", scenario: "protocol", outcome: "success", bytes: Buffer.byteLength(listed), observedCalls: 0, observedScenarioCalls: 0, hashChars, weightedBytes: null });
  } finally { await client.close(); await server.close(); }
  const frequencySample = JSON.parse(fs.readFileSync(new URL("./answerSizes.frequency.json", import.meta.url), "utf8")) as { counts: Record<string, number>; scenarioCounts: Record<string, number> };
  const frequencies = frequencySample.counts;
  const budgets: Record<string, number> = { list_flows: 26000, list_tasks: 26000, list_pipelines: 26000, agent_activity: 24000, create_task: 2000, update_task: 1200, get_task: 10000, get_pipeline: 150000, link_task_to_pipeline: 1800, pipeline_action: 1500, seat_tick_settings: 1800, list_conversations: 12000 };
  for (const [tool, scenario, args] of cases) {
    const result = await service.callTool(tool, { clientRequestId: `size-${rows.length}`, ...args });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const scenarioCalls = frequencySample.scenarioCounts[`${tool}|${scenario}`] ?? 0;
    rows.push({ tool, scenario, outcome: result.ok ? "success" : "refusal", bytes, observedCalls: frequencies[tool] ?? 0, observedScenarioCalls: scenarioCalls, hashChars: (JSON.stringify(result).match(/[a-f0-9]{20,}/gi) ?? []).reduce((sum, value) => sum + value.length, 0), weightedBytes: result.ok ? bytes * scenarioCalls : null });
    if (!process.env.MCP_SIZE_OUTPUT && scenario === "unconfigured census") expect(bytes, `${tool} census response budget`).toBeLessThan(3000);
    if (!process.env.MCP_SIZE_OUTPUT) {
      expect(JSON.stringify(result), `${tool} ${scenario} leaks a long hash`).not.toMatch(/[a-f0-9]{20,}|task-v1:[a-f0-9]{9,}/i);
    }
    if (!process.env.MCP_SIZE_OUTPUT && scenario !== "unconfigured census") {
      expect(result.ok, `${tool}: ${JSON.stringify(result)}`).toBe(true);
      if (budgets[tool]) expect(bytes, `${tool} ${scenario} exceeded its default answer budget`).toBeLessThanOrEqual(budgets[tool]!);
    }
  }
  if (!process.env.MCP_SIZE_OUTPUT) {
    const full = await service.callTool("get_pipeline", { pipelineId: pipelines[0]!.id, full: true });
    expect(JSON.stringify(full)).toContain(head);
    const replay = await service.callTool("deployment_status", { clientRequestId: "full-replay", full: true });
    expect(JSON.stringify(replay)).toContain(head);
    const shortReplay = await service.callTool("deployment_status", { clientRequestId: "short-replay" });
    const again = await service.callTool("deployment_status", { clientRequestId: "short-replay" });
    expect(again.replayed).toBe(true);
    expect(JSON.stringify(shortReplay)).not.toContain(head);
  }
  const { effectiveSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  const { emptySeatTickState } = await import("@/lib/monitor/types");
  const { seatTickDecision } = await import("@/lib/monitor/seatTick");
  const { DEFAULT_SEAT_TICK_POLICY } = await import("@/lib/monitor/seatTick");
  const wake = seatTickDecision({ project: pipelines[0]!.project, now, policy: DEFAULT_SEAT_TICK_POLICY,
    seat: { conversationId: "conversation_seat", seatEpoch: 1, path: null, designatedAt: null, turn: "idle", activity: null },
    settings: effectiveSeatTickSettings(settings, now, 3_600_000), state: emptySeatTickState(), pipelines: [], tasks: [], events: [], pullRequests: [], pullRequestsUnavailable: null, signals: [], ownLanes: [], children: [], childrenUnavailable: null, changeFingerprint: "fixture",
    settledDeploys: [{ sha: head, phase: "succeeded", deploymentId: "deployment-fixture", error: null, settledAt: new Date(now).toISOString() }],
  });
  const { seatTickWakeMessage } = await import("@/lib/monitor/report");
  if (wake.verdict.kind !== "wake") throw new Error("fixture must produce a deploy wake");
  const wakeText = seatTickWakeMessage({ project: "Fixture board", now, ...wake.verdict, signals: [] });
  if (!process.env.MCP_SIZE_OUTPUT) expect(wakeText).toContain("sha 23456789");
  rows.push({ tool: "seat_wake", scenario: "settled deploy", outcome: "success", bytes: Buffer.byteLength(wakeText), observedCalls: 0, observedScenarioCalls: 0, hashChars: (wakeText.match(/[a-f0-9]{20,}/gi) ?? []).reduce((n, h) => n+h.length, 0), weightedBytes: null });
  if (!process.env.MCP_SIZE_OUTPUT) expect(wakeText).not.toMatch(/[a-f0-9]{20,}/i);
  // Frequencies come from a bounded manager transcript sample; each scenario has its own matched call count.
  console.log(rows.map(row => `${row.tool} [${row.scenario}]: ${row.bytes} bytes (${row.outcome})`).join("\n"));
  if (process.env.MCP_SIZE_OUTPUT) fs.writeFileSync(process.env.MCP_SIZE_OUTPUT, "[\n" + rows.map(row => "  " + JSON.stringify(row)).join(",\n") + "\n]\n");
  expect(new Set(rows.filter(row => row.tool !== "seat_wake" && row.tool !== "tools/list").map(row => row.tool)).size).toBe(MCP_TOOL_NAMES.length);

});

test("review ambiguity survives the real Viewer-control transport", async () => {
  if (process.env.MCP_SIZE_OUTPUT) return;
  const oldUrl = process.env.LLV_VIEWER_CONTROL_URL;
  const { VIEWER_SPAWN_CAPABILITY_ENV } = await import("@/lib/agent/spawnPolicy");
  const oldCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "reviewId is ambiguous; pass more characters", code: "short_id_ambiguous", field: "reviewId", candidates: ["pr_12345678a", "pr_12345678b"] }, { status: 409 }) });
  try {
    process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${server.port}`;
    process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "a".repeat(43);
    const { productionViewerControlDependencies } = await import("./bindings");
    const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies()), new MemoryMcpReceiptStore());
    const answer = await service.callTool("resend_prototype_review_telegram", { clientRequestId: "ambiguous-review-transport", reviewId: "pr_12345678" });
    expect(answer).toMatchObject({ ok: false, code: "short_id_ambiguous", retryable: false, details: { field: "reviewId", candidates: ["pr_12345678a", "pr_12345678b"] } });
  } finally {
    server.stop(true);
    process.env.LLV_VIEWER_CONTROL_URL = oldUrl;
    if (oldCapability === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV]; else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = oldCapability;
  }
});

test("tools/list shortens hashes in input-field descriptions", async () => {
  if (process.env.MCP_SIZE_OUTPUT) return;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createViewerMcpServer, TOOL_INPUT_SCHEMAS, TOOL_TRANSPORT_SCHEMAS, createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
  const { z } = await import("zod");
  const original = TOOL_INPUT_SCHEMAS.get_task;
  const originalTransport = TOOL_TRANSPORT_SCHEMAS.get_task;
  const planted = "d".repeat(40);
  const schema = z.object({ taskId: z.string().describe(`Identifier ${planted}`) });
  TOOL_INPUT_SCHEMAS.get_task = schema as never;
  TOOL_TRANSPORT_SCHEMAS.get_task = schema as never;
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "catalog-short-ids", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const listed = JSON.stringify(await client.listTools());
    expect(listed).not.toContain(planted);
    expect(listed).toContain("dddddddd");
  } finally {
    await client.close(); await server.close();
    TOOL_INPUT_SCHEMAS.get_task = original;
    TOOL_TRANSPORT_SCHEMAS.get_task = originalTransport;
  }
});

test("default prototype media references shorten and retain resolvable ids", async () => {
  if (process.env.MCP_SIZE_OUTPUT) return;
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
  const review = `pr_${"a".repeat(32)}`;
  const image = "b".repeat(64);
  const original = "c".repeat(64);
  const video = "d".repeat(64);
  const answer = createMcpToolService({ read_prototype_review: async () => ({
    rounds: [{ reviewId: review, variants: [{ frames: [{ image: { id: image, url: `/api/image?prototype=${review}&media=${image}` }, original: { id: original, url: `/api/image?prototype=${review}&media=${original}` } }], videos: [{ media: { id: video, url: `/api/tasks/task/prototypes/${review}/video/${video}` } }] }] }],
  }) } as never, new MemoryMcpReceiptStore());
  const result = await answer.callTool("read_prototype_review", { clientRequestId: "short-media", taskId: "task" });
  const payload = JSON.stringify(result);
  expect(payload).not.toMatch(/[a-f0-9]{20,}/i);
  expect(payload).toContain("prototype=pr_aaaaaaaa");
  expect(payload).toContain("media=bbbbbbbb");
  expect(payload).toContain("/prototypes/pr_aaaaaaaa/video/dddddddd");
  expect(payload).toContain("/video/dddddddd");
  expect(result).toMatchObject({ ok: true, rounds: [{ variants: [{ frames: [{ image: { id: "bbbbbbbb" }, original: { id: "cccccccc" } }], videos: [{ media: { id: "dddddddd" } }] }] }] });
});

test("pipeline revision receipt replay accepts full and displayed references after the record changes", async () => {
  if (process.env.MCP_SIZE_OUTPUT) return;
  const full = "a1b2c3d4" + "e".repeat(56);
  let calls = 0, revision = full;
  const canonicalize = (retainedRevision: string) => (args: Record<string, unknown>) => {
    const revision = args.expectedRevision;
    return typeof revision === "string" && retainedRevision.toLowerCase().startsWith(revision.toLowerCase())
      ? { ...args, expectedRevision: retainedRevision }
      : args;
  };
  const service = createMcpToolService({ pipeline_action: Object.assign(async () => {
    calls++;
    const answer = { accepted: true, revision };
    revision = "f".repeat(64);
    return answer;
  }, { canonicalizeReceiptArgs: canonicalize(full) }) } as never, new MemoryMcpReceiptStore());
  const args = { pipelineId: "pipe-receipt", action: "resolve-decision", expectedRevision: full, answer: "accept" };
  const first = await service.callTool("pipeline_action", { clientRequestId: "full-then-short", ...args });
  const replay = await service.callTool("pipeline_action", { clientRequestId: "full-then-short", ...args, expectedRevision: full.slice(0, 8) });
  expect(first.ok).toBe(true);
  expect(replay).toMatchObject({ ok: true, replayed: true });
  expect(calls).toBe(1);
  const conflict = await service.callTool("pipeline_action", { clientRequestId: "full-then-short", ...args, answer: "reject" });
  expect(conflict).toMatchObject({ ok: false, code: "idempotency_conflict" });

  const reverse = createMcpToolService({ pipeline_action: Object.assign(async () => { calls++; return { accepted: true }; }, { canonicalizeReceiptArgs: canonicalize(full) }) } as never, new MemoryMcpReceiptStore());
  await reverse.callTool("pipeline_action", { clientRequestId: "short-then-full", ...args, expectedRevision: full.slice(0, 8) });
  const fullReplay = await reverse.callTool("pipeline_action", { clientRequestId: "short-then-full", ...args });
  expect(fullReplay).toMatchObject({ ok: true, replayed: true });
  expect(calls).toBe(2);
});

test("pipeline receipt replay does not merge distinct full revisions with a shared prefix", async () => {
  if (process.env.MCP_SIZE_OUTPUT) return;
  const retained = "a1b2c3d" + "1" + "e".repeat(56);
  const other = "a1b2c3d" + "2" + "e".repeat(56);
  let calls = 0;
  const canonicalize = (args: Record<string, unknown>) => {
    const revision = args.expectedRevision;
    return typeof revision === "string" && retained.startsWith(revision.toLowerCase())
      ? { ...args, expectedRevision: retained }
      : args;
  };
  const guarded = createMcpToolService({
    pipeline_action: Object.assign(async () => { calls++; return { accepted: true }; }, { canonicalizeReceiptArgs: canonicalize }),
  } as never, new MemoryMcpReceiptStore());
  await guarded.callTool("pipeline_action", { clientRequestId: "prefix-collision", action: "resolve-decision", expectedRevision: retained, answer: "accept" });
  const conflict = await guarded.callTool("pipeline_action", { clientRequestId: "prefix-collision", action: "resolve-decision", expectedRevision: other, answer: "accept" });
  expect(conflict).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(calls).toBe(1);
});

test("short budget-page tokens continue their page and refuse changed filters or owners", async () => {
  if (process.env.MCP_SIZE_OUTPUT) return;
  const { budgetPage } = await import("./budgetPage");
  const owner = {}; let reads = 0;
  const load = async () => { reads++; return { rows: [0,1,2].map(n => ({ conversationId: `conversation_${n}` })), meta: {}, upstream: null }; };
  const first = await budgetPage(owner, "fixture", { project: "fixture" }, 1000, load, false, 1);
  expect(first.nextCursor).toMatch(/^mcp-page-[a-f0-9]{8}$/);
  const next = await budgetPage(owner, "fixture", { project: "fixture", cursor: first.nextCursor }, 1000, load, false, 1);
  expect(next.conversations).toEqual([{ conversationId: "conversation_1" }]); expect(reads).toBe(1);
  await expect(budgetPage(owner, "fixture", { project: "different", cursor: first.nextCursor }, 1000, load, false, 1)).rejects.toThrow("expired or filters changed");
  await expect(budgetPage({}, "fixture", { project: "fixture", cursor: first.nextCursor }, 1000, load, false, 1)).rejects.toThrow("expired or filters changed");
});
