import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const roots: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
export function closeReceiptReadFixtures() {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
export function receiptReadFixture(count = 513, databaseFile?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-read-")); roots.push(root);
  const seed = new AgentRegistry(path.join(root, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const original = seed.ensureConversation("codex", "/fixture/current.jsonl", null);
  seed.close();
  const id = "conversation_selected" as const;
  const at = "2026-10-01T00:00:00.000Z";
  const conversation = { ...original, id, createdAt: at, updatedAt: at,
    generations: original.generations.map(g => ({ ...g, id: "current", host: null, createdAt: at })) };
  const initial = normalizeRegistry({ version: 2, entries: {}, conversations: { [id]: conversation },
    receipts: Object.fromEntries(Array.from({ length: count }, (_, n) => {
      const selected = n === count - 1;
      const key = `receipt-${n.toString().padStart(5, "0")}`;
      return [key, { launchId: key, conversationId: selected ? id : `conversation_history_${n}`, engine: "codex",
        cwd: "/fixture", createdAt: at, state: selected ? "starting" : "completed", transport: "structured", error: null,
        artifactPath: selected ? "/fixture/current.jsonl" : `/fixture/history-${n}.jsonl`,
        launchProfile: emptyLaunchProfile({ cwd: "/fixture", title: "Receipt read fixture", mcpServers: ["viewer"] }) }];
    })) });
  let reads = 0;
  const filename = databaseFile ?? path.join(root, "registry.sqlite");
  const open = () => {
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: initial, normalize: normalizeRegistry,
      onRowPayloadRead: (collection, n) => { if (collection === "receipts") reads += n; } });
    stores.push(store); return store;
  };
  const store = open();
  while (store.archiveInactive(250)) { /* seed retained production history */ }
  return { store, open, initial, id, filename, reset: () => { reads = 0; }, reads: () => reads };
}

export function observeReceiptSelections(store: SqliteAgentRegistryStore, measure = false) {
  const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
  const query = db.query.bind(db), observed = new WeakSet<object>();
  const plans: string[] = [];
  let bytes = 0, syncMs = 0, maxMs = 0, calls = 0;
  const io = () => {
    const raw = fs.readFileSync("/proc/thread-self/io", "utf8");
    return { bytes: Number(/^rchar: (\d+)$/m.exec(raw)![1]), observer: Buffer.byteLength(raw) };
  };
  db.query = ((sql: string) => {
    const statement = query(sql);
    if (!observed.has(statement) && sql.includes("json_extract") && sql.includes("'receipts'") && !sql.startsWith("EXPLAIN")) {
      observed.add(statement);
      const all = statement.all.bind(statement);
      statement.all = (...bindings) => {
        const plan = query(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[];
        plans.push(...plan.map(row => row.detail));
        const before = measure ? io() : null, start = performance.now();
        try { return all(...bindings); }
        finally {
          const elapsed = performance.now() - start, after = measure ? io() : null;
          if (before && after) bytes += after.bytes - before.bytes - before.observer;
          syncMs += elapsed; maxMs = Math.max(maxMs, elapsed); calls++;
        }
      };
    }
    return statement;
  }) as typeof db.query;
  return { plans, reset() { bytes = syncMs = maxMs = calls = 0; plans.length = 0; },
    metrics: () => ({ bytes, syncMs, maxMs, calls }) };
}
