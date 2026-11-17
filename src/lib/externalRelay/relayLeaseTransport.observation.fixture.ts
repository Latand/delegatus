import { clonePairing } from "./clone.fixture";
import { InlineRelayLeaseTransport, RelayLeaseTransport } from "./relayLeaseTransport";

const relay = clonePairing(process.argv[2]!);
const Transport = process.argv[3] === "worker" ? RelayLeaseTransport : InlineRelayLeaseTransport;
let acknowledged!: () => void;
const first = new Promise<void>(resolve => { acknowledged = resolve; });
const transport = new Transport(relay, "private-request", "private-target", "private-lease", 60_000,
  frame => { if (frame.phase !== "attempt") acknowledged(); }, null);
try {
  await transport.ready;
  await first;
  const result = await transport.complete({ lease_id: "private-lease", outcome: "failed", reason: "cancelled", detail: null }, Date.now() + 1000, 4000);
  if (result.delivery !== "refused") throw new Error("local completion was not refused");
} finally { await transport.close(); }
