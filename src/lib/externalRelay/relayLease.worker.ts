import { createInterface } from "node:readline";
import { completeRelayRequest } from "./relayCompletion";
import { ExternalRelayError, relayCall } from "./client";
import { ownerRelayAuthorized, ownerRelayFailureReplyAuthorized, ownerRelayStatusReplyAuthorized } from "./ownerAuthority";
import type { PairedRelay } from "./store";
import type { ExternalRelayCompletion, ExternalRelayProgress } from "./protocol";

type Start = { type: "start"; relay: PairedRelay; requestId: string; targetId: string; leaseId: string; intervalMs: number; progress: ExternalRelayProgress | null };
type Command = { type: "progress"; progress: ExternalRelayProgress | null }
  | { type: "complete"; body: ExternalRelayCompletion; until: number; plainMax: number; ownerAuthorization: boolean | "status" | "failure" }
  | { type: "stop" };
let start: Start | undefined;
let progress: ExternalRelayProgress | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextDue = 0;
let stopped = false;
let busy = false;
let completionAccepted = false;
let completionInFlight = false;
let completionLeaseLost: { status: number; code: string } | undefined;
let heartbeatSettled: Promise<void> = Promise.resolve();
let settleHeartbeat!: () => void;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
async function beat() {
  if (!start || stopped || busy) return;
  busy = true;
  heartbeatSettled = new Promise<void>(resolve => { settleHeartbeat = resolve; });
  const current = ++seq, sent = progress;
  send({ type: "heartbeat", seq: current, phase: "attempt", status: 0 });
  try {
    const response = await relayCall(start.relay.api_base, `/requests/${encodeURIComponent(start.requestId)}/heartbeat`, "POST",
      { lease_id: start.leaseId, seq: current, progress: sent }, start.relay.credential,
      { timeoutMs: 5000, maxBytes: start.relay.limits.max_response_bytes });
    send({ type: "heartbeat", seq: current, phase: "acknowledged", status: response.status });
    if (progress === sent) progress = null;
  } catch (error) {
    const status = error instanceof ExternalRelayError ? error.status : 0;
    const code = error instanceof ExternalRelayError ? error.code : "transport_error";
    const leaseLost = status === 404 || status === 409 && code === "lease_lost";
    const phase = completionAccepted && leaseLost ? "post_completion" : completionInFlight && leaseLost ? "completion_pending" : "failed";
    send({ type: "heartbeat", seq: current, phase, status, code });
    if (phase === "completion_pending") completionLeaseLost = { status, code };
    if (phase === "failed" && leaseLost) stopped = true;
  } finally {
    busy = false;
    settleHeartbeat();
    if (!stopped) {
      const now = Date.now();
      if (nextDue < now) nextDue = now;
      timer = setTimeout(() => void beat(), Math.max(0, nextDue - now));
      nextDue += start!.intervalMs;
    }
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  let command: Start | Command;
  try { command = JSON.parse(line) as Start | Command; } catch { process.exit(1); return; }
  if (command.type === "start") {
    if (start) { process.exit(1); return; }
    start = command;
    progress = command.progress;
    nextDue = Date.now() + command.intervalMs;
    send({ type: "ready" });
    setImmediate(() => void beat());
    return;
  }
  if (!start) { process.exit(1); return; }
  if (command.type === "progress") { progress = command.progress; return; }
  if (command.type === "stop") { stopped = true; clearTimeout(timer); return; }
  if (command.type === "complete") {
    const body = command.body;
    completionInFlight = true;
    void completeRelayRequest(start.relay, start.requestId, body, () => command.until,
      command.ownerAuthorization ? () => command.ownerAuthorization === "status"
        ? ownerRelayStatusReplyAuthorized(start!.relay.id, start!.targetId, start!.requestId, body, command.plainMax)
        : (command.ownerAuthorization === "failure" ? ownerRelayFailureReplyAuthorized : ownerRelayAuthorized)(start!.relay.id, start!.targetId, start!.requestId) : undefined,
      async () => { send({ type: "refresh_features" }); }, command.plainMax)
      .then(async result => {
        completionInFlight = false;
        if (result.delivery === "accepted") completionAccepted = true;
        stopped = true; clearTimeout(timer);
        send({ type: "completion", result });
        if (busy) await heartbeatSettled;
        if (completionLeaseLost) send({ type: "heartbeat", seq, phase: result.delivery === "accepted" ? "post_completion" : "failed", ...completionLeaseLost });
        send({ type: "drained" });
      }).catch(async () => {
        completionInFlight = false; stopped = true; clearTimeout(timer);
        send({ type: "completion", error: true });
        if (busy) await heartbeatSettled;
        send({ type: "drained" });
      });
  }
});
input.once("close", () => { stopped = true; clearTimeout(timer); });
