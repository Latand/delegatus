/* The state-writer mode of mcp-call-cost-benchmark.ts. Every process uses a
 * generated fixture, and the outer caller supplies the owned CPU runner. */
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NextRequest } from "next/server";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ownFixtureChild, reapFixtureChildren } from "../src/lib/mcp/ownedFixtureChildren";

const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-01T00:00:00.000Z";
function environment(root: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && !/^(LLV_|DELEGATUS_|MCP_SQL_|NEXT_PUBLIC_|TMUX)/.test(entry[0])));
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMUX_TMPDIR", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "GH_CONFIG_DIR"]) {
    env[name] = path.join(root, name);
    fs.mkdirSync(env[name]!, { recursive: true });
  }
  // The state guard admits the complete fixture tree through this temp root.
  env.TMPDIR = root;
  return { ...env, CODEX_HOME: env.LLV_CODEX_HOME!, CLAUDE_CONFIG_DIR: env.LLV_CLAUDE_HOME!,
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_STRUCTURED_HOSTS: "0", LLV_STATE_ACTIVATION: "sqlite", NODE_ENV: "test" };
}
async function waitFile(filename: string, child: ReturnType<typeof Bun.spawn>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(filename)) {
    if (child.exitCode !== null) throw new Error(`fixture exited ${child.exitCode} before ${path.basename(filename)}`);
    if (Date.now() > deadline) throw new Error(`fixture readiness timed out: ${path.basename(filename)}`);
    await Bun.sleep(10);
  }
}

export async function stateWriterChild(mode: string): Promise<void> {
  if (mode === "seed") {
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: {}, displayNames: { fixture: "Fixture" } }));
    const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
    beginOrchestratorSeatIntent({ project: "fixture", mandate: "Fixture board", clientRequestId: "fixture-seat", mode: "existing", now: at });
    completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "fixture-seat", conversationId: "conversation_fixture_seat", path: null, preparedAuthCredentialBaseline: null, now: at });
    const { saveTasks } = await import("@/lib/tasks/store");
    const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
    const { tombstoneCollection } = await import("@/lib/links/tombstones");
    const { agentRegistry } = await import("@/lib/agent/registry");
    const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
    saveTasks(Array.from({ length: 1000 }, (_, n) => ({ id: taskId(n), project: "fixture", text: `Task ${n}`, status: "inbox" as const,
      placement: "unplaced" as const, board: n < 37 ? "shown" as const : "hidden" as const, assignments: [], createdAt: at, updatedAt: at })));
    const lanes = Array.from({ length: 900 }, (_, n) => buildPipeline({ id: `inert-${n}`, task: `Inert ${n}`, project: "fixture", repoDir: "/fixture", stages: [{
      id: "build", kind: "run", prompt: "Fixture", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
    }], srcPath: null, srcConversationId: null, now: at }));
    savePipelines(lanes);
    await tombstoneCollection(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), true)!.mutate((rows, persist) => {
      rows.push(...Array.from({ length: 100 }, (_, n) => ({ id: `deleted-${n}`, project: "fixture", gone: "1790812800000.000.aaaaaaaa", o: "fixture-install" })));
      persist();
    });
    const registry = agentRegistry();
    const capabilities: string[] = [];
    for (let n = 0; n < 37; n++) {
      const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: "/fixture", role: "builder", origin: { kind: "operator" } });
      if (begun.kind !== "created") throw new Error("fixture admission failed");
      capabilities.push(registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId));
    }
    fs.writeFileSync(process.env.MCP_BENCH_READY!, JSON.stringify(capabilities), { mode: 0o600 });
    const { Database } = await import("bun:sqlite");
    const verify = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    try {
      const counts = verify.query<{ collection: string; count: number }, []>("SELECT collection,count(*) AS count FROM state_rows GROUP BY collection").all();
      if (counts.find(row => row.collection === "tasks")?.count !== 1037 || counts.find(row => row.collection === "pipelines")?.count !== 900
        || counts.find(row => row.collection === "task_tombstones")?.count !== 100) throw new Error("seed row counts differ from the declared fixture");
      fs.writeFileSync(`${process.env.MCP_BENCH_READY}.counts.json`, JSON.stringify(counts));
    } finally { verify.close(); }
    return;
  }
  if (mode === "viewer") {
    if (!process.env.MCP_BENCH_HOST_NAMESPACE || fs.readlinkSync("/proc/self/ns/pid") === process.env.MCP_BENCH_HOST_NAMESPACE
      || fs.readlinkSync("/proc/self") !== String(process.pid)) throw new Error("fixture Viewer needs its own process namespace");
    // The identical observer also covers a candidate's Viewer-owned task
    // executor. Older revisions have no executor to install a launch for.
    if (fs.existsSync(path.resolve("src/lib/mcp/taskExecutor.ts"))) {
      const { McpTaskExecutor } = await import("../src/lib/mcp/taskExecutor");
      const wrapper = path.join(process.env.TMPDIR!, "task-observed-bun");
      const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} --preload ${quote(path.resolve("scripts/sqlite-observer.ts"))} "$@"\n`, { mode: 0o700 });
      (globalThis as Record<symbol, unknown>)[Symbol.for("llv.mcp.taskExecutor")] = new McpTaskExecutor({
        launch: { executable: wrapper, workerPath: path.resolve("src/lib/mcpTask.worker.ts") },
        env: { MCP_BENCH_TASK_EXECUTOR: "1" },
      });
    }
    const { handleMcpHttpRequest } = await import("@/lib/mcp/http");
    const { createProductionViewerMcpService } = await import("@/lib/mcp/server");
    const service = createProductionViewerMcpService(false);
    await service;
    (globalThis as Record<symbol, unknown>)[Symbol.for("llv.mcp.httpService")] = service;
    const { viewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");
    viewerLoopMonitor.start();
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    let phase = "cold";
    const boundaries: ReturnType<typeof setTimeout>[] = [];
    const sample = () => fs.appendFileSync(process.env.MCP_BENCH_RESOURCES!, `${JSON.stringify({ at: Date.now(), phase, cpu: process.cpuUsage(), rss: process.memoryUsage().rss,
      loopP50: delay.percentile(50) / 1e6, loopP95: delay.percentile(95) / 1e6, loopP99: delay.percentile(99) / 1e6, loopMax: delay.max / 1e6 })}\n`);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch: async request => {
      if (new URL(request.url).pathname === "/fixture-boundaries") {
        const input = await request.json() as { warmEnd: number; measuredEnd: number };
        phase = "warm"; delay.reset();
        boundaries.push(setTimeout(() => { sample(); phase = "measured"; delay.reset(); sample(); }, Math.max(0, input.warmEnd - Date.now())));
        boundaries.push(setTimeout(() => { sample(); phase = "drain"; delay.reset(); }, Math.max(0, input.measuredEnd - Date.now())));
        return Response.json({ ok: true });
      }
      return handleMcpHttpRequest(new NextRequest(request));
    } });
    process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
    fs.writeFileSync(process.env.MCP_BENCH_READY!, JSON.stringify({ url: server.url.origin, pid: process.pid }));
    const timer = setInterval(sample, 1000);
    const stop = () => { clearInterval(timer); boundaries.forEach(clearTimeout); delay.disable(); viewerLoopMonitor.stop(); server.stop(true); process.exit(0); };
    process.on("SIGTERM", stop);
    return;
  }
  throw new Error(`unknown state writer fixture mode: ${mode}`);
}

function census(pids: Set<number>) {
  // Children are discovered only through the recorded fixture parents. This
  // process runs in a private PID namespace, with no machine peers visible.
  for (const pid of pids) {
    try {
      for (const name of fs.readdirSync(`/proc/${pid}/task`)) {
        const children = fs.readFileSync(`/proc/${pid}/task/${name}/children`, "utf8").trim();
        for (const child of children.split(/\s+/).filter(Boolean)) pids.add(Number(child));
      }
    } catch { /* a recorded fixture exited */ }
  }
  return [...pids].flatMap(pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      if (stat[0] === "Z") return [];
      let main = 0, wal = 0, shm = 0;
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        let target = ""; try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (target.endsWith("/state.sqlite")) main++;
        if (target.endsWith("/state.sqlite-wal")) wal++;
        if (target.endsWith("/state.sqlite-shm")) shm++;
      }
      return [{ pid, start: stat[19], main, wal, shm, cpuTicks: Number(stat[11]) + Number(stat[12]), rssPages: Number(stat[21]) }];
    } catch { return []; }
  });
}

export async function runStateWriterSample(): Promise<void> {
  const root = process.env.MCP_BENCH_OUTPUT!;
  const scratch = process.env.MCP_BENCH_SCRATCH_ROOT ?? "/tmp";
  const relative = root ? path.relative(scratch, root) : "";
  if (!path.isAbsolute(scratch) || !relative || relative.startsWith("..") || path.isAbsolute(relative)
    || !process.env.MCP_SQL_OBSERVER) throw new Error("state writer sample requires isolated output and a validated observer");
  if (!process.env.MCP_BENCH_HOST_NAMESPACE || fs.readlinkSync("/proc/self/ns/pid") === process.env.MCP_BENCH_HOST_NAMESPACE
    || fs.readlinkSync("/proc/self") !== String(process.pid)) throw new Error("fixture needs its own process namespace");
  fs.mkdirSync(root, { recursive: true });
  const group = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!group) throw new Error("fixture needs readable cgroup quota evidence");
  const quotaHierarchyLeafFirst: Record<string, string>[] = [];
  for (let directory = path.join("/sys/fs/cgroup", group); directory.startsWith("/sys/fs/cgroup"); directory = path.dirname(directory)) {
    quotaHierarchyLeafFirst.push(Object.fromEntries(["cpu.max", "memory.max", "cpuset.cpus.effective"].flatMap(name => {
      const filename = path.join(directory, name);
      return fs.existsSync(filename) ? [[name, fs.readFileSync(filename, "utf8").trim()]] : [];
    })));
  }
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ bunVersion: Bun.version, quotaHierarchyLeafFirst }));
  const env = environment(path.join(root, "sandbox"));
  fs.cpSync(process.env.MCP_BENCH_SEED!, env.LLV_STATE_DIR!, { recursive: true });
  const capabilities = JSON.parse(fs.readFileSync(process.env.MCP_BENCH_CAPABILITIES!, "utf8")) as string[];
  const count = Number(process.env.MCP_BENCH_CLIENTS ?? 1);
  const warmSeconds = Number(process.env.MCP_BENCH_WARM_SECONDS ?? 30);
  const seconds = Number(process.env.MCP_BENCH_SECONDS ?? 300);
  const mode = process.env.MCP_BENCH_TRANSPORT ?? "stdio";
  const shared = process.env.MCP_BENCH_SHARED === "1";
  const { Database } = await import("bun:sqlite");
  const seedRead = new Database(path.join(env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  const firstTask = seedRead.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection='tasks' AND row_key=?").get(`t:${taskId(0)}`)!;
  let sharedRevision = (JSON.parse(firstTask.value_json) as { revision: string }).revision;
  seedRead.close();
  const observer = path.resolve("scripts/sqlite-observer.ts");
  const events = path.join(root, "sql.ndjson");
  const observed = { MCP_SQL_OBSERVER: process.env.MCP_SQL_OBSERVER!, MCP_SQL_EVENTS: events, MCP_BENCH_LEASES: "1" };
  const ready = path.join(root, "viewer.ready");
  const profile = process.env.MCP_BENCH_PROFILE === "1" ? ["--cpu-prof", `--cpu-prof-dir=${root}`] : [];
  const viewer = ownFixtureChild(Bun.spawn({ cmd: [process.execPath, ...profile, "--preload", observer, "src/lib/mcp/writerConcurrencyChild.ts"],
    env: { ...env, ...observed, LLV_STATE_OWNER: "viewer", MCP_BENCH_CHILD: "viewer", MCP_BENCH_READY: ready, MCP_BENCH_RESOURCES: path.join(root, "viewer.ndjson") },
    stdout: Bun.file(path.join(root, "viewer.stdout")), stderr: Bun.file(path.join(root, "viewer.stderr")) }));
  const pids = new Set([viewer.pid]);
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  const calls: Array<{ client: number; index: number; phase: string; offered: number; name: string; args: Record<string, unknown>; completed?: number; ok?: boolean; code?: string; latency?: number; result?: unknown; reconciled?: unknown }> = [];
  try {
    await waitFile(ready, viewer);
    const { url } = JSON.parse(fs.readFileSync(ready, "utf8")) as { url: string };
    // Node runs the real launcher; its configured Bun wrapper installs the
    // identical observer before the real source entry in each revision.
    const shim = path.join(root, "observed-bun");
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} --preload ${quote(observer)} "$@"\n`, { mode: 0o700 });
    for (let n = 0; n < count && mode === "stdio"; n++) {
      const transport = new StdioClientTransport({ command: "node", args: [path.resolve("bin/mcp-server.mjs")], cwd: process.cwd(),
        env: { ...env, ...observed, LLV_SPAWN_CAPABILITY: capabilities[n]!, LLV_BUN_EXECUTABLE: shim, LLV_VIEWER_CONTROL_URL: url }, stderr: "pipe" });
      const client = new Client({ name: "state-writer-fixture", version: "1" });
      clients.push({ client, transport });
      await client.connect(transport);
      if (transport.pid) pids.add(transport.pid);
      transport.stderr?.on("data", chunk => fs.appendFileSync(path.join(root, `client-${n}.stderr`), chunk));
    }
    // Refuse a broken service before spending a measurement window on errors.
    const probeArgs = { taskId: taskId(0) };
    let probe: { ok?: boolean } | undefined;
    if (mode === "stdio") {
      const response = await clients[0]!.client.callTool({ name: "get_task", arguments: probeArgs });
      probe = response.structuredContent as typeof probe;
    } else {
      const response = await fetch(`${url}/api/mcp`, { method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "x-llv-spawn-capability": capabilities[0]!, origin: url,
      }, body: JSON.stringify({ jsonrpc: "2.0", id: "fixture-preflight", method: "tools/call", params: { name: "get_task", arguments: probeArgs } }) });
      const envelope = await response.json() as { result?: { structuredContent?: typeof probe } };
      probe = envelope.result?.structuredContent;
    }
    if (!probe?.ok) throw new Error(`fixture task preflight failed: ${JSON.stringify(probe)}`);
    const sample = (phase: string) => fs.appendFileSync(path.join(root, "census.ndjson"), `${JSON.stringify({ at: Date.now(), phase, processes: census(pids) })}\n`);
    sample("cold"); sampler = setInterval(() => sample("load"), 250);
    const pending = new Set<Promise<void>>();
    const scheduledStart = performance.now();
    const wallStart = Date.now();
    fs.writeFileSync(path.join(root, "boundaries.json"), JSON.stringify({ coldEnd: wallStart, warmEnd: wallStart + warmSeconds * 1000, measuredEnd: wallStart + (warmSeconds + seconds) * 1000, clients: count, warmSeconds, seconds, mode, shared }));
    await fetch(`${url}/fixture-boundaries`, { method: "POST", body: fs.readFileSync(path.join(root, "boundaries.json"), "utf8") });
    for (let index = 0; index < warmSeconds + seconds; index++) {
      await Bun.sleep(Math.max(0, scheduledStart + index * 1000 - performance.now()));
      const expectedRevision = sharedRevision;
      for (let n = 0; n < count; n++) {
        const phase = index < warmSeconds ? "warm" : "measured";
        const key = `load-${n}-${index}`;
        const kind = index % 10;
        const name = kind < 6 ? "list_tasks" : kind < 9 ? "update_task" : "create_task";
        const args = kind < 6 ? { project: "fixture", limit: 50 } : kind < 9
          ? { taskId: taskId(shared ? 0 : n), text: `Updated ${shared ? "shared" : n} ${index}`, clientRequestId: key,
            ...(shared ? { expectedProject: "fixture", expectedRevision } : {}) }
          : { project: "fixture", text: `Created ${n} ${index}`, placement: "unplaced", board: "hidden", clientRequestId: key };
        const row: typeof calls[number] = { client: n, index, phase, name, args, offered: Date.now() }; calls.push(row);
        const started = performance.now();
        const operation = (async () => {
          try {
            let result: Record<string, unknown>;
            if (mode === "stdio") {
              const response = await clients[n]!.client.callTool({ name, arguments: args });
              const content = response.content as Array<{ text?: string }>;
              if (!response.structuredContent) row.result = response;
              result = response.structuredContent as Record<string, unknown>
                ?? JSON.parse(content[0]?.text ?? "null") as Record<string, unknown>;
            } else {
              const response = await fetch(`${url}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-llv-spawn-capability": capabilities[n]!, origin: url },
                body: JSON.stringify({ jsonrpc: "2.0", id: key, method: "tools/call", params: { name, arguments: args } }) });
              const envelope = await response.json() as { result?: { structuredContent?: Record<string, unknown> } };
              result = envelope.result?.structuredContent ?? { ok: false, code: `http-${response.status}` };
            }
            row.ok = result.ok === true; row.code = typeof result.code === "string" ? result.code : undefined;
            if (shared && name === "update_task" && result.ok === true && typeof result.revision === "string") sharedRevision = result.revision;
            // Full responses stay private for equivalence analysis; summaries
            // publish only counts and hashes of normalized fixture rows.
            row.result = result;
          } catch (error) { row.ok = false; row.code = String(error); }
          row.completed = Date.now(); row.latency = performance.now() - started;
        })();
        pending.add(operation); void operation.finally(() => pending.delete(operation));
      }
    }
    await Bun.sleep(Math.max(0, scheduledStart + (warmSeconds + seconds) * 1000 - performance.now()));
    const allPendingAtObservedEnd = pending.size;
    await Promise.race([Promise.all(pending), Bun.sleep(35_000)]);
    const drainedAt = Date.now();
    const allPendingAfterDrain = pending.size;
    const pendingAfterDrain = calls.filter(row => row.phase === "measured" && row.completed === undefined).length;
    // Re-query uncertain mutations under their original keys. Settled replies
    // are already evidence; recovery adds no replay burst for those successes.
    // This phase is outside the measurement window and cannot improve its
    // completed/failed counters. Save the returned disposition verbatim.
    const reconciliationDeadline = Date.now() + 300_000;
    const mutations = calls.filter(row => row.name !== "list_tasks");
    const uncertain = mutations.filter(row => {
      const result = row.result as { ok?: boolean; code?: string } | undefined;
      if (!result || ["outcome_unknown", "request_in_progress", "tool_failed"].includes(result.code ?? "")) return true;
      row.reconciled = row.result; return false;
    });
    let recoveryIndex = 0;
    let recoveryAttempts = 0;
    const recover = async () => { for (;;) {
      const row = uncertain[recoveryIndex++];
      if (!row || Date.now() >= reconciliationDeadline) return;
      recoveryAttempts++;
      try {
        if (mode === "stdio") {
          const response = await clients[row.client]!.client.callTool({ name: row.name, arguments: row.args }, undefined,
            { timeout: Math.min(30_000, reconciliationDeadline - Date.now()) });
          row.reconciled = response.structuredContent ?? JSON.parse((response.content as Array<{ text?: string }>)[0]?.text ?? "null");
        } else {
          const response = await fetch(`${url}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-llv-spawn-capability": capabilities[row.client]!, origin: url },
            signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, reconciliationDeadline - Date.now()))),
            body: JSON.stringify({ jsonrpc: "2.0", id: `reconcile-${row.client}-${row.index}`, method: "tools/call", params: { name: row.name, arguments: row.args } }) });
          const envelope = await response.json() as { result?: { structuredContent?: unknown } };
          row.reconciled = envelope.result?.structuredContent ?? { ok: false, code: `http-${response.status}` };
        }
      } catch (error) { row.reconciled = { transportError: String(error) }; }
    } };
    await Promise.all(Array.from({ length: Math.min(19, count) }, recover));
    clearInterval(sampler); sampler = undefined; sample("idle");
    fs.writeFileSync(path.join(root, "calls.json"), JSON.stringify(calls));
    const db = new Database(path.join(env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    const rows = db.query<{ collection: string; row_key: string; value_json: string; row_revision: number }, []>("SELECT collection,row_key,value_json,row_revision FROM state_rows ORDER BY collection,row_key").all(); db.close();
    fs.writeFileSync(path.join(root, "rows.json"), JSON.stringify(rows));
    const measured = calls.filter(row => row.phase === "measured");
    const measuredEnd = wallStart + (warmSeconds + seconds) * 1000;
    const completedAtEnd = measured.filter(row => row.completed !== undefined && row.completed <= measuredEnd).length;
    const latencies = measured.flatMap(row => row.latency === undefined ? [] : [row.latency]).sort((a, b) => a - b);
    const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)];
    const summary = { clients: count, mode, shared, offered: measured.length, completed: measured.filter(row => row.completed !== undefined).length,
      failed: measured.filter(row => row.ok === false).length,
      pendingAtEnd: measured.length - completedAtEnd, allPendingAtObservedEnd,
      pendingAfterDrain, allPendingAfterDrain, drainedAt,
      pendingAfterReconciliation: measured.filter(row => row.completed === undefined).length,
      allPendingAfterReconciliation: pending.size, reconciledAt: Date.now(),
      completedAtEnd, offeredAfterEnd: measured.filter(row => row.offered >= measuredEnd).length,
      failedAtEnd: measured.filter(row => row.ok === false && row.completed !== undefined && row.completed <= measuredEnd).length,
      reconciliation: { mutations: calls.filter(row => row.name !== "list_tasks").length,
        uncertainReplies: uncertain.length,
        queried: recoveryAttempts, settled: calls.filter(row => row.reconciled !== undefined).length,
        successful: calls.filter(row => (row.reconciled as { ok?: boolean } | undefined)?.ok === true).length,
        unknown: calls.filter(row => row.name !== "list_tasks" && (!row.reconciled || (row.reconciled as { code?: string; transportError?: string }).transportError
          || ["outcome_unknown", "request_in_progress"].includes((row.reconciled as { code?: string }).code ?? ""))).length },
      latency: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: latencies.at(-1) },
      seedChecksum: process.env.MCP_BENCH_SEED_CHECKSUM, failures: [...new Set(measured.filter(row => !row.ok).map(row => row.code))] };
    fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    if (sampler) clearInterval(sampler);
    await Promise.all(clients.map(({ client }) => client.close()));
    await reapFixtureChildren();
    const cleanupDeadline = Date.now() + 3_000;
    while (census(pids).length && Date.now() < cleanupDeadline) await Bun.sleep(10);
    fs.writeFileSync(path.join(root, "teardown.json"), JSON.stringify(census(pids)));
    // A transport timeout may leave admitted work running in the Viewer.
    // Preserve the final durable rows after every fixture process has ended.
    const filename = path.join(env.LLV_STATE_DIR!, "state.sqlite");
    if (fs.existsSync(filename)) {
      const db = new Database(filename, { readonly: true });
      try {
        fs.writeFileSync(path.join(root, "final-rows.json"), JSON.stringify(db.query("SELECT * FROM state_rows ORDER BY collection,row_key").all()));
      } finally { db.close(); }
      const receiptFile = path.join(env.LLV_STATE_DIR!, "mcp-receipts.sqlite");
      if (fs.existsSync(receiptFile)) {
        const receipts = new Database(receiptFile, { readonly: true });
        try {
          fs.writeFileSync(path.join(root, "final-receipts.json"), JSON.stringify(receipts.query("SELECT receipt_key,result_json FROM mcp_receipts ORDER BY receipt_key").all()));
        } finally { receipts.close(); }
      }
    }
  }
}

/** Exported for the existing benchmark entry. The controller chooses one
 * immutable checkout/sample at a time, so partial runs remain inspectable. */
export async function stateWriterBenchmark(): Promise<void> {
  if (process.argv.includes("--state-writer-sample")) return runStateWriterSample();
  throw new Error("Use --state-writer-sample with MCP_BENCH_OUTPUT, MCP_BENCH_SEED, MCP_BENCH_CAPABILITIES and MCP_SQL_OBSERVER; run through gate-slot in a private PID namespace");
}
