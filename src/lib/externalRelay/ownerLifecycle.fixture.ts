// Process fixture for durable restart recovery; never launches a real agent.
import fs from "node:fs";
import { runClaimedRequest, relayRequestInFlight } from "./runner";
import { sweepExternalRelayOrphans } from "./poller";
import { readRelayStore, readRunLedger } from "./store";
import { accountManager } from "@/lib/accounts/manager";

const { relay, request, phase, epoch, clockFile } = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
Date.now = () => clockFile ? Number(fs.readFileSync(clockFile, "utf8")) : epoch;
accountManager.resolveHeadlessSpawn = () => ({ kind: "available", account: {
  engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!,
  transcriptRoot: process.env.HOME!, env: { ...process.env } } });
const ports = {
  launch: async (body: Record<string, unknown>) => {
    console.log(`fixture-launch:${body.clientAttemptId}`);
    return { status: 202, body: { conversationId: "conversation_restart_fixture", initialMessage: "delivered" } };
  },
  observe: async () => {
    console.log("fixture-observing");
    if (phase !== "finish" && phase !== "complete-now") await new Promise(() => {});
    return { state: "ended" as const, finalText: "Restart answer" };
  },
  stop: async () => {},
};
const keepAlive = setInterval(() => {}, 1000);
try {
if (phase === "start" || phase === "complete-now") await runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: ports });
else {
  if (!readRelayStore().relays.length) throw new Error("missing durable pairing");
  await sweepExternalRelayOrphans(ports);
  for (;;) {
    const row = readRunLedger().runs.find(row => row.requestId === request.request_id);
    if (!relayRequestInFlight(request.request_id) && (!row || row.ownerTurn?.lateAnswer || row.ownerTurn?.completionAttempt || row.ownerTurn?.diagnostic)) break;
    await fs.promises.stat(process.argv[2]!);
  }
  console.log("fixture-finished");
}
} finally { clearInterval(keepAlive); }
