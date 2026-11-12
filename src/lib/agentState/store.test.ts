import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, normalizeRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { AgentStateService } from "./service";
import { readAgentStateMetrics, readAgentStatePage } from "./store";
import { FIXTURE_NOW, FIXTURE_SESSION, fixtureRegistry, fixtureRecords } from "./testFixture";

const roots: string[] = [], registries: AgentRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(mode: "off" | "sqlite") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-store-")); roots.push(root);
  const filename = path.join(root, "registry.json"), sqliteFilename = path.join(root, "registry.sqlite");
  const source = fixtureRegistry(root, "codex", captureProcessIdentity(process.pid), null);
  fs.writeFileSync(filename, JSON.stringify(source));
  const records = fixtureRecords("codex");
  fs.writeFileSync(path.join(root, "native.jsonl"), [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
  const open = () => { const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode, sqliteFilename }); registries.push(registry); return registry; };
  const service = (registry: AgentRegistry, publish = false) => new AgentStateService({ registry, now: () => FIXTURE_NOW + 2000,
    owns: () => true, process: processIdentityStatus, memory: () => null, release: "fixture", publish: async () => publish });
  return { root, source, sqliteFilename, open, service };
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
    registry.close();
    const successor = f.open();
    await f.service(successor, true).request();
    expect(readAgentStateMetrics(successor)).toMatchObject({ registryTranscriptDivergencesTotal: 1, pendingProjectionPublications: 0 });
    const page = readAgentStatePage(successor, "agentStateJournal", "", 1);
    expect(page.rows).toHaveLength(1);
    expect(readAgentStatePage(successor, "agentStateJournal", page.nextCursor!, 1).rows).toHaveLength(0);
  });
}
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
