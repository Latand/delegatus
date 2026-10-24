// Process fixture for durable restart recovery; never launches a real agent.
import fs from "node:fs";
import { runClaimedRequest, relayRequestInFlight } from "./runner";
import { sweepExternalRelayOrphans } from "./poller";
import { readRelayStore, readRunLedger } from "./store";
import { accountManager } from "@/lib/accounts/manager";

const { relay, request, phase, epoch, clockFile, observedAt, finalText, controlFile } = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
let now = epoch;
Date.now = () => clockFile ? Number(fs.readFileSync(clockFile, "utf8")) : now;
const cap = phase.startsWith("cap-");
let observations = 0;
accountManager.resolveHeadlessSpawn = () => ({ kind: "available", account: {
  engine: "codex", accountId: "fixture", kind: "managed", home: process.env.HOME!,
  transcriptRoot: process.env.HOME!, env: { ...process.env } } });
const ports = {
  launch: async (body: Record<string, unknown>) => {
    console.log(`fixture-launch:${body.clientAttemptId}`);
    return { status: 202, body: { conversationId: "conversation_restart_fixture", initialMessage: cap ? "queued" : "delivered" } };
  },
  observe: async () => {
    console.log("fixture-observing");
    if (cap) {
      if (++observations === 1) {
        now += 3100; // Admit the queued progress change without a wall-clock wait.
        return { state: "running" as const, firstMessagePending: true };
      }
      if (phase === "cap-stalled") {
        console.log("fixture-blocked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      if (phase === "cap-unresponsive") await new Promise(() => {});
      while (await fs.promises.readFile(controlFile, "utf8") !== "finish") await Bun.sleep(10);
      return { state: "ended" as const, firstMessagePending: false, finalText: "Done" };
    }
    if (phase !== "finish" && phase !== "complete-now") await new Promise(() => {});
    if (observedAt !== undefined) await fs.promises.writeFile(clockFile, String(observedAt));
    return { state: "ended" as const, finalText: finalText ?? "Restart answer" };
  },
  stop: async (_id: string, action: string) => { console.log(`fixture-stop:${action}`); },
  pollMs: 10,
};
const keepAlive = setInterval(() => {}, 1000);
try {
if (phase === "start" || phase === "complete-now" || cap) {
  const result = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, ownerPorts: ports });
  console.log(`fixture-result:${JSON.stringify(result)}`);
}
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
