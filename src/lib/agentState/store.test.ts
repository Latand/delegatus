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
import { readAgentProjection, readAgentStateMetrics, readAgentStatePage, subjectId } from "./store";
import { cachedAgentObservation } from "./projectionCache";
import { FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION, fixtureRegistry, fixtureRecords } from "./testFixture";

const roots: string[] = [], registries: AgentRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(mode: "off" | "sqlite") {
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
    const observed = [...page.rows];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = readAgentStatePage(successor, "agentStateJournal", cursor, 1);
      observed.push(...next.rows);
      cursor = next.nextCursor;
    }
    const journalRows = observed.filter(row => "id" in row);
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
