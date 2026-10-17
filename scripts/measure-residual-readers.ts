import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "../src/lib/accounts/migration/contracts";
import { normalizeRegistry, deliveryHasDurableClaimOwner, type RegistryFile } from "../src/lib/agent/registry";
import { SqliteAgentRegistryStore } from "../src/lib/agent/sqliteRegistryStore";
import { saveTasks } from "../src/lib/tasks/store";
import { findPrototypeRound, mutatePrototypeRound } from "../src/lib/prototypeReview/store";
import type { BoardTask } from "../src/lib/tasks/types";
import type { PrototypeReviewRound } from "../src/lib/prototypeReview/types";

const [output, label] = process.argv.slice(2);
const root = process.env.LLV_STATE_DIR;
if (!root || !output || !label || process.env.NODE_ENV !== "test" || process.env.LLV_STATE_OWNER) throw new Error("use an isolated test environment and <output> <label>");
const at = "2026-10-01T00:00:00.000Z";
const callsPerTick = 20, ticks = 9, receiptCount = 10_971, taskCount = 1_705;
const roundId = (n: number) => `pr_${n.toString(16).padStart(32, "0")}`;
const source = normalizeRegistry({ version: 2, entries: {}, receipts: Object.fromEntries(Array.from({ length: receiptCount }, (_, n) => {
  const key = `receipt-${n.toString().padStart(5, "0")}`;
  return [key, { launchId: key, conversationId: `conversation_${n < callsPerTick ? n : "history_" + n}`, engine: "codex", cwd: "/fixture",
    createdAt: at, state: n < callsPerTick ? "starting" : "completed", transport: "structured", error: null,
    artifactPath: `/fixture/${n}.jsonl`, launchProfile: emptyLaunchProfile({ cwd: "/fixture", title: "Receipt fixture " + "x".repeat(2048), mcpServers: ["viewer"] }) }];
})) });
const tasks: BoardTask[] = Array.from({ length: taskCount }, (_, n) => ({ id: `task-${n}`, project: "fixture-project", text: "Prototype fixture",
  details: "x".repeat(2048), status: "inbox", placement: "unplaced", createdAt: at, updatedAt: at, attachments: [], assignments: [], workLinks: [],
  ...(n < callsPerTick ? { prototypeReviews: [{ id: roundId(n), taskId: `task-${n}`, project: "fixture-project", title: "Review", createdAt: at,
    publicationKey: `fixture-${n}`, inputDigest: `fixture-${n}`, source: { conversationId: null }, variants: [] } as PrototypeReviewRound] } : {}) }));
const digest = createHash("sha256").update(JSON.stringify({ source, tasks })).digest("hex");
const filename = path.join(root, "receipts.sqlite");
const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: source, normalize: normalizeRegistry });
saveTasks(tasks);
await store.prepareRecoveryIndexes();
while (store.archiveInactive(250)) await new Promise<void>(resolve => setImmediate(resolve));
store.readOnlySnapshot();
const db = new Database(filename, { readonly: true });
const coldReceiptRows = db.query<{ count: number }, []>("SELECT count(*) AS count FROM registry_cold WHERE collection='receipts'").get()!.count;
const registry = db.query<{ rows: number; bytes: number }, []>("SELECT count(*) AS rows,sum(length(CAST(value_json AS BLOB))) AS bytes FROM registry_rows").get()!;
db.close();
const state = new Database(path.join(root, "state.sqlite"), { readonly: true });
const taskBytes = state.query<{ bytes: number }, []>("SELECT sum(length(CAST(value_json AS BLOB))) AS bytes FROM state_rows WHERE collection='tasks'").get()!.bytes;
state.close();
const rchar = () => Number(fs.readFileSync("/proc/thread-self/io", "utf8").match(/^rchar:\s+(\d+)/m)![1]);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { median: sorted[Math.floor(sorted.length/2)]!, max: sorted.at(-1)! };
};
const results: Record<string, unknown> = {};
for (const workload of ["receipt-ownership", "prototype-round-read", "prototype-round-write"] as const) {
  const call = (n: number, tick: number) => {
    if (workload === "receipt-ownership") {
      const view = store.readOnlySnapshot().file;
      const conversation = { id: `conversation_${n}`, engine: "codex", generations: [{ id: `generation-${n}`, path: `/fixture/${n}.jsonl`, host: null }] };
      if (!deliveryHasDurableClaimOwner(view, conversation as RegistryFile["conversations"][string],
        { generationId: `generation-${n}` } as RegistryFile["heldDeliveries"][string])) throw new Error("ownership changed");
    } else if (workload === "prototype-round-read") {
      if (findPrototypeRound(`task-${n}`, roundId(n))?.title !== "Review") throw new Error("round changed");
    } else mutatePrototypeRound(`task-${n}`, roundId(n), round => { round.telegramPost = { key: `fixture-${tick}`, state: "sent", at }; });
  };
  for (let n = 0; n < callsPerTick; n++) call(n, -1);
  const cpuBefore = process.cpuUsage();
  const perCall: number[] = [], perTick: number[] = [], bytes: number[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    const before = rchar(), start = performance.now();
    for (let n = 0; n < callsPerTick; n++) { const c = performance.now(); call(n, tick); perCall.push(performance.now()-c); }
    perTick.push(performance.now()-start); bytes.push(rchar()-before);
  }
  const cpu = process.cpuUsage(cpuBefore);
  results[workload] = { processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, synchronousMsPerCall: summary(perCall), synchronousMsPerTick: summary(perTick), readBytesPerTick: summary(bytes),
    readBytesPerCall: summary(bytes.map(value => value/callsPerTick)) };
}
const read = (name: string) => { try { return fs.readFileSync(name, "utf8").trim(); } catch { return null; } };
const files = ["src/lib/agent/registry.ts", "src/lib/agent/sqliteRegistryStore.ts", "src/lib/agent/registryArchive.ts", "src/lib/tasks/store.ts", "src/lib/prototypeReview/store.ts", "src/lib/prototypeReview/deliveryWorker.ts", "src/lib/prototypeReview/seatRounds.ts", "scripts/measure-residual-readers.ts"];
fs.writeFileSync(output, JSON.stringify({ label, at: new Date().toISOString(), bun: Bun.version, fixtureSha256: digest,
  load: { receiptCount, taskCount, callsPerTick, ticks, measuredCallsPerWorkload: callsPerTick*ticks, concurrentWriters: 0, coldReceiptRows, registry, taskBytes },
  machine: { cpuMax: read("/sys/fs/cgroup/cpu.max"), memoryMax: read("/sys/fs/cgroup/memory.max"), loadavg: read("/proc/loadavg") },
  sourceSha256: Object.fromEntries(files.map(file => [file, createHash("sha256").update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")])), results }, null, 2));
store.close();
console.log(JSON.stringify({ label, fixtureSha256: digest, results }));
