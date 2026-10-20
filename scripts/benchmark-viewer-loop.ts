/** Compile and run only in an isolated export. See docs/perf/viewer-loop-slices.md. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { profile } from "bun:jsc";
import { NextRequest } from "next/server";
import { GET as sessionGet } from "../src/app/api/session/route";
import { refreshMemoryIndex } from "../src/lib/memory/service";
import { performanceSpans, performanceSites } from "../src/lib/performanceSpans";
import { withViewerOperation } from "../src/lib/viewerLoopMonitor";
import { gatherSeatTickInput, refreshSeatTickEvidence, type SeatTickSources } from "../src/lib/monitor/seatTickSources";
import { emptySeatTickState } from "../src/lib/monitor/types";
import { DEFAULT_SEAT_TICK_POLICY } from "../src/lib/monitor/seatTick";
import { defaultSeatTickSettings } from "../src/lib/monitor/seatTickSettings";
import { sweepAutoMerge, sweepTaskFinishes, productionAutoMergePorts } from "../src/lib/forge/autoMerge";
import { buildPipeline, savePipelines, loadPipelinesForList, loadPipelinesForListAsync } from "../src/lib/pipelines/store";
import type { Pipeline } from "../src/lib/pipelines/types";
import { buildRegistryPerformanceDataset } from "../src/lib/agent/registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { closeAgentRegistryForTests, normalizeRegistry, setAgentRegistryForTests } from "../src/lib/agent/registry";

const root = process.env.LLV_STATE_DIR;
if (!root || process.env.LLV_VIEWER_CONTROL_URL !== "http://127.0.0.1:1" || process.env.LLV_LOOP_BENCHMARK !== "1"
  || process.env.LLV_CODEX_HOME !== path.join(root, "codex")) {
  throw Error("benchmark requires isolated state and a closed control URL");
}
fs.mkdirSync(root, { recursive: true });
const NOW = Date.parse("2026-10-01T00:00:00Z");
const seed = buildPipeline({
  id: "seed0001", task: "Synthetic work", project: "fixture", repoDir: "/repo",
  stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
  srcPath: null, srcConversationId: null, now: new Date(NOW).toISOString(), state: "draft",
});
const reviewedHead = "a".repeat(40);
const attempts = Array.from({ length: 6000 }, (_, index) => ({
  n: index + 1, state: "running" as const,
  effectiveRole: { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null },
  launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
  startedAt: new Date(NOW - index * 1000).toISOString(), completedAt: null,
  input: null, activatedBy: null, output: null, verdict: null, error: null,
}));
const pipelines: Pipeline[] = Array.from({ length: 804 }, (_, i) => {
  const id = `lane${String(i).padStart(4, "0")}`;
  return { ...seed, id, worktreeDir: `/repo-pipeline-${id}`, branch: `pipeline/synthetic-work-${id}`,
    taskIds: [`task-${i}`], spec: "Synthetic context. ".repeat(5500),
    state: i < 603 ? "running" : "completed", lastPassedCommit: reviewedHead,
    srcConversationId: i >= 603 ? "benchmark-seat" : null,
    cursor: i < 603 ? { stageId: "build", state: "running", input: null, activatedBy: null } : null,
    runs: [{ stageId: "build", attempts: i === 0 ? attempts : attempts.slice(0, 8) }],
    merge: { state: "queued", by: null, repository: "fixture/project", prNumber: null,
      policyChangedAt: new Date(NOW).toISOString(), reviewedHead, chain: [reviewedHead], updates: [], seenChecks: [],
      head: null, headSeenAt: null, lastChecks: null, readAt: null, nextReadAt: new Date(NOW + 60_000).toISOString(),
      readFailures: 0, requestedAt: new Date(NOW + i).toISOString(), mergedHead: null, mergeCommit: null, method: null,
      mergedAt: null, attempts: 0, reason: null, blockedAt: null, updatedAt: new Date(NOW).toISOString() } };
});
savePipelines(pipelines);
let sourcePipelines: readonly Pipeline[] = loadPipelinesForList();
const tasks = Array.from({ length: 1200 }, (_, i) => ({
  id: `task-${i}`, project: "fixture", status: "done", text: "Synthetic task", placement: "unplaced", assignments: [],
  createdAt: new Date(NOW - 86400000).toISOString(), updatedAt: new Date(NOW - 86400000).toISOString(),
}));
const memoryFile = path.join(root, "codex", "memories", "memory_summary.md");
fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
const memoryText = "v1\n## User preferences\n" + Array.from({ length: 3500 }, (_, i) =>
  `- Preserve synthetic receipt ${i}. ${"Check the persisted evidence. ".repeat(15)}`).join("\n");
let iteration = 0;
const sources = {
  prepareRead: async () => { await loadPipelinesForListAsync(); }, now: () => NOW,
  settings: () => defaultSeatTickSettings("fixture"), seatFor: () => ({ active: { conversationId: "benchmark-seat", seatEpoch: 1, path: null, designatedAt: new Date(NOW).toISOString(), turn: "idle", activity: null }, pending: null, history: [] }), activeSeats: () => ["fixture"],
  pipelines: () => sourcePipelines, archivedPipelines: () => [], tasks: () => tasks,
  registry: () => ({
    pageSeatChildren: () => ({ file: { entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {} },
      keys: [], after: null, complete: true, evidenceGap: false }),
    readOnlySnapshot: () => ({ entries: {}, receipts: {}, lineageEdges: {}, memberships: {}, conversations: {}, conversationAliases: {} }),
  }),
  liveness: async () => [], lifecycleJournal: () => ({ version: 1, events: [], nextSeq: 1 }),
  latestDeployment: () => ({ state: "unreadable", error: "synthetic" }), retirementReport: () => null,
  openPullRequests: async () => ({ ok: true, pullRequests: [] }), wakeState: async () => "retained", withdrawWake: async () => "withdrawn",
} as unknown as SeatTickSources;
const ports = productionAutoMergePorts({
  loadPipelines: loadPipelinesForList, setting: () => ({ enabled: true, changedAt: new Date(NOW).toISOString(), changedBy: "operator" }), pullRequestOf: () => null,
  hasPublishedPrototype: () => false, finishTask: () => "missing", run: async () => { throw Error("No network"); }, log: () => {},
});
const date = Date;
const uuid = crypto.randomUUID, bytes = crypto.randomBytes;
let seedId = 0;
let registryDataset: ReturnType<typeof buildRegistryPerformanceDataset>;
try {
  globalThis.Date = new Proxy(date, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [NOW]); },
    apply() { return new date(NOW).toString(); },
    get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
  });
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++seedId).padStart(12, "0")}`;
  crypto.randomBytes = ((size: number) => Buffer.alloc(size, 17)) as typeof crypto.randomBytes;
  registryDataset = buildRegistryPerformanceDataset(root, undefined, { sessionsRoot: path.join(root, "codex", "sessions") });
}
finally { globalThis.Date = date; crypto.randomUUID = uuid; crypto.randomBytes = bytes; }
const corpusHash = crypto.createHash("sha256");
const census = new Database(registryDataset.filename, { readonly: true });
try {
  for (const row of census.query<{ collection: string; row_key: string; value_json: string }, []>(
    "SELECT collection,row_key,value_json FROM registry_records ORDER BY collection,row_key").iterate()) {
    corpusHash.update(JSON.stringify([row.collection, row.row_key, row.value_json.replaceAll(path.dirname(root), "$FIXTURE")]));
  }
} finally { census.close(); }
const registrySha256 = corpusHash.digest("hex");
let registry: SqliteAgentRegistryStore | undefined;
const warmRegistryWriter = new SqliteAgentRegistryStore(registryDataset.filename, {
  normalize: normalizeRegistry, initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
});
const warmRegistryReader = new SqliteAgentRegistryStore(registryDataset.filename, {
  readOnly: true, normalize: normalizeRegistry, initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
});
await warmRegistryReader.prepareReadOnlySnapshot();
const cases = {
  memory: async () => {
    fs.writeFileSync(memoryFile, memoryText + `\n- Revision ${++iteration}.`);
    fs.utimesSync(memoryFile, new Date(NOW + iteration * 1000), new Date(NOW + iteration * 1000));
    return refreshMemoryIndex({ claudeHomes: [], codexHome: path.join(root, "codex"), skillRoots: [] });
  },
  seat: async () => {
    const input = await gatherSeatTickInput("fixture", emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, sources);
    setImmediate(() => {
      sourcePipelines = Object.freeze(sourcePipelines.map((pipeline, index) => index === 0
        ? Object.freeze({ ...pipeline, task: "", spec: `replacement spec projection #654321\n${"Evidence changed. ".repeat(1200)}` }) : pipeline));
    });
    const refreshed = await refreshSeatTickEvidence(input, sources);
    return { pipelines: refreshed.pipelines.length, ownLanes: refreshed.ownLanes.length,
      specTitle: refreshed.pipelines[0]?.title ?? null,
      specProjected: refreshed.pipelines[0]?.title.startsWith("replacement spec projection") ?? false };
  },
  merge: async () => {
    for (let i = 0; i < 6; i++) await ports.mutate(pipelines[pipelines.length - 1 - i]!.id, row => { row.stateDetail = `sample-${++iteration}`; return true; });
    await sweepAutoMerge(ports);
    await sweepTaskFinishes(ports);
  },
  registry: () => withViewerOperation("http.render", async () => {
    registry?.close();
    registry = new SqliteAgentRegistryStore(registryDataset.filename, { normalize: normalizeRegistry, initialSnapshot: normalizeRegistry({ version: 2, entries: {}, receipts: {} }), readOnly: true });
    return Object.keys((await registry.prepareReadOnlySnapshot()).file.entries).length;
  }),
  "registry-warm": () => withViewerOperation("http.render", async () => {
    const archived = warmRegistryWriter.archiveInactive(1);
    if (archived !== 1) throw Error("warm registry fixture has no eligible archive row");
    return Object.keys((await warmRegistryReader.prepareReadOnlySnapshot()).file.entries).length;
  }),
  session: async () => {
    closeAgentRegistryForTests();
    setAgentRegistryForTests(null);
    const response = await sessionGet(new NextRequest(`http://127.0.0.1/api/session?conversationId=${registryDataset.conversations[0]!.conversationId}`));
    if (response.status !== 200) throw Error("synthetic session must be readable");
    return response.status;
  },
};

const conditions = {
  runtime: Bun.version, utc: new Date().toISOString(), synthetic: { agents: 0, mutatingLanes: 6, mutationPosition: "tail", pipelines: pipelines.length,
    pipelinePayloadField: "spec", pipelineBytes: Buffer.byteLength(JSON.stringify(pipelines)), mergeQueueRows: pipelines.length,
    openLanes: 603, ownSettledLanes: 201, activeSeat: true,
    tasks: tasks.length, memoryBytes: Buffer.byteLength(memoryText), memoryEntries: 3500,
    registryRows: registryDataset.rows, registryBytes: registryDataset.payloadBytes, warmArchiveInvalidations: 3, registrySha256 },
};
type StackTrace = { traces: Array<{ frames: Array<{ name: string }> }> };
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    if (!Object.hasOwn(cases, name)) return new Response("missing", { status: 404 });
    const run = cases[name as keyof typeof cases];
    performanceSpans.clear();
    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => { const at = performance.now(); gaps.push(Math.max(0, at - last - 1)); last = at; }, 1);
    await new Promise(resolve => setImmediate(resolve));
    const cpu = process.cpuUsage(), start = performance.now();
    let answer: unknown;
    try {
      const capture = await profile(async () => {
        answer = await run();
        // A timer opportunity after the final continuation accounts for its gap.
        await new Promise(resolve => setTimeout(resolve, 0));
      }, 1000);
      const spans = performanceSpans.snapshot();
      const frames = new Map<string, number>();
      const traces = (capture.stackTraces as unknown as StackTrace).traces;
      for (const trace of traces) {
        const frame = trace.frames[0];
        if (frame && /^[A-Za-z_$][\w$]*$/.test(frame.name)) frames.set(frame.name, (frames.get(frame.name) ?? 0) + 1);
      }
      const sync = spans.records.filter(span => span.kind === "sync");
      const exclusiveMs: Record<string, number> = {};
      for (const span of sync) {
        const children = sync.filter(child => child.parent === span.span).reduce((total, child) => total + child.totalMs, 0);
        const site = performanceSites[span.site]!;
        exclusiveMs[site] = (exclusiveMs[site] ?? 0) + Math.max(0, span.totalMs - children);
      }
      gaps.sort((a, b) => a - b);
      return Response.json({ name, elapsed: performance.now() - start, profiledSyncMs: traces.filter(trace => trace.frames.length > 0).length, unresolvedSamples: traces.filter(trace => !trace.frames.length).length, cpu: process.cpuUsage(cpu), load: os.loadavg(),
        gapP95: gaps[Math.floor(gaps.length * .95)] ?? 0, gapMax: gaps.at(-1) ?? 0,
        exclusiveMs, spansDropped: spans.dropped, top: [...frames].sort((a, b) => b[1] - a[1]).slice(0, 18),
        longestSlices: sync.toSorted((a, b) => b.maxMs - a.maxMs).slice(0, 8).map(span => ({ site: performanceSites[span.site], maxMs: span.maxMs })),
        ...(name === "memory" || name === "session" || name === "seat" ? { answer } : {}) });
    } finally { clearInterval(timer); }
  },
});
console.log(JSON.stringify({ ready: server.url.origin, conditions }));
const stop = () => { server.stop(true); registry?.close(); warmRegistryReader.close(); warmRegistryWriter.close(); closeAgentRegistryForTests(); setAgentRegistryForTests(null); };
process.on("SIGTERM", () => { stop(); process.exit(0); });
if (!process.argv.includes("--serve")) {
  const output = process.argv[2];
  if (!output) throw Error("expected a result file or --serve");
  const runs: unknown[] = [];
  try {
    for (let repeat = 0; repeat < 3; repeat++) for (const name of Object.keys(cases)) {
      const response = await fetch(new URL(name, server.url));
      if (!response.ok) throw Error("benchmark request failed");
      const row = await response.json(); runs.push(row); console.log(JSON.stringify(row));
    }
    fs.writeFileSync(output, JSON.stringify({ conditions, runs }, null, 2));
  } finally { stop(); }
}
