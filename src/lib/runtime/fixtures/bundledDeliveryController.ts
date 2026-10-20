import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "../client";
import { FakeEngineHost } from "./fakeEngineHost";

const directory = process.argv[2]!;
const key = JSON.parse(process.argv[3]!);
const instrumentation = await import(pathToFileURL(process.argv[4]!).href);
const route = await import(pathToFileURL(process.argv[5]!).href);
const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
const client = {
  snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
  append: async event => journal.append(event), producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
  effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
  operationStatus: async id => journal.operationResult(id),
  transitionOperation: async (...args) => journal.transitionOperation(...args),
} satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
let releases = 0;
const host = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {}, release: async () => { releases++; } });
try {
  await instrumentation.bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
  if (!route.hasStructuredDeliveryController(registry)) throw new Error("route did not find the controller");
  await route.publishStructuredDeliveryHost({ key, host });
  await route.bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
  const retained = instrumentation.hasStructuredDeliveryHost(key);
  await route.completeStructuredDeliveryQueueStartup([]);
  // Completion awaits the drain. Replaying it cannot write the original twice.
  await route.completeStructuredDeliveryQueueStartup([]);
  await route.releaseStructuredDeliveryHost(key);
  await route.releaseStructuredDeliveryHost(key);
  await route.bindStructuredDeliveryQueue([], { registry, client: null });
  console.log(JSON.stringify({ distinct: instrumentation !== route, retained, releases, writes: host.ledger.writes.length }));
} finally {
  await route.bindStructuredDeliveryQueue([], { registry, client: null });
  registry.close();
  journal.close();
}
