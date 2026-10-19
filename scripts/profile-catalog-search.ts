/** Compare revisions through an independent MCP caller and owned HTTP server.
 * Run in an isolated export under gate-slot.sh. Args: repository corpus
 * [selected=951] [samples=11] [state-directory] [base]. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const [repository, corpus, selectedArg, samplesArg, stateArg] = process.argv.slice(2);
if (!repository || !corpus || !process.env.TMPDIR) throw new Error("usage: profile-catalog-search.ts repository corpus [selected] [samples] [state]; TMPDIR must name private scratch");
const repo = path.resolve(repository);
const root = path.resolve(corpus);
const selected = Number(selectedArg ?? 951);
const samples = Number(samplesArg ?? 11);
if (!Number.isSafeInteger(selected) || selected < 1 || selected > 8247 || !Number.isSafeInteger(samples) || samples < 1 || samples > 100) throw new Error("invalid profile counts");
fs.mkdirSync(root, { recursive: true });
const state = path.resolve(stateArg ?? fs.mkdtempSync(path.join(process.env.TMPDIR, "catalog-profile-state-")));
const prepareProjection = process.argv[7] !== "base";
const serverScript = path.join(import.meta.dir, "profile-catalog-search-server.ts");
const sourceDigests = Object.fromEntries(["src/lib/scanner/conversationSearchProjection.ts", "src/app/api/conversations/route.ts", "src/lib/mcp/bindings.ts"].map(file => [file, fs.existsSync(path.join(repo, file)) ? createHash("sha256").update(fs.readFileSync(path.join(repo, file))).digest("hex") : null]));
sourceDigests["scripts/profile-catalog-search.ts"] = createHash("sha256").update(fs.readFileSync(path.join(import.meta.dir, "profile-catalog-search.ts"))).digest("hex");
sourceDigests["scripts/profile-catalog-search-server.ts"] = createHash("sha256").update(fs.readFileSync(path.join(import.meta.dir, "profile-catalog-search-server.ts"))).digest("hex");
const load = () => fs.existsSync("/proc/loadavg") ? fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0] : null;

async function startServer(options: { prepare: boolean; stallMs?: number; state: string }) {
  const loadBefore = load();
  const env = {
    ...process.env,
    LLV_STATE_DIR: options.state,
    LLV_RESOURCE_OBSERVATION_WORKER: "1",
    PROFILE_PREPARE: options.prepare ? "1" : "0",
    PROFILE_STALL_MS: String(options.stallMs ?? 0),
  };
  const child = Bun.spawn([process.execPath, serverScript, repo, root, String(selected), options.state], { env, stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.getReader();
  let stderr = "";
  const stderrTask = new Response(child.stderr).text().then(value => { stderr = value; });
  const decoder = new TextDecoder();
  let buffered = "";
  const readyWatchdog = setTimeout(() => child.kill("SIGTERM"), 60_000);
  readyWatchdog.unref();
  let ready: { origin: string; rows: number; prepared: boolean; preparationMs: number } | undefined;
  try {
    while (!ready) {
      const { value, done } = await stdout.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf("\n");
      if (newline >= 0) ready = JSON.parse(buffered.slice(0, newline));
    }
  } catch (error) {
    child.kill("SIGTERM");
    await child.exited;
    await stderrTask;
    throw error;
  } finally { clearTimeout(readyWatchdog); }
  if (!ready) {
    child.kill("SIGTERM");
    await child.exited;
    await stderrTask;
    throw new Error(`catalog profile server failed readiness: ${stderr}`);
  }
  return {
    ...ready,
    loadBefore,
    loadAfter: load(),
    child,
    stop: async () => { child.kill("SIGTERM"); await child.exited; await stderrTask; },
  };
}

process.env.LLV_STATE_DIR = state;
process.env.LLV_RESOURCE_OBSERVATION_WORKER = "1";
delete process.env.LLV_VIEWER_CONTROL_TOKEN;
delete process.env.LLV_TOKEN;
const { viewerMcpBindings, productionViewerControlDependencies } = await import(path.join(repo, "src/lib/mcp/bindings.ts"));
type Observation = { sample: number; variant: string; ms: number; bytes: number; returned: number; total: number | null; ok: boolean; loadBefore: string | null; loadAfter: string | null };
const observations: Observation[] = [];
const startedAt = new Date().toISOString();
let mainServer: Awaited<ReturnType<typeof startServer>> | undefined;
let stallServer: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const serverState = path.join(state, "profile-server");
  mainServer = await startServer({ prepare: prepareProjection, state: serverState });
  for (let sample = 1; sample <= samples; sample++) {
    for (const variant of ["MCP search", "HTTP search", "MCP default", "HTTP default"]) {
      const search = variant.endsWith("search");
      const loadBefore = load();
      const start = performance.now();
      let bytes = 0;
      let returned = 0;
      let total: number | null = null;
      let ok = false;
      try {
        let body;
        if (variant.startsWith("MCP")) {
          process.env.LLV_VIEWER_CONTROL_URL = mainServer.origin;
          const client = viewerMcpBindings(undefined, productionViewerControlDependencies(true));
          body = await client.list_conversations(search ? { project: "selected", query: "keyword", limit: 5 } : { limit: 50 }, { deadlineAt: Date.now() + 12_000 });
          bytes = Buffer.byteLength(JSON.stringify(body));
          returned = typeof body.count === "number" ? body.count : 0;
          total = typeof body.total === "number" ? body.total : null;
          ok = total === (search ? selected : 8247) && returned > 0 && returned <= (search ? 5 : 50) && Array.isArray(body.conversations) && body.conversations.length === returned;
        } else {
          const response = await fetch(`${mainServer.origin}/api/conversations?${search ? "project=selected&q=keyword&limit=5" : "limit=50"}`, { signal: AbortSignal.timeout(12_000) });
          const text = await response.text();
          bytes = Buffer.byteLength(text);
          body = JSON.parse(text);
          returned = body.items?.length ?? 0;
          total = body.total ?? null;
          ok = response.ok && body.total === (search ? selected : 8247) && body.items?.length === (search ? 5 : 50);
        }
      } catch { /* Failed calls remain in the latency distribution. */ }
      const observation = { sample, variant, ms: performance.now() - start, bytes, returned, total, ok, loadBefore, loadAfter: load() };
      observations.push(observation);
      console.error(JSON.stringify(observation));
    }
  }

  // The server blocks synchronously for 15 seconds. The independent MCP
  // caller must exhaust its 12-second budget before that server resumes.
  const stallState = path.join(state, "profile-stall-server");
  stallServer = await startServer({ prepare: false, stallMs: 15_000, state: stallState });
  process.env.LLV_VIEWER_CONTROL_URL = stallServer.origin;
  const stalledClient = viewerMcpBindings(undefined, productionViewerControlDependencies(true));
  const stallLoadBefore = load();
  const stallStarted = performance.now();
  let stallFailed = false;
  try {
    await stalledClient.list_conversations({ limit: 5 }, { deadlineAt: Date.now() + 12_000 });
  } catch { stallFailed = true; }
  const stalledMs = performance.now() - stallStarted;
  const stallLoadAfter = load();
  if (!stallFailed || stalledMs < 5_000 || stalledMs > 14_500) throw new Error(`independent MCP deadline control failed: failed=${stallFailed} elapsedMs=${stalledMs}`);
  await stallServer.stop();
  stallServer = undefined;
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const summary = [...new Set(observations.map(row => row.variant))].map(variant => {
    const rows = observations.filter(row => row.variant === variant);
    const successfulBytes = rows.filter(row => row.ok).map(row => row.bytes);
    return { variant, successes: rows.filter(row => row.ok).length, count: rows.length,
      ms: { p50: percentile(rows.map(row => row.ms), .5), p95: percentile(rows.map(row => row.ms), .95), max: Math.max(...rows.map(row => row.ms)) },
      bytes: successfulBytes.length ? { p50: percentile(successfulBytes, .5), p95: percentile(successfulBytes, .95), max: Math.max(...successfulBytes) } : null };
  });
  console.log(JSON.stringify({ revision: prepareProjection ? "candidate" : "base", sourceDigests, corpus: 8247, selected, samples, startedAt, finishedAt: new Date().toISOString(), server: { separateProcess: true, preparedBeforeListening: mainServer.prepared, preparationMs: mainServer.preparationMs, loadBefore: mainServer.loadBefore, loadAfter: mainServer.loadAfter }, stallControl: { serverStallMs: 15_000, clientBudgetMs: 12_000, failed: stallFailed, elapsedMs: stalledMs, loadBefore: stallLoadBefore, loadAfter: stallLoadAfter }, cold: observations[0], summary, observations }, null, 2));
  if (observations.some(row => !row.ok)) process.exitCode = 1;
} finally {
  await stallServer?.stop();
  await mainServer?.stop();
}
