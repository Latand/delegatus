/** Paired, isolated snapshot replay. Inputs are a read-only SQLite backup and
 * a git-archive export of the baseline with dependencies. The report contains
 * counts, timings and hashes; the output directory also holds private payloads
 * and working database copies. See docs/perf/runtime-snapshots.md for scope.
 *
 * bun scripts/benchmark-runtime-snapshots.ts <backup> <baseline-tree> <output-dir>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Database } from "bun:sqlite";
import { RuntimeJournal } from "../src/runtime-host/journal";
import { serveRuntimeHost } from "../src/runtime-host/socket";
import { PreserializedJson } from "../src/runtime-host/preserializedJson";
import { UnixRuntimeHostClient } from "../src/lib/runtime/client";
import { projectSnapshotRead, type RuntimeSnapshotReadKind } from "../src/lib/runtime/snapshotReads";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "../src/lib/blockingWaits";

const [backup, baselineTree, output] = process.argv.slice(2);
if (!backup || !baselineTree || !output) throw new Error("expected backup, baseline tree and private output directory");
const clock = Date.parse("2026-10-15T05:10:46.389Z");
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statistics = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1] ?? 0,
    p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? 0, max: sorted.at(-1) ?? 0 };
};
const schedule: RuntimeSnapshotReadKind[] = ["activity", "activity", "activity", "activity", "metadata", "metadata", "metadata", "owners"];

if (process.env.SNAPSHOT_BENCH_SERVER) {
  const variant = process.env.SNAPSHOT_BENCH_SERVER;
  const bodies = Object.fromEntries(["metadata", "activity", "owners"].map(kind => [kind, fs.readFileSync(path.join(output, `${variant}-${kind}.json`), "utf8")]));
  const server = serveRuntimeHost(path.join(output, "probe.sock"), { handle: async request => {
    const kind = (request.params?.snapshotRead as { kind?: string } | undefined)?.kind ?? (Array.isArray(request.params?.voiceBodiesFor) ? "metadata" : "owners");
    return { id: request.id, ok: true, result: new PreserializedJson(bodies[kind]!) };
  } });
  await once(server, "listening");
  console.log(JSON.stringify({ ready: true, pid: process.pid }));
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
} else {
  fs.mkdirSync(output, { mode: 0o700 });
  const beforeHash = hash(fs.readFileSync(backup));
  const baseline = await import(pathToFileURL(path.join(baselineTree, "src/runtime-host/journal.ts")).href) as { RuntimeJournal: typeof RuntimeJournal };
  const legacyClient = await import(pathToFileURL(path.join(baselineTree, "src/lib/runtime/client.ts")).href) as typeof import("../src/lib/runtime/client");
  const legacyDiagnostics = await import(pathToFileURL(path.join(baselineTree, "src/lib/blockingWaits.ts")).href) as typeof import("../src/lib/blockingWaits");
  const bodies: Record<string, Record<string, string>> = {};
  const collection: Array<Record<string, unknown>> = [];
  const fullControls: Array<Record<string, unknown>> = [];
  const oracleHashes = new Map<string, string>();
  const compare = (variant: string, key: string, value: unknown) => {
    const digest = hash(JSON.stringify(value));
    if (variant === "before") oracleHashes.set(key, digest);
    else if (oracleHashes.get(key) !== digest) throw new Error(`baseline/candidate mismatch at ${key}`);
  };
  for (const variant of ["before", "after"] as const) {
    const database = path.join(output, `${variant}.sqlite`);
    fs.copyFileSync(backup, database);
    fs.chmodSync(database, 0o600);
    const db = new Database(database, { strict: true });
    const Journal = variant === "before" ? baseline.RuntimeJournal : RuntimeJournal;
    // Constructors migrate. The audit's immutable-copy harness uses actual
    // read methods, an explicit clock and the copy's verified ready index.
    const metadata = { ready: true, excludedChanges: 0 };
    const journal: RuntimeJournal = Object.assign(Object.create(Journal.prototype), {
      db, now: () => clock, sessionHostMetadata: metadata, snapshotCaches: new Map(), snapshotCacheHits: 0, snapshotRebuilds: 0,
    });
    try {
      const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM entities WHERE kind = 'session'").get()!.n;
      const missing = db.query<{ n: number }, []>("SELECT count(*) AS n FROM entities e LEFT JOIN session_host_metadata m ON e.id=m.id WHERE e.kind='session' AND (m.id IS NULL OR m.checkpoint_seq != e.checkpoint_seq)").get()!.n;
      if (missing) throw new Error("backup metadata is incomplete");
      const full = journal.snapshot();
      compare(variant, "full", full);
      const selected = full.sessions.find(session => session.host === "hosted");
      if (!selected) throw new Error("backup has no hosted session");
      const read = (kind: RuntimeSnapshotReadKind) => variant === "before"
        ? journal.snapshotJson(kind === "metadata" ? [] : undefined)
        : journal.snapshotReadJson({ version: 1, kind });
      bodies[variant] = {};
      for (const kind of ["metadata", "activity", "owners"] as const) {
        const body = read(kind);
        bodies[variant]![kind] = body;
        compare(variant, kind, projectSnapshotRead(JSON.parse(body), kind));
        if (hash(JSON.stringify(projectSnapshotRead(JSON.parse(body), kind))) !== hash(JSON.stringify(projectSnapshotRead(full, kind)))) {
          throw new Error(`caller value mismatch for ${variant}/${kind}`);
        }
        fs.writeFileSync(path.join(output, `${variant}-${kind}.json`), body, { mode: 0o600 });
      }
      for (const phase of ["cold", "ready", "cached", "dirty-one", "dirty-many", "grown-history"] as const) {
        metadata.ready = phase !== "cold";
        if (phase === "grown-history") {
          // Retained dead history grows without changing the selected tail.
          db.exec("BEGIN");
          for (let i = 0; i < 500; i++) db.query(`INSERT INTO entities(kind,id,revision,checkpoint_seq,state_json,updated_at)
            SELECT kind, ?, revision, 0, json_set(state_json, '$.conversationId', ?, '$.host', 'dead'), updated_at
            FROM entities WHERE kind='session' AND id=?`).run(`benchmark-retained-${i}`, `benchmark-retained-${i}`, selected.conversationId);
          db.exec("COMMIT");
        }
        for (let round = 0; round < 3; round++) {
          if (phase !== "cached") (journal as unknown as { snapshotCaches: Map<string, unknown> }).snapshotCaches.clear();
          if (phase.startsWith("dirty")) {
            db.query(`UPDATE entities SET state_json = json_set(state_json, '$.revision', json_extract(state_json, '$.revision') + 1)
              WHERE kind='session' AND id IN (SELECT id FROM session_host_metadata WHERE inactive=0 ORDER BY id LIMIT ?)`)
              .run(phase === "dirty-one" ? 1 : 64);
          }
          const times: Record<string, number> = {};
          for (const kind of ["metadata", "activity", "owners"] as const) {
            const start = performance.now(); const body = read(kind); times[kind] = performance.now() - start;
            const oracle = journal.snapshot();
            compare(variant, `${phase}/${round}/${kind}`, oracle);
            if (JSON.stringify(projectSnapshotRead(JSON.parse(body), kind)) !== JSON.stringify(projectSnapshotRead(oracle, kind))) throw new Error("phase parity failed");
          }
          collection.push({ variant, phase, round, originalSessions: count, times });
        }
      }
    } finally { db.close(); }
  }
  // Alternate full-population controls on the original immutable data, after
  // both mutation campaigns. This avoids assigning phase/order drift to SQL.
  const fullReaders = [baseline.RuntimeJournal, RuntimeJournal].map(Journal => {
    const db = new Database(backup, { readonly: true, strict: true });
    db.exec("PRAGMA query_only=ON");
    const journal: RuntimeJournal = Object.assign(Object.create(Journal.prototype), {
      db, now: () => clock, sessionHostMetadata: { ready: true, excludedChanges: 0 },
      snapshotCaches: new Map(), snapshotCacheHits: 0, snapshotRebuilds: 0,
    });
    return { db, journal };
  });
  try {
    for (let round = 1; round <= 3; round++) for (const [index, variant] of ["before", "after"].entries()) {
      const journal = fullReaders[index]!.journal;
      (journal as unknown as { snapshotCaches: Map<string, unknown> }).snapshotCaches.clear();
      const start = performance.now(); const body = journal.snapshotJson();
      fullControls.push({ variant, round, ms: performance.now() - start, bytes: Buffer.byteLength(body) });
      if (hash(body) !== hash(bodies.before!.activity!)) throw new Error("full snapshot control changed");
      await sleep(25);
    }
  } finally { for (const { db } of fullReaders) db.close(); }
  const runs: Array<Record<string, unknown>> = [];
  // Alternate variants so neighboring rounds see comparable machine load.
  for (let round = 1; round <= 3; round++) for (const variant of ["before", "after"] as const) {
    const child = Bun.spawn([process.execPath, import.meta.path, backup, baselineTree, output], {
      env: { ...process.env, SNAPSHOT_BENCH_SERVER: variant }, stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    console.error(`snapshot benchmark owns child ${child.pid}`);
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      if (!first.value || !JSON.parse(new TextDecoder().decode(first.value)).ready) throw new Error("benchmark server did not start");
      const client = new UnixRuntimeHostClient(path.join(output, "probe.sock"));
      const oldClient = new legacyClient.UnixRuntimeHostClient(path.join(output, "probe.sock"));
      const request = (kind: RuntimeSnapshotReadKind) => variant === "before"
        ? oldClient.snapshot(undefined, kind === "metadata" ? { voiceBodiesFor: [] } : undefined)
        : client.readSnapshot(kind);
      for (const kind of ["metadata", "activity", "owners"] as const) await request(kind);
      resetBlockingWaitsForTests(() => {});
      legacyDiagnostics.resetBlockingWaitsForTests(() => {});
      await sleep(30);
      const gaps: number[] = [], elapsed: number[] = [];
      let last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); gaps.push(Math.max(0, now - last - 5)); last = now; }, 5);
      const start = performance.now(), cpu = process.cpuUsage(), heap = process.memoryUsage().heapUsed;
      try {
        for (let burst = 0; burst < 6; burst++) {
          await sleep(Math.max(0, start + burst * 10_000 - performance.now()));
          await Promise.all(schedule.map(async kind => { const at = performance.now(); await request(kind); elapsed.push(performance.now() - at); }));
        }
        await sleep(Math.max(0, start + 60_000 - performance.now()));
      } finally { clearInterval(timer); }
      const usage = process.cpuUsage(cpu);
      runs.push({ round, variant, requests: 48, offeredWindowMs: 60_000, wallMs: performance.now() - start,
        bytesPer48: 6 * schedule.reduce((sum, kind) => sum + Buffer.byteLength(bodies[variant]![kind]!) + 66, 0),
        rpcMs: statistics(elapsed), timerLatenessMs: statistics(gaps), gapsOver50Ms: gaps.filter(gap => gap >= 50).length,
        cpuMs: (usage.user + usage.system) / 1_000, heapDeltaBytes: process.memoryUsage().heapUsed - heap,
        parse: (variant === "before" ? legacyDiagnostics.blockingWaitDiagnostics() : blockingWaitDiagnostics()).sites["snapshot-parse"] });
    } finally {
      child.stdin.write("quit\n"); child.stdin.end();
      await child.exited; reader.releaseLock();
    }
  }
  if (hash(fs.readFileSync(backup)) !== beforeHash) throw new Error("source backup changed");
  const report = { at: new Date().toISOString(), bun: Bun.version, backupSha256: beforeHash,
    clock, rounds: 3, schedule, equalOracleReads: oracleHashes.size, payloads: Object.fromEntries(Object.entries(bodies).map(([variant, values]) =>
      [variant, Object.fromEntries(Object.entries(values).map(([kind, body]) => [kind, { bytes: Buffer.byteLength(body), sha256: hash(body) }]))])), collection, fullControls, runs };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
