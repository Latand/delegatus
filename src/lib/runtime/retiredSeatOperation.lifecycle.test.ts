import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests, type SpawnReceipt } from "@/lib/agent/registry";
import { FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION, fixtureRecords, fixtureRegistry, at } from "@/lib/agentState/testFixture";
import { observeAgentProcess } from "@/lib/agentState/process";
import { clearAgentObservations } from "@/lib/agentState/projectionCache";
import { AgentStateService } from "@/lib/agentState/service";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { determined } from "./determinable";
import { readHostExit } from "./hostExit";
import * as control from "./structuredHostControl";
import { runStructuredHostRetirementSweep } from "./structuredHostRetirement";

const operationId = "fixture-seat-operation";
const now = FIXTURE_NOW + 2 * 3_600_000;
const launch = () => spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

for (const engine of ["claude", "codex"] as const) {
  test.each([
    "missing-receipt", "terminal-receipt-with-pending-action", "recent-nonterminal-receipt",
  ] as const)(`${engine} retired seat operation: %s`, async condition => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-operation-"));
    const native = launch();
    const owner = launch();
    const nativeIdentity = captureProcessIdentity(native.pid!);
    const ownerIdentity = captureProcessIdentity(owner.pid!);
    const key = { engine, sessionId: FIXTURE_SESSION } as const;
    const keyId = `${engine}:${FIXTURE_SESSION}`;
    let registry: AgentRegistry | undefined;
    let agentState: AgentStateService | undefined;
    const terminate = control.terminateStructuredHostTree;
    const tree = spyOn(control, "terminateStructuredHostTree").mockImplementation((ref, dependencies) =>
      terminate(ref, { ...dependencies, ppidMap: () => new Map([[nativeIdentity.pid, process.pid]]),
        processGroupId: () => null }));
    try {
      await stopFixtureProcess(owner);
      expect(observeAgentProcess(ownerIdentity)).toBe("dead");
      expect(observeAgentProcess(nativeIdentity)).toBe("alive");
      const file = fixtureRegistry(root, engine, nativeIdentity, ownerIdentity);
      const entry = file.entries[keyId]!;
      const artifactPath = entry.artifactPath!;
      const records = fixtureRecords(engine);
      fs.writeFileSync(artifactPath, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
      fs.utimesSync(artifactPath, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
      entry.structuredHostOperationId = operationId;
      entry.structuredHost!.activeTurnRef = null;
      entry.status = "idle";
      file.conversations[FIXTURE_CONVERSATION]!.turn = { state: "terminal", source: "lifecycle", terminalAt: at(1000), observedAt: at(1000) };
      file.memberships[FIXTURE_CONVERSATION] = [{ kind: "orchestrator", containerId: "fixture-seat",
        conversationId: FIXTURE_CONVERSATION, role: "orchestrator", slot: "orchestrator", stageId: null,
        stageOrder: null, round: null, parentConversationId: null, runtime: null, createdAt: at(0) }];
      if (condition !== "missing-receipt") {
        file.receipts[operationId] = {
          launchId: operationId, key, engine, transport: "structured",
          state: condition === "terminal-receipt-with-pending-action" ? "completed" : "path-pending",
          conversationId: FIXTURE_CONVERSATION, artifactPath, cwd: root, createdAt: at(0), admissionOwner: ownerIdentity,
        } as SpawnReceipt;
        if (condition === "terminal-receipt-with-pending-action") entry.pendingAction = "spawn";
      }
      const filename = path.join(root, "registry.json");
      const options = { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") } as const;
      fs.writeFileSync(filename, JSON.stringify(file));
      registry = new AgentRegistry(filename, undefined, undefined, options);
      setAgentRegistryForTests(registry);
      const activeRegistry = registry;
      if (condition === "missing-receipt") {
        expect(activeRegistry.readOnlySnapshot().receipts[operationId]).toBeUndefined();
      }
      agentState = new AgentStateService({ registry, now: () => now, owns: () => true,
        process: observeAgentProcess, memory: () => null, release: "fixture", publish: async () => true });
      await agentState.request();
      const report = await runStructuredHostRetirementSweep({
        snapshot: () => activeRegistry.readOnlySnapshot(), requireAgentState: true,
        publicationState: () => "ready", now: () => now,
        readCursor: () => null, writeCursor: () => {}, record: () => {},
        handoffRows: () => determined([]), durableEventTail: () => determined(0),
        orchestratorSeatConversations: () => determined(new Set<string>()),
        revokedSeatConversations: () => determined(new Set([FIXTURE_CONVERSATION])),
        realtimeBound: () => determined(false), owned: () => false,
        treePss: () => ({ bytes: 0, measuredProcesses: 0 }),
        ppidMap: () => new Map([[nativeIdentity.pid, process.pid]]), processMemory: () => new Map(),
        graceMs: 100,
      });
      expect(report.failed).toEqual([]);
      if (condition === "missing-receipt") {
        expect(report.refused).toEqual([]);
        expect(report.retired).toHaveLength(1);
        expect(report.retired[0]).toMatchObject({ seatRevoked: true, passed: expect.arrayContaining(["no-open-operation"]) });
        expect(activeRegistry.hostEntry(key)).toMatchObject({ status: "dead", pendingAction: null, claimOwner: null });
        expect(observeAgentProcess(nativeIdentity)).toBe("dead");
        expect(readHostExit(nativeIdentity)?.stop?.path).toBe("idle-retirement-sweep");
      } else {
        expect(report.retired).toEqual([]);
        expect(report.refused).toHaveLength(1);
        expect(report.refused[0]).toMatchObject({
          clause: "no-open-operation",
          reason: condition === "terminal-receipt-with-pending-action"
            ? `a spawn action is pending for operation ${operationId}`
            : `operation ${operationId} has no settlement proof (registry: path-pending)`,
        });
        expect(observeAgentProcess(nativeIdentity)).toBe("alive");
        expect(readHostExit(nativeIdentity)?.stop).toBeNull();
        expect(activeRegistry.hostEntry(key)?.structuredTerminationCaptureId).toBeUndefined();
      }
    } finally {
      tree.mockRestore();
      agentState?.stop();
      clearAgentObservations();
      setAgentRegistryForTests(null);
      await Promise.all([stopFixtureProcess(native), stopFixtureProcess(owner)]);
      registry?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}
