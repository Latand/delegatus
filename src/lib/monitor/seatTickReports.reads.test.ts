import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, normalizeRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import * as bridge from "@/lib/bridge/store";
import * as aliases from "@/lib/projects/aliases";
import * as tasks from "@/lib/tasks/store";
import * as pipelines from "@/lib/pipelines/store";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { operatorLocale } from "@/lib/operator/settings";
import { ruleReports, type RuleReportInput } from "./ruleReports";
import { recordSeatRuleReports, seatTickReportRows } from "./seatTickReports";
import { ensureSeatTickCard } from "./seatTickController";
import { seatReadBoard, seatReadRegistry, SEAT_READ_AT } from "./seatReads.fixture";

for (const backend of ["legacy", "sqlite-hot", "sqlite-cold"] as const) test(`rule report read output is byte-identical with mixed and legacy rows (${backend})`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seat-report-reads-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  const registry = new AgentRegistry(path.join(directory, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const restores: Array<() => void> = [];
  let store: SqliteAgentRegistryStore | undefined;
  try {
    aliases.persistProjectAliases([{ source: "old", target: "current", displayName: "Fixture" }]);
    beginOrchestratorSeatIntent({ project: "current", mandate: "Run checks", clientRequestId: "read-seat", mode: "spawn", now: SEAT_READ_AT });
    completeOrchestratorSeatIntent({ project: "current", clientRequestId: "read-seat", conversationId: "conversation_seat", path: null, now: SEAT_READ_AT, preparedAuthCredentialBaseline: null });
    bridge.readBridgeReportLog(); bridge.readBridgeChannel();
    // A real conversation supplies the legacy project fallback, including an
    // agent origin with no project and a record without authorship at all.
    const recipient = registry.ensureConversation("codex", "/fixtures/recipient.jsonl", "default");
    const initial = seatReadRegistry(84, 70);
    initial.conversations.conversation_recipient = { ...registry.snapshot().conversations[recipient.id]!, id: "conversation_recipient",
      projectOwnership: { project: "old", source: "operator", setAt: SEAT_READ_AT, operationId: "fixture-project" } };
    for (const row of Object.values(initial.heldDeliveries)) if (Number(row.id.slice(-6)) % 7 === 5) delete row.command.origin!.project;
    store = backend !== "legacy" ? new SqliteAgentRegistryStore(path.join(directory, "fixture.sqlite"), { initialSnapshot: initial, normalize: normalizeRegistry }) : undefined;
    if (backend === "sqlite-cold") while (store!.archiveInactive(250) > 0) { /* retain the same rows as archived history */ }
    const snapshot = store?.readOnlySnapshot().file ?? initial;
    // Simulate a peer committing after the report's immutable snapshot was
    // acquired. Indexed selection must retain its old membership and order.
    if (store) {
      const peer = new SqliteAgentRegistryStore(store.filename, { initialSnapshot: initial, normalize: normalizeRegistry });
      try {
        peer.mutate(file => {
          file.heldDeliveries["delivery-000005"]!.state = "delivered";
          file.heldDeliveries["delivery-000071"]!.state = "failed";
        }, false);
      } finally { peer.close(); }
    }
    const board = seatReadBoard(45);
    const registryRead = spyOn(registry, "readOnlySnapshot").mockReturnValue(snapshot);
    const taskRead = spyOn(tasks, "loadTasksForList").mockReturnValue(board.tasks);
    const laneRead = spyOn(pipelines, "loadPipelinesForList").mockReturnValue(board.pipelines);
    restores.push(() => registryRead.mockRestore(), () => taskRead.mockRestore(), () => laneRead.mockRestore());
    const append = bridge.appendBridgeReports;
    let appended: Parameters<typeof append>[0] = [];
    const writer = spyOn(bridge, "appendBridgeReports").mockImplementation(inputs => {
      expect(aliases.canonicalProject("scope-probe")).toBe("scope-probe");
      appended = inputs;
      return append(inputs);
    });
    restores.push(() => writer.mockRestore());
    const snapshotRead = aliases.projectAliasSnapshot;
    const scope = spyOn(aliases, "projectAliasSnapshot").mockImplementation(() => {
      const value = snapshotRead();
      return { ...value, aliases: { ...value.aliases, "scope-probe": "scope-active" } };
    });
    restores.push(() => scope.mockRestore());
    for (const project of ["current", "moved"]) {
      if (project === "moved") aliases.persistProjectAliases([{ source: "current", target: "moved", displayName: "Fixture" }]);
      const log = bridge.readBridgeReportLog();
      const canonical = aliases.canonicalProject;
      const input: RuleReportInput = { project, at: SEAT_READ_AT, seatConversationId: "conversation_seat", locale: operatorLocale() === "en" ? "en" : "uk",
        tasks: board.tasks.filter(row => canonical(row.project) === project),
        pipelines: board.pipelines.flatMap(row => canonical(row.project) === project ? [{ ...row, project }] : []),
        deliveries: Object.values(snapshot.heldDeliveries), maintenance: [], dismissals: [],
        bridgeLog: { ...log, reports: log.reports.map(row => row.project ? { ...row, project: canonical(row.project) } : row) },
        deliveryLost: row => snapshot.deliveryOperationOwners[row.command.operationId]?.terminalDisposition === "lost",
        deliveryProject: row => { const held = row.command.origin?.project ?? snapshot.conversations[row.conversationId]?.projectOwnership?.project; return held ? canonical(held) : null; },
      };
      const known = new Set([...log.reports.map(row => row.id), ...log.retired]);
      const expected = ruleReports(input).filter(row => !known.has(bridge.scopedReportId(project, row.key)) && !known.has(bridge.bridgeReportId(row.key)));
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.some(row => row.key === "rule:delivery-unsent:delivery-000005")).toBe(true);
      expect(expected.some(row => row.key === "rule:delivery-unsent:delivery-000004")).toBe(false);
      expect(expected.some(row => row.key === "rule:delivery-unsent:delivery-000002")).toBe(false);
      await recordSeatRuleReports(project, SEAT_READ_AT);
      expect(JSON.stringify(appended)).toBe(JSON.stringify(expected));
      expect(aliases.canonicalProject("scope-probe")).toBe("scope-probe");
      const reports = bridge.readBridgeReportLog().reports;
      const before = reports.filter(row => row.origin?.kind === "manager" && !!row.project && canonical(row.project) === project)
        .map(({ id, project, origin, at, covers, coversOwedAt }) => ({ id, project, origin, at, covers, coversOwedAt }));
      expect(JSON.stringify(seatTickReportRows(project))).toBe(JSON.stringify(before));
    }
  } finally {
    for (const restore of restores.reverse()) restore();
    setAgentRegistryForTests(null); registry.close(); store?.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("card preflight releases its alias snapshot before writes and after errors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seat-card-reads-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  const board = seatReadBoard(30);
  const read = spyOn(tasks, "loadTasksForList").mockReturnValue(board.tasks);
  const snapshot = spyOn(aliases, "projectAliasSnapshot").mockReturnValue({ aliases: { old: "current", "scope-probe": "scope-active" }, displayNames: {} });
  const write = spyOn(tasks, "mutateTasksFile").mockImplementation(() => {
    expect(aliases.canonicalProject("scope-probe")).toBe("scope-probe");
    throw new Error("fixture writer refused");
  });
  try {
    // A resolved absent card takes the read-only exit; an open absent card
    // reaches the writer, with no pinned aliases inherited from preflight.
    const card = { kind: "mcp-unavailable" as const, ref: "fixture-ref", state: "resolved" as const, detail: "Fixture" };
    expect(ensureSeatTickCard("current", card, SEAT_READ_AT)).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(() => ensureSeatTickCard("current", { ...card, state: "open" }, SEAT_READ_AT)).toThrow("fixture writer refused");
    expect(aliases.canonicalProject("scope-probe")).toBe("scope-probe");
    const broken = { ...board.tasks[0]!, get project(): string {
      expect(aliases.canonicalProject("scope-probe")).toBe("scope-active");
      throw new Error("fixture predicate refused");
    } };
    read.mockReturnValue([broken]);
    expect(() => ensureSeatTickCard("current", card, SEAT_READ_AT)).toThrow("fixture predicate refused");
    expect(aliases.canonicalProject("scope-probe")).toBe("scope-probe");
    read.mockImplementation(() => { throw new Error("fixture read refused"); });
    expect(() => ensureSeatTickCard("current", card, SEAT_READ_AT)).toThrow("fixture read refused");
    expect(aliases.canonicalProject("scope-probe")).toBe("scope-probe");
  } finally {
    write.mockRestore(); snapshot.mockRestore(); read.mockRestore();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
