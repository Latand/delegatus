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
import { readAgentProjection, subjectId } from "./store";
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
});
