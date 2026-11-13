import { createToolLoop } from "./toolLoop";
import { x1Request } from "./toolLoop.fixture";
import { claimRelayRequestAsync, externalRelayFile, reserveRelayActionVerificationAsync, settleRelayRequestClaimAsync, type PairedRelay } from "./store";
import { procBackend } from "../proc";
import fs from "node:fs";

const [origin, requestId, phase] = process.argv.slice(2);
Date.now = () => 2_000_000_000_000 + (phase === "expired" ? 60_000 : 0);
const request = x1Request("actions_admin");
request.request_id = requestId!;
const claim = await claimRelayRequestAsync(request.request_id, request.lease_id, Date.now() + 5000);
if (claim.kind !== "claimed") throw new Error("client did not acquire request claim");
if (phase === "legacy") {
  const file = externalRelayFile("requests");
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const state of Object.values(ledger.actionVerifications[request.request_id]) as { sent?: true }[]) delete state.sent;
  fs.writeFileSync(file, JSON.stringify(ledger));
}
const loop = createToolLoop({ api_base: `${origin}/v1`, credential: "x".repeat(43) } as PairedRelay, request, {
  signal: new AbortController().signal,
  ack: async () => true,
  beforeSend: () => { if (phase === "before_send_crash") process.exit(0); },
  lose: () => { throw new Error("unexpected lease loss"); },
  verificationBudget: (id, until, consume) => reserveRelayActionVerificationAsync(request.request_id, request.lease_id, id, until, consume),
}, { sleep: async () => { if (phase === "crash") process.exit(0); } });
await loop.runCalls([{ tool: "request_trigger_rule_update", arguments: JSON.stringify({ name: "Sample" }), cursor: null }], 1);
await settleRelayRequestClaimAsync(request.request_id, request.lease_id, process.pid, procBackend.processIdentity(process.pid)!, "release", null, Date.now() + 5000);
console.log(JSON.stringify(loop.results));
