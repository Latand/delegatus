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
import { RuntimeJournal } from "@/runtime-host/journal";
import { determined } from "./determinable";
import { readHostExit } from "./hostExit";
import * as control from "./structuredHostControl";
import { runStructuredHostRetirementSweep, structuredHostRetirementJournalRecord } from "./structuredHostRetirement";

const operationId = "fixture-seat-operation";
const now = FIXTURE_NOW + 2 * 3_600_000;
const launch = () => spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

for (const engine of ["claude", "codex"] as const) {
  test.each([
    "missing-receipt", "settled-journal", "live-owner", "unverified-owner",
    "open-journal", "first-message", "journal-unavailable", "foreign-operation", "other-receipt",
    "owner-changed-during-read", "work-arrived-before-signal", "seat-restored",
  ] as const)(`${engine} retired seat operation: %s`, async condition => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-operation-"));
    const native = launch();
    const owner = launch();
    const nativeIdentity = captureProcessIdentity(native.pid!);
    const ownerIdentity = captureProcessIdentity(owner.pid!);
    const key = { engine, sessionId: FIXTURE_SESSION } as const;
    const keyId = `${engine}:${FIXTURE_SESSION}`;
    let registry: AgentRegistry | undefined;
    let journal: RuntimeJournal | undefined;
    let agentState: AgentStateService | undefined;
    const terminate = control.terminateStructuredHostTree;
    const tree = spyOn(control, "terminateStructuredHostTree").mockImplementation((ref, dependencies) =>
      terminate(ref, { ...dependencies, ppidMap: () => new Map([[nativeIdentity.pid, process.pid]]),
        processGroupId: () => null }));
    try {
      if (condition !== "live-owner" && condition !== "owner-changed-during-read") await stopFixtureProcess(owner);
      // Keep a second child alive for the replacement-owner race. The original
      // claim names that PID's previous start identity, as after PID reuse.
      const priorOwner = condition === "owner-changed-during-read"
        ? { ...ownerIdentity, startIdentity: `${ownerIdentity.startIdentity}:prior` }
        : condition === "unverified-owner" ? { ...ownerIdentity, bootEpoch: undefined } : ownerIdentity;
      const file = fixtureRegistry(root, engine, nativeIdentity, priorOwner);
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
      const receipt = (id: string) => ({
        launchId: id, key, engine, transport: "structured", state: "path-pending", conversationId: FIXTURE_CONVERSATION,
        artifactPath, cwd: root, createdAt: at(0), admissionOwner: priorOwner,
      }) as SpawnReceipt;
      if (condition === "settled-journal" || condition === "other-receipt") {
        file.receipts[operationId] = receipt(operationId);
        entry.pendingAction = "spawn";
      }
      if (condition === "other-receipt") file.receipts["fixture-another-launch"] = receipt("fixture-another-launch");
      const filename = path.join(root, "registry.json");
      const options = { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") } as const;
      fs.writeFileSync(filename, JSON.stringify(file));
      registry = new AgentRegistry(filename, undefined, undefined, options);
      setAgentRegistryForTests(registry);
      if (condition === "missing-receipt" || condition === "settled-journal") {
        agentState = new AgentStateService({ registry, now: () => now, owns: () => true,
          process: observeAgentProcess, memory: () => null, release: "fixture", publish: async () => true });
        await agentState.request();
      }
      const runtimeFile = path.join(root, "runtime.sqlite");
      journal = new RuntimeJournal(runtimeFile, { structuredHosts: true, now: () => now });
      const publishIdleSession = () => journal!.append({ scope: { type: "session", id: FIXTURE_CONVERSATION }, kind: "session-status", payload: {
        conversationId: FIXTURE_CONVERSATION, sessionKey: key, artifactPath, cwd: root,
        hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
        host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
      } });
      publishIdleSession();
      const admitSpawn = (conversationId: string) => journal!.executeOperation({
        kind: "spawn", operationId, idempotencyKey: operationId, conversationId, engine, cwd: root, prompt: "fixture",
      });
      const admitMessage = () => journal!.executeOperation({
        kind: "send", operationId: `spawn_message_${operationId}`, idempotencyKey: `spawn_message_${operationId}`,
        conversationId: FIXTURE_CONVERSATION, text: "fixture",
      });
      if (condition === "settled-journal") {
        admitSpawn(FIXTURE_CONVERSATION);
        journal.transitionOperation(operationId, "delivered");
        publishIdleSession();
      }
      if (condition === "open-journal") admitSpawn(FIXTURE_CONVERSATION);
      if (condition === "first-message") admitMessage();
      if (condition === "foreign-operation") admitSpawn("conversation_fixture-other");
      journal.close();
      journal = new RuntimeJournal(runtimeFile, { structuredHosts: true, now: () => now });
      const activeRegistry = registry;
      let readCount = 0;
      let seatRestored = false;
      const report = await runStructuredHostRetirementSweep({
        snapshot: () => activeRegistry.readOnlySnapshot(), requireAgentState: agentState !== undefined,
        publicationState: () => "ready", now: () => now,
        readCursor: () => null, writeCursor: () => {}, record: () => {},
        handoffRows: () => determined([]), durableEventTail: () => determined(0),
        orchestratorSeatConversations: () => determined(new Set(seatRestored ? [FIXTURE_CONVERSATION] : [])),
        revokedSeatConversations: () => determined(new Set(seatRestored ? [] : [FIXTURE_CONVERSATION])),
        realtimeBound: () => determined(false), owned: () => false,
        treePss: () => ({ bytes: 0, measuredProcesses: 0 }),
        ppidMap: () => new Map([[nativeIdentity.pid, process.pid]]), processMemory: () => new Map(),
        readOperation: async id => {
          readCount++;
          if (condition === "journal-unavailable") throw new Error("fixture journal asleep");
          if (condition === "owner-changed-during-read" && readCount === 1) {
            activeRegistry.agentStateWrite(state => { state.entries[keyId]!.claimOwner = `structured-host:${JSON.stringify(ownerIdentity)}`; });
          }
          if (condition === "seat-restored" && readCount === 2) seatRestored = true;
          // Initial assessment used both original ids. Inject the new send
          // while the shared signal ladder prepares its fresh journal proof.
          if (condition === "work-arrived-before-signal" && readCount === 3) admitMessage();
          return journal!.currentRetryResult(id);
        },
        readSession: async request => journal!.readSession(request),
        graceMs: 100,
      });
      if (condition === "work-arrived-before-signal") expect(readCount).toBeGreaterThanOrEqual(3);
      if (condition === "owner-changed-during-read" || condition === "seat-restored") expect(readCount).toBeGreaterThan(0);
      if (condition === "missing-receipt" || condition === "settled-journal") {
        expect(report.failed).toEqual([]);
        expect(report.retired).toHaveLength(1);
        const settlement = { operationId, ownerPid: ownerIdentity.pid,
          registryState: condition === "settled-journal" ? "path-pending" : "absent",
          journal: { settled: true, operation: condition === "settled-journal" ? "delivered" : "absent", firstMessage: "absent" } } as const;
        expect(structuredHostRetirementJournalRecord(report).retired[0]!.settledOperation).toEqual(settlement);
        expect(activeRegistry.hostEntry(key)).toMatchObject({ status: "dead", pendingAction: null, claimOwner: null });
        expect(observeAgentProcess(nativeIdentity)).toBe("dead");
        expect(readHostExit(nativeIdentity)?.stop?.path).toBe("idle-retirement-sweep");
      } else {
        expect(report.retired).toEqual([]);
        expect(observeAgentProcess(nativeIdentity)).toBe("alive");
        expect(readHostExit(nativeIdentity)?.stop).toBeNull();
        expect(activeRegistry.hostEntry(key)?.structuredTerminationCaptureId).toBeUndefined();
        if (condition === "open-journal" || condition === "first-message") {
          expect(report.refused[0]).toMatchObject({ clause: "no-open-operation" });
          expect(report.refused[0]!.reason).toContain("journal status is queued");
        }
      }
    } finally {
      tree.mockRestore();
      agentState?.stop();
      clearAgentObservations();
      setAgentRegistryForTests(null);
      await Promise.all([stopFixtureProcess(native), stopFixtureProcess(owner)]);
      journal?.close();
      registry?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}
