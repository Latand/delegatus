import fs from "node:fs";
import { agentRegistry } from "@/lib/agent/registry";
import { adoptCodexRegistryHosts, detachCodexHostForViewerRestart, codexHostColumns } from "@/lib/runtime/registry";
import { readCodexConfirmedDelivery, type CodexAppServerHostOptions } from "@/lib/runtime/codexAppServerHost";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { runtimeHostClient } from "@/lib/runtime/client";
import { normalizeQueueEntry } from "@/lib/runtime/engineHost";
import { RecordedCheckObserver, productionObserverPorts } from "./observer";
import { readEnvelope } from "./wire";

const configuration = readEnvelope(process.argv[2]!) as {
  options: CodexAppServerHostOptions; ready: string; conversation: string; deliveries: string;
};
const registry = agentRegistry();
const adopted = await adoptCodexRegistryHosts(registry, () => configuration.options, process.env,
  entry => registry.conversationForPath(entry.artifactPath)?.id === configuration.conversation);
if (adopted.length !== 1) throw new Error("recorded fixture did not reconnect to its original native owner");
const item = adopted[0]!;
const host = item.host;
await bindStructuredDeliveryQueue(adopted, { registry, client: runtimeHostClient(), watchdogIntervalMs: 0,
  hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
const observer = new RecordedCheckObserver({
  ...productionObserverPorts,
  async deliver(row) {
    const notice = row.notification!;
    const outcome = await productionObserverPorts.deliver(row);
    if (outcome.state === "delivered") {
      const confirmed = outcome.operation && await readCodexConfirmedDelivery(host.identity.path!, normalizeQueueEntry({ id: outcome.operation, text: notice.text }));
      if (!confirmed) throw new Error("native completion lacks its original canonical operation receipt");
      if (!fs.existsSync(configuration.deliveries)) fs.appendFileSync(configuration.deliveries, notice.key + "\n");
    }
    return outcome;
  },
});
await observer.start();
await new Promise<void>((resolve, reject) => {
  let unsubscribe = () => {};
  let settled = false;
  const timer = setTimeout(() => { unsubscribe(); reject(new Error("native fixture turn did not settle")); }, 30_000);
  unsubscribe = host.onStateChange(state => {
    if (!state.activeTurnRef) { settled = true; clearTimeout(timer); unsubscribe(); resolve(); }
  });
  if (settled) unsubscribe();
});
fs.writeFileSync(configuration.ready, JSON.stringify({ owner: codexHostColumns(await host.health(), 1).process, controller: process.pid }));
process.stdout.write("ready\n");
process.on("SIGTERM", () => {
  observer.stop();
  void bindStructuredDeliveryQueue([], { registry, client: null })
    .then(() => detachCodexHostForViewerRestart(registry, item.key, host)).then(() => process.exit(0));
});
process.stdin.resume();
