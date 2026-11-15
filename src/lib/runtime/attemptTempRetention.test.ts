import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { statePath } from "@/lib/configDir";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { attemptReferencesClear, repositoryReferencesAttemptTemp } from "./attemptTempFilesystem";
import * as filesystem from "./attemptTempFilesystem";
import * as removal from "./attemptTempRemoval";
import type { ProcessScan } from "@/lib/tempSweep";
import { AttemptTempStore, BLOCKED_SUBTREE_RETRY_MS, EXPIRED_HOLD_RETRY_MS, sweepAttemptTemps, type AttemptTempState, type AttemptTempOwner } from "./attemptTempRetention";
import { attemptTempAuthority, attemptTempState } from "./attemptTempProduction";
import { finishedLane, holdFinishedRoot, nameInReport } from "./attemptTempRetention.testSupport";
import { recordedRootHeld, RecordedCheckStore } from "@/lib/recordedChecks/store";
import { Database } from "bun:sqlite";
import { sweepEvidenceCopies } from "./attemptEvidenceCopies";
import * as copyDiscovery from "./attemptCopyDiscovery";
import { digest } from "@/lib/recordedChecks/wire";
import * as evidenceCopy from "./attemptTempCopy";
import { preserveAttemptEvidence } from "./attemptTempEvidence";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { attemptMutationCurrent } from "./attemptMutationFence";
import { sweepMonotonicNow } from "./attemptTempDeadline";

const roots: string[] = [];
afterEach(() => { removeKeepMarkers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(statePath("report-media"), { recursive: true, force: true }); });
const NOW = Date.parse("2026-10-22T12:00:00Z");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attempt-retention-")); roots.push(root);
  const filename = path.join(root, "owners.sqlite");
  const store = new AttemptTempStore(filename);
  const make = (name: string, age = 0, evidence = false, launchId = name) => {
    const directory = path.join(root, `llv-stage-${name}`); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
    store.register({ directory, pipelineId: "lane", launchId, retainUntilClose: evidence, createdAt: NOW - age });
    return directory;
  };
  const sweep = (state: AttemptTempState = "settled", options = {}) => sweepAttemptTemps(store, {
    now: () => NOW, state: async () => state, scan: () => ({ ownNamespace: null, processes: [] }),
    references: (original: string, current: string, scan: ProcessScan) => attemptReferencesClear(original, current, scan, async () => true), ...options,
  });
  return { root, filename, store, make, sweep };
}

test.each([1, 2, 3, 4])("expired root keeps a nested human marker added at reference boundary %i", async boundary => {
  const f = fixture(), directory = f.make("late-marker");
  fs.mkdirSync(path.join(directory, "nested"));
  let reads = 0, injected = false;
  try {
    const report = await f.sweep("expired", { references: async (_original: string, current: string) => {
      if (++reads === boundary) { plantKeepMarker(path.join(current, "nested", ".delegatus-keep")); injected = true; }
      return true;
    } });
    expect(injected).toBeTrue(); expect(report.removed).toBe(0);
    expect(fs.existsSync(path.join(directory, "nested", ".delegatus-keep"))).toBeTrue();
    expect(f.store.has(directory)).toBeTrue();
  } finally { f.store.close(); }
});

test.each([
  { replay: false, boundary: "references" }, { replay: true, boundary: "references" },
  { replay: false, boundary: "authority" }, { replay: true, boundary: "authority" },
])("copy protection survives a late marker (%j)", async ({ replay, boundary }) => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const destination = statePath("evidence", "attempt-temp", digest("late-copy-marker"));
  fs.mkdirSync(path.join(destination, "nested"), { recursive: true });
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  const options = { now: () => NOW, state: async () => "expired" as const,
    scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true };
  try {
    if (replay) {
      const original = removal.removeTreeWithinAttemptBudget;
      const rm = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (target, started) => {
        started();
        if (path.basename(target).startsWith(".delegatus-trash-")) throw new Error("fixture interrupted copy retirement");
        return original(target, started);
      });
      try { expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(1); } finally { rm.mockRestore(); }
      f.store.registerCopy({ ...f.store.copy(destination)!, checkedAt: 0 });
    }
    let injected = false, target = "", observedDirectory = destination;
    const pin = (current: string) => {
      if (current !== destination && !injected) {
        target = path.join(current, "nested", ".delegatus-keep"); plantKeepMarker(target); injected = true;
      }
    };
    const report = await sweepEvidenceCopies(f.store, { ...options, authority: async () => {
      if (boundary === "authority") pin(observedDirectory);
      return { state: "expired", expiresAt: 1, revision: "fixture", isCurrent: () => true };
    }, references: async (_original, current) => {
      observedDirectory = current;
      if (boundary === "references") pin(current);
      return true;
    } });
    expect(injected).toBeTrue(); expect(report.removed).toBe(0); expect(f.store.copy(destination)).not.toBeNull();
    expect(fs.existsSync(path.join(destination, "nested", ".delegatus-keep"))).toBeTrue();
    expect(fs.existsSync(attemptTempJournalPath(destination))).toBeFalse();
    expect(f.store.retention(NOW)).toMatchObject({ dueBytes: 0, upcomingBytes: 0 });
    f.store.close();
    const reopened = new AttemptTempStore(f.filename);
    try { expect(reopened.retention(NOW)).toMatchObject({ dueBytes: 0, upcomingBytes: 0 }); }
    finally { reopened.close(); }
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test.each([false, true])("a human marker added in the final root authority read survives (replay=%s)", async replay => {
  const f = fixture(), directory = f.make("authority-marker"), trash = path.join(f.root, ".delegatus-trash-llv-stage-authority-marker-replay");
  fs.mkdirSync(path.join(directory, "nested"));
  if (replay) {
    const stat = fs.lstatSync(directory); fs.renameSync(directory, trash);
    fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({ directory, trash, uid: stat.uid,
      identity: `${stat.dev}:${stat.ino}`, disposable: true }));
  }
  let currentDirectory = directory, injected = false;
  try {
    const report = await f.sweep("expired", { references: async (_original: string, current: string) => { currentDirectory = current; return true; },
      authority: async () => {
        if (currentDirectory !== directory && !injected) { plantKeepMarker(path.join(currentDirectory, "nested", ".delegatus-keep")); injected = true; }
        return { state: "expired", expiresAt: 1, revision: "fixture", isCurrent: () => true };
      } });
    expect(injected).toBeTrue(); expect(report.removed).toBe(0); expect(f.store.has(directory)).toBeTrue();
    expect(fs.existsSync(path.join(directory, "nested", ".delegatus-keep"))).toBeTrue();
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
  } finally { f.store.close(); }
});

test("a missing automatic-copy parent reconciles expired rows and old failures across a restart", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "missing-copy-state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  const parent = statePath("evidence", "attempt-temp"), destination = path.join(parent, digest("missing-parent"));
  // An earlier cleanup has already removed the namespace; no filesystem effect is needed.
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane",
    createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  f.store.copyFailure(destination, "earlier cleanup");
  f.store.copyFailure(parent, "earlier discovery failure");
  try {
    const options = { now: () => NOW, state: async () => "expired" as const,
      authority: async () => ({ state: "expired" as const, expiresAt: 1, revision: "fixture", isCurrent: () => true }),
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true };
    expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(0);
    expect(f.store.copy(destination)).toBeNull();
    expect(f.store.retention(NOW).dueBytes).toBe(0);
    expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(0);
    f.store.close();
    expect((await retentionProcess(f.filename, NOW + 60001, "copies")).errors).toBe(0);
    const db = new Database(f.filename);
    try { expect(db.query("SELECT * FROM copy_retention_failures").all()).toEqual([]); }
    finally { db.close(); }
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test.each(["live", "revoked", "symlink", "unreadable", "replaced"] as const)("missing copy reconciliation retains %s authority or parent proof", async kind => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "guarded-copy-state"); fs.mkdirSync(process.env.LLV_STATE_DIR);
  const parent = statePath("evidence", "attempt-temp"), destination = path.join(parent, digest(kind));
  const external = path.join(f.root, "external"); fs.mkdirSync(external);
  if (kind === "symlink") { fs.mkdirSync(path.dirname(parent)); fs.symlinkSync(external, parent); }
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  const access = fs.accessSync;
  const unreadable = kind === "unreadable" ? spyOn(fs, "accessSync").mockImplementation((target, mode) => {
    if (String(target) === process.env.LLV_STATE_DIR) throw Object.assign(new Error("fixture unreadable parent"), { code: "EACCES" });
    return access(target, mode);
  }) : null;
  try {
    const report = await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "expired",
      authority: async () => {
        if (kind === "replaced") fs.mkdirSync(parent, { recursive: true });
        return { state: kind === "live" ? "live" : "expired", expiresAt: 1, revision: "fixture", isCurrent: () => kind !== "revoked" };
      }, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(report.removed).toBe(0); expect(f.store.copy(destination)).not.toBeNull();
    expect(fs.readdirSync(external)).toEqual([]);
    if (kind === "live" || kind === "revoked") expect(report.errors).toBe(0);
    else expect(report.errors).toBeGreaterThan(0);
  } finally { unreadable?.mockRestore(); f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("missing copy namespaces reconcile eight rows per process without phantom bytes", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "bounded-missing-state"); fs.mkdirSync(process.env.LLV_STATE_DIR);
  try {
    for (let n = 0; n < 20; n++) f.store.registerCopy({ destination: statePath("evidence", "attempt-temp", digest(n)),
      pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
    f.store.close();
    for (const checked of [8, 8, 4]) {
      const report = await retentionProcess(f.filename, NOW, "copies");
      expect(report).toMatchObject({ checked, removed: 0, errors: 0 });
    }
    const reopened = new AttemptTempStore(f.filename);
    try { expect(reopened.retention(NOW).dueBytes).toBe(0); expect(reopened.dueCopies(NOW, 8)).toEqual([]); }
    finally { reopened.close(); }
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("reporting reads remain bounded with a large copy and root backlog", () => {
  const f = fixture(), db = new Database(f.filename);
  try {
    db.transaction(() => {
      for (let n = 0; n < 10000; n++) {
        db.query("INSERT INTO copies VALUES(?,NULL,'legacy','unattributed',1,NULL,0,4096)").run(`copy-${n}`);
        db.query("INSERT INTO roots VALUES(?,'lane','launch',1,1,'1:1',0,0,4096)").run(`root-${n}`);
        db.query("INSERT INTO root_retention(directory,expiresAt) VALUES(?,1)").run(`root-${n}`);
      }
    })();
    const ledger = (f.store as unknown as { db: Database }).db, query = ledger.query.bind(ledger);
    const plans: string[] = [], executions: { sql: string; args: unknown[] }[] = [];
    const observed = spyOn(ledger, "query").mockImplementation(((sql: string) => {
      if (/^SELECT/i.test(sql.trim())) {
        const parameters = sql.match(/\?/g)?.length ?? 0;
        plans.push(...query(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(parameters).fill(NOW)).map(row => (row as { detail: string }).detail));
      }
      const statement = query(sql);
      return new Proxy(statement, { get(target, method) {
        const value = Reflect.get(target, method);
        if (method === "get" || method === "all") return (...args: unknown[]) => {
          executions.push({ sql, args });
          return value.apply(target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof ledger.query);
    try { f.store.retention(NOW); f.store.unattributedCopies(); }
    finally { observed.mockRestore(); }
    let aggregateRows = 0;
    for (const { sql, args } of executions) {
      if (!/sum\s*\(/i.test(sql)) continue;
      const bounded = /FROM \(([\s\S]*)\)\s*$/i.exec(sql)?.[1];
      if (bounded) aggregateRows += query(bounded).all(...args as []).length;
      else {
        const from = sql.slice(sql.toUpperCase().indexOf("FROM "));
        const parameters = from.match(/\?/g)?.length ?? 0;
        aggregateRows += (query(`SELECT count(*) AS count ${from}`).get(...(parameters ? args.slice(-parameters) : []) as []) as { count: number }).count;
      }
    }
    expect(aggregateRows).toBeGreaterThan(0);
    expect(aggregateRows).toBeLessThanOrEqual(3584);
    expect(plans.join("\n")).not.toMatch(/SCAN (?:copies|roots|r)(?:\s|$)/);
    expect(f.store.retention(NOW).dueBytes).toBe(10000 * 4096);
    expect(f.store.unattributedCopies()).toEqual({ count: 10000, bytes: 10000 * 4096 });
  } finally { db.close(); f.store.close(); }
});

test("legacy reporting advances bounded pages across real helper restarts and skips an exhausted deadline", async () => {
  const f = fixture(); f.store.close();
  const legacy = path.join(f.root, "legacy.sqlite"), db = new Database(legacy);
  db.exec(`CREATE TABLE roots(directory TEXT PRIMARY KEY,pipelineId TEXT,launchId TEXT,retainUntilClose INTEGER,
    createdAt REAL,identity TEXT,released INTEGER,checkedAt REAL,bytes REAL);
    CREATE TABLE copies(destination TEXT PRIMARY KEY,pipelineId TEXT,launchId TEXT,kind TEXT,
      createdAt REAL,expiresAt REAL,checkedAt REAL,bytes REAL);
    CREATE TABLE root_retention(directory TEXT PRIMARY KEY,expiresAt REAL,failure TEXT);`);
  db.transaction(() => {
    for (let n = 0; n < 101; n++) {
      const key = String(n).padStart(3, "0");
      db.query("INSERT INTO roots VALUES(?,'lane','launch',1,1,'1:1',0,0,4096)").run(key);
      db.query("INSERT INTO root_retention VALUES(?,1,NULL)").run(key);
      db.query("INSERT INTO copies VALUES(?,NULL,'legacy','unattributed',1,NULL,0,2048)").run(key);
    }
  })(); db.close();
  const store = new AttemptTempStore(legacy);
  try {
    store.refreshReporting(() => NOW, NOW);
    expect(store.retention(NOW)).toMatchObject({ dueBytes: 0, partial: true });
    expect(store.unattributedCopies()).toEqual({ count: 0, bytes: 0 });
  } finally { store.close(); }
  for (const count of [32, 64, 96, 101]) {
    const result = await retentionProcess(legacy, NOW, "reporting");
    expect(result.retention).toMatchObject({ dueBytes: count * 4096, upcomingBytes: 0, partial: count < 101 });
    expect(result.unattributed).toEqual({ count, bytes: count * 2048 });
  }
  const reopened = new AttemptTempStore(legacy);
  try {
    reopened.forget("000"); reopened.forgetCopy("000");
    reopened.refreshReporting(() => NOW, NOW);
    expect(reopened.retention(NOW)).toMatchObject({ dueBytes: 100 * 4096, partial: false });
    expect(reopened.unattributedCopies()).toEqual({ count: 100, bytes: 100 * 2048 });
  } finally { reopened.close(); }
});

test("incremental reporting follows bytes, expiry, pins, deletion and clock changes at radix boundaries", () => {
  const f = fixture(), directory = f.make("reporting"), expiries = [1, 255, 256, 65535, 65536, 65536.5, NOW, NOW + 256];
  try {
    f.store.measure(directory, 111); f.store.retainRoot(directory, 256);
    expiries.forEach((expiresAt, n) => f.store.registerCopy({ destination: `copy-${n}`, pipelineId: "lane", launchId: "launch",
      kind: "lane", createdAt: 1, expiresAt, checkedAt: 0, bytes: n + 1 }));
    for (const now of [0, 1, 255, 256, 65535, 65536, 65537, NOW, NOW + 256, 255]) {
      const due = expiries.reduce((sum, expiry, n) => sum + (expiry <= now ? n + 1 : 0), 0) + (256 <= now ? 111 : 0);
      const upcoming = expiries.reduce((sum, expiry, n) => sum + (expiry > now && expiry <= now + 256 ? n + 1 : 0), 0)
        + (256 > now && 256 <= now + 256 ? 111 : 0);
      expect(f.store.retention(now, 256)).toMatchObject({ dueBytes: due, upcomingBytes: upcoming });
    }
    f.store.copyEligible("copy-0", false); f.store.copyEligible("copy-7", false);
    expect(f.store.retention(NOW, 256)).toMatchObject({ dueBytes: 138, upcomingBytes: 0 });
    f.store.measure(directory, 222); f.store.retainRoot(directory, null);
    expect(f.store.retention(NOW, 256).dueBytes).toBe(27);
    f.store.forgetCopy("copy-1"); f.store.copyEligible("copy-0", true);
    expect(f.store.retention(NOW, 256).dueBytes).toBe(26);
  } finally { f.store.close(); }
});

test("a repeated copy discovery failure is logged once and clears after discovery recovers", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "discovery-state");
  const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
  const discovery = spyOn(copyDiscovery, "discoverAttemptCopies").mockImplementation(() => { throw new Error("fixture discovery refusal"); });
  const lines: unknown[][] = [], log = spyOn(console, "error").mockImplementation((...args) => { lines.push(args); });
  const options = { now: () => NOW, state: async () => "expired" as const, scan: () => ({ ownNamespace: null, processes: [] }) };
  try {
    for (let n = 0; n < 3; n++) expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(1);
    expect(lines).toHaveLength(1);
    discovery.mockRestore();
    expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(0);
    const db = new Database(f.filename);
    try { expect(db.query("SELECT * FROM copy_retention_failures WHERE destination=?").all(parent)).toEqual([]); }
    finally { db.close(); }
  } finally { discovery.mockRestore(); log.mockRestore(); f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("a copy sweep with its deadline spent never reads the backlog for reporting", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "spent-state");
  let clockReads = 0;
  const reads = spyOn(f.store, "dueCopies");
  const inspections = spyOn(f.store, "copiesToInspect");
  try {
    const report = await sweepEvidenceCopies(f.store, { now: () => ++clockReads === 1 ? NOW : NOW + 10001,
      state: async () => "expired", scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(report.checked).toBe(0); expect(report.errors).toBe(0);
    expect(reads).not.toHaveBeenCalled();
    expect(inspections).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); inspections.mockRestore(); f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("an existing nested human marker keeps an expired automatic copy", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const destination = statePath("evidence", "attempt-temp", digest("existing-copy-marker"));
  fs.mkdirSync(path.join(destination, "nested"), { recursive: true });
  plantKeepMarker(path.join(destination, "nested", ".delegatus-keep"));
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  try {
    expect((await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "expired",
      authority: async () => ({ state: "expired", expiresAt: 1, revision: "fixture", isCurrent: () => true }),
      references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) })).removed).toBe(0);
    expect(fs.existsSync(path.join(destination, "nested", ".delegatus-keep"))).toBeTrue();
    expect(f.store.copy(destination)).not.toBeNull();
    expect(f.store.retention(NOW).dueBytes).toBe(0);
    expect(f.store.retention(NOW).upcomingBytes).toBe(0);
    f.store.close();
    expect((await retentionProcess(f.filename, NOW + 60001, "copies")).removed).toBe(0);
    const reopened = new AttemptTempStore(f.filename);
    try { expect(reopened.retention(NOW + 60001).dueBytes).toBe(0); }
    finally { reopened.close(); }
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("a pinned copy in quarantine stays out of upcoming bytes when expiry moves into the future", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "recent-trash-state");
  const destination = statePath("evidence", "attempt-temp", digest("recent-trash"));
  fs.mkdirSync(destination, { recursive: true }); plantKeepMarker(path.join(destination, ".delegatus-keep"));
  const stat = fs.lstatSync(destination), trash = path.join(path.dirname(destination), `.delegatus-trash-${path.basename(destination)}-fixture`);
  fs.renameSync(destination, trash);
  fs.writeFileSync(attemptTempJournalPath(destination), JSON.stringify({ directory: destination, trash, uid: stat.uid,
    identity: `${stat.dev}:${stat.ino}`, disposable: true }));
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  try {
    expect((await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "closed",
      authority: async () => ({ state: "closed", expiresAt: NOW + 1000, revision: "fixture", isCurrent: () => true }),
      scan: () => ({ ownNamespace: null, processes: [] }) })).removed).toBe(0);
    expect(f.store.retention(NOW)).toMatchObject({ dueBytes: 0, upcomingBytes: 0 });
    expect(fs.existsSync(path.join(destination, ".delegatus-keep"))).toBeTrue();
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("a recent pinned copy stays out of upcoming bytes and becomes eligible after its marker is removed", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "recent-copy-state");
  const destination = statePath("evidence", "attempt-temp", digest("recent-pin")), marker = path.join(destination, ".delegatus-keep");
  fs.mkdirSync(destination, { recursive: true }); plantKeepMarker(marker);
  const expiresAt = NOW + 6 * 86400000;
  // The root sweep schedules its new copy at expiry, without a due visit first.
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane",
    createdAt: 1, expiresAt, checkedAt: expiresAt, bytes: 4096 });
  const options = { now: () => NOW, state: async () => "closed" as const,
    authority: async () => ({ state: "closed" as const, expiresAt, revision: "fixture", isCurrent: () => true }),
    scan: () => ({ ownNamespace: null, processes: [] }) };
  try {
    for (let n = 0; n < 3; n++) {
      expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(0);
      expect(f.store.copy(destination)).toMatchObject({ expiresAt, checkedAt: expiresAt });
      expect(f.store.retention(NOW)).toMatchObject({ dueBytes: 0, upcomingBytes: 0 });
    }
    const restart = async () => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"),
        f.filename, String(NOW + 60001), "scheduled-copies", String(expiresAt)],
        { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, error).toBe(0);
      return JSON.parse(output);
    };
    expect((await restart()).retention).toMatchObject({ dueBytes: 0, upcomingBytes: 0, until: null });
    expect(fs.existsSync(marker)).toBeTrue();
    fs.unlinkSync(marker);
    expect((await restart()).retention).toMatchObject({ dueBytes: 0, upcomingBytes: 4096, until: expiresAt });
    expect(f.store.copy(destination)).toMatchObject({ expiresAt, checkedAt: expiresAt });
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("scheduled copy inspection advances eight rows per process independently of expiry", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "inspection-state");
  const expiresAt = NOW + 6 * 86400000, destinations: string[] = [];
  try {
    for (let n = 0; n < 20; n++) {
      const destination = statePath("evidence", "attempt-temp", digest(n)); destinations.push(destination);
      fs.mkdirSync(destination, { recursive: true }); plantKeepMarker(path.join(destination, ".delegatus-keep"));
      f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane",
        createdAt: 1, expiresAt, checkedAt: expiresAt, bytes: 4096 });
    }
    // An unattributable backlog must not be scanned by the independent cursor.
    const db = new Database(f.filename);
    try {
      db.transaction(() => {
        for (let n = 0; n < 1000; n++) db.query("INSERT INTO copies VALUES(?,NULL,'legacy','unattributed',1,NULL,0,1)").run(`legacy-${n}`);
      })();
      const plans = db.query<{ detail: string }, [string, number]>("EXPLAIN QUERY PLAN SELECT * FROM copies WHERE destination>? AND kind<>'unattributed' ORDER BY destination LIMIT ?").all("", 8);
      expect(plans.every(row => !row.detail.includes("SCAN"))).toBeTrue();
    } finally { db.close(); }
    for (const [inspected, remaining] of [[8, 12], [8, 4], [4, 0]]) {
      const result = await retentionProcess(f.filename, NOW, "scheduled-copies", String(expiresAt));
      expect(result.report).toMatchObject({ inspected, checked: 0, removed: 0, errors: 0 });
      expect(result.retention.upcomingBytes).toBe(remaining! * 4096);
    }
    for (const destination of destinations) {
      expect(f.store.copy(destination)).toMatchObject({ expiresAt, checkedAt: expiresAt });
      expect(fs.existsSync(path.join(destination, ".delegatus-keep"))).toBeTrue();
    }
    // A complete scan wraps durably and can observe a removed pin next time.
    fs.unlinkSync(path.join(destinations.sort()[0], ".delegatus-keep"));
    const next = await retentionProcess(f.filename, NOW, "scheduled-copies", String(expiresAt));
    expect(next.report).toMatchObject({ inspected: 8, removed: 0, errors: 0 });
    expect(next.retention).toMatchObject({ dueBytes: 0, upcomingBytes: 4096, until: expiresAt });
  } finally { f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test.each(["late-pin", "replacement", "parent-symlink", "unreadable", "deadline"] as const)("scheduled copy forecast refuses %s after inspection and recovers", async kind => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "inspection-race-state");
  const destination = statePath("evidence", "attempt-temp", digest(kind)), expiresAt = NOW + 6 * 86400000;
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, "payload"), "keep data");
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane",
    createdAt: 1, expiresAt, checkedAt: expiresAt, bytes: 4096 });
  let now = NOW;
  const inspect = filesystem.inspectAttemptTree;
  const observation = spyOn(filesystem, "inspectAttemptTree").mockImplementation(async (directory, original) => {
    const result = await inspect(directory, original);
    if (directory === destination) {
      if (kind === "late-pin") plantKeepMarker(path.join(directory, ".delegatus-keep"));
      if (kind === "replacement") { fs.renameSync(directory, directory + "-previous"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "replacement"); }
      if (kind === "parent-symlink") {
        const parent = path.dirname(directory); fs.renameSync(parent, parent + "-previous"); fs.symlinkSync(parent + "-previous", parent);
      }
      if (kind === "unreadable") throw Object.assign(new Error("fixture unreadable copy"), { code: "EACCES" });
      if (kind === "deadline") now += 10001;
    }
    return result;
  });
  const options = { now: () => now, state: async () => "closed" as const,
    scan: () => ({ ownNamespace: null, processes: [] }) };
  try {
    const report = await sweepEvidenceCopies(f.store, options);
    expect(report).toMatchObject({ inspected: 1, checked: 0, removed: 0, errors: kind === "unreadable" ? 1 : 0 });
    expect(f.store.retention(NOW)).toMatchObject({ dueBytes: 0, upcomingBytes: 0 });
    expect(f.store.copy(destination)).toMatchObject({ expiresAt, checkedAt: expiresAt });
    expect(fs.readFileSync(path.join(destination, "payload"), "utf8")).toBe(kind === "replacement" ? "replacement" : "keep data");
    observation.mockRestore();
    if (kind === "late-pin") fs.unlinkSync(path.join(destination, ".delegatus-keep"));
    if (kind === "parent-symlink") { const parent = path.dirname(destination); fs.unlinkSync(parent); fs.renameSync(parent + "-previous", parent); }
    const next = await retentionProcess(f.filename, NOW + 60001, "scheduled-copies", String(expiresAt));
    expect(next.report).toMatchObject({ inspected: 1, checked: 0, removed: 0, errors: 0 });
    expect(next.retention.upcomingBytes).toBe(4096);
  } finally { observation.mockRestore(); f.store.close(); process.env.LLV_STATE_DIR = priorState; }
});

test("expired linked evidence retires without following its target; recent failures are logged once", async () => {
  const f = fixture(), directory = f.make("linked", 30 * 86400000), target = path.join(f.root, "outside");
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, "frame.png"), "keep target");
  fs.symlinkSync(target, path.join(directory, ".artifacts"));
  const lines: unknown[][] = [], log = spyOn(console, "error").mockImplementation((...args) => { lines.push(args); });
  try {
    for (let n = 0; n < 3; n++) { f.store.defer(directory, 0); expect((await f.sweep("closed")).errors).toBe(1); }
    expect(lines).toHaveLength(1);
    f.store.defer(directory, 0);
    expect((await f.sweep("expired")).removed).toBe(1);
    expect(fs.readFileSync(path.join(target, "frame.png"), "utf8")).toBe("keep target");
  } finally { log.mockRestore(); f.store.close(); }
});

test.each(["keep", "outside-git", "cwd", "checkout-link"])("retention preserves an expired root protected by %s", async kind => {
  const f = fixture(), directory = f.make(kind, 30 * 86400000), checkout = path.join(f.root, "checkout");
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  if (kind === "keep") plantKeepMarker(path.join(directory, ".delegatus-keep"));
  if (kind === "outside-git") fs.writeFileSync(path.join(directory, ".git"), `gitdir: ${path.join(checkout, ".git")}\n`);
  if (kind === "checkout-link") fs.symlinkSync(directory, path.join(checkout, "scratch"));
  const scan = () => ({ ownNamespace: null, processes: kind === "cwd" || kind === "checkout-link"
    ? [{ pid: 123, namespace: null, stamped: false, paths: [kind === "cwd" ? directory : checkout] }] : [] });
  try {
    expect((await f.sweep("expired", { scan })).removed).toBe(0);
    expect(fs.existsSync(directory)).toBeTrue();
  } finally { f.store.close(); }
});

test.each(["absent", "quarantine"])("expired recorded hold is settled for a previously %s root", async kind => {
  const f = fixture(), directory = f.make(kind, 30 * 86400000);
  try {
    const ids = [await holdFinishedRoot(directory, "lane", "first", [], f.store.owner(directory)!.launchId), await holdFinishedRoot(directory, "lane", "second", [], f.store.owner(directory)!.launchId)];
    if (kind === "absent") fs.rmSync(directory, { recursive: true });
    else {
      const stat = fs.lstatSync(directory), trash = path.join(f.root, ".delegatus-trash-llv-stage-quarantine-fixture");
      fs.renameSync(directory, trash);
      fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({ directory, trash, uid: stat.uid, identity: `${stat.dev}:${stat.ino}`, disposable: true }));
    }
    const result = await f.sweep("expired");
    expect(result.errors).toBe(0); expect(result.removed).toBe(kind === "absent" ? 0 : 1);
    expect(recordedRootHeld(directory)).toBeFalse(); expect(f.store.has(directory)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
    const checks = new RecordedCheckStore(undefined, false);
    try { for (const id of ids) expect(checks.get(id)?.acknowledgement?.disposition).toBe("expired-with-lane"); }
    finally { checks.close(); }
  } finally { f.store.close(); }
});

test("retention removal holds no state transaction or collection lease", async () => {
  const f = fixture(), directory = f.make("lock-free", 30 * 86400000);
  try {
    await holdFinishedRoot(directory, "lane", "", [], f.store.owner(directory)!.launchId);
    let removals = 0;
    const result = await f.sweep("expired", { remove: async (trash: string, guard: () => Promise<boolean>, dispatch: () => boolean,
      mutationStarted: () => void) => {
      expect(await guard()).toBeTrue(); expect(dispatch()).toBeTrue();
      const db = new Database(statePath("state.sqlite"));
      try {
        db.exec("PRAGMA busy_timeout=0"); db.exec("BEGIN IMMEDIATE");
        if (db.query("SELECT 1 FROM sqlite_master WHERE name='state_leases'").get())
          expect(db.query("SELECT 1 FROM state_leases LIMIT 1").get()).toBeNull();
        db.exec("ROLLBACK");
      } finally { db.close(); }
      removals++; mutationStarted(); await fs.promises.rm(trash, { recursive: true });
    } });
    expect(result.errors).toBe(0); expect(removals).toBe(1);
  } finally { f.store.close(); }
});

test.each(["before-quarantine", "after-quarantine"])("a new process resumes expired retirement %s", async where => {
  const f = fixture(), directory = f.make(where, 30 * 86400000);
  await holdFinishedRoot(directory, "lane", "", [], f.store.owner(directory)!.launchId);
  let interrupted = false;
  try {
    const report = await f.sweep("expired", where === "before-quarantine" ? { references: async () => { interrupted = true; throw new Error("fixture stop before quarantine"); } }
      : { remove: async () => { interrupted = true; throw new Error("fixture stop after quarantine"); } });
    expect(interrupted).toBeTrue(); expect(report.errors).toBeGreaterThan(0);
    expect(recordedRootHeld(directory)).toBeFalse();
  } finally { f.store.close(); }
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(NOW + 60001), "expired"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0); expect(JSON.parse(output).removed).toBe(1);
  const reopened = new AttemptTempStore(f.filename);
  try { expect(reopened.has(directory)).toBeFalse(); expect(fs.existsSync(directory)).toBeFalse(); }
  finally { reopened.close(); }
});

test("a mismatched recorded-check binding refuses expiry and leaves independent work runnable", async () => {
  const f = fixture(), directory = f.make("binding-mismatch", 30 * 86400000), independent = f.make("independent", 30 * 86400000);
  try {
    await holdFinishedRoot(directory, "another-lane");
    const report = await f.sweep("expired");
    expect(report.errors).toBe(1); expect(report.removed).toBe(1);
    expect(recordedRootHeld(directory)).toBeTrue(); expect(fs.existsSync(directory)).toBeTrue(); expect(fs.existsSync(independent)).toBeFalse();
  } finally { f.store.close(); }
});

test.each(["pipeline", "launch", "identity", "missing"] as const)("a changed sibling %s refuses the whole acknowledgement before preparation and after admission", async change => {
  for (const boundary of ["preparation", "admission"] as const) {
    const f = fixture(), directory = f.make("first"), sibling = f.make("sibling", 0, true, "first");
    const id = await holdFinishedRoot(directory, "lane", boundary, [sibling], "first");
    const mutate = () => {
      const db = new Database(f.filename);
      try {
        if (change === "missing") db.query("DELETE FROM roots WHERE directory=?").run(sibling);
        else {
          const field = { pipeline: "pipelineId", launch: "launchId", identity: "identity" }[change];
          db.query(`UPDATE roots SET ${field}=? WHERE directory=?`).run(change === "identity" ? "0:0" : "replacement", sibling);
        }
      } finally { db.close(); }
    };
    const write = RecordedCheckStore.prototype.write;
    let injected = false;
    const hook = spyOn(RecordedCheckStore.prototype, "write").mockImplementation(async function (this: RecordedCheckStore, ...args: Parameters<typeof write>) {
      if (boundary === "admission" && args[0].id === id && args[0].acknowledgement?.disposition === "expired-with-lane") { mutate(); injected = true; }
      return write.apply(this, args);
    });
    try {
      if (boundary === "preparation") mutate();
      const report = await f.sweep("expired", { maxRoots: 1, authority: async () => ({ state: "expired", expiresAt: NOW - 1000, revision: "fixture", isCurrent: () => true }) });
      expect(report.removed).toBe(0); expect(report.errors).toBe(1);
      if (boundary === "admission") expect(injected).toBeTrue();
      for (const root of [directory, sibling]) {
        expect(recordedRootHeld(root)).toBeTrue(); expect(fs.existsSync(root)).toBeTrue();
        expect(f.store.requiredRootExpiry(root)).toBe(boundary === "preparation" ? null : NOW - 1000);
      }
      const checks = new RecordedCheckStore();
      try { expect(checks.get(id)?.acknowledgement).toBeNull(); } finally { checks.close(); }
    } finally { hook.mockRestore(); f.store.close(); }
  }
});

test("copies retain unfinished, recent and unattributed data and never touch durable evidence stores", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
  const candidates = ["expired", "recent", "open", "agent", "legacy"];
  const destinations = candidates.map(name => {
    const destination = path.join(parent, digest(name)); fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "capture.png"), name);
    if (name !== "legacy") f.store.registerCopy({ destination, pipelineId: name === "agent" ? null : name, launchId: name,
      kind: name === "agent" ? "agent" : "lane", createdAt: NOW - 8 * 86400000, expiresAt: name === "agent" ? NOW - 1000 : null, checkedAt: 0, bytes: 4096 });
    else fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ original: "/srv/missing-root", files: [] }));
    return destination;
  });
  const durable = [statePath("evidence", "lane", "frame.png"), statePath("evidence", "recorded-checks", "capture.png"),
    statePath("prototype-reviews", "frame.png"), path.join(f.root, "cleanup-ledger.jsonl")];
  for (const filename of durable) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, "durable"); }
  try {
    const report = await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "unknown",
      authority: async owner => ({ state: owner.pipelineId === "expired" ? "expired" : owner.pipelineId === "recent" ? "closed" : "live",
        expiresAt: owner.pipelineId === "recent" ? NOW + 86400000 : null, revision: "fixture", isCurrent: () => true }),
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report.errors).toBe(0); expect(report.removed).toBe(2); expect(report.unattributed.count).toBe(1);
    expect(destinations.map(destination => fs.existsSync(destination))).toEqual([false, true, true, false, true]);
    for (const filename of durable) expect(fs.readFileSync(filename, "utf8")).toBe("durable");
  } finally { process.env.LLV_STATE_DIR = priorState; f.store.close(); }
});

test("a creation-expired agent copy waits for the host-finish retention owner", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "agent-copy-state");
  const destination = statePath("evidence", "attempt-temp", digest("agent-copy")); fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "capture.png"), "capture");
  f.store.registerCopy({ destination, pipelineId: null, launchId: "agent-copy", kind: "agent", createdAt: NOW - 8 * 86400000,
    expiresAt: NOW - 1000, checkedAt: 0, bytes: 4096 });
  try {
    const report = await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "expired",
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true }, { agentCopiesManagedSeparately: true });
    expect(report.removed).toBe(0); expect(fs.existsSync(destination)).toBeTrue(); expect(f.store.copy(destination)?.expiresAt).toBeNull();
  } finally { process.env.LLV_STATE_DIR = priorState; f.store.close(); }
});

async function retentionProcess(filename: string, now: number, mode: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), filename, String(now), mode, ...args],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  return JSON.parse(output);
}

test("forty expired held roots drain in pages of four or thirty-two across process restarts", async () => {
  const f = fixture();
  const directories: string[] = [];
  try {
    for (let n = 0; n < 40; n++) {
      const directory = f.make(`bounded-${String(n).padStart(2, "0")}`, 30 * 86400000); directories.push(directory);
      await holdFinishedRoot(directory, "lane", "", [], f.store.owner(directory)!.launchId); f.store.measure(directory, 4096);
    }
    expect((await f.sweep("expired")).removed).toBe(4);
  } finally { f.store.close(); }
  expect((await retentionProcess(f.filename, NOW + 60001, "expired-pressure")).removed).toBe(32);
  expect((await retentionProcess(f.filename, NOW + 120002, "expired-pressure")).removed).toBe(4);
  expect(directories.every(directory => !fs.existsSync(directory) && !recordedRootHeld(directory))).toBeTrue();
}, 60000);

test("twenty expired copies drain eight per process and recover a journaled rename", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
  const destinations: string[] = [];
  try {
    for (let n = 0; n < 20; n++) {
      const destination = path.join(parent, digest(n)); fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "frame.png"), "fixture"); destinations.push(destination);
      f.store.registerCopy({ destination, pipelineId: "lane", launchId: String(n), kind: "lane", createdAt: 1,
        expiresAt: NOW - 1000, checkedAt: 0, bytes: 4096 });
    }
    const destination = destinations[0], stat = fs.lstatSync(destination), trash = path.join(parent, `.delegatus-trash-${path.basename(destination)}-fixture`);
    fs.renameSync(destination, trash);
    fs.writeFileSync(attemptTempJournalPath(destination), JSON.stringify({ directory: destination, trash, uid: stat.uid, identity: `${stat.dev}:${stat.ino}`, disposable: true }));
    f.store.close();
    for (const expected of [8, 8, 4]) expect((await retentionProcess(f.filename, NOW, "copies")).removed).toBe(expected);
    expect(destinations.every(directory => !fs.existsSync(directory))).toBeTrue(); expect(fs.existsSync(trash)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(destination))).toBeFalse();
  } finally { process.env.LLV_STATE_DIR = priorState; }
});

test("legacy adoption resumes its cursor in another process without losing the interrupted name", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
  try {
    const names = Array.from({ length: 65 }, (_, n) => digest(n)).sort();
    for (const name of names) {
      const destination = path.join(parent, name); fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ original: "/srv/absent", files: [] }));
    }
    // The first page was recorded; the helper stopped just after checkpointing
    // its next name and before registering it.
    for (const name of names.slice(0, 32)) f.store.registerCopy({ destination: path.join(parent, name), pipelineId: null,
      launchId: "legacy", kind: "unattributed", createdAt: 1, expiresAt: null, checkedAt: 0, bytes: 4096 });
    f.store.checkpointCopies(names[32]); f.store.close();
    let total = 32;
    for (let page = 0; page < 3; page++) {
      const result = await retentionProcess(f.filename, NOW, "copies");
      expect(result.adopted).toBeLessThanOrEqual(32); total += result.adopted;
    }
    expect(total).toBe(65);
    const last = await retentionProcess(f.filename, NOW, "copies");
    expect(last.adopted).toBe(0); expect(last.unattributed.count).toBe(65);
    expect(fs.readdirSync(parent)).toHaveLength(65);
  } finally { process.env.LLV_STATE_DIR = priorState; }
});

test("legacy adoption attributes a real producer manifest through its still-recorded owner", async () => {
  const f = fixture(), directory = f.make("legacy-owner"), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  try {
    fs.writeFileSync(path.join(directory, "frame.png"), "legacy capture");
    const evidence = await preserveAttemptEvidence(directory, directory, f.store.owner(directory)!.identity);
    expect(evidence.destination).toBeDefined();
    const report = await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "expired",
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report.adopted).toBe(1); expect(report.removed).toBe(1); expect(report.unattributed.count).toBe(0);
    expect(fs.existsSync(evidence.destination!)).toBeFalse(); expect(fs.existsSync(directory)).toBeTrue();
  } finally { process.env.LLV_STATE_DIR = priorState; f.store.close(); }
});

test("a changed copy authority after an awaited consumer observation preserves its directory", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const destination = statePath("evidence", "attempt-temp", digest("copy-race"));
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, "frame.png"), "preserve");
  f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  let current = true;
  try {
    const report = await sweepEvidenceCopies(f.store, { now: () => NOW, state: async () => "expired",
      authority: async () => ({ state: current ? "expired" : "live", revision: "fixture", isCurrent: () => current }),
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => { current = false; return true; } });
    expect(report.removed).toBe(0); expect(report.errors).toBe(0);
    expect(fs.readFileSync(path.join(destination, "frame.png"), "utf8")).toBe("preserve");
    expect(f.store.copy(destination)).not.toBeNull();
  } finally { process.env.LLV_STATE_DIR = priorState; f.store.close(); }
});

test("one failing evidence copy preserves its journal, logs once and allows an independent copy through", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "copy-state");
  const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
  const failed = path.join(parent, digest("failed-copy")), independent = path.join(parent, digest("independent-copy"));
  for (const destination of [failed, independent]) {
    fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "frame.png"), "capture");
    f.store.registerCopy({ destination, pipelineId: "lane", launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  }
  const remove = removal.removeTreeWithinAttemptBudget, lines: unknown[][] = [];
  const log = spyOn(console, "error").mockImplementation((...args) => { lines.push(args); });
  const rm = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (target, started) => {
    started();
    if (target.includes(path.basename(failed))) throw new Error("fixture copy removal refused");
    return remove(target, started);
  });
  let now = NOW;
  const options = { now: () => now, state: async () => "expired" as const,
    scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true };
  try {
    expect((await sweepEvidenceCopies(f.store, options)).removed).toBe(1);
    for (let n = 0; n < 2; n++) { now += 60001; expect((await sweepEvidenceCopies(f.store, options)).errors).toBe(1); }
    expect(lines).toHaveLength(1); expect(fs.existsSync(independent)).toBeFalse();
    expect(fs.existsSync(attemptTempJournalPath(failed))).toBeTrue();
    rm.mockRestore(); now += 60001;
    expect((await sweepEvidenceCopies(f.store, options)).removed).toBe(1);
  } finally { rm.mockRestore(); log.mockRestore(); process.env.LLV_STATE_DIR = priorState; f.store.close(); }
});

test("a settled attempt removes its scratch without waiting for host release", async () => {
  const f = fixture(); const directory = f.make("settled");
  try { expect((await f.sweep()).removed).toBe(1); expect(fs.existsSync(directory)).toBeFalse(); }
  finally { f.store.close(); }
});

type NamespacePath = "namespace-only" | "permission-fallback";
type NamespaceChange = "control" | "producer-changed" | "checkout-unreadable" | "root-replaced" | "namespace-refused";
type NamespaceTree = { foreign?: boolean; image?: "source" | "named" };
async function integratedNamespaceSweep(kind: NamespacePath, change: NamespaceChange = "control", expired = false, tree: NamespaceTree = {}) {
  const f = fixture(), directory = f.make(`namespace-${kind}`), bin = path.join(f.root, "bin");
  const checkout = path.join(f.root, "checkout"), completion = path.join(f.root, "cleanup-complete");
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  fs.mkdirSync(path.join(directory, "private")); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(directory, "private", "payload"), "reclaim me");
  if (expired) fs.writeFileSync(path.join(directory, "frame.png"), "expired evidence");
  // A container that ran as another user leaves a directory this user cannot list.
  const locked = path.join(directory, "private", "pgdata");
  if (tree.foreign) { fs.mkdirSync(locked); fs.writeFileSync(path.join(locked, "base"), "database files"); fs.chmodSync(locked, 0); }
  // An image of a checked-out source tree, and whether a report named it.
  const image = path.join(directory, "private", "vendor", "static", "icon.png");
  if (tree.image) { fs.mkdirSync(path.dirname(image), { recursive: true }); fs.writeFileSync(image, "source asset"); }
  if (tree.image === "named") nameInReport(image);
  f.store.measure(directory, 8192); f.store.release(directory);
  fs.writeFileSync(path.join(bin, "docker"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "ps" || args[0] === "rm") process.exit(0);
if (args[0] !== "run") process.exit(61);
const source = /source=([^,]+)/.exec(args[args.indexOf("--mount") + 1])?.[1];
if (!source || !source.startsWith(${JSON.stringify(f.root + path.sep)})) process.exit(62);
const scripts = args.flatMap((arg, index) => arg === "-c" ? [index] : []);
const commandAt = scripts[scripts.length - 1];
const script = args[commandAt + 1];
if (script.includes("sha256sum /tmp/sorted") && !script.includes("-delete")) {
  process.stdout.write("a".repeat(64) + "\\n"); process.exit(0);
}
// The namespace holds DAC_OVERRIDE: it lists what this user cannot.
const grant = file => { if (!fs.lstatSync(file).isDirectory()) return; fs.chmodSync(file, 0o700); for (const entry of fs.readdirSync(file)) grant(file + "/" + entry); };
// The no-evidence proof: the paths the evidence ledger links, passed after
// the identity, or, before them, every picture anywhere in the tree.
const at = commandAt + 2, linked = args.slice(at + 3, at + 3 + Number(args[at + 2]));
const pictures = file => { try { return fs.lstatSync(file).isDirectory() ? fs.readdirSync(file).some(entry => pictures(file + "/" + entry)) : /\.(png|jpe?g|gif|webp|avif|bmp|svg|pdf|mp4|webm)$/i.test(file); } catch { return false; } };
if (script.includes("found=$(find") ? pictures(source) : script.includes('test "$linked" = 0') && linked.some(file => fs.existsSync(source + "/" + file))) process.exit(75);
if (script.includes("-delete")) {
  if (${JSON.stringify(change)} === "namespace-refused") process.exit(75);
  process.stdout.write("DELEGATUS_REMOVAL_STARTED\\n");
  grant(source);
  for (const entry of fs.readdirSync(source)) fs.rmSync(source + "/" + entry, { recursive: true, force: true });
  if (${JSON.stringify(change)} === "checkout-unreadable") fs.chmodSync(${JSON.stringify(checkout)}, 0);
  if (${JSON.stringify(change)} === "root-replaced") {
    fs.renameSync(source, source + "-original"); fs.mkdirSync(source);
    fs.writeFileSync(source + "/payload", "replacement");
  }
  fs.writeFileSync(${JSON.stringify(completion)}, "done");
}
`, { mode: 0o700 });
  const previousPath = process.env.PATH, previousImage = process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  process.env.PATH = bin + path.delimiter + (previousPath ?? "");
  process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = "fixture-image";
  const nativeOpendir = fs.promises.opendir.bind(fs.promises);
  const opendir = spyOn(fs.promises, "opendir").mockImplementation(async (target, options) => {
    if (kind === "namespace-only" && String(target).startsWith(f.root + path.sep) && path.basename(String(target)) === "private")
      throw Object.assign(new Error("fixture private"), { code: "EACCES" });
    return nativeOpendir(target, options);
  });
  const nativeRm = removal.removeTreeWithinAttemptBudget;
  const rm = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (target, started) => {
    if (kind === "permission-fallback" && String(target).startsWith(f.root + path.sep) && path.basename(String(target)).startsWith(".delegatus-trash-"))
      throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return nativeRm(target, started);
  });
  try {
    const report = await f.sweep("closed", { maxRoots: 1, capBytes: 0, references: async () => true,
      state: async (owner: AttemptTempOwner, inventory: filesystem.RepositoryLinkInventory) => {
        await filesystem.repositoryReferencesAttemptTemp(checkout, owner.directory, owner.directory, inventory);
        return expired ? "expired" : "closed";
      },
      authority: async () => ({ state: expired ? "expired" : "closed", revision: "unchanged",
        isCurrent: () => change !== "producer-changed" || !fs.existsSync(completion) }) });
    if (tree.image === "named") {
      // The evidence ledger links a picture in the tree: the proof refuses.
      expect(report).toMatchObject({ removed: 0, errors: 1 });
      expect(fs.existsSync(image)).toBeTrue(); expect(fs.existsSync(completion)).toBeFalse();
      return;
    }
    if (change === "namespace-refused") {
      expect(fs.existsSync(completion)).toBeFalse();
      expect(report).toMatchObject({ removed: 0, errors: 1 });
      expect(f.store.has(directory)).toBeTrue();
      expect(fs.readFileSync(path.join(directory, "private", "payload"), "utf8")).toBe("reclaim me");
      expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
      expect(fs.readdirSync(f.root).filter(name => name.startsWith(".delegatus-trash-"))).toEqual([]);
      return;
    }
    expect(fs.existsSync(completion)).toBeTrue();
    if (change !== "control") {
      expect(report.removed).toBe(0);
      expect(report.errors).toBe(change === "root-replaced" ? 1 : 0);
      expect(report.outcomes[0].reason).toContain(change === "root-replaced"
        ? "identity changed before namespace rmdir" : "authority changed before namespace rmdir");
      expect(fs.existsSync(attemptTempJournalPath(directory))).toBeTrue();
      expect(f.store.has(directory)).toBeTrue();
      const trash = fs.readdirSync(f.root).find(name => name.startsWith(".delegatus-trash-") && !name.endsWith("-original"));
      expect(trash).toBeDefined();
      if (change === "root-replaced") expect(fs.readFileSync(path.join(f.root, trash!, "payload"), "utf8")).toBe("replacement");
      else expect(fs.readdirSync(path.join(f.root, trash!))).toEqual([]);
      return;
    }
    expect(report.errors).toBe(0);
    expect(report.removed).toBe(1);
    expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
    expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.readdirSync(f.root).filter(name => name.startsWith(".delegatus-trash-"))).toEqual([]);
    expect(f.store.has(directory)).toBeFalse();
    expect(f.store.bytes()).toBe(0);
  } finally {
    opendir.mockRestore(); rm.mockRestore(); f.store.close(); fs.chmodSync(checkout, 0o700);
    try { fs.chmodSync(locked, 0o700); } catch { /* Removed or never made. */ }
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousImage === undefined) delete process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE; else process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE = previousImage;
  }
}

test.skipIf(process.platform !== "linux")("expired evidence also retires through the permission-denied namespace fallback", async () => {
  await integratedNamespaceSweep("permission-fallback", "control", true);
});

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("an expired root with a subtree this user cannot list retires through the namespace", async () => {
  await integratedNamespaceSweep("permission-fallback", "control", true, { foreign: true });
});

test("the no-evidence proof counts a picture a report named, kept or not, and a root recorded-check custody holds", async () => {
  const f = fixture(), directory = f.make("proof-ledger");
  fs.mkdirSync(path.join(directory, "vendor")); fs.writeFileSync(path.join(directory, "vendor", "icon.png"), "source asset");
  try {
    expect(filesystem.ledgerLinkedEvidence(directory)).toEqual([]);
    nameInReport(path.join(directory, "shots", "frame.png"));
    const index = JSON.parse(fs.readFileSync(statePath("report-media", "index.json"), "utf8"));
    fs.writeFileSync(statePath("report-media", index[0].file), "kept copy");
    expect(filesystem.ledgerLinkedEvidence(directory)).toEqual([path.join("shots", "frame.png")]);
    await holdFinishedRoot(directory);
    expect(() => filesystem.ledgerLinkedEvidence(directory)).toThrow("recorded-check custody");
  } finally { f.store.close(); }
});

test.skipIf(process.platform !== "linux").each([["source", "namespace-only"], ["source", "permission-fallback"], ["named", "namespace-only"]] as const)(
  "the namespace no-evidence proof counts only what the evidence ledger links (%s image, %s)", (image, kind) =>
    integratedNamespaceSweep(kind, "control", false, { image }));

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("a root whose cleanup container cannot run waits for the operator and is reported", async () => {
  const f = fixture(), directory = f.make("blocked", 2 * 86400000), bin = path.join(f.root, "bin");
  // What a container that ran as another user leaves behind: a directory this
  // user can neither list nor empty. Mode 000 on our own directory models it.
  const locked = path.join(directory, "tmp", "pgdata");
  fs.mkdirSync(locked, { recursive: true }); fs.writeFileSync(path.join(locked, "base"), Buffer.alloc(8192)); fs.chmodSync(locked, 0);
  fs.mkdirSync(path.join(directory, "tmp", "empty-foreign")); fs.chmodSync(path.join(directory, "tmp", "empty-foreign"), 0o500);
  // Docker answers, but no cleanup image is installed: the namespace cannot run.
  fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(f.root, "docker.log"))}\n`
    + 'case "$1" in ps) exit 0 ;; image) exit 0 ;; *) exit 1 ;; esac\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previousPath ?? "");
  try {
    const held = await f.sweep("expired");
    expect(held).toMatchObject({ removed: 0, errors: 0, operatorHeld: 1 });
    expect(held.outcomes[0]).toMatchObject({ directory, disposition: "operator", unreadable: true });
    expect(held.outcomes[0].reason).toContain("1 directory this user cannot remove");
    expect(held.outcomes[0].reason).toContain("no installed container cleanup utility image");
    expect(held.operatorHeldBytes).toBeGreaterThanOrEqual(4096);
    expect(held.blocked).toMatchObject({ roots: 1, listed: [{ directory, count: 1, entries: [{ path: locked, uid: process.getuid!(), unreadable: true }] }] });
    expect(fs.existsSync(path.join(directory, "tmp"))).toBeTrue();
    expect(f.store.owner(directory)!.checkedAt).toBe(NOW + BLOCKED_SUBTREE_RETRY_MS);
    const dockerLog = path.join(f.root, "docker.log");
    expect((fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, "utf8") : "").split("\n").filter(line => line.startsWith("run"))).toEqual([]);
    // Once the operator removed it, the next visit retires the root and the report forgets it.
    fs.chmodSync(locked, 0o700); fs.rmSync(locked, { recursive: true });
    const retired = await f.sweep("expired", { now: () => NOW + BLOCKED_SUBTREE_RETRY_MS });
    expect(retired).toMatchObject({ removed: 1, errors: 0, blocked: { roots: 0, listed: [] } });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally {
    try { fs.chmodSync(locked, 0o700); } catch { /* Removed above. */ }
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    f.store.close();
  }
});

test.skipIf(process.platform !== "linux").each(["namespace-only", "permission-fallback"] as const)(
  "an unchanged integrated sweep finishes namespace cleanup in one pass (%s)", kind => integratedNamespaceSweep(kind));
test.skipIf(process.platform !== "linux").each([
  ["namespace-only", "producer-changed"], ["namespace-only", "checkout-unreadable"], ["namespace-only", "root-replaced"],
  ["permission-fallback", "producer-changed"], ["permission-fallback", "checkout-unreadable"], ["permission-fallback", "root-replaced"],
] as const)("an integrated sweep refuses post-delete drift (%s, %s)", (kind, change) => integratedNamespaceSweep(kind, change));
test.skipIf(process.platform !== "linux")("a namespace refusal before delete restores the root and clears its journal", async () => {
  await integratedNamespaceSweep("namespace-only", "namespace-refused");
});

test.each(["absent", "unreadable", "restored-with-link"] as const)(
  "the final producer read revalidates a changed consumer checkout (%s)", async change => {
    const f = fixture(), directory = f.make(`consumer-${change}`);
    const producer = path.join(f.root, "producer-checkout"), consumer = path.join(f.root, "consumer-checkout");
    fs.mkdirSync(path.join(producer, ".git"), { recursive: true });
    fs.mkdirSync(path.join(consumer, ".git"), { recursive: true });
    const cwd = path.join(consumer, "work"); fs.mkdirSync(cwd);
    f.store.measure(directory, 4096); f.store.release(directory);
    const previousConsumer = `${consumer}-previous`;
    let now = NOW, stateReads = 0, inject = false, injected = false;
    let sharedInventory: InstanceType<typeof filesystem.RepositoryLinkInventory> | undefined;
    const readdirApi = fs.promises as unknown as {
      readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
    };
    const readdir = readdirApi.readdir.bind(readdirApi);
    const mutateConsumer = () => {
      if (change === "absent") fs.renameSync(consumer, previousConsumer);
      else if (change === "unreadable") fs.chmodSync(consumer, 0);
      else {
        fs.renameSync(consumer, previousConsumer);
        fs.mkdirSync(path.join(consumer, ".git"), { recursive: true });
        fs.mkdirSync(path.join(consumer, "work"));
        fs.symlinkSync(directory, path.join(consumer, "dependency"), "dir");
      }
    };
    const observed = spyOn(readdirApi, "readdir").mockImplementation(async (target, options) => {
      const entries = await readdir(target, options);
      if (inject && !injected && path.resolve(String(target)) === producer) {
        injected = true;
        mutateConsumer();
      }
      return entries;
    });
    const scan = () => ({ ownNamespace: null, processes: [{ pid: 81, namespace: null, stamped: false, paths: [cwd] }] });
    const sweep = () => sweepAttemptTemps(f.store, { now: () => now, maxRoots: 1, capBytes: 0,
      scan,
      state: async (owner, inventory) => {
        stateReads++;
        sharedInventory = inventory;
        if (stateReads === 4) {
          fs.writeFileSync(path.join(producer, "refresh-inventory"), "changed");
          inject = true;
        }
        await repositoryReferencesAttemptTemp(producer, owner.directory, owner.directory, inventory);
        return "closed";
      },
      references: (original, current, currentScan) => attemptReferencesClear(original, current, currentScan, async () => true, sharedInventory),
    });
    try {
      // Seed the producer inventory, then arrange injection during the real
      // awaited producer readdir at dispatch (the fourth state observation).
      const first = await sweep();
      expect(injected).toBeTrue();
      expect(first).toMatchObject({ removed: 0, errors: 0, held: 1 });
      expect(fs.readFileSync(path.join(directory, "data"))).toHaveLength(4096);
      expect(fs.readFileSync(path.join(directory, ".delegatus-attempt-owner"), "utf8")).toContain("attempt-temp.sqlite");

      if (change === "absent") fs.renameSync(previousConsumer, consumer);
      if (change === "unreadable") fs.chmodSync(consumer, 0o700);
      now += 60_001;
      if (change === "restored-with-link") {
        expect((await sweep()).removed).toBe(0);
        expect(fs.readFileSync(path.join(directory, "data"))).toHaveLength(4096);
        fs.unlinkSync(path.join(consumer, "dependency"));
        now += 60_001;
      }
      expect((await sweep()).removed).toBe(1);
      expect(fs.existsSync(directory)).toBeFalse();
    } finally {
      observed.mockRestore();
      try { fs.chmodSync(consumer, 0o700); } catch { /* absent variant */ }
      f.store.close();
    }
  });

test("an absent root with an evidence hold stops contributing stale bytes", async () => {
  const checks = await import("@/lib/recordedChecks/store");
  const f = fixture(); const directory = f.make("gone");
  f.store.measure(directory, 30 * 1024 ** 3);
  fs.rmSync(directory, { recursive: true });
  const held = spyOn(checks, "recordedRootHeld").mockImplementation(target => target === directory);
  try {
    const report = await f.sweep();
    expect(report.bytes).toBe(0);
    // Custody survives the missing directory; only physical accounting changes.
    expect(f.store.owner(directory)?.bytes).toBe(0);
  } finally { held.mockRestore(); f.store.close(); }
});

test("a failed completion receipt retains custody but never restores removed allocation", async () => {
  const checks = await import("@/lib/recordedChecks/store");
  const f = fixture(); const directory = f.make("receipt-failure");
  const retirement = checks.recordRootRetirement;
  const receipt = spyOn(checks, "recordRootRetirement").mockImplementation(async (...args) => {
    if (args[3] === "completed") throw new Error("fixture completion receipt unavailable");
    return retirement(...args);
  });
  try {
    const report = await f.sweep("closed");
    expect(report).toMatchObject({ removed: 1, errors: 1, bytes: 0, failedBytes: 0 });
    expect(f.store.owner(directory)?.bytes).toBe(0);
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { receipt.mockRestore(); f.store.close(); }
});

test.each([false, true])("producer record revision drift preserves native removal and journal replay (journal replay=%s)", async replay => {
  for (const transition of ["attempt-running", "closed-lane-running"] as const) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-producer-revision-"));
    const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
    const pipeline = buildPipeline({ id: `producer-revision-${transition}`, task: "Producer revision", project: "fixture", repoDir: parent,
      stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
      srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
    const producer = pipeline.worktreeDir!;
    const producerExisted = fs.existsSync(producer);
    pipeline.state = transition === "closed-lane-running" ? "closed" : "running";
    if (transition === "closed-lane-running") {
      pipeline.cursor = null;
      pipeline.closedAt = "2026-10-22T12:00:00Z";
    }
    pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "revision-launch",
      effectiveRole: role, conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: "2026-10-22T12:00:00Z", completedAt: "2026-10-22T12:00:00Z", input: null, activatedBy: null, output: null,
      verdict: null, error: null }] }];
    if (transition !== "closed-lane-running") fs.mkdirSync(path.join(producer, ".git"), { recursive: true });
    savePipelines([pipeline]);
    const directory = path.join(parent, "llv-stage-revision");
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "preserve me");
    const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
    const owner = { directory, pipelineId: pipeline.id, launchId: "revision-launch", retainUntilClose: false, createdAt: 1 };
    store.register(owner);
    store.measure(directory, 4096); store.release(directory);
    const trash = path.join(parent, ".delegatus-trash-llv-stage-revision-replay");
    if (replay) {
      const stat = fs.lstatSync(directory);
      fs.renameSync(directory, trash);
      fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({
        directory, trash, uid: stat.uid, identity: `${stat.dev}:${stat.ino}`, disposable: true,
      }));
    }
    const now = NOW;
    let quarantineReferenceReads = 0, injected = false;
    const authority = (owner: AttemptTempOwner, inventory: filesystem.RepositoryLinkInventory) => attemptTempAuthority(owner, inventory, () => now);
    const sweep = () => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, capBytes: 0,
      state: async (owner, inventory) => (await authority(owner, inventory)).state, authority, scan: () => ({ ownNamespace: null, processes: [] }),
      references: async (_original, current) => {
        await Promise.resolve();
        if (path.basename(current).startsWith(".delegatus-trash-")
          && ++quarantineReferenceReads === (replay ? 4 : 2)) {
          injected = true;
          if (transition === "closed-lane-running") pipeline.state = "running";
          else pipeline.runs[0]!.attempts[0]!.state = "running";
          savePipelines([pipeline]);
        }
        return true;
      },
    });
    try {
      const changed = await sweep();
      expect(injected).toBeTrue();
      expect(changed).toMatchObject({ removed: 0, errors: 0, liveHeld: 1 });
      expect(await attemptTempState(owner)).toBe(transition === "attempt-running" ? "live" : "unknown");
      expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("preserve me");
    } finally {
      store.close(); savePipelines([]);
      if (!producerExisted) fs.rmSync(producer, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test.each([false, true])("post-eligibility producer and checkout changes preserve native removal and journal replay (journal replay=%s)", async replay => {
  for (const change of ["revision", "checkout"] as const) {
    const f = fixture(), directory = f.make(`dispatch-${change}-${replay}`);
    const producer = path.join(f.root, "dispatch-producer"), retiredProducer = `${producer}-retired`;
    fs.mkdirSync(path.join(producer, ".git"), { recursive: true });
    f.store.measure(directory, 4096); f.store.release(directory);
    const trash = path.join(f.root, `.delegatus-trash-${path.basename(directory)}-replay`);
    if (replay) {
      const stat = fs.lstatSync(directory);
      fs.renameSync(directory, trash);
      fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({
        directory, trash, uid: stat.uid, identity: `${stat.dev}:${stat.ino}`, disposable: true,
      }));
    }
    let current = true, authorityReads = 0, injected = false;
    let inventory: InstanceType<typeof filesystem.RepositoryLinkInventory>;
    const sweep = () => sweepAttemptTemps(f.store, { now: () => NOW, maxRoots: 1, capBytes: 0,
      state: async (_owner, observed) => { inventory = observed; return "closed"; },
      authority: async () => {
        const observedRead = ++authorityReads;
        let checks = 0;
        return { state: "closed" as const, revision: "revision-1", isCurrent: () => {
          if (observedRead === (replay ? 2 : 3) && ++checks === 1) queueMicrotask(() => {
            injected = true;
            if (change === "revision") current = false;
            else fs.renameSync(producer, retiredProducer);
          });
          return current;
        } };
      },
      scan: () => ({ ownNamespace: null, processes: [] }),
      references: async (original, currentPath) => {
        await repositoryReferencesAttemptTemp(producer, original, currentPath, inventory);
        return true;
      },
    });
    try {
      const result = await sweep();
      expect(injected).toBeTrue();
      expect(result.removed).toBe(0);
      expect(fs.readFileSync(path.join(directory, "data"), "utf8").length).toBe(4096);
    } finally {
      if (fs.existsSync(retiredProducer)) fs.renameSync(retiredProducer, producer);
      f.store.close();
    }
  }
});

test.each([false, true])("final dispatch rechecks checkout discovery and external aliases (journal replay=%s)", async replay => {
  for (const change of ["control", "absent-no-marker", "restore-no-marker", "alias-retarget"] as const) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-consumer-dispatch-"));
    const directory = path.join(parent, "llv-stage-root");
    const consumer = path.join(parent, "consumer"), cwd = path.join(consumer, "work");
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
    fs.mkdirSync(cwd, { recursive: true });
    const alias = path.join(parent, "external-alias"), unrelated = path.join(parent, "unrelated");
    fs.mkdirSync(unrelated);
    if (change === "alias-retarget" || change === "control") fs.mkdirSync(path.join(consumer, ".git"));
    if (change === "alias-retarget") {
      fs.symlinkSync(unrelated, alias, "dir");
      fs.symlinkSync(path.join(alias, path.basename(directory)), path.join(consumer, "dependency"), "dir");
    }
    const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
    const pipeline = buildPipeline({ id: "consumer-dispatch-lane", task: "Fixture", project: "fixture", repoDir: parent,
      stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
      srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
    const producer = pipeline.worktreeDir!;
    fs.mkdirSync(path.join(producer, ".git"), { recursive: true });
    pipeline.state = "running";
    pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "fixture-launch",
      effectiveRole: role, conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null,
      verdict: null, error: null }] }];
    savePipelines([pipeline]);
    const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
    store.register({ directory, pipelineId: pipeline.id, launchId: "fixture-launch", retainUntilClose: false, createdAt: 1 });
    store.measure(directory, 4096); store.release(directory);
    const trash = path.join(parent, ".delegatus-trash-llv-stage-root-replay");
    if (replay) {
      const stat = fs.lstatSync(directory);
      fs.renameSync(directory, trash);
      fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({
        directory, trash, uid: stat.uid, identity: `${stat.dev}:${stat.ino}`, disposable: true,
      }));
    }
    let changed = false, armed = false, now = NOW;
    let inventory: InstanceType<typeof filesystem.RepositoryLinkInventory>;
    const nativeRead = fs.promises.readdir.bind(fs.promises);
    const readdirApi = fs.promises as unknown as {
      readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
    };
    const observed = spyOn(readdirApi, "readdir").mockImplementation(async (target, options) => {
      const entries = await nativeRead(target, options);
      if (armed && String(target) === producer) {
        armed = false; changed = true;
        if (change === "absent-no-marker") fs.renameSync(consumer, consumer + "-old");
        if (change === "restore-no-marker") {
          fs.renameSync(consumer, consumer + "-old");
          fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(consumer, ".git"));
          fs.symlinkSync(directory, path.join(consumer, "dependency"), "dir");
        }
        if (change === "alias-retarget") {
          fs.unlinkSync(alias); fs.symlinkSync(parent, alias, "dir");
        }
      }
      return entries;
    });
    const processes = [{ pid: 42, namespace: null, stamped: false, paths: [cwd] }];
    const sweep = () => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, capBytes: 0,
      state: (owner, current) => {
        inventory = current;
        return attemptTempState(owner, current);
      },
      scan: () => ({ ownNamespace: null, processes }),
      references: (original, current, scan) => {
        if (!armed && !changed && change !== "control") {
          fs.writeFileSync(path.join(producer, "force-fresh-inventory"), "refresh"); armed = true;
        }
        return attemptReferencesClear(original, current, scan, async () => true, inventory);
      },
    });
    try {
      const result = await sweep();
      expect(changed).toBe(change !== "control");
      expect(result.removed).toBe(change === "control" ? 1 : 0);
      if (change !== "control") {
        expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
        if (change === "absent-no-marker") fs.renameSync(consumer + "-old", consumer);
        if (change === "restore-no-marker") fs.unlinkSync(path.join(consumer, "dependency"));
        if (change === "alias-retarget") { fs.unlinkSync(alias); fs.symlinkSync(unrelated, alias, "dir"); }
        now += 60_001;
        expect((await sweep()).removed).toBe(1);
      }
    } finally {
      observed.mockRestore(); store.close(); savePipelines([]);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("consumer checkouts that take longer than one tick are each read once, and the root retires on a later tick", async () => {
  const f = fixture(), directory = f.make("slow-consumer-checkouts");
  f.store.measure(directory, 4096); f.store.release(directory);
  const processes = Array.from({ length: 5 }, (_, n) => {
    const checkout = path.join(f.root, `checkout-${n}`), cwd = path.join(checkout, "work");
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true }); fs.mkdirSync(cwd);
    return { pid: 500 + n, namespace: null, stamped: false, paths: [cwd] };
  });
  let now = NOW;
  let shared: InstanceType<typeof filesystem.RepositoryLinkInventory> | undefined;
  const readdirApi = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = readdirApi.readdir.bind(readdirApi);
  // Each checkout directory costs four seconds of the tick's clock, so the
  // five checkouts take forty seconds: more than one tick's inventory budget
  // and four times the age at which a single tick repeats a read.
  const observed = spyOn(readdirApi, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (String(target).startsWith(path.join(f.root, "checkout-"))) now += 4_000;
    return entries;
  });
  const checkoutReads = new Map();
  const sweep = () => sweepAttemptTemps(f.store, { now: () => now, maxRoots: 1, capBytes: 0, checkoutReads,
    scan: () => ({ ownNamespace: null, processes }),
    state: async (_owner, inventory) => { shared = inventory; return "closed"; },
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true, shared) });
  try {
    const first = await sweep();
    expect(first).toMatchObject({ removed: 0, deferred: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "data"))).toHaveLength(4096);
    now += 60_001;
    const second = await sweep();
    expect(second).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
    expect(first.inventoryWalks + second.inventoryWalks).toBe(5);
  } finally { observed.mockRestore(); f.store.close(); }
});

test("with reads kept across ticks, a checkout link made during the final authority read still holds the root", async () => {
  const f = fixture(), directory = f.make("late-link-kept-reads");
  f.store.measure(directory, 4096); f.store.release(directory);
  const consumer = path.join(f.root, "consumer-checkout"), cwd = path.join(consumer, "work");
  fs.mkdirSync(path.join(consumer, ".git"), { recursive: true }); fs.mkdirSync(cwd);
  const link = path.join(cwd, "late-dependency");
  let now = NOW, stateReads = 0;
  let shared: InstanceType<typeof filesystem.RepositoryLinkInventory> | undefined;
  const checkoutReads = new Map();
  const sweep = () => sweepAttemptTemps(f.store, { now: () => now, maxRoots: 1, capBytes: 0, checkoutReads,
    scan: () => ({ ownNamespace: null, processes: [{ pid: 91, namespace: null, stamped: false, paths: [cwd] }] }),
    state: async (_owner, inventory) => {
      shared = inventory;
      // The third read is the authority read that follows the first complete
      // reference observation of this root.
      if (++stateReads === 3) fs.symlinkSync(directory, link, "dir");
      return "closed";
    },
    references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true, shared) });
  try {
    const first = await sweep();
    expect(fs.lstatSync(link).isSymbolicLink()).toBeTrue();
    expect(first).toMatchObject({ removed: 0, errors: 0, liveHeld: 1 });
    expect(fs.readFileSync(path.join(directory, "data"))).toHaveLength(4096);
    now += 60_001;
    expect((await sweep()).removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, "data"))).toHaveLength(4096);
    fs.unlinkSync(link);
    now += 60_001;
    expect((await sweep()).removed).toBe(1);
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { f.store.close(); }
});

test("a loaded 727-root sweep defers its remaining page without errors or holds", async () => {
  const f = fixture();
  for (let n = 0; n < 727; n++) f.store.measure(f.make(String(n).padStart(4, "0"), 86400000), 4096);
  let now = NOW;
  try {
    const report = await f.sweep("closed", { now: () => now, capBytes: 0, maxRoots: 32,
      onRetired: () => { now += 40_001; } });
    expect(report).toMatchObject({ removed: 1, checked: 1, deferred: 31, held: 0, errors: 0 });
    expect(report.deferredBytes).toBe(31 * 4096);
    expect(report.unexaminedBytes).toBe(695 * 4096);
    expect(f.store.due(now + 60000, 727)).toHaveLength(726);
  } finally { f.store.close(); }
});

test.each(["budget-run", "budget-inventory", "budget-read"] as const)("%s deferral survives a helper restart with ledger accounting and fairness", async mode => {
  const f = fixture();
  const directories: string[] = [];
  for (const name of ["first", "second"]) {
    const directory = f.make(`restart-${mode}-${name}`);
    directories.push(directory);
    f.store.measure(directory, 4096); f.store.release(directory);
  }
  const repository = path.join(f.root, "budget-repository"); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  f.store.close();
  const run = async (at: number, budgetMode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(at), budgetMode], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toBe(""); return JSON.parse(stdout);
  };
  try {
    const removed = mode === "budget-read" ? 0 : 1;
    const deferred = await run(NOW, mode);
    expect(deferred).toMatchObject({ removed, deferred: 2 - removed, errors: 0, held: 0 });
    if (removed) expect(deferred.removedBytes).toBeGreaterThan(0);
    else expect(deferred.outcomes.every((row: { reason: string }) => row.reason.includes("time budget"))).toBeTrue();
    expect(deferred.deferredBytes).toBe(deferred.bytes);
    expect(fs.existsSync(directories[0]!)).toBe(!removed); expect(fs.existsSync(directories[1]!)).toBeTrue();
    const resumed = await run(NOW + 120_000, "--default-budget");
    expect(resumed).toMatchObject({ removed: 2 - removed, errors: 0, bytes: 0 });
    expect(resumed.removedBytes).toBeGreaterThan(0);
    expect(fs.readdirSync(f.root).filter(name => name.startsWith("llv-stage-restart-"))).toHaveLength(0);
  } finally {
    const reopened = new AttemptTempStore(f.filename); reopened.close();
  }
});

test("an incomplete real checkout inventory defers roots with their bytes instead of errors or live holds", async () => {
  const f = fixture();
  for (let n = 0; n < 18; n++) f.make(`inventory-${n}`);
  const processes = ["first", "second"].map((name, n) => {
    const repository = path.join(f.root, name); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    return { pid: 1000 + n, namespace: null, stamped: false, paths: [repository] };
  });
  let now = NOW, advanced = false;
  const targets = filesystem.RepositoryLinkInventory.prototype.targets;
  const clock = spyOn(filesystem.RepositoryLinkInventory.prototype, "targets").mockImplementation(async function (this: filesystem.RepositoryLinkInventory, repository: string) {
    const result = await targets.call(this, repository);
    if (!advanced) { advanced = true; now += 30_001; }
    return result;
  });
  try {
    const report = await sweepAttemptTemps(f.store, { now: () => now, maxRoots: 18, capBytes: 0,
      state: async () => "closed", scan: () => ({ ownNamespace: null, processes }) });
    expect(report).toMatchObject({ checked: 18, removed: 0, deferred: 18, held: 0, errors: 0 });
    expect(report.deferredBytes).toBeGreaterThanOrEqual(18 * 4096);
    expect(report.liveHeldBytes).toBe(0);
  } finally { clock.mockRestore(); f.store.close(); }
});

test("pressure retires the oldest released settled roots first and reserves fair visits", async () => {
  const f = fixture();
  const oldest = f.make("oldest-unreleased", 10 * 86400000);
  const older = f.make("z-older-small", 2 * 86400000), newer = f.make("a-newer-large", 86400000);
  fs.writeFileSync(path.join(newer, "data"), Buffer.alloc(16 * 1024 ** 2));
  f.store.measure(older, 4096); f.store.measure(newer, 16 * 1024 ** 2);
  f.store.release(older); f.store.release(newer);
  try {
    const first = await f.sweep("closed", { maxRoots: 1, capBytes: 0 });
    expect(first.removed).toBe(1); expect(fs.existsSync(older)).toBeFalse(); expect(fs.existsSync(newer)).toBeTrue();
    const second = await f.sweep("closed", { maxRoots: 2, capBytes: 0 });
    expect(second.removed).toBe(2); expect(fs.existsSync(oldest)).toBeFalse(); expect(fs.existsSync(newer)).toBeFalse();
  } finally { f.store.close(); }
});

test("roots whose lane retention ended lead every page across the ledger, oldest finish first", async () => {
  const f = fixture();
  // Rows the round robin would visit first: they were checked longest ago.
  const round = Array.from({ length: 12 }, (_, n) => f.make(`round-${String(n).padStart(2, "0")}`, 30 * 86400000));
  const newer = f.make("expired-newer", 1000), older = f.make("expired-older", 2000), pending = f.make("expires-tomorrow", 3000);
  f.store.retainRoot(newer, NOW - 1000); f.store.retainRoot(older, NOW - 2 * 86400000); f.store.retainRoot(pending, NOW + 86400000);
  const page = (limit: number, pressure = false, at = NOW) => f.store.due(at, limit, pressure).map(row => row.directory);
  try {
    for (const pressure of [false, true]) {
      expect(page(4, pressure).slice(0, 2)).toEqual([older, newer]);
      expect(page(4, pressure).slice(2)).toEqual(round.slice(0, 2));
      expect(page(4, pressure)).not.toContain(pending);
    }
    // At most half of a page, so the round robin keeps moving.
    expect(page(2)).toEqual([older, round[0]]);
    // Held past its retention, the oldest steps back and the next one leads.
    const report = await f.sweep("live", { maxRoots: 2 });
    expect(report.outcomes.map((row: { directory: string }) => row.directory)).toEqual([older, round[0]]);
    expect(page(2, false, NOW + 60_000)).toEqual([newer, round[1]]);
    expect(f.store.owner(older)!.checkedAt).toBe(NOW + EXPIRED_HOLD_RETRY_MS);
  } finally { f.store.close(); }
});

test("a root the run budget never reached keeps its place for the next tick", async () => {
  const f = fixture();
  const first = f.make("budget-first", 3000), second = f.make("budget-second", 2000), third = f.make("budget-third", 1000);
  let now = NOW;
  try {
    const report = await f.sweep("closed", { maxRoots: 3, now: () => now, onRetired: () => { now += 40_001; } });
    expect(report).toMatchObject({ removed: 1, deferred: 2, errors: 0 });
    expect(fs.existsSync(first)).toBeFalse();
    expect(f.store.owner(second)!.checkedAt).toBe(NOW - 2000); expect(f.store.owner(third)!.checkedAt).toBe(NOW - 1000);
    expect(f.store.due(now, 2).map(row => row.directory)).toEqual([second, third]);
  } finally { f.store.close(); }
});

test("current finished-lane authority runs before a larger released live root under pressure", async () => {
  const f = fixture();
  const live = f.make("released-live"), finished = f.make("finished", 2 * 86400000);
  fs.writeFileSync(path.join(live, "data"), Buffer.alloc(16 * 1024 ** 2));
  f.store.measure(live, 16 * 1024 ** 2); f.store.release(live); f.store.measure(finished, 4096);
  let now = NOW;
  try {
    const report = await f.sweep("closed", { maxRoots: 2, capBytes: 0, now: () => now,
      state: async (owner: { directory: string }) => owner.directory === live ? "live" : "closed",
      onRetired: () => { now += 40_001; } });
    expect(report).toMatchObject({ checked: 1, removed: 1, held: 0, deferred: 1, errors: 0 });
    expect(fs.existsSync(live)).toBeTrue(); expect(fs.existsSync(finished)).toBeFalse();
  } finally { f.store.close(); }
});

test("pressure fairness survives real process restarts behind a failing released prefix and new arrivals", async () => {
  const f = fixture();
  for (let n = 0; n < 40; n++) {
    const directory = f.make(`blocked-error-${String(n).padStart(2, "0")}`);
    f.store.measure(directory, (40 - n) * 1024 ** 2); f.store.release(directory);
  }
  const first = f.make("later-old-owner", 10 * 86400000), second = f.make("later-next-owner", 9 * 86400000);
  f.store.measure(first, 4096); f.store.measure(second, 4096);
  f.store.close();
  for (let tick = 0; tick < 2; tick++) {
    const at = NOW + tick * 60000;
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(at), "pressure"], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toContain("fixture authority failure");
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ checked: 4, removed: 1 });
    expect(report.errors + report.held).toBe(3);
    expect(fs.existsSync(tick === 0 ? first : second)).toBeFalse();
    const reopened = new AttemptTempStore(f.filename);
    try {
      const directory = path.join(f.root, `llv-stage-blocked-arrival-${tick}`); fs.mkdirSync(directory);
      reopened.register({ directory, pipelineId: "lane", launchId: "blocked-new", retainUntilClose: false, createdAt: at });
      reopened.measure(directory, 100 * 1024 ** 2); reopened.release(directory);
    } finally { reopened.close(); }
  }
});

test("the report separates live, evidence and failed allocation with a readable cause", async () => {
  const f = fixture();
  const live = f.make("live"), evidence = f.make("evidence", 0, true), failed = f.make("failed");
  try {
    const report = await f.sweep("settled", { maxRoots: 3, state: async (owner: { directory: string }) => {
      if (owner.directory === failed) throw new Error("fixture authority unavailable");
      return owner.directory === live ? "live" : "settled";
    } });
    expect(report).toMatchObject({ held: 2, liveHeld: 1, evidenceHeld: 1, errors: 1, deferred: 0 });
    expect(report.liveHeldBytes).toBeGreaterThanOrEqual(4096);
    expect(report.evidenceHeldBytes).toBeGreaterThanOrEqual(4096);
    expect(report.failedBytes).toBeGreaterThanOrEqual(4096);
    expect(report.outcomes.find(row => row.directory === evidence)?.reason).toContain("evidence");
    expect(report.outcomes.find(row => row.directory === failed)?.reason).toContain("fixture authority unavailable");
  } finally { f.store.close(); }
});

test("a budget deferral cannot hide a real retirement failure in the same reply", async () => {
  const temps = await import("@/lib/tempSweep");
  const f = fixture(); f.make("mixed-failure");
  const sweep = spyOn(temps, "sweepStaleTempDirs").mockResolvedValue({
    at: new Date(NOW).toISOString(), maxAgeHours: 0, roots: [f.root],
    removed: [], removedBytes: 0, kept: { young: 0, inUse: 0, worktree: 0, deferred: 0 },
    errors: ["attempt temp deferred: run budget exhausted", "fixture retirement refused"],
  });
  try {
    const report = await f.sweep("closed");
    expect(report).toMatchObject({ removed: 0, deferred: 0, held: 0, errors: 1 });
    expect(report.failedBytes).toBeGreaterThanOrEqual(4096);
    expect(report.outcomes[0]?.reason).toContain("fixture retirement refused");
  } finally { sweep.mockRestore(); f.store.close(); }
});

test("the capped sweep evicts old unowned roots oldest first within its tick budget", async () => {
  const f = fixture(); const newer = f.make("a-newer", 3 * 86400000); const older = f.make("z-older", 4 * 86400000);
  try {
    const report = await f.sweep("orphan", { maxRoots: 1, capBytes: 0, maxAgeMs: 86400000 });
    expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThanOrEqual(4096);
    expect(fs.existsSync(older)).toBeFalse(); expect(fs.existsSync(newer)).toBeTrue();
  } finally { f.store.close(); }
});

test.each(["live", "unknown"] as const)("%s ownership retains scratch", async state => {
  const f = fixture(); const directory = f.make(state);
  try {
    const report = await f.sweep(state);
    expect(report.removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    expect(report.liveHeldBytes > 0).toBe(state === "live");
  }
  finally { f.store.close(); }
});

test("declared evidence survives settlement until lane close", async () => {
  const f = fixture(); const directory = f.make("evidence", 0, true);
  try {
    expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    expect((await f.sweep("closed", { now: () => NOW + 60000 })).removed).toBe(1);
  } finally { f.store.close(); }
});

test("a process holder retains a settled directory", async () => {
  const f = fixture(); const directory = f.make("held");
  try {
    const report = await f.sweep("settled", { scan: () => ({ ownNamespace: null, processes: [{ pid: 123, namespace: null, stamped: false, paths: [path.join(directory, "future")] }] }) });
    expect(report.removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    expect(report.liveHeldBytes).toBeGreaterThanOrEqual(4096);
  } finally { f.store.close(); }
});

test.each([2, 3])("ownership revoked at authority read %i preserves the original tree", async revokeAt => {
  const f = fixture(); const directory = f.make("revoked"); let reads = 0;
  try {
    const report = await f.sweep("settled", { state: async () => ++reads >= revokeAt ? "live" : "settled" });
    expect(reads).toBe(revokeAt); expect(report.removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});

test("replacement during an authority await preserves both identities", async () => {
  const f = fixture(); const directory = f.make("replaced"); let changed = false;
  try {
    const report = await f.sweep("settled", { state: async () => {
      if (!changed) { changed = true; fs.renameSync(directory, directory + "-saved"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "keep"), "replacement"); }
      return "settled";
    } });
    expect(report.removed).toBe(0); expect(fs.readFileSync(path.join(directory, "keep"), "utf8")).toBe("replacement");
    expect(fs.existsSync(directory + "-saved/data")).toBeTrue();
  } finally { f.store.close(); }
});

test("a symlink replacement cannot redirect cleanup", async () => {
  const f = fixture(); const directory = f.make("symlink");
  fs.renameSync(directory, directory + "-saved"); fs.symlinkSync(directory + "-saved", directory);
  try { expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(directory + "-saved/data")).toBeTrue(); }
  finally { f.store.close(); }
});

for (const replacement of ["directory", "symlink"] as const) test(`a ${replacement} swap during measurement keeps the prior accounting and both trees`, async () => {
  const f = fixture(); const directory = f.make("measurement-swap"), saved = `${directory}-saved`;
  const measure = filesystem.measureAttemptAllocation;
  const race = spyOn(filesystem, "measureAttemptAllocation").mockImplementation(async target => {
    const measured = await measure(target);
    if (target === directory) {
      fs.renameSync(directory, saved);
      if (replacement === "symlink") fs.symlinkSync(saved, directory);
      else { fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "keep"), "replacement"); }
    }
    return measured;
  });
  try {
    const report = await f.sweep();
    expect(report).toMatchObject({ removed: 0, held: 1, errors: 0, bytes: 0 });
    expect(f.store.owner(directory)?.bytes).toBe(0);
    expect(fs.readFileSync(path.join(saved, "data")).length).toBe(4096);
    if (replacement === "directory") expect(fs.readFileSync(path.join(directory, "keep"), "utf8")).toBe("replacement");
    else expect(fs.lstatSync(directory).isSymbolicLink()).toBeTrue();
  } finally { race.mockRestore(); f.store.close(); }
});

test("a tick budget and its fairness checkpoint survive real helper restarts", async () => {
  const f = fixture(); const a = f.make("first", 100); const b = f.make("second", 0);
  f.store.close();
  for (const removed of [a, b]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(NOW)], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ checked: 1, removed: 1 });
    expect(fs.existsSync(removed)).toBeFalse();
    if (removed === a) expect(fs.existsSync(b)).toBeTrue();
  }
});

test("unowned roots younger than the configured age stay even over cap", async () => {
  const f = fixture(); const directory = f.make("young", 86400000 - 1);
  try { expect((await f.sweep("orphan", { capBytes: 0, maxAgeMs: 86400000 })).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue(); }
  finally { f.store.close(); }
});

test("dry run records the decision without removing or spending the ledger", async () => {
  const f = fixture(); const directory = f.make("dry-run");
  try {
    const report = await f.sweep("settled", { mode: "dry-run" });
    expect(report.removed).toBe(1); expect(report.unexaminedBytes).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    expect((await f.sweep("settled", { now: () => NOW + 60000 })).removed).toBe(1);
  } finally { f.store.close(); }
});

test("disposable test repositories retire but linked worktrees remain for their owner", async () => {
  const f = fixture(); const disposable = f.make("fixture"); const linked = f.make("linked");
  fs.mkdirSync(path.join(disposable, ".git")); fs.writeFileSync(path.join(disposable, ".git/HEAD"), "fixture");
  fs.writeFileSync(path.join(linked, ".git"), "gitdir: retained-metadata");
  try {
    expect((await f.sweep()).removed).toBe(1); expect(fs.existsSync(disposable)).toBeFalse();
    expect(fs.readFileSync(path.join(linked, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});

test("a failed removal is recovered from its durable intent on the next tick", async () => {
  const { spyOn } = await import("bun:test");
  const f = fixture(); const directory = f.make("interrupted");
  const remove = removal.removeTreeWithinAttemptBudget;
  const refused = spyOn(removal, "removeTreeWithinAttemptBudget").mockImplementation(async (target, started) => {
    started();
    if (target.includes(`.delegatus-trash-${path.basename(directory)}-`)) throw new Error("fixture removal refused");
    return remove(target, started);
  });
  try { expect((await f.sweep()).errors).toBe(1); }
  finally { refused.mockRestore(); }
  try {
    const held = await f.sweep("live", { now: () => NOW + 60000 });
    expect(held.removed).toBe(0); expect(held.bytes).toBeGreaterThanOrEqual(4096);
    const report = await f.sweep("settled", { now: () => NOW + 120000 });
    expect(report.removed).toBe(1); expect(report.removedBytes).toBeGreaterThan(0); expect(report.held).toBe(0);
    expect(fs.readdirSync(f.root).some(name => name.startsWith(".delegatus-trash-"))).toBeFalse();
  } finally { f.store.close(); }
});

test("a live checkout link retains another attempt root while the consumer is idle", async () => {
  const f = fixture(); const directory = f.make("dependency");
  const checkout = path.join(f.root, "consumer"); fs.mkdirSync(checkout); fs.mkdirSync(path.join(checkout, ".git"));
  fs.symlinkSync(directory, path.join(checkout, "node_modules"), "dir");
  try {
    expect((await f.sweep("settled", { scan: () => ({ ownNamespace: null, processes: [{ pid: 321, namespace: null, stamped: true, paths: [checkout] }] }) })).removed).toBe(0);
    expect(fs.existsSync(path.join(checkout, "node_modules/data"))).toBeTrue();
  } finally { f.store.close(); }
});

test.each([2, 4, 6])("authority changes after native observations at read %i retain scratch", async revokeAt => {
  const f = fixture(); const directory = f.make("late-authority"); let reads = 0;
  try {
    expect((await f.sweep("settled", { state: async () => ++reads >= revokeAt ? "live" : "settled" })).removed).toBe(0);
    expect(fs.existsSync(path.join(directory, "data"))).toBeTrue();
  } finally { f.store.close(); }
});


test("a quarantine replacement during asynchronous validation is preserved", async () => {
  const { removeTreeViaTrash } = await import("@/lib/tempSweep");
  const f = fixture(); const directory = f.make("quarantine-replacement");
  let replacement = "", saved = "";
  try {
    expect(await removeTreeViaTrash(directory, {
      journal: path.join(f.root, "intent.json"), disposable: true,
      held: async trash => {
        await Promise.resolve();
        saved = trash + "-saved"; fs.renameSync(trash, saved);
        replacement = trash; fs.mkdirSync(trash); fs.writeFileSync(path.join(trash, "keep"), "replacement");
        return false;
      },
    })).toBeFalse();
    expect(fs.existsSync(path.join(directory, "keep")) || fs.existsSync(path.join(replacement, "keep"))).toBeTrue();
    expect(fs.readFileSync(path.join(saved, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});


test.skipIf(process.platform !== "linux")("a real held file lock retains scratch until its owner exits", async () => {
  const { scanProcesses } = await import("@/lib/tempSweep");
  const f = fixture(); const directory = f.make("locked");
  const child = Bun.spawn(["flock", "--exclusive", path.join(directory, "held.lock"), process.execPath,
    path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--hold"], {
    env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  // Observe only this fixture's kernel references. Unrelated test runs on the
  // shared test machine can retire their own checkout during a /proc scan.
  const ownedScan = () => {
    const scan = scanProcesses();
    return { ...scan, processes: scan.processes.filter(process => process.pid === child.pid) };
  };
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    expect((await f.sweep("settled", { scan: ownedScan })).removed).toBe(0);
    expect(fs.existsSync(directory)).toBeTrue();
    child.stdin.end(); expect(await child.exited).toBe(0);
    expect((await f.sweep("settled", { now: () => NOW + 60000, scan: ownedScan })).removed).toBe(1);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited; f.store.close();
  }
}, 30000);


test("a disposable clone that owns linked worktrees stays with the preservation owner", async () => {
  const f = fixture(); const directory = f.make("linked-parent");
  fs.mkdirSync(path.join(directory, ".git/worktrees/consumer"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".git/worktrees/consumer/gitdir"), "external-checkout/.git");
  try { expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(path.join(directory, "data"))).toBeTrue(); }
  finally { f.store.close(); }
});


test("an empty Git marker outside a disposable cache retains its attempt root", async () => {
  const f = fixture(); const directory = f.make("damaged-git");
  fs.writeFileSync(path.join(directory, ".git"), "");
  try { expect((await f.sweep()).removed).toBe(0); expect(fs.existsSync(path.join(directory, "data"))).toBeTrue(); }
  finally { f.store.close(); }
});


test("retirement reports its counts before inspecting the next root", async () => {
  const f = fixture(); const first = f.make("first", 100); f.make("second");
  let removed = 0;
  try {
    const report = await f.sweep("settled", { state: async (owner: { launchId: string }) => {
      if (owner.launchId === "second") { expect(removed).toBe(1); throw new Error("fixture observation refused"); }
      return "settled";
    }, onRetired: (count: number, bytes: number) => {
      removed += count; expect(bytes).toBeGreaterThanOrEqual(4096); expect(fs.existsSync(first)).toBeFalse();
    } });
    expect(report).toMatchObject({ removed: 1, errors: 1 }); expect(removed).toBe(1);
  } finally { f.store.close(); }
});


test("new arrivals cannot starve a due owner across helper restarts", async () => {
  const f = fixture(); const old = f.make("old", 1000); f.store.close();
  const run = async (now: number, state = "settled") => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(now), state],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); return JSON.parse(stdout);
  };
  expect(await run(NOW, "live")).toMatchObject({ checked: 1, removed: 0 });
  const store = new AttemptTempStore(f.filename);
  const arrival = path.join(f.root, "llv-stage-arrival"); fs.mkdirSync(arrival);
  try { store.register({ directory: arrival, pipelineId: "lane", launchId: "arrival", retainUntilClose: false, createdAt: NOW + 60000 }); }
  finally { store.close(); }
  expect(await run(NOW + 60000)).toMatchObject({ checked: 1, removed: 1 });
  expect(fs.existsSync(old)).toBeFalse(); expect(fs.existsSync(arrival)).toBeTrue();
}, 30000);


test("the persisted total cap raises the default sweep budget, then returns to its normal bound", async () => {
  const f = fixture();
  const directories = Array.from({ length: 40 }, (_, n) => f.make(`capped-${n}`, (n + 2) * 86400000));
  // Seed the same durable allocation projection a prior measurement writes;
  // no large payload is needed to test the 100 GiB policy.
  for (const directory of directories) f.store.measure(directory, 4 * 1024 ** 3);
  f.store.close();
  for (const expected of [32, 4]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"),
      f.filename, String(NOW), "orphan", "--default-budget"], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ checked: expected, removed: expected, capBytes: 100 * 1024 ** 3 });
  }
  for (const [n, directory] of directories.entries()) expect(fs.existsSync(directory)).toBe(n < 4);
}, 60000);

// The waiting helper may report its file-transaction wait (50 ms or longer,
// which a loaded host always reaches) as one diagnostic line. Any other line
// on stderr is still a failure.
function unexpectedStderr(stderr: string): string {
  return stderr.split("\n").filter(line => {
    if (!line.startsWith("[blocking-wait] ")) return line !== "";
    const sample = JSON.parse(line.slice("[blocking-wait] ".length)) as { site?: string; refused?: boolean };
    return sample.site !== "file-transaction" || sample.refused === true;
  }).join("\n");
}

test.each(["release", "crash"] as const)("concurrent helpers serialize retirement and recover an exited owner (%s)", async ending => {
  const crash = ending === "crash";
  const f = fixture(); const directory = f.make("concurrent"); f.store.close();
  const spawn = (now: number, state: string) => Bun.spawn([process.execPath,
    path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.filename, String(now), state],
  { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const first = spawn(NOW, "hold-state"); let second: ReturnType<typeof spawn> | undefined;
  try {
    const reader = first.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    second = spawn(NOW + 60000, "settled");
    const deadline = performance.now() + 5000;
    const queue = f.filename + ".sweep.write-locks";
    while ((!fs.existsSync(queue) || fs.readdirSync(queue).length < 2) && performance.now() < deadline && second.exitCode === null)
      await Bun.sleep(10);
    expect(fs.existsSync(directory)).toBeTrue();
    expect(fs.existsSync(queue) && fs.readdirSync(queue).length >= 2).toBeTrue();
    if (crash) first.kill("SIGKILL"); else first.stdin.end();
    await first.exited;
    const [stdout, stderr, code] = await Promise.all([new Response(second.stdout).text(), new Response(second.stderr).text(), second.exited]);
    expect({ code, stderr: unexpectedStderr(stderr) }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ removed: crash ? 1 : 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally {
    for (const child of [first, second]) if (child) {
      child.stdin.end(); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited;
    }
  }
}, 20000);


test("legacy scratch adoption survives reopening and preserves foreign and live roots", async () => {
  const f = fixture(), scratch = path.join(f.root, "scratch"); fs.mkdirSync(scratch, { mode: 0o700 });
  const old = path.join(scratch, "llv-stage-AbC123"), live = path.join(scratch, "llv-stage-DeF456");
  for (const directory of [old, live, path.join(scratch, "my-proof")]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.symlinkSync(old, path.join(scratch, "llv-stage-XyZ789"));
  try {
    expect((await f.sweep("orphan")).removed).toBe(0);
    expect(f.store.has(old)).toBeTrue(); expect(f.store.has(live)).toBeTrue();
  } finally { f.store.close(); }
  const store = new AttemptTempStore(f.filename);
  try {
    const report = await sweepAttemptTemps(store, { now: () => NOW + 2 * 86400000, state: async () => "orphan",
      scan: () => ({ ownNamespace: null, processes: [{ pid: 123, namespace: null, stamped: false, paths: [live] }] }),
      references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true) });
    expect(report.removed).toBe(1); expect(fs.existsSync(old)).toBeFalse(); expect(fs.existsSync(live)).toBeTrue();
    expect(store.has(path.join(scratch, "my-proof"))).toBeFalse();
    expect(store.has(path.join(scratch, "llv-stage-XyZ789"))).toBeFalse();
  } finally { store.close(); }
});

test("a settled attempt containing the real uv cache retires through the ledger", async () => {
  const f = fixture(), directory = f.make("uv");
  fs.mkdirSync(path.join(directory, "cache/uv/sdists-v9"), { recursive: true });
  fs.writeFileSync(path.join(directory, "cache/uv/sdists-v9/.git"), "");
  try { expect((await f.sweep()).removed).toBe(1); expect(fs.existsSync(directory)).toBeFalse(); }
  finally { f.store.close(); }
});


test("legacy adoption advances its bounded cursor across store restarts", () => {
  const f = fixture(), scratch = path.join(f.root, "scratch"); fs.mkdirSync(scratch, { mode: 0o700 });
  const directories = Array.from({ length: 37 }, (_, index) => path.join(scratch, `llv-stage-A${String(index).padStart(5, "0")}`));
  for (const directory of directories) fs.mkdirSync(directory, { mode: 0o700 });
  expect(f.store.adopt(NOW)).toEqual({ adopted: 32, errors: 0 }); f.store.close();
  const resumed = new AttemptTempStore(f.filename);
  try {
    expect(resumed.adopt(NOW + 1)).toEqual({ adopted: 5, errors: 0 });
    for (const directory of directories) expect(resumed.has(directory)).toBeTrue();
  } finally { resumed.close(); }
});

function legacyEvidence(f: ReturnType<typeof fixture>) {
  const directory = path.join(f.root, "scratch/llv-stage-AbC123");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(directory, ".git")); fs.mkdirSync(path.join(directory, ".artifacts"));
  fs.writeFileSync(path.join(directory, ".artifacts/prototype.png"), "prototype bytes");
  fs.writeFileSync(path.join(directory, "report.webp"), "report bytes");
  fs.writeFileSync(path.join(directory, "scratch.bin"), "disposable");
  return directory;
}

function savedAttemptEvidence(original: string): string | undefined {
  const root = statePath("evidence", "attempt-temp");
  return fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)).find(directory => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")).original === original; }
    catch { return false; }
  }) : undefined;
}

test.each(["png", "jpg", "jpeg", "gif", "webp", "avif", "BMP"])("legacy %s capture survives adoption and retirement across reopening", async extension => {
  const f = fixture(), directory = path.join(f.root, "scratch/llv-stage-AbC123");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, `report.${extension}`), "raster capture bytes");
  expect((await f.sweep("orphan")).removed).toBe(0); f.store.close();
  const store = new AttemptTempStore(f.filename);
  try {
    const report = await sweepAttemptTemps(store, { now: () => NOW + 2 * 86400000, state: async () => "orphan",
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    const saved = savedAttemptEvidence(directory);
    expect(saved).toBeDefined();
    expect(fs.readFileSync(path.join(saved!, `files/report.${extension}`), "utf8")).toBe("raster capture bytes");
  } finally { store.close(); }
});

test("legacy scratch screenshots survive adoption and retirement across reopening", async () => {
  const f = fixture(), directory = legacyEvidence(f);
  expect((await f.sweep("orphan")).removed).toBe(0); f.store.close();
  const store = new AttemptTempStore(f.filename);
  try {
    const report = await sweepAttemptTemps(store, { now: () => NOW + 2 * 86400000, state: async () => "orphan",
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    const saved = savedAttemptEvidence(directory);
    expect(saved).toBeDefined();
    expect(fs.readFileSync(path.join(saved!, "files/.artifacts/prototype.png"), "utf8")).toBe("prototype bytes");
    expect(fs.readFileSync(path.join(saved!, "files/report.webp"), "utf8")).toBe("report bytes");
    expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.existsSync(path.join(saved!, "files/scratch.bin"))).toBeFalse();
  } finally { store.close(); }
});

test.each(["refused", "corrupt"])("%s evidence preservation keeps legacy scratch and retries", async failure => {
  const f = fixture(), directory = legacyEvidence(f), copy = evidenceCopy.copyAttemptEvidenceWithinBudget;
  f.store.adopt(NOW); let attempted = false;
  const refused = spyOn(evidenceCopy, "copyAttemptEvidenceWithinBudget").mockImplementation(async (source, target) => {
    if (String(target).includes(path.join("evidence", "attempt-temp"))) {
      attempted = true;
      if (failure === "refused") throw new Error("fixture preservation refused");
      await copy(source, target); fs.writeFileSync(target, "corrupt"); return;
    }
    return copy(source, target);
  });
  try {
    expect(await f.sweep("orphan", { now: () => NOW + 2 * 86400000 })).toMatchObject({ removed: 0, errors: 1 });
    expect(attempted).toBeTrue();
    expect(fs.readFileSync(path.join(directory, ".artifacts/prototype.png"), "utf8")).toBe("prototype bytes");
  } finally { refused.mockRestore(); }
  try {
    expect((await f.sweep("orphan", { now: () => NOW + 3 * 86400000 })).removed).toBe(1);
    const saved = savedAttemptEvidence(directory)!;
    expect(fs.readFileSync(path.join(saved, "files/.artifacts/prototype.png"), "utf8")).toBe("prototype bytes");
  } finally { f.store.close(); }
});

test.each(["new", "changed"])("evidence arriving during the final authority read retains scratch until preserved (%s)", async kind => {
  const f = fixture(), directory = legacyEvidence(f); let added = false;
  f.store.adopt(NOW);
  try {
    expect((await f.sweep("orphan", { now: () => NOW + 2 * 86400000, state: async () => {
      if (!added && savedAttemptEvidence(directory)) {
        added = true; fs.writeFileSync(path.join(directory, kind === "new" ? "late.png" : ".artifacts/prototype.png"), "late frame");
      }
      return "orphan";
    } })).removed).toBe(0);
    expect(added).toBeTrue();
    expect((await f.sweep("orphan", { now: () => NOW + 3 * 86400000 })).removed).toBe(1);
    const saved = savedAttemptEvidence(directory)!;
    const manifest = JSON.parse(fs.readFileSync(path.join(saved, "manifest.json"), "utf8"));
    const entry = manifest.files.find((file: { path: string }) => file.path === (kind === "new" ? "late.png" : ".artifacts/prototype.png"));
    expect(fs.readFileSync(path.join(saved, entry.savedPath), "utf8")).toBe("late frame");
    expect(fs.readFileSync(path.join(saved, "files/.artifacts/prototype.png"), "utf8")).toBe("prototype bytes");
  } finally { f.store.close(); }
});

test.each([".artifacts", "frame.png"])("linked %s evidence retains scratch and its outside target", async name => {
  const f = fixture(), directory = f.make("linked-evidence");
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "frame.png"), "outside capture");
  fs.symlinkSync(name === ".artifacts" ? outside : path.join(outside, "frame.png"), path.join(directory, name));
  try {
    expect((await f.sweep()).removed).toBe(0);
    expect(fs.existsSync(directory)).toBeTrue();
    expect(fs.readFileSync(path.join(outside, "frame.png"), "utf8")).toBe("outside capture");
  } finally { f.store.close(); }
});

test("a destination link swapped after hashing cannot authorize retirement", async () => {
  const f = fixture(), directory = legacyEvidence(f); f.store.adopt(NOW);
  const originalLstat = fs.lstatSync; let swapped = false;
  const lstat = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
    if (!swapped && options?.bigint && String(file).endsWith(path.join("files", ".artifacts", "prototype.png"))
      && !fs.existsSync(directory)) {
      swapped = true;
      const outside = path.join(f.root, "outside-capture.png");
      fs.renameSync(file, outside); fs.symlinkSync(outside, file);
    }
    return originalLstat(file, options);
  }) as typeof fs.lstatSync);
  try {
    const report = await f.sweep("orphan", { now: () => NOW + 2 * 86400000 });
    expect(swapped).toBeTrue(); expect(report.removed).toBe(0);
    expect(fs.readFileSync(path.join(directory, ".artifacts/prototype.png"), "utf8")).toBe("prototype bytes");
    expect(fs.readFileSync(path.join(f.root, "outside-capture.png"), "utf8")).toBe("prototype bytes");
  } finally { lstat.mockRestore(); f.store.close(); }
});


// W5 exercises the public sweep with real evidence/check writers and authority.
async function lostTrashFixture(source: "manifest" | "active" | "history" | "none", name = "lost") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-trash-binding-")); roots.push(root);
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const scratch = statePath("scratch"); fs.mkdirSync(scratch, { recursive: true });
  const store = new AttemptTempStore();
  const pipeline = finishedLane(root, "2026-10-01T00:00:00Z");
  savePipelines([pipeline]);
  const directory = path.join(scratch, `llv-stage-${name}`), trash = path.join(scratch, `.delegatus-trash-llv-stage-${name}-interrupted`);
  fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "capture.png"), "retained payload");
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`, journal = attemptTempJournalPath(directory);
  const manifest = async (lane: string | null = pipeline.id, launch = "retention-launch") => {
    const result = await preserveAttemptEvidence(directory, directory, identity, { pipelineId: lane, launchId: launch, register: () => {} });
    return path.join(result.destination!, "manifest.json");
  };
  let checkId: string | undefined, manifestFile: string | undefined;
  if (source === "manifest") manifestFile = await manifest();
  if (source === "active" || source === "history") {
    checkId = await holdFinishedRoot(directory, pipeline.id);
    if (source === "history") {
      const checks = new RecordedCheckStore();
      try {
        const row = checks.get(checkId)!;
        await checks.write({ ...row, revision: 2, acknowledgement: { actor: "fixture", disposition: "adopt-retained", at: 1,
          resultRevision: 0, resultDigest: "", evidenceDigest: "" } }, 1);
        const db = new Database(statePath("state.sqlite"));
        try { expect(db.query("SELECT id FROM recorded_checks WHERE id=?").get(checkId)).toBeNull(); }
        finally { db.close(); }
      } finally { checks.close(); }
    }
  }
  fs.renameSync(directory, trash);
  fs.writeFileSync(journal, JSON.stringify({ directory, trash, uid: stat.uid, identity, snapshot: null, disposable: true }));
  const authority = (owner: AttemptTempOwner, inventory: filesystem.RepositoryLinkInventory) => attemptTempAuthority(owner, inventory, () => NOW);
  const tick = (extra = {}) => sweepAttemptTemps(store, { now: () => NOW, maxRoots: 4,
    state: async (owner, inventory) => (await authority(owner, inventory)).state, authority,
    scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true, ...extra });
  const run = async (extra = {}) => {
    let report = await tick(extra);
    for (let n = 0; n < 12 && !report.outcomes.some(row => row.directory === directory && row.disposition !== "deferred"); n++) report = await tick(extra);
    return report;
  };
  const retained = () => {
    expect(fs.readFileSync(path.join(trash, "capture.png"), "utf8")).toBe("retained payload");
    expect(fs.existsSync(journal)).toBeTrue(); expect(fs.existsSync(directory)).toBeFalse();
    const owner = store.owner(directory);
    if (owner) expect(owner.pipelineId).not.toBeNull();
  };
  const close = () => { store.close(); process.env.LLV_STATE_DIR = previous; };
  return { root, store, pipeline, directory, trash, identity, journal, checkId, manifestFile, tick, run, retained, close };
}

for (const source of ["manifest", "active", "history"] as const) {
  test(`lost trash binding from ${source} retires only after the lane expires`, async () => {
    const f = await lostTrashFixture(source);
    try {
      expect(f.store.has(f.directory)).toBeFalse();
      const report = await f.run();
      expect(report).toMatchObject({ removed: 1, errors: 0 });
      expect(fs.existsSync(f.trash)).toBeFalse(); expect(fs.existsSync(f.journal)).toBeFalse();
      expect(f.store.has(f.directory)).toBeFalse();
    } finally { f.close(); }
  });
  test.each(["open", "resumed", "missing-lane", "recent"] as const)(`lost trash binding from ${source} preserves %s lane`, async state => {
    const f = await lostTrashFixture(source);
    try {
      if (state === "open") { f.pipeline.state = "running"; savePipelines([f.pipeline]); }
      if (state === "missing-lane") savePipelines([]);
      if (state === "recent") { f.pipeline.closedAt = "2026-10-21T00:00:00Z"; savePipelines([f.pipeline]); }
      let resumed = false;
      const report = await f.run(state !== "resumed" ? {} : { state: async (owner: AttemptTempOwner, inventory: filesystem.RepositoryLinkInventory) => {
        const old = await attemptTempAuthority(owner, inventory, () => NOW);
        f.pipeline.state = "running"; savePipelines([f.pipeline]); resumed = true;
        return old.state;
      } });
      expect(report.removed).toBe(0); f.retained();
      expect(f.store.owner(f.directory)).toMatchObject({ pipelineId: f.pipeline.id, launchId: "retention-launch", identity: f.identity, retainUntilClose: 1 });
      expect(report.outcomes.find(row => row.directory === f.directory)?.reason).toMatch(/ownership (unknown|orphan|closed)|authority|expired/);
      if (state === "resumed") expect(resumed).toBeTrue();
    } finally { f.close(); }
  });
}

test.each(["nonmatching", "absent"] as const)("lost trash watches a %s manifest through the synchronous dispatch fence", async kind => {
  const f = await lostTrashFixture("manifest");
  try {
    const destination = statePath("evidence", "attempt-temp", digest("negative-fence-copy"));
    fs.mkdirSync(destination);
    const file = path.join(destination, "manifest.json"), value = { original: f.directory + "-other", identity: f.identity,
      pipelineId: "other-open-lane", launchId: "other-launch", files: [] };
    if (kind === "nonmatching") fs.writeFileSync(file, JSON.stringify(value));
    f.pipeline.state = "running"; savePipelines([f.pipeline]);
    expect((await f.run()).removed).toBe(0); f.retained();
    expect(f.store.recoveredTrashCurrent(f.directory)).toBeTrue();
    let changed = false;
    expect(attemptMutationCurrent(f.store.trashRecoveryWatches(f.directory), () => {
      const valid = f.store.recoveredTrashCurrent(f.directory);
      expect(valid).toBeTrue();
      // Publication after the metadata read must invalidate that same dispatch.
      const temporary = path.join(destination, "next.json");
      fs.writeFileSync(temporary, JSON.stringify({ ...value, original: f.directory }));
      fs.renameSync(temporary, file); changed = true;
      return valid;
    })).toBeFalse();
    expect(changed).toBeTrue(); f.retained();
  } finally { f.close(); }
});

test.each([1024, 1025])("lost trash bounds persisted manifest observations at %i entries", async count => {
  const f = await lostTrashFixture("active");
  try {
    const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
    for (let n = 0; n < count; n++) fs.mkdirSync(path.join(parent, digest(["observation-bound", n])));
    let report;
    for (let n = 0; n < 80; n++) {
      report = await f.tick();
      expect(report.recovery.manifestEntries).toBeLessThanOrEqual(32);
      const db = new Database(f.store.filename);
      try {
        expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM trash_recovery_observations").get()!.count).toBeLessThanOrEqual(1024);
      } finally { db.close(); }
      if (report.outcomes.some(row => row.directory === f.directory && row.disposition !== "deferred")) break;
    }
    if (count === 1024) {
      expect(report!.removed).toBe(1); expect(fs.existsSync(f.trash)).toBeFalse(); expect(fs.existsSync(f.journal)).toBeFalse();
      const db = new Database(f.store.filename);
      try { expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM trash_recovery_observations").get()!.count).toBe(0); }
      finally { db.close(); }
    } else {
      expect(report!.removed).toBe(0); f.retained(); expect(f.store.has(f.directory)).toBeFalse();
      expect(report!.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown: manifest observation limit" }));
    }
  } finally { f.close(); }
});

test.each(["complete", "interrupted"] as const)("lost trash invalidates a legacy restored checkpoint with %s proof-format upgrade", async upgrade => {
  const f = await lostTrashFixture("manifest");
  try {
    const destination = statePath("evidence", "attempt-temp", digest("legacy-negative-copy")); fs.mkdirSync(destination);
    f.pipeline.state = "running"; savePipelines([f.pipeline]);
    expect((await f.run()).removed).toBe(0); f.retained();
    const db = new Database(f.store.filename);
    try { db.exec("DROP TABLE trash_recovery_observations"); } finally { db.close(); }
    if (upgrade === "interrupted") {
      const original = Database.prototype.exec;
      const exec = spyOn(Database.prototype, "exec").mockImplementation(function(this: Database, sql) {
        if (sql.startsWith("UPDATE trash_recovery SET restored=0")) throw new Error("fixture interrupted proof upgrade");
        return original.call(this, sql);
      });
      try { expect(() => new AttemptTempStore(f.store.filename)).toThrow("fixture interrupted proof upgrade"); }
      finally { exec.mockRestore(); }
      const check = new Database(f.store.filename);
      try { expect(check.query("SELECT 1 FROM sqlite_master WHERE name='trash_recovery_observations'").get()).toBeNull(); }
      finally { check.close(); }
      f.retained();
    }
    fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ original: f.directory, identity: f.identity,
      pipelineId: "other-open-lane", launchId: "other-launch", files: [] }));
    f.pipeline.state = "completed"; savePipelines([f.pipeline]);
    const report = await retentionProcess(f.store.filename, NOW + 120_001, "production");
    expect(report.removed).toBe(0); f.retained();
    expect(report.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown" }));
  } finally { f.close(); }
});

test.each(["absent", "null-lane", "missing-check", "corrupt-check", "wrong-inode", "wrong-path"] as const)("lost trash keeps owner-unknown with %s binding", async kind => {
  const source = kind === "missing-check" || kind === "corrupt-check" ? "active" : kind === "absent" ? "none" : "manifest";
  const f = await lostTrashFixture(source);
  try {
    if (f.manifestFile) {
      const value = JSON.parse(fs.readFileSync(f.manifestFile, "utf8"));
      if (kind === "null-lane") value.pipelineId = null;
      if (kind === "wrong-inode") value.identity = "0:0";
      if (kind === "wrong-path") value.original += "-other";
      fs.writeFileSync(f.manifestFile, JSON.stringify(value));
    }
    if (f.checkId) {
      const db = new Database(statePath("state.sqlite"));
      try {
        if (kind === "missing-check") db.query("DELETE FROM recorded_checks WHERE id=?").run(f.checkId);
        else db.query("UPDATE recorded_checks SET value='{}' WHERE id=?").run(f.checkId);
      } finally { db.close(); }
    }
    const report = await f.run();
    expect(report.removed).toBe(0); f.retained(); expect(f.store.has(f.directory)).toBeFalse();
    expect(report.outcomes.find(row => row.directory === f.directory)?.reason).toBe("owner-unknown");
  } finally { f.close(); }
});

for (const sources of ["manifests", "checks", "mixed"] as const) {
  test.each(["lane", "launch"] as const)(`lost trash refuses conflicting ${sources} %s`, async conflict => {
    const f = await lostTrashFixture(sources === "checks" ? "active" : "manifest");
    try {
      const lane = conflict === "lane" ? "other-lane" : f.pipeline.id, launch = conflict === "launch" ? "other-launch" : "retention-launch";
      if (sources === "manifests") {
        const value = JSON.parse(fs.readFileSync(f.manifestFile!, "utf8")), other = statePath("evidence", "attempt-temp", digest("other-copy"));
        fs.mkdirSync(other); fs.writeFileSync(path.join(other, "manifest.json"), JSON.stringify({ ...value, pipelineId: lane, launchId: launch }));
      } else {
        // The root-row writer needs the original directory, then the same inode returns to quarantine.
        fs.renameSync(f.trash, f.directory);
        try { await holdFinishedRoot(f.directory, lane, "other-check", [], launch); }
        finally { fs.renameSync(f.directory, f.trash); }
      }
      const report = await f.run();
      expect(report.removed).toBe(0); f.retained(); expect(f.store.has(f.directory)).toBeFalse();
      expect(report.outcomes.find(row => row.directory === f.directory)?.reason).toBe("owner-unknown");
    } finally { f.close(); }
  });
}


test("lost trash recovery pages survive helper restarts and keep missing proof past its retry", async () => {
  const f = await lostTrashFixture("none");
  try {
    const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
    for (let n = 0; n < 70; n++) {
      const destination = path.join(parent, digest(["unrelated", n])); fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ original: f.directory + "-other", identity: f.identity,
        pipelineId: f.pipeline.id, launchId: "retention-launch", files: [] }));
    }
    let report;
    for (let n = 0; n < 12; n++) {
      report = await retentionProcess(f.store.filename, NOW, "production");
      expect(report.recovery.entries).toBeLessThanOrEqual(32);
      expect(report.recovery.manifestEntries).toBeLessThanOrEqual(32);
      expect(report.recovery.checks).toBeLessThanOrEqual(33);
      expect(report.removed).toBe(0); f.retained(); expect(f.store.has(f.directory)).toBeFalse();
      if (report.outcomes.some((row: { reason: string }) => row.reason === "owner-unknown")) break;
    }
    expect(report.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown" }));
    report = await retentionProcess(f.store.filename, NOW + 60_001, "production");
    expect(report.removed).toBe(0); f.retained(); expect(f.store.has(f.directory)).toBeFalse();
    const destination = path.join(parent, digest("late-binding")); fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ original: f.directory, identity: f.identity,
      pipelineId: f.pipeline.id, launchId: "retention-launch", files: [] }));
    let removed = 0;
    for (let n = 0; n < 16 && !removed; n++) {
      report = await retentionProcess(f.store.filename, NOW + 120_002, "production");
      expect(report.recovery.entries).toBeLessThanOrEqual(32); expect(report.recovery.manifestEntries).toBeLessThanOrEqual(32);
      removed += report.removed;
    }
    expect(removed).toBe(1); expect(fs.existsSync(f.journal)).toBeFalse(); expect(fs.existsSync(f.trash)).toBeFalse();
  } finally { f.close(); }
});

test.each(["journal-link", "trash-link", "acquired-original", "identity", "uid", "outside"] as const)("lost trash recovery refuses %s without touching external data", async kind => {
  const f = await lostTrashFixture("manifest");
  try {
    const value = JSON.parse(fs.readFileSync(f.journal, "utf8")), external = path.join(f.root, "external");
    fs.mkdirSync(external); fs.writeFileSync(path.join(external, "payload"), "external payload");
    if (kind === "journal-link") { const saved = path.join(f.root, "journal-copy"); fs.renameSync(f.journal, saved); fs.symlinkSync(saved, f.journal); }
    if (kind === "trash-link") { fs.renameSync(f.trash, path.join(f.root, "saved-trash")); fs.symlinkSync(external, f.trash); }
    if (kind === "acquired-original") fs.mkdirSync(f.directory);
    if (kind === "identity") value.identity = "0:0";
    if (kind === "uid") value.uid = -1;
    if (kind === "outside") value.trash = external;
    if (["identity", "uid", "outside"].includes(kind)) fs.writeFileSync(f.journal, JSON.stringify(value));
    const report = await f.run();
    expect(report.removed).toBe(0); expect(f.store.has(f.directory)).toBeFalse();
    expect(fs.existsSync(f.journal)).toBeTrue(); expect(fs.readFileSync(path.join(external, "payload"), "utf8")).toBe("external payload");
  } finally { f.close(); }
});

test("lost trash recovery defers before enumeration when its tick deadline is exhausted", async () => {
  const f = await lostTrashFixture("manifest");
  try {
    // Admit the sweep, then exhaust its budget before trash recovery starts.
    let reads = 0;
    const report = await f.tick({ runBudgetMs: 40_000, now: () => NOW + (reads++ === 0 ? 0 : 40_000) });
    expect(report.removed).toBe(0); expect(report.recovery).toEqual({ entries: 0, manifestEntries: 0, checks: 0, restored: 0 });
    expect(f.store.has(f.directory)).toBeFalse(); f.retained();
  } finally { f.close(); }
});

test("lost trash recovery uses a monotonic budget with calendar retention timestamps", async () => {
  const f = await lostTrashFixture("manifest");
  try {
    f.pipeline.state = "running";
    savePipelines([f.pipeline]);
    let report = await f.tick({ now: () => NOW, budgetNow: sweepMonotonicNow });
    expect(report.recovery.manifestEntries).toBeGreaterThan(0);
    let restoredOwner = report.recovery.restored ? f.store.owner(f.directory) : null;
    for (let n = 0; n < 8 && !restoredOwner; n++) {
      report = await f.tick({ now: () => NOW, budgetNow: sweepMonotonicNow });
      if (report.recovery.restored) restoredOwner = f.store.owner(f.directory);
    }
    expect(report.recovery.restored).toBeGreaterThanOrEqual(1);
    expect(restoredOwner).toMatchObject({ pipelineId: f.pipeline.id, launchId: "retention-launch", identity: f.identity });
    f.retained();
  } finally { f.close(); }
});


test.each(["manifest", "active", "history"] as const)("lost trash rechecks %s proof after an awaited reference observation", async source => {
  const f = await lostTrashFixture(source);
  try {
    let changed = false;
    const report = await f.run({ references: async () => {
      if (changed) return true;
      changed = true;
      if (f.manifestFile) {
        const value = JSON.parse(fs.readFileSync(f.manifestFile, "utf8")); value.launchId = "changed-launch";
        fs.writeFileSync(f.manifestFile, JSON.stringify(value));
      } else {
        const db = new Database(statePath("state.sqlite"));
        try { db.query("DELETE FROM recorded_check_roots WHERE id=?").run(f.checkId!); }
        finally { db.close(); }
      }
      return true;
    } });
    expect(changed).toBeTrue(); expect(report.removed).toBe(0); f.retained();
  } finally { f.close(); }
});

for (const source of ["manifest", "active", "history"] as const) {
  for (const kind of ["nonmatching", "absent"] as const) {
    test.each([1, 2])(`lost trash keeps a ${kind} manifest becoming conflicting at reference %i (${source})`, async boundary => {
      const f = await lostTrashFixture(source);
      try {
        const destination = statePath("evidence", "attempt-temp", digest("existing-negative-copy"));
        fs.mkdirSync(destination, { recursive: true });
        const file = path.join(destination, "manifest.json");
        const value = { original: f.directory + "-other", identity: f.identity,
          pipelineId: "other-open-lane", launchId: "other-launch", files: [] };
        if (kind === "nonmatching") fs.writeFileSync(file, JSON.stringify(value));
        let reads = 0;
        const report = await f.run({ references: async () => {
          if (++reads === boundary) fs.writeFileSync(file, JSON.stringify({ ...value, original: f.directory }));
          return true;
        } });
        expect(reads).toBeGreaterThanOrEqual(boundary);
        expect(report.removed).toBe(0); f.retained();
        expect(report.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown" }));
      } finally { f.close(); }
    });

    test.each(["paging", "restored"] as const)(`lost trash revalidates ${kind} manifest observations after a process restart during %s (${source})`, async phase => {
      const f = await lostTrashFixture(source);
      try {
        const parent = statePath("evidence", "attempt-temp"); fs.mkdirSync(parent, { recursive: true });
        const value = { original: f.directory + "-other", identity: f.identity,
          pipelineId: "other-open-lane", launchId: "other-launch", files: [] };
        const negatives = new Set<string>();
        for (let n = 0; n < (phase === "paging" ? 70 : 1); n++) {
          const name = digest(["negative-copy", n]), destination = path.join(parent, name);
          negatives.add(name); fs.mkdirSync(destination);
          if (kind === "nonmatching") fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(value));
        }
        const first = copyDiscovery.discoverAttemptCopies(parent, "", () => NOW, NOW + 1000);
        const victim = path.join(parent, first.names.find(name => negatives.has(name))!, "manifest.json");
        if (phase === "restored") { f.pipeline.state = "running"; savePipelines([f.pipeline]); }
        let report = await retentionProcess(f.store.filename, NOW, "production");
        if (phase === "restored") {
          for (let n = 0; n < 4 && !f.store.has(f.directory); n++) report = await retentionProcess(f.store.filename, NOW, "production");
        }
        expect(report.removed).toBe(0); f.retained();
        if (phase === "paging") expect(f.store.has(f.directory)).toBeFalse();
        else expect(f.store.has(f.directory)).toBeTrue();
        fs.writeFileSync(victim, JSON.stringify({ ...value, original: f.directory }));
        f.pipeline.state = "completed"; savePipelines([f.pipeline]);
        for (let n = 0; n < 16; n++) {
          report = await retentionProcess(f.store.filename, NOW + 120_001, "production");
          expect(report.removed).toBe(0); f.retained();
          expect(report.recovery.manifestEntries).toBeLessThanOrEqual(32);
          if (report.outcomes.some((row: { reason: string }) => row.reason === "owner-unknown")) break;
        }
        expect(report.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown" }));
      } finally { f.close(); }
    });
  }
}


test("lost trash refreshes its proof after an unrelated copy arrives and the open lane later expires", async () => {
  const f = await lostTrashFixture("manifest");
  try {
    f.pipeline.state = "running"; savePipelines([f.pipeline]);
    expect((await f.run()).removed).toBe(0); f.retained();
    const other = statePath("evidence", "attempt-temp", digest("new-unrelated-copy")); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "manifest.json"), JSON.stringify({ original: f.directory + "-other", identity: f.identity,
      pipelineId: "other-lane", launchId: "other-launch", files: [] }));
    f.pipeline.state = "completed"; savePipelines([f.pipeline]);
    let removed = 0;
    for (let n = 0; n < 12 && !removed; n++) removed += (await f.tick({ now: () => NOW + 120_001 + n * 60_001 })).removed;
    expect(removed).toBe(1); expect(fs.existsSync(f.journal)).toBeFalse(); expect(fs.existsSync(f.trash)).toBeFalse();
  } finally { f.close(); }
});


test.each(["wrong-inode", "wrong-path", "null-lane"] as const)("lost trash ignores a recorded check with %s", async kind => {
  const f = await lostTrashFixture("active");
  try {
    const db = new Database(statePath("state.sqlite"));
    try {
      if (kind === "wrong-inode") db.query("UPDATE recorded_check_roots SET identity='0:0' WHERE id=?").run(f.checkId!);
      if (kind === "wrong-path") db.query("UPDATE recorded_check_roots SET directory=? WHERE id=?").run(f.directory + "-other", f.checkId!);
      if (kind === "null-lane") {
        const stored = db.query<{ value: string }, [string]>("SELECT value FROM recorded_checks WHERE id=?").get(f.checkId!)!;
        const value = JSON.parse(stored.value); value.binding.pipeline = null;
        db.query("UPDATE recorded_checks SET value=? WHERE id=?").run(JSON.stringify(value), f.checkId!);
      }
    } finally { db.close(); }
    const report = await f.run();
    expect(report.removed).toBe(0); expect(f.store.has(f.directory)).toBeFalse(); f.retained();
    expect(report.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown" }));
  } finally { f.close(); }
});

test.each(["manifests", "checks"] as const)("lost trash refuses consensus overflow in %s", async source => {
  const f = await lostTrashFixture(source === "checks" ? "active" : "manifest");
  try {
    if (source === "manifests") {
      const value = fs.readFileSync(f.manifestFile!, "utf8");
      for (let n = 0; n < 32; n++) {
        const other = statePath("evidence", "attempt-temp", digest(["overflow-copy", n])); fs.mkdirSync(other);
        fs.writeFileSync(path.join(other, "manifest.json"), value);
      }
    } else {
      fs.renameSync(f.trash, f.directory);
      try { for (let n = 0; n < 32; n++) await holdFinishedRoot(f.directory, f.pipeline.id, `overflow-${n}`); }
      finally { fs.renameSync(f.directory, f.trash); }
    }
    const report = await f.run();
    expect(report.removed).toBe(0); expect(f.store.has(f.directory)).toBeFalse(); f.retained();
    expect(report.outcomes).toContainEqual(expect.objectContaining({ directory: f.directory, reason: "owner-unknown" }));
    expect(report.recovery.manifestEntries).toBeLessThanOrEqual(32); expect(report.recovery.checks).toBeLessThanOrEqual(33);
  } finally { f.close(); }
});

test("lost trash accepts agreeing manifest and recorded-check bindings", async () => {
  const f = await lostTrashFixture("manifest");
  try {
    fs.renameSync(f.trash, f.directory);
    try { await holdFinishedRoot(f.directory, f.pipeline.id); }
    finally { fs.renameSync(f.directory, f.trash); }
    const report = await f.run();
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(f.journal)).toBeFalse(); expect(fs.existsSync(f.trash)).toBeFalse();
  } finally { f.close(); }
});


test.each(["manifest", "check"] as const)("lost trash accepts the %s writer's bounded long launch identity", async source => {
  const f = await lostTrashFixture("none");
  try {
    const launch = "launch-" + "x".repeat(2048);
    fs.renameSync(f.trash, f.directory);
    try {
      if (source === "manifest") await preserveAttemptEvidence(f.directory, f.directory, f.identity,
        { pipelineId: f.pipeline.id, launchId: launch, register: () => {} });
      else await holdFinishedRoot(f.directory, f.pipeline.id, "long-launch", [], launch);
    } finally { fs.renameSync(f.directory, f.trash); }
    const report = await f.run();
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(f.journal)).toBeFalse(); expect(fs.existsSync(f.trash)).toBeFalse();
  } finally { f.close(); }
});


test("lost trash journal discovery advances across helper restarts while unrelated scratch arrives", async () => {
  const f = await lostTrashFixture("none");
  try {
    const scratch = path.dirname(f.directory);
    for (let n = 0; n < 100; n++) {
      const directory = path.join(scratch, `llv-stage-journal-${String(n).padStart(3, "0")}`);
      const trash = path.join(scratch, `.delegatus-trash-${path.basename(directory)}-interrupted`);
      fs.mkdirSync(trash); fs.writeFileSync(path.join(trash, "payload"), "preserve me");
      const stat = fs.lstatSync(trash);
      fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({ directory, trash, uid: stat.uid,
        identity: `${stat.dev}:${stat.ino}`, snapshot: null, disposable: true }));
    }
    let discovered = 0;
    for (let tick = 0; tick < 15 && discovered < 101; tick++) {
      fs.mkdirSync(path.join(scratch, `unrelated-arrival-${tick}`));
      const report = await retentionProcess(f.store.filename, NOW, "production");
      expect(report.removed).toBe(0); expect(report.recovery.entries).toBeLessThanOrEqual(32);
      const db = new Database(f.store.filename);
      try { discovered = db.query<{ count: number }, []>("SELECT count(*) AS count FROM trash_recovery").get()!.count; }
      finally { db.close(); }
    }
    expect(discovered).toBe(101); f.retained(); expect(f.store.has(f.directory)).toBeFalse();
  } finally { f.close(); }
});
