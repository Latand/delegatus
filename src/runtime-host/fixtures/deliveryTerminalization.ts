import { RuntimeJournal } from "../journal";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import { AgentRegistry } from "@/lib/agent/registry";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import path from "node:path";

const now = () => Date.parse("2026-10-01T00:00:00Z");
const journal = new RuntimeJournal(process.argv[3]!, { structuredHosts: true, now });
const operationId = "terminalization-send";
if (process.argv[2] === "claim") {
  console.log(JSON.stringify(journal.claimDeliveryAction(operationId, "discard")));
  // Simulate the process disappearing after the journal commit, before the
  // Viewer's reservation projection or any orderly journal shutdown.
  process.exit(0);
}
const host = new FakeEngineHost();
const registry = new AgentRegistry(path.join(path.dirname(process.argv[3]!), "registry.json"), undefined, undefined, { sqliteMode: "off", now });
const projected = await resolveSendReceipt(operationId, { registry, progress: null, client: {
  operationStatus: async id => journal.operationResult(id),
} as RuntimeHostClient });
await new StructuredDeliveryQueue({
  effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
  transition: async (...args) => { journal.transitionOperation(...args); },
  status: async id => journal.operationResult(id)?.receipt ?? null,
}, () => host).drain();
console.log(JSON.stringify({ receipt: journal.operationResult(operationId)?.receipt,
  writes: host.ledger.writes.length, effects: journal.effectBatch().length, projected }));
registry.close();
journal.close();
