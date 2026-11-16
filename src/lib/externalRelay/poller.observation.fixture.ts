import { clonePairing } from "./clone.fixture";
import { ensureExternalRelayPollers, relayPollerStatus, stopExternalRelayPollers, wakeExternalRelayPoller } from "./poller";
import { updateRelayStore } from "./store";

const relay = { ...clonePairing(process.argv[2]!), paused: false };
updateRelayStore(store => ({ ...store, relays: [relay] }));
try {
  ensureExternalRelayPollers();
  const deadline = performance.now() + 10_000;
  while (relayPollerStatus(relay.id).state !== "credential_rejected") {
    if (performance.now() >= deadline) throw new Error("local poll fixture did not park");
    if (relayPollerStatus(relay.id).state === "unreachable") wakeExternalRelayPoller(relay.id);
    await Bun.sleep(5);
  }
  const modulePath = "./poller.ts";
  const routeCopy = await import(`${modulePath}?status-reader`);
  console.log("POLL_STATUS " + JSON.stringify(routeCopy.relayPollerStatus(relay.id).poll));
} finally { stopExternalRelayPollers(); }
