/** Compare revisions against one invented corpus, through HTTP and the real
 * MCP read transport. Run in an isolated export under gate-slot.sh.
 * Args: repository corpus [selected=951] [samples=11] [state-directory]. */
import fs from "node:fs";
import path from "node:path";

const [repository, corpus, selectedArg, samplesArg, state] = process.argv.slice(2);
if (!repository || !corpus || !process.env.TMPDIR) throw new Error("usage: profile-catalog-search.ts repository corpus [selected] [samples] [state]; TMPDIR must name private scratch");
const repo = path.resolve(repository);
const root = path.resolve(corpus);
const selected = Number(selectedArg ?? 951);
const samples = Number(samplesArg ?? 11);
if (!Number.isSafeInteger(selected) || selected < 1 || selected > 8247 || !Number.isSafeInteger(samples) || samples < 1 || samples > 100) throw new Error("invalid profile counts");
fs.mkdirSync(root, { recursive: true });
process.env.LLV_STATE_DIR = state ?? fs.mkdtempSync(path.join(process.env.TMPDIR, "catalog-profile-state-"));
// Imported control bindings must not import legacy account files into this
// invented fixture. The observation worker uses the same read-only boundary.
process.env.LLV_RESOURCE_OBSERVATION_WORKER = "1";
const { replaceConversationCatalog } = await import(path.join(repo, "src/lib/scanner/conversationCatalog.ts"));
const { setFileCatalogMembershipProbeForTests } = await import(path.join(repo, "src/lib/scanner/scanCache.ts"));
const { GET } = await import(path.join(repo, "src/app/api/conversations/route.ts"));
const { viewerMcpBindings, productionViewerControlDependencies } = await import(path.join(repo, "src/lib/mcp/bindings.ts"));
const payload = JSON.stringify({ type: "user", message: { content: "Scoped keyword. " + "Synthetic prompt detail. ".repeat(2000) } }) + "\n";
const rows = Array.from({ length: 8247 }, (_, n) => {
  const pathname = path.join(root, `${n}.jsonl`);
  if (!fs.existsSync(pathname)) {
    fs.writeFileSync(pathname, payload);
    fs.utimesSync(pathname, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  }
  const stat = fs.statSync(pathname);
  return { path: pathname, root: "claude-projects", name: `${n}.jsonl`, project: n < selected ? "selected" : "other", title: "Conversation", firstPrompt: "", engine: "claude", kind: "session", fmt: "claude", mtime: stat.mtimeMs / 1000, size: stat.size };
});
setFileCatalogMembershipProbeForTests(async () => null);
replaceConversationCatalog(rows);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: GET });
const origin = server.url.origin;
process.env.LLV_VIEWER_CONTROL_URL = origin;
// The probe owns this port-0 listener and carries no production credentials.
delete process.env.LLV_VIEWER_CONTROL_TOKEN;
delete process.env.LLV_TOKEN;
const tools = viewerMcpBindings(undefined, productionViewerControlDependencies(true));
const load = () => fs.existsSync("/proc/loadavg") ? fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0] : null;
type Observation = { sample: number; variant: string; ms: number; bytes: number; returned: number; total: number | null; ok: boolean; loadBefore: string | null; loadAfter: string | null };
const observations: Observation[] = [];
const startedAt = new Date().toISOString();
try {
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
          body = await tools.list_conversations(search ? { project: "selected", query: "keyword", limit: 5 } : { limit: 50 }, { deadlineAt: Date.now() + 12_000 });
          bytes = Buffer.byteLength(JSON.stringify(body));
          returned = typeof body.count === "number" ? body.count : 0;
          total = typeof body.total === "number" ? body.total : null;
          ok = total === (search ? selected : rows.length) && returned > 0 && returned <= (search ? 5 : 50) && Array.isArray(body.conversations) && body.conversations.length === returned;
        } else {
          const response = await fetch(`${origin}/api/conversations?${search ? "project=selected&q=keyword&limit=5" : "limit=50"}`, { signal: AbortSignal.timeout(12_000) });
          const text = await response.text();
          bytes = Buffer.byteLength(text);
          body = JSON.parse(text);
          returned = body.items?.length ?? 0;
          total = body.total ?? null;
          ok = response.ok && body.total === (search ? selected : rows.length) && body.items?.length === (search ? 5 : 50);
        }
      } catch { /* The failed observation remains in the latency distribution. */ }
      const observation = { sample, variant, ms: performance.now() - start, bytes, returned, total, ok, loadBefore, loadAfter: load() };
      observations.push(observation);
      console.error(JSON.stringify(observation));
    }
  }
} finally { server.stop(true); }
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = [...new Set(observations.map(row => row.variant))].map(variant => {
  const rows = observations.filter(row => row.variant === variant);
  const successfulBytes = rows.filter(row => row.ok).map(row => row.bytes);
  return { variant, successes: rows.filter(row => row.ok).length, count: rows.length,
    ms: { p50: percentile(rows.map(row => row.ms), .5), p95: percentile(rows.map(row => row.ms), .95), max: Math.max(...rows.map(row => row.ms)) },
    bytes: { p50: percentile(successfulBytes, .5), p95: percentile(successfulBytes, .95), max: Math.max(...successfulBytes) } };
});
console.log(JSON.stringify({ corpus: rows.length, selected, samples, startedAt, finishedAt: new Date().toISOString(), cold: observations[0], summary, observations }, null, 2));
if (observations.some(row => !row.ok)) process.exitCode = 1;
