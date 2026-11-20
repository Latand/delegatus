import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, type SpawnReceipt } from "@/lib/agent/registry";
import { FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION, fixtureRecords, fixtureRegistry, at } from "@/lib/agentState/testFixture";
import { observeAgentProcess } from "@/lib/agentState/process";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeOperationCommand } from "./contracts";
import { readHostExit } from "./hostExit";
import { spawnNativeWaitOwner } from "./nativeWaitOwner";
import { treeHasOnlyMcpChildren } from "./structuredHostRetirement";
import { agentScopeEngine, reconcileUnregisteredAgentProcesses } from "./unregisteredAgentProcesses";

const launchId = "fixture-orphan-launch";
const now = FIXTURE_NOW + 2 * 3_600_000;
const idleMs = 3_600_000;

test("orphan custody recognizes native scopes in both agent slices", () => {
  const prefix = "0::/user.slice/delegatus-agents.slice";
  const stamp = "a".repeat(12);
  expect(agentScopeEngine(`${prefix}/delegatus-agent-claude-${stamp}.scope`)).toBe("claude");
  expect(agentScopeEngine(`${prefix}/delegatus-agents-work.slice/delegatus-agent-codex-${stamp}.scope`)).toBe("codex");
  expect(agentScopeEngine(`0::/user.slice/independent.slice/delegatus-agent-codex-${stamp}.scope`)).toBeNull();
});

for (const engine of ["claude", "codex"] as const) {
  test.skipIf(process.platform !== "linux").each([
    "dead-row", "dead-session", "absent-row", "live-row", "other-live-row", "ambiguous-owner", "open-journal", "probe-limit",
    "other-runtime-work", "replacement-owner", "resumed-turn", "release-changed", "writer-admission",
    "send-wins-runtime-admission", "missing-launch-proof", "drain-fails-kill-before-signal",
  ] as const)(`${engine} unregistered process reconciliation: %s`, async condition => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-orphan-"));
    const binary = path.join(root, engine);
    // Use a versioned native image behind the CLI symlink in the absent-row
    // case. Linux reports the executable's target name through /proc.
    const executable = condition === "absent-row" ? path.join(root, "2.1.0") : binary;
    fs.copyFileSync(Bun.which("sleep")!, executable);
    fs.chmodSync(executable, 0o700);
    if (executable !== binary) fs.symlinkSync(executable, binary);
    const capability = createHash("sha256").update("fixture native launch").digest("base64url");
    const env = { ...process.env, ["LLV_SPAWN_" + "CAPABILITY"]: capability };
    const native = spawnNativeWaitOwner(binary, ["60"], { env, stdio: "pipe" });
    const waiter = captureProcessIdentity(native.pid!);
    const nativeClosed = new Promise<void>(resolve => native.once("close", () => resolve()));
    const peer = spawn(binary, ["60"], { env, stdio: "ignore" });
    const peerIdentity = captureProcessIdentity(peer.pid!);
    let registry: AgentRegistry | undefined;
    let journal: RuntimeJournal | undefined;
    try {
      await native.spawnReady;
      const identity = captureProcessIdentity(native.pid!);
      expect(identity).not.toEqual(waiter);
      if (condition === "absent-row") expect(fs.readlinkSync(`/proc/${identity.pid}/exe`)).toBe(fs.realpathSync(binary));
      native.retainExit(true);
      const file = fixtureRegistry(root, engine, identity, null);
      const key = { engine, sessionId: FIXTURE_SESSION } as const;
      const keyId = `${engine}:${FIXTURE_SESSION}`;
      const entry = file.entries[keyId]!;
      const artifactPath = entry.artifactPath!;
      const records = fixtureRecords(engine);
      const writeTranscript = (rows: unknown[]) => fs.writeFileSync(artifactPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      writeTranscript([...records.open, ...records.close]);
      fs.utimesSync(artifactPath, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
      file.conversations[FIXTURE_CONVERSATION]!.turn = { state: "terminal", source: "lifecycle", terminalAt: at(1000), observedAt: at(1000) };
      file.receipts[launchId] = {
        launchId, key, engine, transport: "structured", state: "completed", conversationId: FIXTURE_CONVERSATION,
        artifactPath, cwd: root, createdAt: at(0),
        spawnCapabilityDigest: createHash("sha256").update(capability).digest("hex"),
        ...(condition === "absent-row" ? { hostSetup: { phase: "executing", processes: [identity] } } : {}),
      } as SpawnReceipt;
      entry.structuredHostOperationId = launchId;
      if (condition === "absent-row") delete file.entries[keyId];
      else if (condition !== "live-row") {
        if (condition === "other-live-row") {
          const another = FIXTURE_SESSION.slice(0, -1) + "c";
          file.entries[`${engine}:${another}`] = { ...entry, key: { engine, sessionId: another },
            artifactPath: path.join(root, "other.jsonl") };
        }
        entry.structuredHost = null;
        entry.status = "dead";
        if (condition !== "missing-launch-proof") entry.hostExitProcess = identity;
        if (condition === "ambiguous-owner") {
          entry.claimOwner = `structured-host:${JSON.stringify({ pid: waiter.pid, startIdentity: waiter.startIdentity })}`;
        }
      }
      if (condition === "probe-limit") {
        for (let index = 0; index < 64; index++) {
          const sessionId = `fixture-unrelated-${index}`;
          file.entries[`${engine}:${sessionId}`] = { ...entry, key: { engine, sessionId },
            artifactPath: path.join(root, `${sessionId}.jsonl`), hostExitProcess: undefined };
        }
      }
      const filename = path.join(root, "registry.json");
      let entryReads = 0;
      const options = { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite"),
        onSqliteRowPayloadRead: (collection: string, count: number) => {
          if (collection === "entries") entryReads += count;
        },
      } as const;
      fs.writeFileSync(filename, JSON.stringify(file));
      registry = new AgentRegistry(filename, undefined, undefined, options);
      registry.agentStateRead(() => undefined);
      entryReads = 0;
      journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => now });
      journal.append({ scope: { type: "session", id: FIXTURE_CONVERSATION }, kind: "session-status", payload: {
        conversationId: FIXTURE_CONVERSATION, sessionKey: key, artifactPath, cwd: root,
        hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
        host: condition === "dead-session" ? "dead" : "hosted",
        turn: condition === "dead-session" ? "unknown" : "idle", activeTurnId: null, provenance: "structured",
        writerClaim: condition === "dead-session" ? null : `fixture-writer-${engine}`,
      } });
      if (condition === "open-journal" || condition === "probe-limit") journal.executeOperation({ kind: "spawn", operationId: launchId, idempotencyKey: launchId,
        conversationId: FIXTURE_CONVERSATION, engine, cwd: root, prompt: "fixture" });
      if (condition === "other-runtime-work") {
        journal.executeOperation({ kind: "send", operationId: "fixture-pending-send",
          idempotencyKey: "fixture-pending-send", conversationId: FIXTURE_CONVERSATION, text: "fixture" });
        expect(journal.readSession({ conversationId: FIXTURE_CONVERSATION })?.retirementBlocked).toBe(true);
      }
      const activeRegistry = registry;
      let writerAdmissions = 0;
      if (condition === "writer-admission") {
        const admit = activeRegistry.deliveryWriteOrBusy.bind(activeRegistry);
        activeRegistry.deliveryWriteOrBusy = (correlation, write) => {
          if (correlation.label === "registry.unregistered-agent-stop") {
            writerAdmissions++;
            activeRegistry.upsert({ ...entry, status: "live", claimOwner: `structured-host:${JSON.stringify(waiter)}` });
          }
          return admit(correlation, write);
        };
      }
      let ready = true;
      let sessionReads = 0;
      let pulled = 0;
      let operationReads = 0;
      let failedDrainOnce = false;
      const ports = {
        registry, idleMs, now: () => now, ready: () => ready, noLocalWork: () => true, treeIdle: treeHasOnlyMcpChildren,
        pids: { [Symbol.asyncIterator]: async function* () {
          const candidates = condition === "probe-limit"
            ? Array<number>(5).fill(identity.pid)
            : [peerIdentity.pid, identity.pid];
          for (const pid of candidates) {
            pulled++;
            yield pid;
          }
        } },
        attemptId: (() => { let sequence = 0; return () => `fixture-attempt-${++sequence}`; })(),
        client: {
          command: async (command: RuntimeOperationCommand) => {
            if (condition === "send-wins-runtime-admission") journal!.executeOperation({
              kind: "send", operationId: "fixture-boundary-send", idempotencyKey: "fixture-boundary-send",
              conversationId: FIXTURE_CONVERSATION, text: "boundary send",
            });
            return journal!.executeOperation(command);
          },
          transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => {
            const [id, status, details, options] = args;
            if (condition === "drain-fails-kill-before-signal" && !failedDrainOnce
              && id.startsWith(`unregistered-retirement-${launchId}-`) && status === "delivering") {
              failedDrainOnce = true;
              journal!.transitionOperation(id, "failed", { reason: "fixture-drain-refused" }, { fromStatuses: ["queued"] });
            }
            return journal!.transitionOperation(id, status, details, options);
          },
          operationStatus: async (id: string) => {
            operationReads++;
            return journal!.currentRetryResult(id);
          },
          readSession: async (request: { conversationId?: string; artifactPath?: string }) => {
            if (++sessionReads === 1) {
              if (condition === "replacement-owner") activeRegistry.upsert({ ...entry, status: "live",
                claimOwner: `structured-host:${JSON.stringify(waiter)}` });
              if (condition === "resumed-turn") writeTranscript([...records.open, ...records.close,
                ...(engine === "codex" ? [{ type: "event_msg", timestamp: at(1500),
                  payload: { type: "task_started", turn_id: "fixture-reopened" } }] : records.open)]);
              if (condition === "release-changed") ready = false;
            }
            return journal!.readSession(request);
          },
        },
      };
      const outcomes = await reconcileUnregisteredAgentProcesses(ports);
      if (condition === "probe-limit") {
        expect(operationReads).toBe(4);
        expect(pulled).toBe(4);
        expect(entryReads).toBeLessThan(32);
      }
      if (["dead-row", "absent-row", "other-runtime-work", "replacement-owner", "resumed-turn", "release-changed", "writer-admission", "send-wins-runtime-admission"].includes(condition)) {
        expect(sessionReads).toBeGreaterThan(0);
      }
      if (condition === "writer-admission") expect(writerAdmissions).toBe(1);
      expect(observeAgentProcess(peerIdentity)).toBe("alive");
      expect(readHostExit(peerIdentity)?.stop).toBeNull();
      if (condition === "dead-row" || condition === "dead-session" || condition === "absent-row") {
        expect(outcomes).toEqual([{ launchId, key: keyId, process: identity, outcome: "stopped" }]);
        expect(journal.snapshot().recentOperations.find(row => row.operationId.startsWith(`unregistered-retirement-${launchId}-`))?.status)
          .toBe("delivered");
        // A delivered kill makes this generation dead; once its successor
        // host is recorded, the orphan retirement must no longer reserve it.
        journal.append({ scope: { type: "session", id: FIXTURE_CONVERSATION }, kind: "session-status", payload: {
          conversationId: FIXTURE_CONVERSATION, sessionKey: key, host: "hosted", turn: "idle", activeTurnId: null,
          writerClaim: `fixture-replacement-${engine}`,
        } });
        expect(journal.executeOperation({ kind: "send", operationId: "fixture-after-orphan-stop",
          idempotencyKey: "fixture-after-orphan-stop", conversationId: FIXTURE_CONVERSATION, text: "continue", policy: "queue" })
          .receipt).toMatchObject({ status: "queued" });
        await nativeClosed;
        expect(observeAgentProcess(waiter)).toBe("dead");
        expect(observeAgentProcess(identity)).toBe("dead");
        expect(readHostExit(identity)).toMatchObject({ stop: { operationId: launchId,
          path: "unregistered-agent-reconciliation", signal: "SIGTERM" }, exit: { signal: "SIGTERM" } });
      } else {
        expect(outcomes).toEqual([]);
        expect(observeAgentProcess(identity)).toBe("alive");
        expect(readHostExit(identity)?.stop).toBeNull();
        if (condition === "drain-fails-kill-before-signal") {
          const failed = journal.snapshot().recentOperations.find(row => row.operationId.startsWith(`unregistered-retirement-${launchId}-`));
          expect(failed)
            .toMatchObject({ status: "failed", reason: "fixture-drain-refused" });
          expect(journal.operationResult(failed!.operationId)?.receipt.status).toBe("failed");
          const retry = await reconcileUnregisteredAgentProcesses(ports);
          expect(retry).toEqual([{ launchId, key: keyId, process: identity, outcome: "stopped" }]);
          const attempts = journal.snapshot().recentOperations.filter(row => row.operationId.startsWith(`unregistered-retirement-${launchId}-`));
          expect(attempts.map(row => row.status)).toContain("delivered");
          expect(new Set(attempts.map(row => row.operationId)).size).toBeGreaterThan(1);
        }
      }
    } finally {
      try {
        await Promise.all([stopFixtureProcess(peer), (async () => {
          try { await native.abortLaunch(); await nativeClosed; }
          finally { await stopFixtureIdentity(waiter); }
        })()]);
      } finally {
        journal?.close();
        registry?.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 15_000);
}
