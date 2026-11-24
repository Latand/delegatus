import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { validAgentFacts } from "./model";
import { antigravityTurnState, turnStateFromRecords } from "./nativeTurnState";
import { observeAgentProcess } from "./process";
import { clearAgentObservations } from "./projectionCache";
import { AgentStateService } from "./service";
import { readAgentProjection, readAgentStateMetrics, readAgentStatePage, readAgentStatesPage, subjectId } from "./store";
import { FIXTURE_NOW, FIXTURE_SESSION, fixtureRecords, fixtureRegistry } from "./testFixture";
import { foldNativeBoundaries, readNativePromptAnchor } from "./transcript";

const roots: string[] = [];
const registries: AgentRegistry[] = [];

afterEach(() => {
  clearAgentObservations();
  for (const registry of registries.splice(0)) registry.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Antigravity agentState integration", () => {
  it("classifies Antigravity NDJSON records across busy and terminal states", () => {
    expect(antigravityTurnState([
      { type: "session.start", timestamp: "2026-11-23T00:00:00.000Z", data: { sessionId: "s1" } },
    ]).state).toBe("unknown");

    expect(turnStateFromRecords([
      { type: "user.message", timestamp: "2026-11-23T00:00:01.000Z", data: { entryId: "e1" } },
      { type: "assistant.turn_start", timestamp: "2026-11-23T00:00:01.100Z", data: { turnId: "t1" } },
    ], "antigravity").state).toBe("busy");

    expect(turnStateFromRecords([
      { type: "user.message", timestamp: "2026-11-23T00:00:01.000Z", data: { entryId: "e1" } },
      { type: "tool.execution_start", timestamp: "2026-11-23T00:00:02.000Z", data: { toolCallId: "tc1" } },
      { type: "tool.execution_complete", timestamp: "2026-11-23T00:00:03.000Z", data: { toolCallId: "tc1" } },
    ], "antigravity").state).toBe("busy");

    for (const terminalType of ["assistant.turn_end", "abort", "session.error", "session.quota_exhausted", "session.shutdown"] as const) {
      const verdict = turnStateFromRecords([
        { type: "user.message", timestamp: "2026-11-23T00:00:01.000Z", data: { entryId: "e1" } },
        { type: terminalType, timestamp: "2026-11-23T00:00:05.000Z", data: {} },
      ], "antigravity");
      expect(verdict.state).toBe("terminal");
    }
  });

  it("tracks promptOrdinal in foldNativeBoundaries and projects antigravity AgentFacts through AgentStateService", async () => {
    const folded = foldNativeBoundaries([
      { kind: "start", type: "user.message", id: "u1", at: 1000 },
      { kind: "continue", type: "assistant.turn_start", id: null, at: 1100 },
      { kind: "terminal", type: "assistant.turn_end", id: null, at: 2000, outcome: "completed" },
      { kind: "start", type: "user.message", id: "u2", at: 3000 },
      { kind: "terminal", type: "abort", id: null, at: 3500, outcome: "interrupted" },
    ], "antigravity", "antigravity:2-abcd");
    expect(folded).toMatchObject({
      state: "closed",
      opening: "user.message",
      closing: "abort",
      promptOrdinal: 2,
      outcome: "interrupted",
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-state-"));
    roots.push(root);
    const filename = path.join(root, "registry.json");
    fs.writeFileSync(filename, JSON.stringify(fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null)));
    const records = fixtureRecords("antigravity");
    const transcript = path.join(root, "native.jsonl");
    fs.writeFileSync(transcript, [...records.open, ...records.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const anchor = await readNativePromptAnchor(transcript, true);
    expect(anchor).not.toBeNull();

    const registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: path.join(root, "registry.sqlite"),
    });
    registries.push(registry);

    const service = new AgentStateService({
      registry,
      now: () => FIXTURE_NOW + 2000,
      owns: () => true,
      process: observeAgentProcess,
      memory: () => null,
      release: "fixture",
      publish: async () => true,
    });
    await service.request();

    const entry = registry.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
    const projection = readAgentProjection(registry, subjectId(entry));
    expect(projection).not.toBeNull();
    expect(validAgentFacts(projection!.facts)).toBe(true);
    expect(validAgentFacts({ ...projection!.facts, engine: "unknown-engine" })).toBe(false);
    expect(projection!.facts.engine).toBe("antigravity");
    expect(projection!.facts.turn).toMatchObject({
      determined: true,
      value: { state: "closed", promptOrdinal: 1 },
    });

    // Rollback compatibility: the shared SQLite `agentStates` collection and JSON
    // snapshot MUST NEVER hold `facts.engine === "antigravity"` rows (which prior
    // releases reject with `invalid agent-state row`), `agentStateMetrics` MUST
    // keep the 3-engine `stuckByEngine` shape, and Antigravity projections MUST
    // live inside the dedicated `registry_antigravity_agent_states` table in the
    // same SQLite database (no separate sidecar file).
    expect(fs.existsSync(path.join(root, "antigravity-agent-states.json"))).toBe(false);
    const { Database } = await import("bun:sqlite");
    const db = new Database(path.join(root, "registry.sqlite"), { readonly: true });
    try {
      const rawStates = db.query<{ value_json: string }, []>(
        "SELECT value_json FROM registry_rows WHERE collection = 'agentStates'",
      ).all();
      expect(rawStates.every((row) => (JSON.parse(row.value_json) as { facts?: { engine?: string } }).facts?.engine !== "antigravity")).toBe(true);
      const agRows = db.query<{ subject: string }, []>(
        "SELECT subject FROM registry_antigravity_agent_states",
      ).all();
      expect(agRows.map((row) => row.subject)).toEqual([subjectId(entry)]);
      const rawMetrics = db.query<{ value_json: string }, []>(
        "SELECT value_json FROM registry_rows WHERE collection = 'agentStateMetrics' AND row_key = 'current'",
      ).get();
      expect(rawMetrics).not.toBeNull();
      const parsedMetrics = JSON.parse(rawMetrics!.value_json) as { stuckByEngine: Record<string, number> };
      expect(Object.keys(parsedMetrics.stuckByEngine).sort()).toEqual(["claude", "codex", "copilot"]);
    } finally {
      db.close();
    }
    const exported = await registry.prepareReadOnlySnapshot();
    expect(Object.values(exported.agentStates).some((row) => row.facts.engine === "antigravity")).toBe(false);

    const reader = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: path.join(root, "registry.sqlite"),
    });
    registries.push(reader);
    expect(readAgentProjection(reader, subjectId(entry))?.facts.engine).toBe("antigravity");
  });

  it("commits Antigravity projection, journal, and metrics in one SQLite transaction and rolls back atomically on write failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-atomic-"));
    roots.push(root);
    const filename = path.join(root, "agent-registry.json");
    const sqliteFilename = path.join(root, "registry.sqlite");
    fs.writeFileSync(filename, JSON.stringify(fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null)));
    const rows = fixtureRecords("antigravity");
    fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename,
    });
    registries.push(registry);
    const makeService = () => new AgentStateService({
      registry,
      now: () => FIXTURE_NOW + 2000,
      owns: () => true,
      process: observeAgentProcess,
      memory: () => null,
      release: "fixture",
      publish: async () => true,
    });
    const snapshotCounts = () => {
      const file = registry.snapshot();
      const metrics = file.agentStateMetrics.current;
      const entry = registry.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
      return {
        projected: readAgentProjection(registry, subjectId(entry)) !== null,
        subjects: metrics?.subjectsObserved ?? 0,
        journal: Object.keys(file.agentStateJournal).length,
      };
    };

    // Inject a failure during the Antigravity projection write inside the SQLite transaction.
    const { Database } = await import("bun:sqlite");
    const faultDb = new Database(sqliteFilename);
    try {
      faultDb.exec(`
        CREATE TABLE IF NOT EXISTS registry_antigravity_agent_states (
          subject TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );
        CREATE TRIGGER fail_ag_state_insert
        BEFORE INSERT ON registry_antigravity_agent_states
        BEGIN
          SELECT RAISE(ABORT, 'synthetic EIO on antigravity projection');
        END;
      `);
    } finally {
      faultDb.close();
    }

    // AgentStateService catches per-subject persistence errors and defers the subject;
    // the single SQLite transaction MUST roll back journal, metrics, and projection together.
    await makeService().request();
    expect(snapshotCounts()).toEqual({ projected: false, subjects: 0, journal: 0 });
    expect(fs.existsSync(path.join(root, "antigravity-agent-states.json"))).toBe(false);

    // Clear the injected write fault and retry: accounting MUST commit exactly once.
    const healDb = new Database(sqliteFilename);
    try {
      healDb.exec("DROP TRIGGER fail_ag_state_insert");
    } finally {
      healDb.close();
    }
    await makeService().request();
    expect(snapshotCounts()).toEqual({ projected: true, subjects: 1, journal: 1 });
    expect(fs.existsSync(path.join(root, "antigravity-agent-states.json"))).toBe(false);
  });

  it("keeps host-retirement-cursor.json strictly v1 legacy-valid after sweeping an Antigravity host", async () => {
    const { normalizeRegistry } = await import("@/lib/agent/registry");
    const { runStructuredHostRetirementSweep } = await import("@/lib/runtime/structuredHostRetirement");
    const prevState = process.env.LLV_STATE_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-cursor-"));
    roots.push(root);
    process.env.LLV_STATE_DIR = root;
    try {
      const seed = fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null);
      const file = normalizeRegistry(seed);
      const sweepOpts = {
        snapshot: () => file,
        publicationState: () => "ready" as const,
        owned: () => true,
        record: () => {},
        handoffRows: () => ({ determined: true as const, value: [] }),
        pidAlive: () => ({ determined: false as const, why: "fixture" }),
        ownerProcess: () => "unverified" as const,
        processIdentity: () => ({ determined: false as const, why: "fixture" }),
        reconcileGone: async () => ({ status: "changed" as const, reason: "fixture" }),
        terminate: async () => { throw new Error("unexpected terminate"); },
      };

      const report1 = await runStructuredHostRetirementSweep(sweepOpts);
      expect(report1.progress?.afterKey).toBe(`antigravity:${FIXTURE_SESSION}`);
      const v1Path = path.join(root, "host-retirement-cursor.json");
      const v2Path = path.join(root, "host-retirement-cursor-v2.json");
      const v1 = JSON.parse(fs.readFileSync(v1Path, "utf8")) as { version: number; afterKey: string | null };
      // Strict legacy 3-engine v1 validator accepts `{ version: 1, afterKey: null }` cleanly on rollback.
      expect(v1).toEqual({ version: 1, afterKey: null });
      const v2 = JSON.parse(fs.readFileSync(v2Path, "utf8")) as { version: number; afterKey: string };
      expect(v2.version).toBe(2);
      expect(v2.afterKey).toBe(`antigravity:${FIXTURE_SESSION}`);

      // Next candidate sweep resumes from the v2 Antigravity cursor.
      const report2 = await runStructuredHostRetirementSweep(sweepOpts);
      expect(report2.progress?.beforeKey).toBe(`antigravity:${FIXTURE_SESSION}`);

      // If a rolled-back prior release writes a legacy Claude cursor to v1, candidate follows v1.
      const claudeKey = `claude:${FIXTURE_SESSION}`;
      fs.writeFileSync(v1Path, `${JSON.stringify({ version: 1, afterKey: claudeKey })}\n`);
      const report3 = await runStructuredHostRetirementSweep(sweepOpts);
      expect(report3.progress?.beforeKey).toBe(claudeKey);
    } finally {
      if (prevState === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = prevState;
    }
  });

  it("persists Antigravity projections across reopen in sqlite, dual-write, and off modes without double accounting", async () => {
    for (const mode of ["sqlite", "dual-write", "off"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-ag-reopen-${mode}-`));
      roots.push(root);
      const filename = path.join(root, "agent-registry.json");
      const sqliteFilename = path.join(root, "registry.sqlite");
      fs.writeFileSync(filename, JSON.stringify(fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null)));
      const rows = fixtureRecords("antigravity");
      fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

      const openRegistry = () => new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode, sqliteFilename });
      const collect = async (reg: AgentRegistry) => {
        await new AgentStateService({
          registry: reg,
          now: () => FIXTURE_NOW + 2000,
          owns: () => true,
          process: observeAgentProcess,
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();
      };
      const observe = (reg: AgentRegistry) => {
        const snap = reg.snapshot();
        const entry = reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
        return {
          present: readAgentProjection(reg, subjectId(entry)) !== null,
          subjects: snap.agentStateMetrics.current?.subjectsObserved ?? 0,
          journal: Object.keys(snap.agentStateJournal).length,
        };
      };

      const firstReg = openRegistry();
      let initial: ReturnType<typeof observe>;
      try {
        await collect(firstReg);
        initial = observe(firstReg);
        expect(initial).toEqual({ present: true, subjects: 1, journal: 1 });
      } finally {
        firstReg.close();
      }
      expect(fs.existsSync(path.join(root, "antigravity-agent-states.json"))).toBe(false);

      const secondReg = openRegistry();
      try {
        expect(observe(secondReg)).toEqual(initial);
        await collect(secondReg);
        expect(observe(secondReg)).toEqual({ present: true, subjects: 1, journal: 1 });
      } finally {
        secondReg.close();
      }
    }
  });

  it("decodes O(1) Antigravity projections on subject lookup, bounded page read, and metrics cursor read", async () => {
    const { Database } = await import("bun:sqlite");
    const { readAgentStatesPage } = await import("./store");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-keyed-cost-"));
    roots.push(root);
    const filename = path.join(root, "registry.json");
    const sqliteFilename = path.join(root, "registry.sqlite");
    fs.writeFileSync(filename, JSON.stringify(fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null)));
    const rows = fixtureRecords("antigravity");
    fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const reg = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename });
    registries.push(reg);
    await new AgentStateService({
      registry: reg,
      now: () => FIXTURE_NOW + 2000,
      owns: () => true,
      process: observeAgentProcess,
      memory: () => null,
      release: "fixture",
      publish: async () => true,
    }).request();

    const entry = reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
    const saved = readAgentProjection(reg, subjectId(entry))!;
    const db = new Database(sqliteFilename);
    try {
      db.exec("BEGIN");
      db.exec("DELETE FROM registry_antigravity_agent_states");
      for (let i = 0; i < 128; i += 1) {
        const subject = i.toString(16).padStart(48, "0");
        const row = { ...saved, subject, facts: { ...saved.facts, subject }, verdict: { ...saved.verdict, subject } };
        db.query("INSERT INTO registry_antigravity_agent_states (subject, value_json) VALUES (?, ?)").run(subject, JSON.stringify(row));
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const origParse = JSON.parse;
    let parsedAntigravity = 0;
    JSON.parse = function (body: string, ...args: unknown[]) {
      const value = (origParse as (text: string, ...rest: unknown[]) => unknown).call(JSON, body, ...args);
      if ((value as { facts?: { engine?: string } } | null)?.facts?.engine === "antigravity") {
        parsedAntigravity += 1;
      }
      return value;
    } as typeof JSON.parse;
    try {
      parsedAntigravity = 0;
      const point = readAgentProjection(reg, "0".repeat(48));
      expect(point?.facts.engine).toBe("antigravity");
      expect(parsedAntigravity).toBe(1);

      parsedAntigravity = 0;
      const page = readAgentStatesPage(reg, "", 1);
      expect(page).toHaveLength(1);
      expect(parsedAntigravity).toBe(1);

      parsedAntigravity = 0;
      const cursor = reg.agentStateRead((file) => file.agentStateMetrics.maintenance?.afterKey ?? "");
      expect(typeof cursor).toBe("string");
      expect(parsedAntigravity).toBe(0);
    } finally {
      JSON.parse = origParse;
    }
  });

  it("persists Antigravity entries and generations with null accountId so legacy 3-engine rateLimit logic never throws while candidate restores accountId", async () => {
    const { Database } = await import("bun:sqlite");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-rollback-rl-"));
    roots.push(root);
    const filename = path.join(root, "agent-registry.json");
    const sqliteFilename = path.join(root, "registry.sqlite");
    const seed = fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null);
    const seedEntry = Object.values(seed.entries)[0]!;
    const seedConv = Object.values(seed.conversations)[0]!;
    seedEntry.accountId = "default";
    seedConv.generations[0]!.accountId = "default";

    for (const mode of ["sqlite", "dual-write", "off"] as const) {
      const subRoot = path.join(root, mode);
      fs.mkdirSync(subRoot, { recursive: true });
      const fn = path.join(subRoot, "agent-registry.json");
      const sq = path.join(subRoot, "registry.sqlite");
      const reg = new AgentRegistry(fn, undefined, undefined, { sqliteMode: mode, sqliteFilename: sq });
      try {
        reg.agentStateWrite((file) => {
          file.entries[`antigravity:${FIXTURE_SESSION}`] = structuredClone(seedEntry);
          file.conversations[seedConv.id] = structuredClone(seedConv);
        });
      } finally {
        reg.close();
      }

      // Candidate reopens and sees full `accountId: "default"` losslessly.
      const reopened = new AgentRegistry(fn, undefined, undefined, { sqliteMode: mode, sqliteFilename: sq });
      try {
        const snap = reopened.snapshot();
        expect(snap.entries[`antigravity:${FIXTURE_SESSION}`]?.accountId).toBe("default");
        expect(snap.conversations[seedConv.id]?.generations[0]?.accountId).toBe("default");
      } finally {
        reopened.close();
      }

      // Raw stored rows carry `accountId: null` so pre-Antigravity `rateLimit.ts`
      // (`snapshot.quotaObservations[engine][accountId]`) never indexes `"antigravity"`.
      let rawEntries: Record<string, { artifactPath: string; status: string; accountId: string | null }>;
      let rawConversations: Record<string, { id: string; engine: string; generations: Array<{ path: string; accountId: string | null }> }>;
      if (mode === "sqlite" || mode === "dual-write") {
        const db = new Database(sq, { readonly: true });
        try {
          const entryJson = db.query<{ value_json: string }, [string]>(
            "SELECT value_json FROM registry_rows WHERE collection = 'entries' AND row_key = ?",
          ).get(`antigravity:${FIXTURE_SESSION}`)!.value_json;
          const convJson = db.query<{ value_json: string }, [string]>(
            "SELECT value_json FROM registry_rows WHERE collection = 'conversations' AND row_key = ?",
          ).get(seedConv.id)!.value_json;
          rawEntries = { [`antigravity:${FIXTURE_SESSION}`]: JSON.parse(entryJson) };
          rawConversations = { [seedConv.id]: JSON.parse(convJson) };
        } finally {
          db.close();
        }
      } else {
        const rawJson = JSON.parse(fs.readFileSync(fn, "utf8")) as {
          entries: typeof rawEntries;
          conversations: typeof rawConversations;
        };
        rawEntries = rawJson.entries;
        rawConversations = rawJson.conversations;
      }

      expect(rawEntries[`antigravity:${FIXTURE_SESSION}`]?.accountId).toBeNull();
      expect(rawConversations[seedConv.id]?.generations[0]?.accountId).toBeNull();

      // Exact legacy 7bc9b9de rateLimit.ts lookup with only 3 quotaObservations groups:
      const legacyQuotaObservations: Record<string, Record<string, unknown>> = { claude: {}, codex: {}, copilot: {} };
      const hosts = new Map<string, { engine: string; accountId: string | null }>();
      for (const conv of Object.values(rawConversations)) {
        if (conv.engine === "copilot") continue;
        for (const gen of conv.generations) {
          hosts.set(gen.path, { engine: conv.engine, accountId: gen.accountId });
        }
      }
      const activeEntries = new Map<string, { engine: string; accountId: string }>();
      for (const entry of Object.values(rawEntries)) {
        const host = hosts.get(entry.artifactPath);
        if (!host || !entry.accountId) continue;
        activeEntries.set(entry.artifactPath, { engine: host.engine, accountId: entry.accountId });
      }
      const artifactPath = seedEntry.artifactPath;
      const host = hosts.get(artifactPath);
      const activeEntry = activeEntries.get(artifactPath);
      const accountId = activeEntry?.accountId ?? host?.accountId ?? null;
      const engine = activeEntry?.engine ?? host?.engine;
      expect(() => (engine && accountId ? legacyQuotaObservations[engine]![accountId] : undefined)).not.toThrow();
      expect(accountId).toBeNull();
    }
  });

  it("idempotently migrates historical pre-fix Antigravity entries and generations on open across sqlite, dual-write, and off modes", async () => {
    const { Database } = await import("bun:sqlite");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-hist-mig-"));
    roots.push(root);
    const seed = fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null);
    const seedEntry = Object.values(seed.entries)[0]!;
    const seedConv = Object.values(seed.conversations)[0]!;
    seedEntry.accountId = "default";
    seedConv.generations[0]!.accountId = "default";
    const entryKey = `antigravity:${FIXTURE_SESSION}`;

    // 1. SQLite DB created by an earlier candidate head (raw rows still hold accountId="default").
    {
      const sqDir = path.join(root, "sqlite");
      fs.mkdirSync(sqDir, { recursive: true });
      const fn = path.join(sqDir, "agent-registry.json");
      const sq = path.join(sqDir, "agent-registry.sqlite");
      // Bootstrap valid SQLite schema first, then overwrite raw rows with historical accountId="default".
      const bootstrap = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sq });
      bootstrap.agentStateWrite((file) => {
        file.entries[entryKey] = structuredClone(seedEntry);
        file.conversations[seedConv.id] = structuredClone(seedConv);
      });
      bootstrap.close();

      const legacyDb = new Database(sq);
      try {
        const curEntry = JSON.parse(legacyDb.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection = 'entries' AND row_key = ?",
        ).get(entryKey)!.value_json) as Record<string, unknown>;
        curEntry.accountId = "default";
        delete curEntry.antigravityAccountId;
        const curConv = JSON.parse(legacyDb.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection = 'conversations' AND row_key = ?",
        ).get(seedConv.id)!.value_json) as { generations: Array<Record<string, unknown>> };
        curConv.generations[0]!.accountId = "default";
        delete curConv.generations[0]!.antigravityAccountId;
        legacyDb.query("UPDATE registry_rows SET value_json = ? WHERE collection = 'entries' AND row_key = ?").run(JSON.stringify(curEntry), entryKey);
        legacyDb.query("UPDATE registry_rows SET value_json = ? WHERE collection = 'conversations' AND row_key = ?").run(JSON.stringify(curConv), seedConv.id);
      } finally {
        legacyDb.close();
      }

      // Opening the registry MUST migrate both historical rows automatically without mutating them.
      const reg1 = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sq });
      try {
        expect(reg1.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })?.accountId).toBe("default");
        expect(reg1.conversation(seedConv.id)?.generations[0]?.accountId).toBe("default");
      } finally {
        reg1.close();
      }

      const inspectDb = new Database(sq, { readonly: true });
      let revAfterFirstOpen: number;
      try {
        const rawEntry = JSON.parse(inspectDb.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection = 'entries' AND row_key = ?",
        ).get(entryKey)!.value_json) as { accountId: string | null; antigravityAccountId?: string };
        const rawConv = JSON.parse(inspectDb.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection = 'conversations' AND row_key = ?",
        ).get(seedConv.id)!.value_json) as { generations: Array<{ accountId: string | null; antigravityAccountId?: string }> };
        expect(rawEntry.accountId).toBeNull();
        expect(rawEntry.antigravityAccountId).toBe("default");
        expect(rawConv.generations[0]?.accountId).toBeNull();
        expect(rawConv.generations[0]?.antigravityAccountId).toBe("default");
        revAfterFirstOpen = Number(inspectDb.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key = 'revision'").get()!.value);
      } finally {
        inspectDb.close();
      }

      // Second open MUST be a no-op (idempotent, zero revision bump).
      const reg2 = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sq });
      reg2.close();
      const checkDb = new Database(sq, { readonly: true });
      try {
        expect(Number(checkDb.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key = 'revision'").get()!.value)).toBe(revAfterFirstOpen);
      } finally {
        checkDb.close();
      }
    }

    // 2. JSON-backed `off` mode: legacy JSON with accountId="default" is migrated on open.
    {
      const offDir = path.join(root, "off");
      fs.mkdirSync(offDir, { recursive: true });
      const fn = path.join(offDir, "agent-registry.json");
      fs.writeFileSync(fn, JSON.stringify(seed));
      const reg = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      try {
        expect(reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })?.accountId).toBe("default");
        expect(reg.conversation(seedConv.id)?.generations[0]?.accountId).toBe("default");
      } finally {
        reg.close();
      }
      const raw = JSON.parse(fs.readFileSync(fn, "utf8")) as {
        entries: Record<string, { accountId: string | null; antigravityAccountId?: string }>;
        conversations: Record<string, { generations: Array<{ accountId: string | null; antigravityAccountId?: string }> }>;
      };
      expect(raw.entries[entryKey]?.accountId).toBeNull();
      expect(raw.entries[entryKey]?.antigravityAccountId).toBe("default");
      expect(raw.conversations[seedConv.id]?.generations[0]?.accountId).toBeNull();
      expect(raw.conversations[seedConv.id]?.generations[0]?.antigravityAccountId).toBe("default");
    }

    // 3. `dual-write` mode: legacy SQLite + JSON with accountId="default" both migrate on open.
    {
      const dwDir = path.join(root, "dual-write");
      fs.mkdirSync(dwDir, { recursive: true });
      const fn = path.join(dwDir, "agent-registry.json");
      const sq = path.join(dwDir, "agent-registry.sqlite");
      fs.writeFileSync(fn, JSON.stringify(seed));
      const seededReg = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "dual-write", sqliteFilename: sq });
      seededReg.close();
      // Rewrite both JSON and SQLite back to legacy `accountId: "default"` at the same revision.
      const legacyJson = JSON.parse(fs.readFileSync(fn, "utf8")) as {
        entries: Record<string, { accountId: string | null; antigravityAccountId?: string }>;
        conversations: Record<string, { generations: Array<{ accountId: string | null; antigravityAccountId?: string }> }>;
      };
      legacyJson.entries[entryKey]!.accountId = "default";
      delete legacyJson.entries[entryKey]!.antigravityAccountId;
      legacyJson.conversations[seedConv.id]!.generations[0]!.accountId = "default";
      delete legacyJson.conversations[seedConv.id]!.generations[0]!.antigravityAccountId;
      fs.writeFileSync(fn, `${JSON.stringify(legacyJson)}\n`);
      const db = new Database(sq);
      try {
        db.query("UPDATE registry_rows SET value_json = ? WHERE collection = 'entries' AND row_key = ?")
          .run(JSON.stringify(legacyJson.entries[entryKey]), entryKey);
        db.query("UPDATE registry_rows SET value_json = ? WHERE collection = 'conversations' AND row_key = ?")
          .run(JSON.stringify(legacyJson.conversations[seedConv.id]), seedConv.id);
      } finally {
        db.close();
      }
      const reg = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "dual-write", sqliteFilename: sq });
      try {
        expect(reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })?.accountId).toBe("default");
        expect(reg.conversation(seedConv.id)?.generations[0]?.accountId).toBe("default");
      } finally {
        reg.close();
      }
      const rawJson = JSON.parse(fs.readFileSync(fn, "utf8")) as {
        entries: Record<string, { accountId: string | null; antigravityAccountId?: string }>;
        conversations: Record<string, { generations: Array<{ accountId: string | null; antigravityAccountId?: string }> }>;
      };
      expect(rawJson.entries[entryKey]?.accountId).toBeNull();
      expect(rawJson.entries[entryKey]?.antigravityAccountId).toBe("default");
      expect(rawJson.conversations[seedConv.id]?.generations[0]?.accountId).toBeNull();
      expect(rawJson.conversations[seedConv.id]?.generations[0]?.antigravityAccountId).toBe("default");
      const checkDb = new Database(sq, { readonly: true });
      try {
        const rawEntry = JSON.parse(checkDb.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection = 'entries' AND row_key = ?",
        ).get(entryKey)!.value_json) as { accountId: string | null; antigravityAccountId?: string };
        const rawConv = JSON.parse(checkDb.query<{ value_json: string }, [string]>(
          "SELECT value_json FROM registry_rows WHERE collection = 'conversations' AND row_key = ?",
        ).get(seedConv.id)!.value_json) as { generations: Array<{ accountId: string | null; antigravityAccountId?: string }> };
        expect(rawEntry.accountId).toBeNull();
        expect(rawEntry.antigravityAccountId).toBe("default");
        expect(rawConv.generations[0]?.accountId).toBeNull();
        expect(rawConv.generations[0]?.antigravityAccountId).toBe("default");
      } finally {
        checkDb.close();
      }
    }
  });

  it("preserves single-subject accounting across a downgrade JSON rewrite and re-upgrade in off and dual-write modes", async () => {
    for (const scenario of [
      { mode: "off" as const, stripEntryMirror: false },
      { mode: "off" as const, stripEntryMirror: true },
      { mode: "dual-write" as const, stripEntryMirror: false },
    ]) {
      const { mode, stripEntryMirror } = scenario;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-ag-json-cycle-${mode}-${stripEntryMirror ? "bare" : "mirror"}-`));
      roots.push(root);
      const fn = path.join(root, "agent-registry.json");
      const sq = path.join(root, "agent-registry.sqlite");
      fs.writeFileSync(fn, JSON.stringify(fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null)));
      const rows = fixtureRecords("antigravity");
      fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

      const measure = () => {
        const raw = JSON.parse(fs.readFileSync(fn, "utf8")) as {
          antigravityAgentStates?: Record<string, unknown>;
          agentStateMetrics?: { current?: { subjectsObserved?: number } };
          agentStateJournal?: Record<string, unknown>;
        };
        return {
          extra: Object.keys(raw.antigravityAgentStates ?? {}).length,
          subjects: raw.agentStateMetrics?.current?.subjectsObserved ?? 0,
          journal: Object.keys(raw.agentStateJournal ?? {}).length,
        };
      };
      const runService = async (reg: AgentRegistry) => {
        await new AgentStateService({
          registry: reg,
          now: () => FIXTURE_NOW + 2000,
          owns: () => true,
          process: () => "alive",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();
      };

      // Phase 1 (candidate): initial observation -> 1/1/1.
      const regUp = new AgentRegistry(fn, undefined, undefined, { sqliteMode: mode, sqliteFilename: sq });
      try {
        await runService(regUp);
        expect(measure()).toEqual({ extra: 1, subjects: 1, journal: 1 });
        // In-memory entries never leak the storage-only projection mirrors.
        const liveEntry = regUp.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION }) as unknown as Record<string, unknown>;
        expect("antigravityProjection" in liveEntry).toBe(false);
        expect("antigravityProjections" in liveEntry).toBe(false);
      } finally {
        regUp.close();
      }

      // Phase 2 (prior release rewrite): strips unknown top-level `antigravityAgentStates`
      // while keeping `agentStateMetrics`, `agentStateJournal`, SQLite's extra table
      // (in dual-write), and (for current candidate -> prior release in `off`) the
      // entry-level `antigravityProjections` mirror spread by prior `normalizeEntry`.
      const downgraded = JSON.parse(fs.readFileSync(fn, "utf8")) as {
        antigravityAgentStates?: Record<string, unknown>;
        entries?: Record<string, Record<string, unknown>>;
      };
      delete downgraded.antigravityAgentStates;
      if (stripEntryMirror && downgraded.entries) {
        for (const entry of Object.values(downgraded.entries)) {
          delete entry.antigravityProjection;
          delete entry.antigravityProjections;
        }
      }
      fs.writeFileSync(fn, `${JSON.stringify(downgraded)}\n`);
      expect(measure()).toEqual({ extra: 0, subjects: 1, journal: 1 });

      // Phase 3 (candidate again): restores projection without double-counting subjects or journal.
      const regAgain = new AgentRegistry(fn, undefined, undefined, { sqliteMode: mode, sqliteFilename: sq });
      try {
        if (!stripEntryMirror) {
          // Both `off` (via entry mirror) and `dual-write` (via SQLite table) restore
          // top-level `antigravityAgentStates` immediately on startup open.
          expect(measure()).toEqual({ extra: 1, subjects: 1, journal: 1 });
        }
        await runService(regAgain);
        expect(measure()).toEqual({ extra: 1, subjects: 1, journal: 1 });
        // Repeated pass stays 1/1/1.
        await runService(regAgain);
        expect(measure()).toEqual({ extra: 1, subjects: 1, journal: 1 });
      } finally {
        regAgain.close();
      }
    }
  });

  it("records separate subject accounting and journal entries when an Antigravity process is replaced under the same session key", async () => {
    for (const previousExits of [false, true]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-ag-pid-swap-${previousExits ? "dead" : "live"}-`));
      roots.push(root);
      const fn = path.join(root, "agent-registry.json");
      const sq = path.join(root, "agent-registry.sqlite");
      const baseIdentity = captureProcessIdentity(process.pid);
      const firstProcess = baseIdentity;
      const secondProcess = {
        ...baseIdentity,
        pid: baseIdentity.pid + 1000,
        startIdentity: `${baseIdentity.startIdentity ?? "1"}-gen-2`,
      };

      fs.writeFileSync(fn, JSON.stringify(fixtureRegistry(root, "antigravity", firstProcess, null)));
      const rows = fixtureRecords("antigravity");
      fs.writeFileSync(
        path.join(root, "native.jsonl"),
        [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n",
      );

      const reg = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sq });
      try {
        let firstAlive = true;
        let clock = FIXTURE_NOW + 2000;
        const service = new AgentStateService({
          registry: reg,
          now: () => clock,
          owns: () => true,
          process: (identity) => {
            if (identity.pid === firstProcess.pid && identity.startIdentity === firstProcess.startIdentity) {
              return firstAlive ? "alive" : "dead";
            }
            return "alive";
          },
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        });

        await service.request();
        const firstEntry = reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
        const firstSubject = subjectId(firstEntry);
        expect(readAgentStatesPage(reg, "", 16).length).toBe(1);
        expect(readAgentStateMetrics(reg).subjectsObserved).toBe(1);
        expect(readAgentStatePage(reg, "agentStateJournal", "", 16).rows.length).toBe(1);

        // Replace PID + startIdentity under the same Antigravity session key.
        if (previousExits) firstAlive = false;
        clock += 5000;
        const entryKey = `antigravity:${FIXTURE_SESSION}`;
        reg.agentStateWrite((file) => {
          const entry = file.entries[entryKey];
          if (entry?.structuredHost) {
            entry.structuredHost.process = secondProcess;
          }
        });

        await service.request();
        const secondEntry = reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
        const secondSubject = subjectId(secondEntry);
        expect(secondSubject).not.toBe(firstSubject);

        const projections = readAgentStatesPage(reg, "", 16);
        const metrics = readAgentStateMetrics(reg);
        const journalRows = readAgentStatePage(reg, "agentStateJournal", "", 16).rows as Array<{ subject?: string; from?: string | null; to?: string | null }>;

        expect(projections.map((row) => row.subject).sort()).toEqual([firstSubject, secondSubject].sort());
        expect(metrics.subjectsObserved).toBe(2);
        const secondJournalRows = journalRows.filter((row) => row.subject === secondSubject);
        expect(secondJournalRows.length).toBe(1);
        expect(secondJournalRows[0]?.from).toBeNull();
        expect(secondJournalRows[0]?.to).toBe("unowned");
        if (!previousExits) {
          expect(journalRows.length).toBe(2);
        } else {
          // First process recorded its initial observation + death transition; second process recorded its own initial observation.
          expect(journalRows.filter((row) => row.subject === firstSubject).some((row) => row.to === "dead")).toBe(true);
          expect(journalRows.length).toBeGreaterThanOrEqual(2);
        }
      } finally {
        reg.close();
      }
    }
  });

  it("recovers an unverified journaled subjectId in JSON off mode without double-counting when liveness is first confirmed, and retains all multi-generation projections", async () => {
    // 1. Exact sequence: 77b8c62e-style JSON (unverified initial observation, no entry mirror,
    //    not in `physicalSubjects`) -> 9ff79a35 rewrite drops `antigravityAgentStates` ->
    //    candidate confirms liveness for the first time -> subjectsObserved stays 1,
    //    subjectsUnverified transitions 1 -> 0, journal has 2 rows for that exact subjectId.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-unverified-recover-"));
      roots.push(root);
      const fn = path.join(root, "agent-registry.json");
      fs.writeFileSync(fn, JSON.stringify(fixtureRegistry(root, "antigravity", captureProcessIdentity(process.pid), null)));
      const rows = fixtureRecords("antigravity");
      fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

      const regSeed = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      let id = "";
      try {
        id = subjectId(regSeed.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!);
        await new AgentStateService({
          registry: regSeed,
          now: () => FIXTURE_NOW + 1000,
          owns: () => true,
          process: () => "unverified",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();
        const seededMetrics = readAgentStateMetrics(regSeed);
        expect(seededMetrics.subjectsObserved).toBe(1);
        expect(seededMetrics.subjectsUnverified).toBe(1);
      } finally {
        regSeed.close();
      }

      // Simulate `77b8c62e -> 9ff79a35`: drop both top-level `antigravityAgentStates` and entry mirrors.
      const rewritten = JSON.parse(fs.readFileSync(fn, "utf8")) as {
        antigravityAgentStates?: Record<string, unknown>;
        entries?: Record<string, Record<string, unknown>>;
        agentStateMetrics?: Record<string, { physicalSubjects?: string[] }>;
      };
      delete rewritten.antigravityAgentStates;
      for (const entry of Object.values(rewritten.entries ?? {})) {
        delete entry.antigravityProjection;
        delete entry.antigravityProjections;
      }
      // Confirm the unverified subject was indeed absent from `physicalSubjects`.
      expect(Object.values(rewritten.agentStateMetrics ?? {}).some((m) => m.physicalSubjects?.includes(id))).toBe(false);
      fs.writeFileSync(fn, `${JSON.stringify(rewritten)}\n`);

      const regRecover = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      try {
        expect(readAgentProjection(regRecover, id)).toBeNull();
        await new AgentStateService({
          registry: regRecover,
          now: () => FIXTURE_NOW + 3000,
          owns: () => true,
          process: () => "alive",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();

        const recovered = readAgentProjection(regRecover, id);
        expect(recovered).not.toBeNull();
        expect(recovered?.verdict.state).toBe("unowned");
        const metrics = readAgentStateMetrics(regRecover);
        expect(metrics.subjectsObserved).toBe(1);
        expect(metrics.subjectsUnverified).toBe(0);
        const matchingJournal = (readAgentStatePage(regRecover, "agentStateJournal", "", 16).rows as Array<{ subject?: string; from?: string | null; to?: string | null }>)
          .filter((row) => row.subject === id);
        expect(matchingJournal).toHaveLength(2);
        expect(matchingJournal.map((row) => [row.from, row.to])).toEqual([[null, null], [null, "unowned"]]);
      } finally {
        regRecover.close();
      }
    }

    // 2. Multiple retained process generations under one session key in `off` mode:
    //    all 3 projections survive a prior-release JSON rewrite via `entries[key].antigravityProjections`
    //    and re-observing the first identity keeps subjectsObserved === 3 (never 4).
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-retained-3gen-off-"));
      roots.push(root);
      const fn = path.join(root, "agent-registry.json");
      const base = captureProcessIdentity(process.pid);
      const gens = [
        base,
        { ...base, pid: base.pid + 1001, startIdentity: `${base.startIdentity ?? "1"}-g2` },
        { ...base, pid: base.pid + 1002, startIdentity: `${base.startIdentity ?? "1"}-g3` },
      ];
      fs.writeFileSync(fn, JSON.stringify(fixtureRegistry(root, "antigravity", gens[0]!, null)));
      const rows = fixtureRecords("antigravity");
      fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

      const entryKey = `antigravity:${FIXTURE_SESSION}`;
      const regUp = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      try {
        for (const [idx, proc] of gens.entries()) {
          if (idx > 0) {
            regUp.agentStateWrite((file) => {
              if (file.entries[entryKey]?.structuredHost) file.entries[entryKey]!.structuredHost!.process = proc;
            });
          }
          await new AgentStateService({
            registry: regUp,
            now: () => FIXTURE_NOW + 1000 + idx * 1000,
            owns: () => true,
            process: () => "alive",
            memory: () => null,
            release: "fixture",
            publish: async () => true,
          }).request();
        }
        expect(readAgentStatesPage(regUp, "", 16)).toHaveLength(3);
        expect(readAgentStateMetrics(regUp).subjectsObserved).toBe(3);
      } finally {
        regUp.close();
      }

      // Prior release drops top-level `antigravityAgentStates`, preserving `entries[entryKey].antigravityProjections`.
      const downgraded = JSON.parse(fs.readFileSync(fn, "utf8")) as Record<string, unknown>;
      delete downgraded.antigravityAgentStates;
      fs.writeFileSync(fn, `${JSON.stringify(downgraded)}\n`);

      const regBack = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      try {
        expect(readAgentStatesPage(regBack, "", 16)).toHaveLength(3);
        expect(readAgentStateMetrics(regBack).subjectsObserved).toBe(3);
        // Re-observe first identity: stays 3 projections / 3 subjectsObserved.
        regBack.agentStateWrite((file) => {
          if (file.entries[entryKey]?.structuredHost) file.entries[entryKey]!.structuredHost!.process = gens[0]!;
        });
        await new AgentStateService({
          registry: regBack,
          now: () => FIXTURE_NOW + 9000,
          owns: () => true,
          process: () => "alive",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();
        expect(readAgentStatesPage(regBack, "", 16)).toHaveLength(3);
        expect(readAgentStateMetrics(regBack).subjectsObserved).toBe(3);
      } finally {
        regBack.close();
      }
    }
  });

  it("looks up Antigravity journal history in O(1) via indexed SQLite query and per-subject JSON index even with 12,000 foreign journal rows", async () => {
    const { Database } = await import("bun:sqlite");
    const { registryLatestAgentStateJournalBySubject } = await import("@/lib/agent/sqliteRegistryStore");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-journal-12k-"));
    roots.push(root);
    const fn = path.join(root, "agent-registry.json");
    const sq = path.join(root, "agent-registry.sqlite");
    const proc = captureProcessIdentity(process.pid);
    fs.writeFileSync(fn, JSON.stringify(fixtureRegistry(root, "antigravity", proc, null)));
    const rows = fixtureRecords("antigravity");
    fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const reg = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sq });
    const entry = reg.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!;
    const targetSubject = subjectId(entry);
    reg.close();

    // Seed 12,000 foreign journal rows directly into SQLite `registry_rows`.
    const foreignCount = 12_000;
    const db = new Database(sq);
    try {
      const plan = db.query<{ detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT row_key, value_json FROM registry_rows
        WHERE collection='agentStateJournal' AND json_extract(value_json,'$.subject')=?
        ORDER BY json_extract(value_json,'$.at') DESC, row_order DESC
        LIMIT 1
      `).all(targetSubject);
      expect(plan.some((step) => step.detail.includes("registry_agent_state_journal_subject_order"))).toBe(true);
      expect(plan.some((step) => /TEMP B-TREE/i.test(step.detail))).toBe(false);

      const insert = db.query(
        "INSERT INTO registry_rows (collection, row_key, value_json, row_order) VALUES ('agentStateJournal', ?, ?, ?)",
      );
      db.exec("BEGIN");
      for (let i = 0; i < foreignCount; i += 1) {
        const key = `${String(1_700_000_000_000 + i).padStart(16, "0")}:foreign-${i}`;
        const foreignSubj = `f${i.toString(16).padStart(47, "0")}`;
        const payload = JSON.stringify({
          version: 1,
          id: key,
          at: 1_700_000_000_000 + i,
          subject: foreignSubj,
          entryKey: `claude:foreign-${i}`,
          conversationId: `conversation_foreign_${i}`,
          from: null,
          to: "idle",
          reason: "seeded foreign journal row",
          effectiveAt: null,
          fromTurn: { state: null, nativeId: null, cacheRef: null },
          toTurn: { state: "absent", nativeId: null, cacheRef: null },
          divergence: null,
          evidence: [],
        });
        insert.run(key, payload, i);
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const regHot = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sq });
    const origParse = JSON.parse;
    let foreignJournalParses = 0;
    let targetJournalParses = 0;
    JSON.parse = function (body: string, ...args: unknown[]) {
      const parsed = (origParse as (text: string, ...rest: unknown[]) => unknown).call(JSON, body, ...args) as
        | { subject?: string; entryKey?: string; id?: string }
        | null;
      if (parsed && typeof parsed.id === "string" && typeof parsed.subject === "string" && typeof parsed.entryKey === "string") {
        if (parsed.subject === targetSubject) targetJournalParses += 1;
        else if (parsed.id.includes(":foreign-")) foreignJournalParses += 1;
      }
      return parsed;
    } as typeof JSON.parse;
    try {
      // 1. Point lookup inside a write transaction decodes ZERO foreign journal rows across 12,000 rows.
      foreignJournalParses = 0;
      targetJournalParses = 0;
      const unseenLookup = regHot.agentStateWrite((file) => registryLatestAgentStateJournalBySubject(file, targetSubject));
      expect(unseenLookup).toBeUndefined();
      expect(foreignJournalParses).toBe(0);
      expect(targetJournalParses).toBe(0);

      // 2. Full `AgentStateService.request()` for a brand-new Antigravity process never walks all 12,000 rows
      //    (bounded maintenance reads at most one page of 256 rows; `commitAgentObservation` decodes 0 foreign rows).
      foreignJournalParses = 0;
      targetJournalParses = 0;
      await new AgentStateService({
        registry: regHot,
        now: () => FIXTURE_NOW + 2000,
        owns: () => true,
        process: () => "alive",
        memory: () => null,
        release: "fixture",
        publish: async () => true,
      }).request();
      expect(foreignJournalParses).toBeLessThanOrEqual(256);
      expect(readAgentProjection(regHot, targetSubject)).not.toBeNull();
      expect(readAgentStateMetrics(regHot).subjectsObserved).toBe(1);

      // 3. Drop the projection row while keeping its journal row + 12,000 foreign rows:
      //    point lookup decodes ONLY that exact subject's newest journal row (0 foreign decodes),
      //    and `AgentStateService.request()` recovers without double-counting.
      const dbDrop = new Database(sq);
      try {
        dbDrop.query("DELETE FROM registry_antigravity_agent_states WHERE subject = ?").run(targetSubject);
      } finally {
        dbDrop.close();
      }
      foreignJournalParses = 0;
      targetJournalParses = 0;
      const seenLookup = regHot.agentStateWrite((file) => registryLatestAgentStateJournalBySubject(file, targetSubject));
      expect(seenLookup?.subject).toBe(targetSubject);
      expect(foreignJournalParses).toBe(0);
      expect(targetJournalParses).toBe(1);

      foreignJournalParses = 0;
      targetJournalParses = 0;
      await new AgentStateService({
        registry: regHot,
        now: () => FIXTURE_NOW + 4000,
        owns: () => true,
        process: () => "alive",
        memory: () => null,
        release: "fixture",
        publish: async () => true,
      }).request();
      expect(foreignJournalParses).toBeLessThanOrEqual(256);
      expect(targetJournalParses).toBeLessThanOrEqual(1);
      expect(readAgentProjection(regHot, targetSubject)).not.toBeNull();
      expect(readAgentStateMetrics(regHot).subjectsObserved).toBe(1);
    } finally {
      JSON.parse = origParse;
      regHot.close();
    }

    // 3. JSON `off` mode builds the per-subject journal index once on load and
    //    never walks `Object.values(file.agentStateJournal)` on hot lookups.
    const jsonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-journal-json-idx-"));
    roots.push(jsonRoot);
    const jsonFn = path.join(jsonRoot, "agent-registry.json");
    const jsonSeed = fixtureRegistry(jsonRoot, "antigravity", proc, null) as unknown as {
      agentStateJournal: Record<string, unknown>;
    };
    jsonSeed.agentStateJournal = {};
    for (let i = 0; i < 500; i += 1) {
      const key = `${String(1_700_000_000_000 + i).padStart(16, "0")}:j-${i}`;
      jsonSeed.agentStateJournal[key] = {
        version: 1,
        id: key,
        at: 1_700_000_000_000 + i,
        subject: `e${i.toString(16).padStart(47, "0")}`,
        entryKey: `claude:j-${i}`,
        conversationId: `conversation_j_${i}`,
        from: null,
        to: "idle",
        reason: "seeded json row",
        effectiveAt: null,
        fromTurn: { state: null, nativeId: null, cacheRef: null },
        toTurn: { state: "absent", nativeId: null, cacheRef: null },
        divergence: null,
        evidence: [],
      };
    }
    fs.writeFileSync(jsonFn, JSON.stringify(jsonSeed));
    const jsonReg = new AgentRegistry(jsonFn, undefined, undefined, { sqliteMode: "off" });
    try {
      jsonReg.agentStateRead((file) => {
        let ownKeysCalls = 0;
        const origValues = Object.values;
        Object.values = function (obj: unknown) {
          if (obj === file.agentStateJournal) ownKeysCalls += 1;
          return origValues(obj as Record<string, unknown>);
        } as typeof Object.values;
        try {
          expect(registryLatestAgentStateJournalBySubject(file, targetSubject)).toBeUndefined();
          expect(registryLatestAgentStateJournalBySubject(file, `e${(499).toString(16).padStart(47, "0")}`)?.id).toContain(":j-499");
          expect(ownKeysCalls).toBe(0);
        } finally {
          Object.values = origValues;
        }
      });
    } finally {
      jsonReg.close();
    }
  });

  it("preserves write order on equal-millisecond journal transitions in JSON downgrade recovery and SQLite row_order lookups", async () => {
    const { Database } = await import("bun:sqlite");
    const { registryLatestAgentStateJournalBySubject } = await import("@/lib/agent/sqliteRegistryStore");
    const baseProc = captureProcessIdentity(process.pid);
    let sawSmallerSecondId = false;

    // 1. JSON `off` mode: 8 distinct subjects each record two transitions at the
    //    EXACT same millisecond (alive/unowned -> unverified), then a prior release
    //    rewrites JSON dropping `antigravityAgentStates` & entry mirrors. Re-observing
    //    the same unverified state MUST recover 8/8 with observed=1, unverified=1,
    //    and 2 journal rows (never selecting the first transition by lexicographical id).
    for (let idx = 0; idx < 8; idx += 1) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `llv-ag-eqms-${idx}-`));
      roots.push(root);
      const fn = path.join(root, "agent-registry.json");
      const proc = {
        ...baseProc,
        pid: baseProc.pid + 5000 + idx,
        startIdentity: `${baseProc.startIdentity ?? "1"}-eq-${idx}`,
      };
      fs.writeFileSync(fn, JSON.stringify(fixtureRegistry(root, "antigravity", proc, null)));
      const rows = fixtureRecords("antigravity");
      fs.writeFileSync(path.join(root, "native.jsonl"), [...rows.open, ...rows.close].map((row) => JSON.stringify(row)).join("\n") + "\n");

      const sameMs = FIXTURE_NOW + 5000;
      const regSeed = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      let id = "";
      try {
        id = subjectId(regSeed.hostEntry({ engine: "antigravity", sessionId: FIXTURE_SESSION })!);
        // First transition at `sameMs`: confirmed alive (`to: "unowned"`).
        await new AgentStateService({
          registry: regSeed,
          now: () => sameMs,
          owns: () => true,
          process: () => "alive",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();
        // Second transition at the EXACT SAME millisecond `sameMs`: `unverified` (`to: null`).
        await new AgentStateService({
          registry: regSeed,
          now: () => sameMs,
          owns: () => true,
          process: () => "unverified",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();
        expect(readAgentStateMetrics(regSeed)).toMatchObject({ subjectsObserved: 1, subjectsUnverified: 1 });
      } finally {
        regSeed.close();
      }

      // Simulate `77b8c62e -> 9ff79a35` JSON rewrite (drops projections, preserves JSON key order).
      const rewritten = JSON.parse(fs.readFileSync(fn, "utf8")) as {
        antigravityAgentStates?: Record<string, unknown>;
        entries?: Record<string, Record<string, unknown>>;
        agentStateJournal: Record<string, { id: string; at: number; subject: string; to: string | null }>;
      };
      const seededIds = Object.keys(rewritten.agentStateJournal);
      expect(seededIds).toHaveLength(2);
      expect(rewritten.agentStateJournal[seededIds[0]!]!.at).toBe(sameMs);
      expect(rewritten.agentStateJournal[seededIds[1]!]!.at).toBe(sameMs);
      if (seededIds[1]! < seededIds[0]!) sawSmallerSecondId = true;
      delete rewritten.antigravityAgentStates;
      for (const entry of Object.values(rewritten.entries ?? {})) {
        delete entry.antigravityProjection;
        delete entry.antigravityProjections;
      }
      fs.writeFileSync(fn, `${JSON.stringify(rewritten)}\n`);

      const regRecover = new AgentRegistry(fn, undefined, undefined, { sqliteMode: "off" });
      try {
        await new AgentStateService({
          registry: regRecover,
          now: () => sameMs + 1000,
          owns: () => true,
          process: () => "unverified",
          memory: () => null,
          release: "fixture",
          publish: async () => true,
        }).request();

        const metrics = readAgentStateMetrics(regRecover);
        expect(metrics.subjectsObserved, `subject ${idx} observed`).toBe(1);
        expect(metrics.subjectsUnverified, `subject ${idx} unverified`).toBe(1);
        expect(readAgentStatePage(regRecover, "agentStateJournal", "", 16).rows, `subject ${idx} journal`).toHaveLength(2);
        expect(readAgentProjection(regRecover, id)?.verdict.state).toBeNull();
      } finally {
        regRecover.close();
      }
    }
    // Confirm our 8-subject sweep actually exercised the lexicographically inverted id case.
    expect(sawSmallerSecondId).toBe(true);

    // 2. SQLite mode: equal-`at` rows with `secondKey < firstKey` MUST resolve by
    //    `row_order DESC` (persisted) and in-transaction write order (dirty beats persisted).
    const sqRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-eqms-sqlite-"));
    roots.push(sqRoot);
    const sqFn = path.join(sqRoot, "agent-registry.json");
    const sqPath = path.join(sqRoot, "agent-registry.sqlite");
    fs.writeFileSync(sqFn, JSON.stringify(fixtureRegistry(sqRoot, "antigravity", baseProc, null)));
    const sqReg = new AgentRegistry(sqFn, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: sqPath });
    try {
      const subj = "a".repeat(48);
      const t = FIXTURE_NOW + 9000;
      const keyFirstHigherLex = `${String(t).padStart(14, "0")}:ffff-first`;
      const keySecondLowerLex = `${String(t).padStart(14, "0")}:0000-second`;
      const keyThirdLowestLex = `${String(t).padStart(14, "0")}:0000-0-third-dirty`;
      const makeRow = (id: string, to: "unowned" | null) => ({
        version: 1 as const,
        id,
        subject: subj,
        at: t,
        from: null,
        to,
        reason: to === null ? "unverified process" : "confirmed",
        divergence: null,
        writer: baseProc,
        release: "fixture",
        evidence: [],
      });

      // Persist row 1 (`ffff-first`, row_order=0) then row 2 (`0000-second`, row_order=1).
      sqReg.agentStateWrite((file) => {
        file.agentStateJournal[keyFirstHigherLex] = makeRow(keyFirstHigherLex, "unowned");
      });
      sqReg.agentStateWrite((file) => {
        file.agentStateJournal[keySecondLowerLex] = makeRow(keySecondLowerLex, null);
      });

      // Persisted SQLite lookup picks `row_order DESC` (`0000-second`, to: null).
      const persisted = sqReg.agentStateRead((file) => registryLatestAgentStateJournalBySubject(file, subj));
      expect(persisted?.id).toBe(keySecondLowerLex);
      expect(persisted?.to).toBeNull();

      // Within the same transaction, a newly appended equal-`at` dirty row with an
      // even lower lexicographical key beats the persisted SQLite row.
      const inTx = sqReg.agentStateWrite((file) => {
        file.agentStateJournal[keyThirdLowestLex] = makeRow(keyThirdLowestLex, "unowned");
        return registryLatestAgentStateJournalBySubject(file, subj);
      });
      expect(inTx?.id).toBe(keyThirdLowestLex);
      expect(inTx?.to).toBe("unowned");

      const inspectDb = new Database(sqPath, { readonly: true });
      try {
        const rows = inspectDb.query<{ row_key: string; row_order: number }, [string]>(
          "SELECT row_key, row_order FROM registry_rows WHERE collection='agentStateJournal' AND json_extract(value_json,'$.subject')=? ORDER BY row_order ASC",
        ).all(subj);
        expect(rows.map((r) => r.row_key)).toEqual([keyFirstHigherLex, keySecondLowerLex, keyThirdLowestLex]);
      } finally {
        inspectDb.close();
      }
    } finally {
      sqReg.close();
    }
  });
});
