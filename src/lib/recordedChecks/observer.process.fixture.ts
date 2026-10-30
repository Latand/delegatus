import fs from "node:fs";
import { agentRegistry } from "@/lib/agent/registry";
import { adoptCodexRegistryHosts, detachCodexHostForViewerRestart, codexHostColumns } from "@/lib/runtime/registry";
import { readCodexConfirmedDelivery, type CodexAppServerHostOptions } from "@/lib/runtime/codexAppServerHost";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { runtimeHostClient } from "@/lib/runtime/client";
import { adoptStructuredHostsAtStartup } from "@/lib/runtime/startup";
import { normalizeQueueEntry } from "@/lib/runtime/engineHost";
import { RecordedCheckObserver, productionObserverPorts } from "./observer";
import { recordedHostHeld } from "./store";
import { readEnvelope, writeEnvelope } from "./wire";
import { credentialFreeSocketFixture } from "./native.fixture";

credentialFreeSocketFixture();

const configuration = readEnvelope(process.argv[2]!) as {
  options: CodexAppServerHostOptions; ready: string; conversation: string; deliveries: string; pauseAfterDelivery?: string;
};
const registry = agentRegistry();
const adopted = await adoptStructuredHostsAtStartup({ registry, client: runtimeHostClient(),
  resolveCodexOwner: () => ({ home: configuration.options.codexHome!, kind: "legacy" }),
  adopt: (received, options, env, filter, processed, hooks) => adoptCodexRegistryHosts(received, async entry => {
    const built = await options(entry);
    return { ...configuration.options, ...built, env: { ...configuration.options.env, ...built.env, NODE_ENV: "test" } };
  }, { ...process.env, ...env }, filter, processed, hooks),
});
if (adopted.length > 1 || !adopted.length && recordedHostHeld(configuration.conversation))
  throw new Error("recorded fixture did not reconnect to its required native owner");
const item = adopted[0], host = item?.host;
await bindStructuredDeliveryQueue(adopted, { registry, client: runtimeHostClient(), watchdogIntervalMs: 0,
  hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
const observer = new RecordedCheckObserver({
  ...productionObserverPorts,
  async deliver(row) {
    const notice = row.notification!;
    const outcome = await productionObserverPorts.deliver(row);
    if (outcome.state === "delivered") {
      const confirmed = outcome.operation && await readCodexConfirmedDelivery(notice.path, normalizeQueueEntry({ id: outcome.operation, text: notice.text }));
      if (!confirmed) throw new Error("native completion lacks its original canonical operation receipt");
      if (configuration.pauseAfterDelivery && !fs.existsSync(configuration.pauseAfterDelivery)) {
        writeEnvelope(configuration.pauseAfterDelivery, { operation: outcome.operation, controller: process.pid });
        process.kill(process.pid, "SIGSTOP");
      }
      if (!fs.existsSync(configuration.deliveries)) fs.appendFileSync(configuration.deliveries, notice.key + "\n");
    }
    return outcome;
  },
});
await observer.start();
if (host) await new Promise<void>((resolve, reject) => {
  let unsubscribe = () => {};
  let settled = false;
  const timer = setTimeout(() => { unsubscribe(); reject(new Error("native fixture turn did not settle")); }, 30_000);
  unsubscribe = host.onStateChange(state => {
    if (!state.activeTurnRef) { settled = true; clearTimeout(timer); unsubscribe(); resolve(); }
  });
  if (settled) unsubscribe();
});
fs.writeFileSync(configuration.ready, JSON.stringify({ owner: host ? codexHostColumns(await host.health(), 1).process : null, controller: process.pid }));
process.stdout.write("ready\n");
process.on("SIGTERM", () => {
  observer.stop();
  void bindStructuredDeliveryQueue([], { registry, client: null })
    .then(() => item ? detachCodexHostForViewerRestart(registry, item.key, item.host) : undefined).then(() => process.exit(0));
});
process.stdin.resume();
