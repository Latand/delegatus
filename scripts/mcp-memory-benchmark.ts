/** Reproducible stdio/HTTP memory replay. Run through gate-slot.sh, on Linux.
 * Each invocation owns its state, provider homes, PID namespace and listeners.
 * Compare the answer hashes from two revisions; no operator data is read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const root = process.env.MCP_MEMORY_ROOT!;
const stamp = "2026-01-01T00:00:00.000Z";
const namespace = () => fs.readlinkSync("/proc/self/ns/pid");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));

function comparable(tool: string, result: Record<string, unknown>) {
  const value = structuredClone(result);
  if (tool === "agent_activity" && typeof value.observedAt === "string") value.observedAt = "<observation-time>";
  if (tool === "agent_activity" && Array.isArray(value.conversations)) {
    for (const conversation of value.conversations) {
      for (const field of ["silentForMs", "stalledForMs"]) {
        if (typeof conversation[field] === "number" && conversation[field] > 0) conversation[field] = "<positive-clock-duration>";
      }
    }
  }
  if (tool === "agent_activity" && value.timings && typeof value.timings === "object") {
    value.timings = Object.fromEntries(Object.entries(value.timings).map(([key, duration]) =>
      [key, typeof duration === "number" ? "<measured-duration>" : duration]));
  }
  if (tool === "conversation_messages" && typeof value.cursor === "string") {
    const cursor = JSON.parse(Buffer.from(value.cursor, "base64url").toString());
    // The transcript path is private to the run. Keep the byte offset, record
    // index and all record fingerprints; only its path/filter scope differs.
    if (typeof cursor.s !== "string") throw new Error("Unknown conversation cursor");
    cursor.s = "<transcript-scope>";
    value.cursor = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  }
  return JSON.stringify(value);
}

function isolated(directory: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && !/^(LLV_|DELEGATUS_|NEXT_PUBLIC_|MCP_MEMORY_|TMUX)/.test(entry[0])));
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "LLV_STATE_DIR", "TMPDIR", "CLAUDE_CODE_TMPDIR", "TMUX_TMPDIR", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "GH_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    env[name] = path.join(directory, name);
    fs.mkdirSync(env[name], { recursive: true });
  }
  return { ...env, LLV_CODEX_HOME: env.CODEX_HOME!, LLV_CLAUDE_HOME: env.CLAUDE_CONFIG_DIR!, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_STATE_ACTIVATION: "sqlite", LLV_AGENT_REGISTRY_SQLITE: "sqlite", NODE_ENV: "test", MCP_MEMORY_ROOT: directory };
}

function requirePrivateProc() {
  if (!process.env.MCP_MEMORY_HOST_NS || namespace() === process.env.MCP_MEMORY_HOST_NS
    || fs.readlinkSync("/proc/self") !== String(process.pid)) throw new Error("A private PID namespace is required");
}

async function waitFile(name: string) {
  for (let i = 0; i < 1200; i++) {
    if (fs.existsSync(path.join(root, name))) return read(name);
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${name}`);
}

if (mode === "compare") {
  const [beforePath, afterPath] = process.argv.slice(3);
  if (!beforePath || !afterPath) throw new Error("Usage: mcp-memory-benchmark.ts compare <before> <after>");
  const before = JSON.parse(fs.readFileSync(path.join(beforePath, "result.json"), "utf8"));
  const after = JSON.parse(fs.readFileSync(path.join(afterPath, "result.json"), "utf8"));
  const answers = before.answers.map((row: { tool: string; round: number }, index: number) => {
    if (after.answers[index]?.tool !== row.tool || after.answers[index]?.round !== row.round) throw new Error("Different call sequences");
    const filename = `${row.round}-${row.tool}.answer.json`;
    const a = comparable(row.tool, JSON.parse(fs.readFileSync(path.join(beforePath, filename), "utf8")));
    const b = comparable(row.tool, JSON.parse(fs.readFileSync(path.join(afterPath, filename), "utf8")));
    if (a !== b) throw new Error(`Answer differs: ${filename}`);
    // Check the complete MCP answer as well as its structured payload. The
    // SDK's text block must be the exact JSON spelling of that same payload.
    const envelopes = [beforePath, afterPath].map(directory => {
      const envelope = JSON.parse(fs.readFileSync(path.join(directory, `${row.round}-${row.tool}.response.json`), "utf8"));
      const { structuredContent, content, ...rest } = envelope;
      if (content.length !== 1 || content[0].type !== "text" || content[0].text !== JSON.stringify(structuredContent)) {
        throw new Error(`Text and structured answer differ: ${filename}`);
      }
      return JSON.stringify({ ...rest, content: [{ type: "text", text: comparable(row.tool, structuredContent) }], structuredContent: JSON.parse(comparable(row.tool, structuredContent)) });
    });
    if (envelopes[0] !== envelopes[1]) throw new Error(`MCP envelope differs: ${filename}`);
    const { tool, round } = row;
    return { tool, round, hash: createHash("sha256").update(a).digest("hex"), bytes: Buffer.byteLength(a),
      responseHash: createHash("sha256").update(envelopes[0]!).digest("hex"), responseBytes: Buffer.byteLength(envelopes[0]!) };
  });
  if (answers.length !== after.answers.length) throw new Error("Different call counts");
  console.log(JSON.stringify({ equivalent: true, calls: answers.length, normalization: ["sandbox root", "fixture conversation id", "activity observation time and positive clock durations; zero/null preserved", "activity phase durations; field names preserved", "transcript cursor scope; offsets and fingerprints preserved"], answers }, null, 2));
} else if (mode === "seed") {
  requirePrivateProc();
  const { pipelineCorpus } = await import("../src/lib/pipelines/fixtures/corpus");
  const { savePipelines } = await import("../src/lib/pipelines/store");
  const { saveTasks } = await import("../src/lib/tasks/store");
  const { agentRegistry } = await import("../src/lib/agent/registry");
  const { projectForCwd } = await import("../src/lib/scanner/describe");
  const { internalServiceHeaders } = await import("../src/lib/agent/operatorAuthority");
  internalServiceHeaders("mcp");
  const cwd = "/fixture/mcp-memory";
  const transcript = path.join(process.env.CODEX_HOME!, "sessions", "2026", "01", "01", "rollout-memory.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const rows: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: "memory-fixture-session", cwd } }];
  for (let i = 0; i < 200; i++) rows.push({ timestamp: stamp, type: "response_item", payload: { type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: "output_text", text: `Message ${i} ${"fixture content ".repeat(1000)}` }] } });
  fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const registry = agentRegistry();
  const begun = registry.beginSpawn("codex", cwd, { title: "Memory benchmark caller", cwd });
  const settled = registry.settleSpawn(begun.launchId, { key: { engine: "codex", sessionId: "memory-fixture-session" }, artifactPath: transcript, cwd, accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("Fixture settlement failed");
  const project = projectForCwd(cwd)!;
  const { indexTranscriptSources } = await import("../src/lib/search/transcriptSearch");
  const stat = fs.statSync(transcript);
  await indexTranscriptSources([{ path: transcript, engine: "codex", project, size: stat.size, mtimeMs: stat.mtimeMs }], { complete: true });
  const lanes = pipelineCorpus(120, 6);
  for (const lane of lanes) {
    lane.project = project; lane.createdAt = stamp;
    if (lane.closedAt) lane.closedAt = stamp;
    for (const run of lane.runs) for (const attempt of run.attempts) { attempt.startedAt = stamp; attempt.completedAt = stamp; }
  }
  savePipelines(lanes);
  const taskId = ["0".repeat(8), "0".repeat(4), "4000", "8000", String(1).padStart(12, "0")].join("-");
  saveTasks([{ id: taskId, project, status: "inbox", text: "Memory benchmark prototype", placement: "unplaced", assignments: [], createdAt: stamp, updatedAt: stamp,
    prototypeReviews: [{ id: "round-fixture", title: "Memory fixture", taskId, project, createdAt: stamp, source: { conversationId: null }, publicationKey: "fixture-key", inputDigest: "a".repeat(64),
      variants: [{ number: 1, name: "Fixture variant", description: "Review description. ".repeat(500), frames: [], videos: [] }] }],
  }]);
  write("fixture.json", { transcript, conversationId: settled.conversation.id, taskId, capability: registry.rotateSpawnCapabilityForReceipt(begun.launchId), pipelineJsonBytes: Buffer.byteLength(JSON.stringify(lanes)) });
  process.exit(0);
} else if (mode === "viewer") {
  requirePrivateProc();
  const { NextRequest } = await import("next/server");
  const { handleMcpHttpRequest } = await import("../src/lib/mcp/http");
  const { reviewReadPOST, reviewScopePOST } = await import("../src/lib/prototypeReview/http");
  const { transcriptSearchPage } = await import("../src/lib/search/transcriptSearchPage");
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/mcp") return handleMcpHttpRequest(new NextRequest(request));
    if (pathname === "/api/prototype-reviews/read") return reviewReadPOST(new NextRequest(request));
    if (pathname === "/api/prototype-reviews/scope") return reviewScopePOST(new NextRequest(request));
    if (pathname === "/api/search/transcripts") return transcriptSearchPage(request);
    return new Response("Fixture route not exposed", { status: 404 });
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${listener.port}`;
  write("viewer.json", { origin: process.env.LLV_VIEWER_CONTROL_URL });
} else if (mode === "agent") {
  requirePrivateProc();
  const { heapStats } = await import("bun:jsc");
  const { startViewerMcpServer } = await import("../src/lib/mcp/server");
  await startViewerMcpServer();
  setInterval(() => {
    const command = path.join(root, "sample");
    if (!fs.existsSync(command)) return;
    const label = fs.readFileSync(command, "utf8"); fs.unlinkSync(command);
    if (label.endsWith("gc")) Bun.gc(true);
    const { heapSize, heapCapacity, extraMemorySize, objectCount } = heapStats();
    write(`${label}.json`, { rss: process.memoryUsage().rss, heapSize, heapCapacity, extraMemorySize, objectCount });
  }, 25);
} else if (mode === "run") {
  requirePrivateProc();
  const seed = Bun.spawn([process.execPath, script, "seed"], { stdout: "inherit", stderr: "inherit" });
  if (await seed.exited !== 0) throw new Error("Fixture seeding failed");
  const fixture = read("fixture.json");
  const viewer = Bun.spawn([process.execPath, script, "viewer"], { stdout: "inherit", stderr: "inherit" });
  const client = new Client({ name: "memory-benchmark", version: "1" });
  let transport: StdioClientTransport | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    const { origin } = await waitFile("viewer.json");
    transport = new StdioClientTransport({ command: process.execPath, args: [script, "agent"], env: {
      ...process.env as Record<string, string>, LLV_SPAWN_CAPABILITY: fixture.capability, LLV_VIEWER_CONTROL_URL: origin,
    }, stderr: "inherit" });
    await client.connect(transport);
    const pid = transport.pid!;
    const rss = () => Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)![1]) * 1024;
    let peakRss = rss();
    sampler = setInterval(() => { peakRss = Math.max(peakRss, rss()); }, 10);
    async function sample(label: string) {
      fs.writeFileSync(path.join(root, "sample"), label);
      return { ...await waitFile(`${label}.json`), rss: rss() };
    }
    const atSpawn = await sample("spawn");
    const before = await sample("before-gc");
    const answers: Array<{ round: number; tool: string; bytes: number; hash: string; responseBytes: number; responseHash: string; elapsedMs: number; rssAfter: number }> = [];
    // Native times and sandbox identities differ between independent runs.
    // No text, records, result codes or pagination fields are omitted.
    const normalize = (value: unknown): unknown => {
      if (typeof value === "string") return value.replaceAll(root, "<sandbox>").replaceAll(fixture.conversationId, "conversation_fixture").replaceAll(fixture.transcript, "<transcript>");
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
      return value;
    };
    const steps: Array<[string, Record<string, unknown>]> = [
      ["list_pipelines", { full: true, includeClosed: true, limit: 200 }],
      ["get_pipeline", { pipelineId: "p0000001", full: true }],
      ["conversation_messages", { transcriptPath: fixture.transcript, limit: 200, maxChars: 16000 }],
      ["read_prototype_review", { taskId: fixture.taskId }],
      ["agent_activity", { full: true, transcriptPath: fixture.transcript, limit: 200 }],
      ["search_transcripts", { query: "fixture", order: "newest", limit: 100, full: true }],
    ];
    for (let round = 0; round < 3; round++) for (const [tool, args] of steps) {
      const started = performance.now();
      const response = await client.callTool({ name: tool, arguments: { ...args, clientRequestId: `memory-${round}-${tool}` } });
      const elapsedMs = performance.now() - started;
      const result = response.structuredContent as Record<string, unknown>;
      if (!result?.ok) throw new Error(`${tool}: ${JSON.stringify(result)}`);
      const serialized = JSON.stringify(normalize(result));
      fs.writeFileSync(path.join(root, `${round}-${tool}.answer.json`), serialized);
      const rawResponse = JSON.stringify(response);
      fs.writeFileSync(path.join(root, `${round}-${tool}.response.json`), JSON.stringify(normalize(response)));
      answers.push({ round, tool, bytes: Buffer.byteLength(serialized), hash: createHash("sha256").update(serialized).digest("hex"),
        responseBytes: Buffer.byteLength(rawResponse), responseHash: createHash("sha256").update(rawResponse).digest("hex"), elapsedMs, rssAfter: rss() });
      console.error(`round ${round + 1} ${tool}: ${Math.round(rss() / 1048576)} MiB`);
    }
    await sleep(30_000);
    const afterIdle = await sample("after-idle");
    const afterGc = await sample("after-gc");
    write("result.json", { measuredAt: new Date().toISOString(), runtime: Bun.version, pipelines: 120, pipelineJsonBytes: fixture.pipelineJsonBytes, rounds: 3, idleMs: 30_000, peakRss, atSpawn, before, afterIdle, afterGc, answers });
    console.log(JSON.stringify(read("result.json")));
  } finally {
    if (sampler) clearInterval(sampler);
    await client.close(); await transport?.close();
    viewer.kill(); await viewer.exited;
  }
} else {
  const output = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "mcp-memory-")));
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("The output directory must be empty");
  fs.mkdirSync(output, { recursive: true });
  const env = { ...isolated(output), MCP_MEMORY_HOST_NS: namespace() };
  const child = Bun.spawn(["unshare", "--user", `--map-user=${process.getuid!()}`, `--map-group=${process.getgid!()}`, "--pid", "--fork", "--kill-child", "--mount-proc", "sh", "-c", '"$@"; exit $?', "sh", process.execPath, script, "run"], { env, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
