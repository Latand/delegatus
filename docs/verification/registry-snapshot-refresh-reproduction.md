# Reproduce the historical registry refresh comparison

This comparison runs the complete historical SQLite store and archive modules
inside the reviewed revision's common harness and application. It measures those
historical modules with the same reviewed normalizer, grant policy, dataset,
gate, runtime and surrounding application in both implementations.

Use Bun 1.4.0 and an installed Chromium. Export `CHROME_BIN` and
`PLAYWRIGHT_BROWSERS_PATH` before running. Keep the browser's temporary root
short. Run all measurements sequentially on one machine; do not overlap them
with either build.

Export the reviewed source twice, inside this worktree's ignored artifacts
directory. Install each export's own frozen dependencies. The historical copy
replaces exactly two files with their pre-#2762 versions:

```sh
reviewed=c5db12d42e5c39e0a935b1addd45b4003f565903
historical=6ced7a3a5577de0ad325f3d0648911300cc13826
mkdir -p .artifacts
pair_root=$(mktemp -d "$PWD/.artifacts/refresh-pair.XXXXXXXX")
for variant in historical current; do
  mkdir "$pair_root/$variant"
  git archive "$reviewed" | tar -x -C "$pair_root/$variant"
done
for file in sqliteRegistryStore.ts registryArchive.ts; do
  git show "$historical:src/lib/agent/$file" > "$pair_root/historical/src/lib/agent/$file"
done
```

Append the following compatibility exports to the historical
`src/lib/agent/sqliteRegistryStore.ts`. These functions let the common
application call APIs introduced after that revision. They use the historical
path reader where available and ordinary enumeration otherwise. The historical
class, its owner lookup, refresh, collection ordering, mutation and archive
code remain byte-for-byte intact. None of these helpers adds dependency
tracking or a cache.

```ts
// Compatibility with the common harness's later callers; the historical store above is unchanged.
export interface RegistryRowProjector<C extends RowCollection, T> {
  readonly id: string; readonly collection: C;
  project(row: RegistryFile[C][string]): T;
}
export function registryRowProjection<C extends RowCollection, T>(file: Pick<RegistryFile, C>, projector: RegistryRowProjector<C, T>): Array<[string, T]> {
  const rows = file[projector.collection] as Record<string, RegistryFile[C][string]>;
  return Object.keys(rows).map(key => [key, projector.project(rows[key]!)]);
}
export function registryHasPathIndex(file: RegistryFile): boolean { return pathReaders.has(file); }
export function registryHasEntryKeyIndex(_file: RegistryFile): boolean { return false; }
export function registryConversationsForEntryKey(file: RegistryFile, entryKey: string): RegistryFile["conversations"][string][] {
  return Object.values(file.conversations).filter(row => row.generations.some(generation => `${row.engine}:${generation.id}` === entryKey));
}
export function hotRegistryRows<C extends RowCollection>(file: RegistryFile, collection: C): Array<[string, RegistryFile[C][string]]> {
  return Object.entries(file[collection]) as Array<[string, RegistryFile[C][string]]>;
}
export function archivedOwnersEndedSince(_file: RegistryFile, _since: string): string[] | undefined { return undefined; }

```

The historical release can hit the child deadline before writing its final
report. Retain the existing boot timer as it runs in both copies of
`candidatePerformanceRun.ts`: give `lagWindow` an optional
`onLate?: (late: number) => void` parameter and call `onLate?.(late)` immediately
after `samples.push(late)`. Move the boot window's declaration before the
Viewer's `try` and use this callback, leaving `bootLoop.enable()` in place:

```ts
const bootLoop = lagWindow((late) => {
  if (late <= Number(report.bootLoopMaxMs ?? 0)) return;
  report.bootLoopMaxMs = late;
  finish();
});
```

In the Viewer's `catch`, call `bootLoop.disable()` and add
`bootLoopMaxMs: report.bootLoopMaxMs ?? bootLoop.summary().maxMs` to the object
passed to `finish`. This persists observed samples without extending any
window, deadline or acceptance bound. Use a fresh `gate-retained` output
directory per run so an absent report cannot reuse an earlier run's file.

For the retained process reports, insert the same block in both exports'
`candidatePerformanceRun.ts`, immediately before the final
`fs.rmSync(root, { recursive: true, force: true })` in `gateMain`:

```ts
const retained = path.join(process.cwd(), "gate-retained");
fs.mkdirSync(retained, { recursive: true });
for (const name of fs.readdirSync(root).filter(name => name.endsWith("-report.json"))) {
  fs.copyFileSync(path.join(root, name), path.join(retained, name));
}
```

Use `run_private` from [the measurement report](registry-snapshot-refresh.md#reproduction),
with a fresh short root for every invocation, including installs and builds.
The actual pair used the default gate limits (three CPUs and 8 GiB) and recorded
`cpu.max` and `memory.max` from inside the diagnostic process. The export must
sit outside `node_modules`: webpack excludes TypeScript there from its loaders.

```sh
for variant in historical current; do
  (cd "$pair_root/$variant" && run_private bun install --frozen-lockfile)
done
for variant in historical current; do
  (cd "$pair_root/$variant" && run_private bun test src/lib/agent/sqliteRegistryStore.refresh.test.ts)
done
for variant in historical current; do
  (cd "$pair_root/$variant" && run_private bun run build)
done
```

The historical test run is expected to fail; retain its output and continue.
The reviewed run must pass. Run the gates sequentially and retain every exit
code, including refusals:

```sh
for variant in historical current; do
  (cd "$pair_root/$variant" && run_private bun scripts/verify-viewer-runtime.ts --performance) \
    > "$pair_root/$variant-gate.log" 2>&1
done
```

For the focused refresh comparison, create one dataset with the reviewed
factory, close it, and copy the same SQLite bytes into each isolated run.
Save this seed script as `$pair_root/seed.ts` and run it from the current
export with `run_private bun "$pair_root/seed.ts" "$pair_root/seed"`:

```ts
import fs from "node:fs";
import path from "node:path";
const {buildRegistryPerformanceDataset} = await import(path.join(process.cwd(), "src/lib/agent/registryPerformanceDataset.ts"));
const directory=process.argv[2]!;
fs.mkdirSync(directory,{recursive:true});
const dataset=buildRegistryPerformanceDataset(directory);
fs.writeFileSync(path.join(directory,"dataset.json"), JSON.stringify(dataset));
console.log(JSON.stringify({rows:dataset.rows,coldRows:dataset.coldRows}));

```

Save this diagnostic as `$pair_root/diagnostic-sql.ts`. It replaces only the
write before the timed read with an identical SQL transaction for both stores.
The production row-journal triggers run and the revision advances on commit.
This avoids spending the refresh experiment in the historical implementation's
full mutation path. The full gate above retains each implementation's normal
write path.

```ts
import fs from "node:fs";
import path from "node:path";

const checkout = process.cwd();
const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
console.error(JSON.stringify({ cgroup, cpu: fs.readFileSync(`/sys/fs/cgroup${cgroup}/cpu.max`, "utf8").trim(), memory: fs.readFileSync(`/sys/fs/cgroup${cgroup}/memory.max`, "utf8").trim() }));
const { normalizeRegistry } = await import(path.join(checkout, "src/lib/agent/registry.ts"));
const { SqliteAgentRegistryStore } = await import(path.join(checkout, "src/lib/agent/sqliteRegistryStore.ts"));
const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, "mixed-refresh-"));
const seed=process.argv[2]!;
const dataset=JSON.parse(fs.readFileSync(path.join(seed,"dataset.json"),"utf8"));
const seedBytes=fs.readFileSync(path.join(seed,"agent-registry.sqlite"));
const datasetSha256=new Bun.CryptoHasher("sha256").update(seedBytes).digest("hex");
dataset.filename=path.join(directory,"agent-registry.sqlite");
fs.writeFileSync(dataset.filename,seedBytes);
const { Database } = await import("bun:sqlite");
const layoutDb = new Database(dataset.filename, { readonly: true });
const layout = layoutDb.query("SELECT r.collection,r.row_key,c.archive_id IS NOT NULL AS cold FROM registry_records r LEFT JOIN registry_cold c ON c.collection=r.collection AND c.row_key=r.row_key ORDER BY r.collection,r.row_key").all();
layoutDb.close();
const datasetLayoutSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(layout)).digest("hex");
const open = () => new SqliteAgentRegistryStore(dataset.filename, {
  normalize: normalizeRegistry,
  initialSnapshot: () => { throw new Error("dataset missing"); },
});
const reader = open();
const writer = new Database(dataset.filename);
const kinds = ["conversations", "receipts", "entries"] as const;
const initial = reader.readOnlySnapshot().file;
const keys = {
  entries: dataset.activeEntryKeys,
  receipts: dataset.grantSubjects.filter((row: any) => row.collection === "receipts").map((row: any) => row.key),
  conversations: dataset.activeEntryKeys.map((key: string) => `conversation_${key.slice("codex:".length)}`),
};
for (const kind of kinds) if (!keys[kind].length || !initial[kind][keys[kind][0]]) throw new Error(`no ${kind} subjects`);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  const pick = (fraction: number) => Number(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)].toFixed(3));
  return { count: values.length, p50: pick(.5), p95: pick(.95), max: pick(1) };
};
const results: Record<string, any> = {};
for (const mode of ["external", "local"] as const) {
  const samples = Object.fromEntries(kinds.map(kind => [kind, { write: [] as number[], refresh: [] as number[], decisions: [] as number[] }]));
  let decisions = 0;
  const original = (reader as any).decideStoredRow;
  (reader as any).decideStoredRow = function(...args: any[]) { decisions++; return original.apply(this,args); };
  const delays: number[] = [];
  let expected = performance.now() + 10;
  const timer = setInterval(() => { const now = performance.now(); delays.push(Math.max(0,now-expected)); expected=now+10; },10);
  try {
    for (let round=0;round<6;round++) {
      if(round%5===0) console.error(JSON.stringify({mode,round,at:new Date().toISOString()}));
      for (const kind of kinds) {
        const key = keys[kind][round % keys[kind].length];
        const field = kind === "receipts" ? "clientAttemptId" : "updatedAt";
        const value = kind === "receipts" ? `refresh-${mode}-${round}` : new Date(Date.now()+round).toISOString();
        const start = performance.now();
        const db = mode === "external" ? writer : (reader as any).db;
        db.exec("BEGIN IMMEDIATE");
        const stored=db.query("SELECT value_json,row_order FROM registry_records WHERE collection=? AND row_key=?").get(kind,key);
        if(!stored) throw new Error(`missing ${kind} row`);
        db.run("DELETE FROM registry_cold WHERE collection=? AND row_key=?",kind,key);
        db.query("INSERT INTO registry_rows(collection,row_key,value_json,row_order) VALUES(?,?,json_set(?,?,?),?) ON CONFLICT(collection,row_key) DO UPDATE SET value_json=excluded.value_json,row_order=excluded.row_order").run(kind,key,stored.value_json,`$.${field}`,value,stored.row_order);
        if(db.query("SELECT changes() AS count").get().count!==1) throw new Error(`expected one ${kind} row`);
        db.run("UPDATE registry_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
        db.exec("COMMIT");
        const written = performance.now();
        decisions=0;
        const view = reader.readOnlySnapshot().file;
        const refreshed = performance.now();
        if (round>=1) {
          samples[kind].write.push(written-start);
          samples[kind].refresh.push(refreshed-written);
          samples[kind].decisions.push(decisions);
        }
        // Exercise the collection's deferred materialization before the next write.
        if (view[kind][key]?.[field] !== value) throw new Error(`lost ${kind} write`);
        await Bun.sleep(20);
      }
    }
  } finally { clearInterval(timer); (reader as any).decideStoredRow=original; }
  results[mode]={ kinds: Object.fromEntries(kinds.map(kind => [kind, {
    writeMs: summary(samples[kind].write), refreshMs: summary(samples[kind].refresh),
    grantDecisions: summary(samples[kind].decisions),
  }])), timerLatenessMs: summary(delays) };
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), warmupRounds: 1, measuredRounds: 5, writer: "identical SQL transaction; revision bump and production journal triggers", datasetSha256, datasetLayoutSha256, rows: dataset.rows, coldRows: dataset.coldRows, runtime: Bun.version, results },null,2));
reader.close();
writer.close();
fs.rmSync(directory,{recursive:true,force:true});
```

```sh
for variant in historical current; do
  (cd "$pair_root/$variant" && run_private bun "$pair_root/diagnostic-sql.ts" "$pair_root/seed") \
    > "$pair_root/$variant-refresh.log" 2>&1
done
```

Both `datasetSha256` values and both `datasetLayoutSha256` values must match.
The seed, layout hashing and containment reads happen outside the timing
windows. The digest identifies the exact initial database bytes; the layout
digest identifies every row key and its hot/cold assignment. Each connection
mode gets one warmup round and five measured rounds per write kind.
The 10 ms timer includes warmup, writes, refreshes and deferred row reads.

The full gate uses its unchanged deadlines and acceptance bounds. The copied
process reports preserve evidence if the coordinator cannot finish. The
committed evidence replaces machine paths and UUID identifiers with stable
placeholders; measured numbers and counts are unchanged.
