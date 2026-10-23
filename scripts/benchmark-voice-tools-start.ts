/* Voice call start with 0, 8 and 16 approved added MCP servers (docs/design/voice-extensible-tools.md §4.8, slice 2).

     bun scripts/benchmark-voice-tools-start.ts [--runs 60] [--warmup 10]

   Measures, in one process and against a private state directory:
   - the start route's work: `CompanionLiveSessions.start` with the documented fake Live provider, so no network time
     is included (the route awaits exactly this call);
   - the bytes of the first backend request of a delegation (`provider.respond` body as JSON);
   - the bytes of the Live session configuration the call is minted with.
   The call has call memory as the Viewer passes it, switched off and with a summarizer that refuses, so no model runs.
   The registry holds the same synthetic catalog on every revision: N approved HTTP servers with 32 selected tools in
   total, written through the store's own proposal, probe record and approval, so the data is identical before and after.
   No server is contacted and no child process is started. Run the same file on the base and on the head and compare. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const option = (name: string, fallback: number) => { const at = process.argv.indexOf(name); return at > 0 ? Number(process.argv[at + 1]) : fallback; };
const RUNS = option("--runs", 60), WARMUP = option("--warmup", 10);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-tools-bench-"));
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "LLV_STATE_DIR"]) process.env[name] = path.join(root, name.toLowerCase());
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:9";
process.env.OPENAI_API_KEY = "";

const { CompanionStorage } = await import("../src/lib/voiceCompanion/storage");
const { CompanionAdmission } = await import("../src/lib/voiceCompanion/admission");
const { CompanionLiveSessions } = await import("../src/lib/voiceCompanion/liveSession");
const { FakeLiveProvider, backendResponse, delegationCreated, message } = await import("../src/lib/voiceCompanion/fakeProvider");
const { fixtureBoardReads } = await import("../src/lib/voiceCompanion/boardReads.fixture");
const { CallMemory } = await import("../src/lib/voiceCompanion/callMemory");
const { VoiceToolsStore } = await import("../src/lib/voiceTools/store");
const { validateCatalog, digest } = await import("../src/lib/voiceTools/contracts");
// Present from slice 2 on; the base has no voice side of the hub.
const sessionsModule = await import("../src/lib/voiceTools/sessions" as string).catch(() => null) as null | { VoiceToolSessions: new (store: unknown) => unknown };

const at = "2026-01-01T00:00:00.000Z";
function catalog(server: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, description: `Synthetic tool ${index} of ${server}: reads or changes one thing the operator named, and answers in one sentence.`,
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for, in the operator's words." }, limit: { type: "integer", minimum: 1, maximum: 50 },
      exact: { type: "boolean" } }, required: ["query"] }, annotations: { readOnlyHint: index % 2 === 0 } }));
}
async function registry(count: number) {
  const directory = path.join(root, `registry-${count}`);
  const store = new VoiceToolsStore(directory, () => at);
  for (let index = 0; index < count; index++) {
    const name = `server_${index}`;
    await store.propose({ name, title: `Server ${index}`, capability: `Synthetic server ${index}: answers questions about one synthetic domain.`,
      transport: { type: "http", url: `http://127.0.0.1:9/mcp/${index}` } }, { kind: "operator", conversationId: null, at });
    const tools = validateCatalog(name, catalog(name, 32 / count));
    await store.recordProbe(name, (await store.view()).servers[name].digest, { code: "OK", catalog: { digest: digest(tools), fetchedAt: at, tools } });
    await store.operatorChange(name, (await store.view()).servers[name].digest, "configure", { tools: Object.fromEntries(tools.map(tool => [tool.name, { enabled: true, acts: tool.annotations?.readOnlyHint !== true }])) });
    await store.operatorChange(name, (await store.view()).servers[name].digest, "approve");
  }
  return store;
}
// One storage and admission for every side: each call is closed before the next one starts.
const storage = new CompanionStorage();
// Call memory is switched off, as the Viewer passes it (server.ts) without a model behind it: its summarizer refuses.
storage.updateSettings({ enabled: true, monthlyCapUsd: 10_000, callMemory: false });
const admission = new CompanionAdmission(storage, { recipient: () => ({ project: "fixture", conversationId: "conversation_fixture", seatEpoch: 1, engine: "claude" }),
  send: async () => ({ status: "queued", operationId: "operation_fixture" }), reports: () => [] });
const reads = fixtureBoardReads({ tasks: () => [], pipelines: () => [], activity: async () => [], messages: async () => [] });
function service(store: InstanceType<typeof VoiceToolsStore>) {
  const provider = new FakeLiveProvider();
  provider.responder = (_request, at) => backendResponse(`resp_${at}`, [message("Done.")]);
  const voiceTools = sessionsModule ? new sessionsModule.VoiceToolSessions(store) as { snapshot(starter: unknown): unknown } : undefined;
  return { provider, voiceTools, live: new CompanionLiveSessions(storage, admission, reads, provider, { key: () => "synthetic-credential", closeTimeoutMs: 1, timers: false,
    memory: new CallMemory(storage, admission.records, async () => { throw new Error("NO_MODEL_IN_BENCHMARK"); }),
    ...(voiceTools ? { voiceTools: voiceTools as never } : {}) }) };
}
const counts = [0, 8, 16];
const sides: Array<{ count: number } & ReturnType<typeof service>> = [];
for (const count of counts) sides.push({ count, ...service(await registry(count)) });
const latency = new Map<number, number[]>(counts.map(count => [count, []]));
const bytes = new Map<number, { backend: number; live: number }>();
let sequence = 0;
for (let run = 0; run < WARMUP + RUNS; run++) {
  // Interleaved, so drift in machine load touches every count alike.
  for (const side of sides) {
    const started = performance.now();
    const call = await side.live.start({ project: "fixture", locale: "en", sdp: "v=0", startedBy: { operator: true }, requestId: `bench-${sequence++}` });
    const elapsed = performance.now() - started;
    if (run >= WARMUP) latency.get(side.count)!.push(elapsed);
    if (!bytes.has(side.count)) {
      side.provider.replay(call.providerId, { type: "session.input_transcript.delta", event_id: "input-0", delta: "What is on the board?", start_ms: 0, end_ms: 400 }, delegationCreated("bench", 600));
      await side.live.drain(call.sessionId);
      const { liveSessionConfiguration } = await import("../src/lib/voiceCompanion/sessionConfig");
      const snapshot = side.voiceTools?.snapshot({ operator: true });
      bytes.set(side.count, { backend: Buffer.byteLength(JSON.stringify(side.provider.requests[0])),
        live: Buffer.byteLength(JSON.stringify((liveSessionConfiguration as (...args: unknown[]) => unknown)("en", "fixture", "", snapshot))) });
    }
    await side.live.close(call.sessionId);
  }
}
const quantile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };
console.log(JSON.stringify({ bun: process.versions.bun, cpus: os.cpus().length, loadavg: os.loadavg().map(value => Number(value.toFixed(2))), runs: RUNS, warmup: WARMUP,
  voiceSide: !!sessionsModule,
  results: counts.map(count => ({ servers: count, tools: count ? 32 : 0, startMs: { median: Number(quantile(latency.get(count)!, 0.5).toFixed(3)), p90: Number(quantile(latency.get(count)!, 0.9).toFixed(3)),
    min: Number(Math.min(...latency.get(count)!).toFixed(3)) }, backendRequestBytes: bytes.get(count)!.backend, liveSessionBytes: bytes.get(count)!.live })) }, null, 2));
fs.rmSync(root, { recursive: true, force: true });
