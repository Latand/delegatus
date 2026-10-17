/** Offline only: use a VACUUM INTO state copy bearing .task-export-copy.
 * Run from the source revision being measured, under the isolated gate runner.
 * Output contains counters and a digest, never task text or peer credentials. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const state = process.env.LLV_STATE_DIR;
if (!state || !fs.existsSync(path.join(state, ".task-export-copy"))) throw new Error("An explicitly marked offline state copy is required");
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_CONTROL_URL = "http://127.0.0.1:1";
const source = process.cwd();
const fixedNow = Number(process.env.LLV_TASK_EXPORT_MEASURE_NOW);
if (Number.isFinite(fixedNow) && fixedNow > 0) Date.now = () => fixedNow;
const originalClone = structuredClone;
let memoryClones = 0;
globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
  if (value && typeof value === "object" && "kind" in value && ["rule", "scope", "request"].includes(String(value.kind))) memoryClones++;
  return originalClone(value, options);
}) as typeof structuredClone;
const clockTicks = process.platform === "linux" ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL" }).trim()) : null;
const mainCpu = () => {
  if (!clockTicks) return 0;
  const stat = fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) * 1000 / clockTicks;
};
let calls = 0, bytes = 0, pushDigest = "";
const stub = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks); bytes = body.length;
    pushDigest = createHash("sha256").update(JSON.stringify(JSON.parse(body.toString()).push ?? null)).digest("hex");
    calls++; response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "malformed" }));
  });
});
await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
const port = (stub.address() as { port: number }).port;
const peersFile = path.join(state, "links/peers.json");
const peers = JSON.parse(fs.readFileSync(peersFile, "utf8")) as { peers: { id: string; url: string }[] };
if (!peers.peers.length) { stub.close(); throw new Error("The copied fixture has no peer"); }
for (const peer of peers.peers) peer.url = `http://127.0.0.1:${port}`;
fs.writeFileSync(peersFile, JSON.stringify(peers));
const client = await import(path.join(source, "src/lib/links/client.ts"));
const workerPath = path.join(source, "src/lib/links/taskPageWorker.ts");
const worker = fs.existsSync(workerPath) ? await import(workerPath) : null;
try {
  // A serving Viewer has already opened and initialized its state stores before
  // the scheduled retry. Prime that one-time setup outside the sync budget,
  // then retire the worker so the measured candidate still includes a cold
  // page build followed by unchanged cache hits.
  try { await client.syncPeer(peers.peers[0].id); } catch { /* The malformed stub is expected. */ }
  await worker?.shutdownTaskPageWorker();
  calls = 0; bytes = 0; pushDigest = "";
  for (let iteration = 0; iteration < 3; iteration++) {
    let maxMainGapMs = 0, last = performance.now(), lastCpu = mainCpu(), maxMainThreadCpuWindowMs = 0;
    const timer = setInterval(() => {
      const now = performance.now(), cpuNow = mainCpu();
      maxMainGapMs = Math.max(maxMainGapMs, now - last - 5); last = now;
      maxMainThreadCpuWindowMs = Math.max(maxMainThreadCpuWindowMs, cpuNow - lastCpu); lastCpu = cpuNow;
    }, 5);
    const cpu = process.cpuUsage(), start = performance.now(), clones = memoryClones;
    let error: string | null = null;
    try { await client.syncPeer(peers.peers[0].id); }
    catch (cause) { error = (cause as { code?: string }).code ?? "unavailable"; }
    await new Promise(resolve => setTimeout(resolve, 10)); clearInterval(timer);
    console.log(JSON.stringify({ iteration, policyNow: Date.now(), ms: performance.now() - start, cpu: process.cpuUsage(cpu),
      memoryClones: memoryClones - clones, maxMainGapMs, maxMainThreadCpuWindowMs: clockTicks ? maxMainThreadCpuWindowMs : null, clockTicks, calls, bytes, pushDigest, error,
      workerStats: worker?.taskPageWorkerDiagnostics() ?? null }));
  }
} finally {
  await worker?.shutdownTaskPageWorker();
  await new Promise<void>(resolve => stub.close(() => resolve()));
  globalThis.structuredClone = originalClone;
}
