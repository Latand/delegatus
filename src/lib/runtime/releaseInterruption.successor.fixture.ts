import fs from "node:fs";
import { AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { RuntimeJournal } from "@/runtime-host/journal";
import { createFakeDeliveryLedger, FakeEngineHost } from "./fixtures/fakeEngineHost";
import { InterruptionJournalBusyError } from "./interruptionObligations";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { adoptStructuredHostsAtStartup, type StructuredHostAdoptionFilter } from "./startup";
import type { RuntimeHostClient } from "./client";

const [registryFile, runtimeFile, startedFile, resultFile] = process.argv.slice(2);
if (!registryFile || !runtimeFile || !startedFile || !resultFile) throw new Error("missing isolated successor fixture paths");
const journal = new RuntimeJournal(runtimeFile, { structuredHosts: true });
const registry = new AgentRegistry(registryFile, undefined, undefined, { sqliteMode: "sqlite" });
const ledger = createFakeDeliveryLedger();
const successor: ProcessIdentity = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
const client: RuntimeHostClient = {
  snapshot: async () => journal.snapshot(),
  readSession: async identity => journal.readSession(identity),
  append: async event => journal.append(event),
  command: async command => journal.executeOperation(command),
  operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
  retryOperation: async (id, key, options) => journal.retryOperation(id, key, options),
  effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
  transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  startupGeneration: async () => 1,
};

async function adopt(engine: "codex" | "claude", received: AgentRegistry, shouldAdopt: StructuredHostAdoptionFilter) {
  return Object.values(received.readOnlySnapshot().entries).flatMap(entry => {
    if (entry.key.engine !== engine || !entry.structuredHost || !shouldAdopt(entry)) return [];
    const claimed = received.claimStructuredHost(entry.key, successor, { allowUnhosted: true });
    if (!claimed?.structuredHost || !claimed.claimOwner) return [];
    if (!received.setStructuredHostClaimed(entry.key, {
      ...claimed.structuredHost,
      endpoint: `fixture:successor-${entry.key.sessionId}`,
      process: successor,
      activeTurnRef: null,
    }, "idle", claimed.claimOwner, claimed.claimEpoch)) return [];
    const host = new FakeEngineHost(ledger, {
      status: "idle", sessionKey: sessionKeyId(entry.key), endpoint: "fixture:successor",
      pid: null, processStartIdentity: null, eventCursor: 0, protocolVersion: "test",
      activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null,
    });
    return [{ key: entry.key, host: Object.assign(host, { onStateChange: () => () => {} }) as never }];
  });
}

fs.writeFileSync(startedFile, "admission-started");
try {
  await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
  let adopted: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const hosts = await adoptStructuredHostsAtStartup({
        registry,
        client,
        orchestratorSeats: () => [],
        schedule: () => ({ unref() {} }),
        adopt: async (received, _options, _env, shouldAdopt = () => true) =>
          adopt("codex", received, shouldAdopt) as never,
        adoptClaude: async (received, _options, _env, shouldAdopt = () => true) =>
          adopt("claude", received, shouldAdopt) as never,
      });
      adopted = hosts.map(host => sessionKeyId(host.key));
      break;
    } catch (error) {
      if (!(error instanceof InterruptionJournalBusyError) || attempt === 7) throw error;
      await Bun.sleep(100);
    }
  }
  fs.writeFileSync(resultFile, JSON.stringify({ adopted }));
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await bindStructuredDeliveryQueue([], { registry, client: null });
  registry.close();
  journal.close();
}
