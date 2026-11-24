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
});
