// A fresh runner and orphan sweep share durable state across process exits.
import { spyOn } from "bun:test";
import { accountManager } from "@/lib/accounts/manager";
import { CloudFailure } from "./cloud";
import { contextRequest } from "./request.fixture";
import { runClaimedRequest } from "./runner";
import { sweepExternalRelayOrphans } from "./poller";
import { changeRunAsync, readRunLedger, updateRelayStore, type PairedRelay } from "./store";
import * as client from "./client";

const [mode, tier] = process.argv.slice(2);
const relay: PairedRelay = { id: "cloud_custody", origin: "http://127.0.0.1:1", api_base: "http://127.0.0.1:1/v1", name: "Relay", description: "", credential: "fixture",
  owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null }, pairedAt: "2026-10-20T12:00:00Z", paused: false,
  limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
  targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true, ownerTier: true,
    engine: "codex-cloud", model: "gpt-6.1-sol", effort: null, project: "repository", cloudEnvironmentId: "repo-env", concurrency: 1, hardCapMinutes: 1 }] };
updateRelayStore(store => ({ ...store, relays: [relay] }));
let cloud = 0, local = 0, stops = 0;
const selection = spyOn(accountManager, "resolveHeadlessSpawn").mockImplementation(() => { local++; throw Error("unexpected local admission"); });
const wire = spyOn(client, "relayCall").mockImplementation(async (_base, route) => {
  if (mode === "refused" && route.endsWith("/complete")) throw new client.ExternalRelayError("lease_lost", 409);
  if (mode === "completed" && route.endsWith("/complete")) { process.send?.({ type: "started" }); await new Promise(() => {}); }
  return { status: 200, body: { status: "ok" } } as never;
});
try {
  if (mode === "redeliver") await sweepExternalRelayOrphans({ launch: async () => { throw Error("unexpected launch"); },
    observe: async () => ({ state: "ended", finalText: "" }), stop: async () => { stops++; } });
  const request = { ...contextRequest, request_id: "uncertain_custody", answer: { max_chars: 4000, progress: "none" },
    input: { ...contextRequest.input, tools: [], requester: { ...contextRequest.input.requester, is_owner: tier === "owner" } } };
  const result = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, cloudTransport: async () => {
    cloud++;
    if (mode === "completed" || mode === "refused") return JSON.stringify({ action: "reply", text: "Done", reply_to: "m1" });
    if (mode === "crash") { process.send?.({ type: "started" }); await new Promise(() => {}); }
    throw new CloudFailure(false);
  } });
  if (mode === "acknowledged") await changeRunAsync("uncertain_custody", row => ({ ...row, completionAccepted: true, capacityReleased: true }), Date.now() + 5000);
  // A second delivery in the same process is fenced as well.
  const second = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, cloudTransport: async () => { cloud++; throw new CloudFailure(false); } });
  console.log(JSON.stringify({ result, second, cloud, local, stops, rows: readRunLedger().runs.map(row => ({ requestId: row.requestId, cloudExecution: row.cloudExecution })) }));
} finally { selection.mockRestore(); wire.mockRestore(); }
