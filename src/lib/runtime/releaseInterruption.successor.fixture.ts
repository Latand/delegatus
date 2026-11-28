import fs from "node:fs";
import { AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { RuntimeJournal } from "@/runtime-host/journal";
import { createFakeDeliveryLedger, FakeEngineHost } from "./fixtures/fakeEngineHost";
import { InterruptionJournalBusyError, interruptionObligationDirectory } from "./interruptionObligations";
import type { StructuredHostAdoptionFilter } from "./registry";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { adoptStructuredHostsAtStartup } from "./startup";
import { journalTickets, until } from "./startup.interruptionAdmission.fixture";
import type { RuntimeHostClient } from "./client";

const [registryFile, runtimeFile, milestones, hostKey, incumbentPid] = process.argv.slice(2);
if (!registryFile || !runtimeFile || !milestones || !hostKey || !incumbentPid) throw new Error("missing isolated successor fixture paths");
const milestone = (name: string) => `${milestones}/${name}`;
const cuts = interruptionObligationDirectory(registryFile);
const journal = new RuntimeJournal(runtimeFile, { structuredHosts: true });
const registry = new AgentRegistry(registryFile, undefined, undefined, { sqliteMode: "sqlite" });
const ledger = createFakeDeliveryLedger();
const successor: ProcessIdentity = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
const refused = new Error("the incumbent still owns the fixture host");
const watch = setInterval(() => {
  for (const [pid, name] of [[process.pid, "successor-queued"], [Number(incumbentPid), "incumbent-queued"]] as const) {
    if (!fs.existsSync(milestone(name)) && journalTickets(cuts, pid) > 0) fs.writeFileSync(milestone(name), "");
  }
}, 5);
const client = {
  snapshot: async () => journal.snapshot(),
  readSession: async identity => journal.readSession(identity),
  append: async event => journal.append(event),
  command: async command => journal.executeOperation(command),
  operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
  retryOperation: async (id, key, options) => journal.retryOperation(id, key, options),
  effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
  transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  startupGeneration: async () => "fixture-generation",
} as RuntimeHostClient;

async function adopt(engine: "codex" | "claude", received: AgentRegistry, shouldAdopt: StructuredHostAdoptionFilter) {
  if (engine !== "codex") return [];
  fs.writeFileSync(milestone("journal-admitted"), "");
  if (!fs.existsSync(milestone("incumbent-released"))) {
    await until(() => fs.existsSync(milestone("cut-ready")), 15_000);
    const entry = received.readOnlySnapshot().entries[hostKey];
    if (!entry) throw new Error("missing incumbent fixture host");
    const decision = { refusal: null };
    if (received.claimStructuredHost(entry.key, successor, { allowUnhosted: true, decision })) {
      throw new Error("successor took custody before incumbent release");
    }
    fs.writeFileSync(milestone("claim-refused.tmp"), String(decision.refusal));
    fs.renameSync(milestone("claim-refused.tmp"), milestone("claim-refused"));
    throw refused;
  }
  return Object.values(received.readOnlySnapshot().entries).flatMap(entry => {
    if (sessionKeyId(entry.key) !== hostKey || !entry.structuredHost || !shouldAdopt(entry)) return [];
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
      if (attempt === 7 || (error !== refused && !(error instanceof InterruptionJournalBusyError))) throw error;
      if (error === refused) await until(() => fs.existsSync(milestone("incumbent-released")), 5_000);
      await Bun.sleep(100);
    }
  }
  fs.writeFileSync(milestone("result"), JSON.stringify({ adopted }));
} catch (error) {
  fs.writeFileSync(milestone("result"), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  clearInterval(watch);
  await bindStructuredDeliveryQueue([], { registry, client: null });
  registry.close();
  journal.close();
}
