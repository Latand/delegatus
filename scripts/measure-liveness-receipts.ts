// Linux read-byte accounting follows the original liveness diagnosis replay.
// Source opens read-only; all measured queries run on its isolated VACUUM copy.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const source = process.argv[2];
const directory = process.env.LLV_STATE_DIR;
if (!source || !directory || path.resolve(source) === path.resolve(directory, "agent-registry.sqlite")) {
  throw new Error("usage: LLV_STATE_DIR=<private directory> bun scripts/measure-liveness-receipts.ts <source database>");
}
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, "agent-registry.sqlite");
if (fs.existsSync(filename)) throw new Error("the private copy must not already exist");
const input = new Database(source, { readonly: true });
try { input.query("VACUUM INTO ?").run(filename); } finally { input.close(); }
const db = new Database(filename, { readonly: true });
try {
  const production = fs.readFileSync("src/lib/agent/sqliteRegistryStore.ts", "utf8")
    .match(/`(SELECT r\.row_key FROM registry_rows r INDEXED BY registry_liveness_receipt_session[\s\S]*?)`/u)?.[1];
  if (!production) throw new Error("production session lookup was not found");
  const old = `SELECT r.row_key FROM registry_rows r INDEXED BY registry_liveness_receipt_session
    JOIN registry_liveness_entries e ON e.row_key IN (BIND_KEYS)
    WHERE r.collection='receipts'
      AND (json_extract(r.value_json,'$.key.engine')||':'||json_extract(r.value_json,'$.key.sessionId'))=e.row_key
      AND (json_extract(r.value_json,'$.verifiedHost.agent') IS NOT NULL OR json_extract(r.value_json,'$.pane.panePid') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM registry_cold c WHERE c.collection='receipts' AND c.row_key=r.row_key)`;
  const keys = db.query<{ row_key: string }, []>("SELECT row_key FROM registry_liveness_entries ORDER BY row_order").all().map(row => row.row_key);
  if (!keys.length) throw new Error("the copy has no selected liveness entries");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const readBytes = () => Number(/^rchar: (\d+)/m.exec(fs.readFileSync("/proc/thread-self/io", "utf8"))![1]);
  const shapes = [
    ["singleton", keys.slice(0, 1)], ["multiple", keys.slice(0, 2)],
    ["duplicate", [keys[0]!, keys[0]!]], ["missing", ["missing-liveness-session"]], ["selected", keys],
  ] as const;
  const probes = [];
  for (const [shape, values] of shapes) {
    const binds = values.map(() => "?").join(",");
    const queries = { before: old.replace("BIND_KEYS", binds), after: production.replace("${placeholders}", binds) };
    const statements = { before: db.query<{ row_key: string }, string[]>(queries.before), after: db.query<{ row_key: string }, string[]>(queries.after) };
    const beforeRows = statements.before.all(...values).map(row => row.row_key);
    const afterRows = statements.after.all(...values).map(row => row.row_key);
    if (JSON.stringify(beforeRows) !== JSON.stringify(afterRows)) throw new Error(`result/order mismatch: ${shape}`);
    const plans = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name,
      db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => row.detail)]));
    if (!plans.after!.some(detail => /SEARCH r USING INDEX registry_liveness_receipt_session \(.*<expr>=\?/.test(detail))
      || plans.after!.some(detail => /SCAN (?:r|e|c)\b/.test(detail))) throw new Error(`non-seeking plan: ${shape}`);
    const samples = [];
    for (let repeat = 1; repeat <= 3; repeat++) {
      for (const name of ["before", "after"] as const) {
        const bytes = readBytes(), cpu = process.cpuUsage(), started = performance.now();
        const rows = statements[name].all(...values);
        const ms = performance.now() - started, used = process.cpuUsage(cpu);
        samples.push({ repeat, name, ms, cpuMs: (used.user + used.system) / 1000, readBytes: readBytes() - bytes, count: rows.length });
      }
    }
    probes.push({ shape, selectedKeys: values.length, resultCount: beforeRows.length, resultDigest: hash(JSON.stringify(beforeRows)), plans, samples });
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), runtime: Bun.version, loadAverage: os.loadavg(),
    copyBytes: fs.statSync(filename).size,
    queryDigest: hash(production),
    counts: db.query("SELECT collection, count(*) AS rows FROM registry_rows GROUP BY collection ORDER BY collection").all(),
    coldRows: db.query("SELECT count(*) AS rows FROM registry_cold").get(),
    probes }, null, 2));
} finally { db.close(); }
