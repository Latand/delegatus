import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { AgentStateService } from "./service";
import { publishAgentProjection } from "./publication";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeEventInput } from "@/lib/runtime/contracts";
import { emptyAgentStateMetrics } from "./model";
import { validAgentStateMetricsBeforeAntigravity } from "./legacyMetricsFixture";
import { normalizeAgentStateRows, readAgentProjection, readAgentStateMetrics, readAgentStatePage, subjectId, validAgentStateMetrics } from "./store";
import { cachedAgentObservation } from "./projectionCache";
import { FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION, fixtureRegistry, fixtureRecords } from "./testFixture";
import { readControlProjection } from "./controlStore";
import { settlementDeadlineForRow } from "@/lib/runtime/sendSettlement";

const roots: string[] = [], registries: AgentRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(mode: "off" | "sqlite" | "dual-write") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-store-")); roots.push(root);
  const filename = path.join(root, "registry.json"), sqliteFilename = path.join(root, "registry.sqlite");
  const source = fixtureRegistry(root, "codex", captureProcessIdentity(process.pid), null);
  fs.writeFileSync(filename, JSON.stringify(source));
  const records = fixtureRecords("codex");
  fs.writeFileSync(path.join(root, "native.jsonl"), [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(path.join(root, "native.jsonl"), new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  const open = () => { const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode, sqliteFilename }); registries.push(registry); return registry; };
  const service = (registry: AgentRegistry, publish = false) => new AgentStateService({ registry, now: () => FIXTURE_NOW + 2000,
    owns: () => true, process: processIdentityStatus, memory: () => null, release: "fixture", publish: async () => publish });
  return { root, source, filename, sqliteFilename, open, service };
}
for (const mode of ["off", "sqlite"] as const) {
  test(`${mode}: repair, journal and counters survive writer output, normalization and a new registry process owner`, async () => {
    const f = fixture(mode), registry = f.open();
    await f.service(registry).request();
    const stored = normalizeRegistry(JSON.parse(JSON.stringify(registry.readOnlySnapshot())));
    expect(stored.entries[`codex:${FIXTURE_SESSION}`]!.structuredHost!.activeTurnRef).toBeNull();
    expect(Object.values(stored.agentStateJournal)).toHaveLength(1);
    expect(stored.agentStateMetrics.current!.registryTranscriptDivergencesTotal).toBe(1);
    expect(stored.agentStateMetrics.current!.pendingProjectionPublications).toBe(1);
    const persistedRows = mode === "sqlite"
      ? (() => {
        const db = new Database(f.sqliteFilename, { readonly: true });
        try { return db.query<{ value_json: string }, []>("SELECT value_json FROM registry_rows WHERE collection='agentStateMetrics'").all().map(row => JSON.parse(row.value_json)); }
        finally { db.close(); }
      })()
      : Object.values(JSON.parse(fs.readFileSync(path.join(f.root, "registry.json"), "utf8")).agentStateMetrics);
    expect(persistedRows.length).toBeGreaterThan(0);
    expect(persistedRows.every(validAgentStateMetricsBeforeAntigravity)).toBe(true);
    registry.close();
    const successor = f.open();
    await f.service(successor, true).request();
    expect(readAgentStateMetrics(successor)).toMatchObject({ registryTranscriptDivergencesTotal: 1, pendingProjectionPublications: 0 });
    const page = readAgentStatePage(successor, "agentStateJournal", "", 1);
    expect(page.rows).toHaveLength(1);
    const observed = [...page.rows];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = readAgentStatePage(successor, "agentStateJournal", cursor, 1);
      observed.push(...next.rows);
      cursor = next.nextCursor;
    }
    const journalRows = observed.filter(row => row !== null && "id" in row);
    expect(new Set(journalRows.map(row => row.id)).size).toBe(journalRows.length);
    expect(journalRows.filter(row => row.divergence !== null)).toHaveLength(1);
  });
}
for (const mode of ["off", "sqlite"] as const) {
  test(`${mode}: accepted and settled delivery obligations update durable facts across registry restart`, async () => {
    const f = fixture(mode), registry = f.open();
    const service = f.service(registry);
    await service.request();
    const entry = registry.hostEntry({ engine: "codex", sessionId: FIXTURE_SESSION })!;
    const held = registry.holdDelivery(FIXTURE_CONVERSATION, "accepted fixture work", "fixture-message");
    await service.reconcile(registry.hostEntry(entry.key)!);
    const subject = subjectId(entry);
    const accepted = readAgentProjection(registry, subject)!;
    expect(accepted.facts.obligations).toMatchObject({ determined: true, value: ["delivery:assigned", "delivery-owner"] });
    expect(cachedAgentObservation(subject)?.facts.obligations).toEqual(accepted.facts.obligations);

    service.stop(); registry.close();
    const successor = f.open();
    successor.recordDeliveryOutcome(held.id, "delivered", null, "delivered");
    await f.service(successor).request();
    const settled = readAgentProjection(successor, subject)!;
    expect(settled.facts.obligations).toMatchObject({ determined: true, value: [] });
    expect(cachedAgentObservation(subject)?.facts.obligations).toEqual(settled.facts.obligations);
  });
}
test("revision-only status publishes without invalidating files and a failed real invalidation survives retry", async () => {
  const f = fixture("sqlite"), registry = f.open();
  const key = { engine: "codex" as const, sessionId: FIXTURE_SESSION };
  const entry = registry.hostEntry(key)!;
  const subject = subjectId(entry);
  let statusEvents = 0, fileEvents = 0, failRefresh = false;
  let session: Record<string, unknown> = { sessionKey: key, revision: 10, host: "unhosted", turn: "idle",
    activeTurnId: null, writerClaim: null };
  const client = {
    readSession: async () => session,
    filesRevision: async () => fileEvents,
    append: async (event: RuntimeEventInput) => {
      if (event.kind === "files.revision") {
        if (failRefresh) throw new Error("fixture refresh interruption");
        fileEvents++;
      } else {
        expect(event.expectedSessionRevision).toBe(session.revision as number);
        statusEvents++;
        session = { ...session, ...event.payload, revision: Number(session.revision) + 1 };
      }
    },
  } as unknown as RuntimeHostClient;
  const service = new AgentStateService({ registry, now: () => FIXTURE_NOW + 2000,
    owns: () => true, process: processIdentityStatus, memory: () => null, release: "fixture",
    publish: (row, current) => publishAgentProjection(registry, client, row, current) });
  const observe = () => service.reconcile(registry.hostEntry(key)!);
  try {
    await observe();
    expect([statusEvents, fileEvents]).toEqual([1, 1]);
    service.observeResourceSample([{ agentState: { subject }, rssBytes: 100 }], FIXTURE_NOW + 2000);
    await observe();
    expect([statusEvents, fileEvents]).toEqual([2, 1]);

    // The runtime owner moved independently. Keep the correction owed if only
    // the status commits, then retry with the status already matching.
    session.turn = "running";
    service.observeResourceSample([{ agentState: { subject }, rssBytes: 200 }], FIXTURE_NOW + 2000);
    failRefresh = true;
    await expect(observe()).rejects.toThrow("fixture refresh interruption");
    expect(readAgentProjection(registry, subject)?.pendingFilesRevision).toBe(true);
    failRefresh = false;
    await observe();
    expect(fileEvents).toBe(2);
    expect(readAgentProjection(registry, subject)?.pendingPublication).toBe(false);

    registry.holdDelivery(FIXTURE_CONVERSATION, "fixture", "delivery-fact");
    await observe();
    expect(fileEvents).toBe(3);
  } finally { service.stop(); }
});

test("a refused journal insert rolls back the cache, conversation and counters; retry commits once", async () => {
  const f = fixture("sqlite"), registry = f.open();
  registry.readOnlySnapshot();
  const db = new Database(f.sqliteFilename);
  try {
    db.exec("CREATE TRIGGER refuse_agent_state_journal BEFORE INSERT ON registry_rows WHEN NEW.collection='agentStateJournal' BEGIN SELECT RAISE(ABORT,'fixture journal refusal'); END");
    await expect(f.service(registry).reconcile(registry.hostEntry({ engine: "codex", sessionId: FIXTURE_SESSION })!)).rejects.toThrow("fixture journal refusal");
    expect(registry.hostEntry({ engine: "codex", sessionId: FIXTURE_SESSION })!.structuredHost!.activeTurnRef).not.toBeNull();
    expect(readAgentStateMetrics(registry).registryTranscriptDivergencesTotal).toBe(0);
    db.exec("DROP TRIGGER refuse_agent_state_journal");
    await f.service(registry).request();
    expect(readAgentStateMetrics(registry).registryTranscriptDivergencesTotal).toBe(1);
  } finally { db.close(); }
});
test("legacy snapshots start without a fabricated idle projection", () => {
  const legacy = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
  expect(legacy.agentStates).toEqual({});
  expect(legacy.agentStateJournal).toEqual({});
  expect(legacy.agentStateMetrics).toEqual({});
});

test("delivery reads the settled incident turn across restart and keeps equal subjects in their own registries", async () => {
  const f = fixture("sqlite");
  const registry = f.open();
  const held = registry.holdDelivery(FIXTURE_CONVERSATION, "accepted fixture work", "fixture-message");
  const delivery = registry.readOnlySnapshot().heldDeliveries[held.id]!;
  expect(settlementDeadlineForRow(registry, { delivery })?.policy).toBe("in-turn-ceiling");

  const service = f.service(registry);
  await service.request();
  const entry = registry.hostEntry({ engine: "codex", sessionId: FIXTURE_SESSION })!;
  expect(cachedAgentObservation(subjectId(entry))).not.toBeNull();
  expect(readControlProjection(registry, entry, FIXTURE_CONVERSATION)?.facts.turn)
    .toMatchObject({ determined: true, value: { state: "closed" } });
  expect(settlementDeadlineForRow(registry, { delivery })?.policy).toBe("settlement-window");

  const foreignPath = path.join(f.root, "other-registry.json");
  const foreignSource = structuredClone(f.source);
  foreignSource.entries[`codex:${FIXTURE_SESSION}`] = entry;
  fs.writeFileSync(foreignPath, JSON.stringify(foreignSource));
  const foreign = new AgentRegistry(foreignPath, undefined, undefined, { sqliteMode: "off" });
  registries.push(foreign);
  expect(foreign.hostEntry(entry.key)).toEqual(entry);
  expect(readControlProjection(foreign, entry, FIXTURE_CONVERSATION)).toBeNull();
  expect(readControlProjection(registry, entry, "conversation_other")).toBeNull();

  service.stop();
  registry.close();
  fs.unlinkSync(path.join(f.root, "native.jsonl"));
  const successor = f.open();
  expect(readControlProjection(successor, entry, FIXTURE_CONVERSATION)?.facts.turn)
    .toMatchObject({ determined: true, value: { state: "closed" } });
  expect(settlementDeadlineForRow(successor, { delivery })?.policy).toBe("settlement-window");
});

const preAntigravityMetrics = {
  ...emptyAgentStateMetrics(), at: FIXTURE_NOW, stuckTurns: 3,
  stuckByEngine: { codex: 2, claude: 0, copilot: 1 },
};

function jsonMetrics(filename: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filename, "utf8")).agentStateMetrics;
}

function sqliteMetrics(filename: string): Record<string, string> {
  const db = new Database(filename, { readonly: true });
  try {
    return Object.fromEntries(db.query<{ row_key: string; value_json: string }, []>(
      "SELECT row_key, value_json FROM registry_rows WHERE collection='agentStateMetrics'",
    ).all().map(row => [row.row_key, row.value_json]));
  } finally { db.close(); }
}

for (const mode of ["off", "sqlite"] as const) {
  test(`${mode}: periodic reconciliation writes rollback-compatible metrics from sparse current`, async () => {
    const f = fixture(mode);
    const current = { ...preAntigravityMetrics, stuckByEngine: { codex: 2 } };
    fs.writeFileSync(f.filename, JSON.stringify({ version: 2, entries: {}, receipts: {}, agentStateMetrics: { current } }));
    const registry = f.open();
    const service = f.service(registry);
    try {
      await service.request();
      const rows = mode === "off" ? jsonMetrics(f.filename)
        : Object.fromEntries(Object.entries(sqliteMetrics(f.sqliteFilename)).map(([key, value]) => [key, JSON.parse(value)]));
      const series = `series:${String(Math.floor((FIXTURE_NOW + 2000) / 60_000)).padStart(14, "0")}`;
      expect(Object.keys(rows).sort()).toEqual(["current", "journalMaintenance", "maintenance", "scanProgress", series]);
      for (const row of Object.values(rows)) {
        expect(row).toMatchObject({ stuckByEngine: { codex: 2, claude: 0, copilot: 0 }, at: FIXTURE_NOW + 2000 });
        expect(validAgentStateMetricsBeforeAntigravity(row)).toBe(true);
      }
    } finally { service.stop(); }
  });
}

for (const mode of ["off", "sqlite", "dual-write"] as const) {
  test(`${mode}: first open and reconciliation preserve four-bucket and sparse history`, async () => {
    const f = fixture(mode);
    const current = { ...preAntigravityMetrics, stuckByEngine: { ...preAntigravityMetrics.stuckByEngine, antigravity: 7 } };
    const history = {
      "series:four-buckets": { ...current, at: FIXTURE_NOW - 1 },
      "series:sparse": { ...current, at: FIXTURE_NOW - 2, stuckByEngine: { copilot: 1 } },
    };
    fs.writeFileSync(f.filename, JSON.stringify({ version: 2, entries: {}, receipts: {}, agentStateMetrics: { current, ...history } }));
    const stored = () => [
      ...(mode !== "sqlite" ? [Object.fromEntries(Object.entries(jsonMetrics(f.filename)).map(([key, row]) => [key, JSON.stringify(row)]))] : []),
      ...(mode !== "off" ? [sqliteMetrics(f.sqliteFilename)] : []),
    ];
    const registry = f.open();
    expect(readAgentStateMetrics(registry)).toEqual(current);
    for (const rows of stored()) {
      for (const [key, row] of Object.entries({ current, ...history })) expect(rows[key]).toBe(JSON.stringify(row));
    }
    const service = f.service(registry);
    try { await service.request(); } finally { service.stop(); }
    expect(readAgentStateMetrics(registry).stuckByEngine.antigravity).toBe(7);
    registry.close();
    const reopened = Bun.spawnSync([process.execPath, "-e", `
      import { AgentRegistry } from "@/lib/agent/registry";
      const [filename, sqliteFilename, sqliteMode] = process.argv.slice(1);
      const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode, sqliteFilename });
      try { console.log(registry.agentStateMetricsRead().stuckByEngine.antigravity); }
      finally { registry.close(); }
    `, "--", f.filename, f.sqliteFilename, mode], { timeout: 5_000 });
    expect(reopened.exitCode, reopened.stderr.toString()).toBe(0);
    expect(reopened.stdout.toString().trim()).toBe("0");
    for (const rows of stored()) {
      for (const [key, row] of Object.entries(history)) expect(rows[key]).toBe(JSON.stringify(row));
      const updated = Object.entries(rows).filter(([key]) => !Object.hasOwn(history, key));
      expect(updated).toHaveLength(5);
      for (const [, raw] of updated) expect(validAgentStateMetricsBeforeAntigravity(JSON.parse(raw))).toBe(true);
    }
  });
}

test("SQLite no-ops and process-local counter changes leave the durable revision unchanged", () => {
  const f = fixture("sqlite"), registry = f.open();
  registry.agentStateWrite(file => {
    file.agentStateMetrics.current = { ...emptyAgentStateMetrics(), stuckByEngine: { codex: 2, claude: 0, copilot: 1, antigravity: 7 } };
  });
  const db = new Database(f.sqliteFilename, { readonly: true });
  try {
    const revision = () => db.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='revision'").get()!.value;
    const before = revision(), rows = sqliteMetrics(f.sqliteFilename);
    expect(readAgentStateMetrics(registry).stuckByEngine.antigravity).toBe(7);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(registry.agentStateWrite(() => false)).toBe(false);
      registry.agentStateWrite(file => { file.agentStateMetrics.current!.at = 0; });
      expect(revision()).toBe(before);
    }
    registry.agentStateWrite(file => { file.agentStateMetrics.current!.stuckByEngine.antigravity = 8; });
    expect(revision()).toBe(before);
    expect(sqliteMetrics(f.sqliteFilename)).toEqual(rows);
    expect(readAgentStateMetrics(registry).stuckByEngine.antigravity).toBe(8);
  } finally { db.close(); }
});

test("pre-Antigravity metrics validate and normalize every missing engine bucket", () => {
  const rows = JSON.parse(JSON.stringify({
    current: preAntigravityMetrics,
    "series:fixture": { ...preAntigravityMetrics, stuckTurns: 0, stuckByEngine: {} },
  }));
  const before = JSON.stringify(rows);
  const expected = {
    current: { ...preAntigravityMetrics, stuckByEngine: { ...preAntigravityMetrics.stuckByEngine, antigravity: 0 } },
    "series:fixture": { ...preAntigravityMetrics, stuckTurns: 0, stuckByEngine: emptyAgentStateMetrics().stuckByEngine },
  };
  expect(validAgentStateMetrics(rows.current)).toBe(true);
  expect(normalizeAgentStateRows(rows, "metrics")).toEqual(expected);
  expect(normalizeRegistry({ version: 2, entries: {}, receipts: {}, agentStateMetrics: rows }).agentStateMetrics).toEqual(rows);
  expect(JSON.stringify(rows)).toBe(before);
});

test("JSON registry startup and unrelated transactions preserve sparse historical metrics", () => {
  const f = fixture("off");
  const source = { ...f.source, agentStateMetrics: {
    current: preAntigravityMetrics,
    "series:fixture": { ...preAntigravityMetrics, at: FIXTURE_NOW - 1 },
  } };
  fs.writeFileSync(path.join(f.root, "registry.json"), JSON.stringify(source));
  const storedRows = () => JSON.parse(fs.readFileSync(path.join(f.root, "registry.json"), "utf8")).agentStateMetrics;
  const before = JSON.stringify(source.agentStateMetrics);
  const first = f.open();
  expect(readAgentStateMetrics(first).stuckByEngine.antigravity).toBe(0);
  expect(JSON.stringify(storedRows())).toBe(before);
  first.close();
  registries.splice(registries.indexOf(first), 1);
  const reopened = f.open();
  expect(reopened.agentStateWrite(() => false)).toBe(false);
  expect(JSON.stringify(storedRows())).toBe(before);
});

test("registry writes keep Antigravity counts in memory and persist rollback-compatible rows", () => {
  for (const mode of ["off", "sqlite"] as const) {
    const f = fixture(mode), registry = f.open();
    registry.agentStateWrite(file => {
      const metrics = emptyAgentStateMetrics();
      metrics.stuckByEngine.antigravity = 7;
      file.agentStateMetrics.current = metrics;
      return true;
    });
    expect(readAgentStateMetrics(registry).stuckByEngine.antigravity).toBe(7);
    expect(readAgentStatePage(registry, "agentStateMetrics", "", 32).rows.some(row => row !== null && "stuckByEngine" in row && row.stuckByEngine.antigravity === 7)).toBe(true);
    const persisted = mode === "sqlite"
      ? (() => {
        const db = new Database(f.sqliteFilename, { readonly: true });
        try { return JSON.parse(db.query<{ value_json: string }, [string]>("SELECT value_json FROM registry_rows WHERE collection='agentStateMetrics' AND row_key=?").get("current")!.value_json); }
        finally { db.close(); }
      })()
      : JSON.parse(fs.readFileSync(path.join(f.root, "registry.json"), "utf8")).agentStateMetrics.current;
    expect(validAgentStateMetricsBeforeAntigravity(persisted)).toBe(true);
    expect(persisted.stuckByEngine).toEqual({ codex: 0, claude: 0, copilot: 0 });
    expect(Object.keys(persisted)).toHaveLength(Object.keys(emptyAgentStateMetrics()).length);
    registry.close();
  }
});

test("metrics reject malformed engine buckets and keep reason buckets required", () => {
  for (const stuckByEngine of [null, [], { codex: null }, { codex: undefined },
    { antigravity: "0" }, { copilot: -1 }, { claude: 0.5 }, { obsolete: 0 }]) {
    const row = { ...preAntigravityMetrics, stuckByEngine };
    expect(validAgentStateMetrics(row)).toBe(false);
    expect(() => normalizeAgentStateRows({ current: row }, "metrics")).toThrow("invalid agent-state row");
  }
  expect(validAgentStateMetrics({ ...preAntigravityMetrics, stuckByEngine: {}, stuckByReason: { silent: 0 } })).toBe(false);
});

test("SQLite reads pre-Antigravity metrics without rewriting history and persists rollback-compatible metrics", async () => {
  const f = fixture("sqlite"), registry = f.open();
  registry.readOnlySnapshot();
  const db = new Database(f.sqliteFilename);
  try {
    const legacy = JSON.stringify(preAntigravityMetrics);
    const insert = db.query("INSERT INTO registry_rows (collection, row_key, value_json, row_order) VALUES ('agentStateMetrics', ?, ?, ?)");
    insert.run("current", legacy, 1);
    insert.run("series:fixture", legacy, 2);
    const raw = db.query<{ value_json: string }, [string]>("SELECT value_json FROM registry_rows WHERE collection='agentStateMetrics' AND row_key=?");
    const expected = { ...preAntigravityMetrics, stuckByEngine: { ...preAntigravityMetrics.stuckByEngine, antigravity: 0 } };
    expect(readAgentStateMetrics(registry)).toEqual(expected);
    expect(readAgentStatePage(registry, "agentStateMetrics", "current").rows).toEqual([expected]);
    expect(raw.get("current")?.value_json).toBe(legacy);
    expect(raw.get("series:fixture")?.value_json).toBe(legacy);

    await f.service(registry).request();
    const persistedCurrent = JSON.parse(raw.get("current")!.value_json);
    expect(validAgentStateMetricsBeforeAntigravity(persistedCurrent)).toBe(true);
    expect(persistedCurrent.stuckByEngine).toEqual({ codex: 2, claude: 0, copilot: 1 });
    expect(raw.get("series:fixture")?.value_json).toBe(legacy);
  } finally { db.close(); }
});
