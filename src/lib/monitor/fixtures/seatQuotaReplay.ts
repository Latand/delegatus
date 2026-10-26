import path from "node:path";
import { cancelSeatQuotaOnControl, readSeatQuotaControlPage, recoverSeatQuota, readSeatQuotaObligation, seatQuotaDispatchGuard, type SeatQuotaRecoveryPorts } from "../seatQuotaRecovery";
import { RuntimeJournal } from "@/runtime-host/journal";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { StructuredDispatchDeferredError, StructuredSendRefusedError } from "@/lib/runtime/engineHost";
import { setSystemTime } from "bun:test";

const phase = process.argv[2];
const cut = Date.parse("2026-10-26T10:00:00Z");
const reset = cut + 600_000;
const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, "runtime.sqlite"), { now: () => reset });
if (!journal.readSession({ conversationId: "conversation_seat" })) journal.append({ scope: { type: "session", id: "conversation_seat" },
  kind: "session-status", payload: { conversationId: "conversation_seat", sessionKey: { engine: "claude", sessionId: "seat-session" },
    hostKind: "claude-broker", host: "hosted", turn: "idle", activeTurnId: null, writerClaim: "fixture:1" } });
if (phase === "control-page") for (let index = 0; index < 101; index++) {
  journal.append({ scope: { type: "system", id: "fixture" }, kind: "fixture-control", effect: {
    id: `fixture-stop-${index}`, kind: "runtime.stop-boundary", payload: { operationId: `stop-${index}`,
      conversationId: index === 100 ? "conversation_seat" : "conversation_other", origin: "operator", originAuthenticated: true,
      admittedAt: new Date(cut + 1).toISOString() } }, payload: {} });
}
let replayed = false;
let now = phase === "before-reset" || phase.endsWith("-persist") ? cut + 1 : reset;
let exhausted = false;
let project = "fixture";
const ports: SeatQuotaRecoveryPorts = {
  now: () => now,
  seat: () => {
    if (!phase.startsWith("alias-control-")) return { conversationId: "conversation_seat", seatEpoch: 7, designatedAt: new Date(cut - 60_000).toISOString() };
    const seat = orchestratorSeatFor(project).active;
    return seat?.conversationId ? { conversationId: seat.conversationId, seatEpoch: seat.seatEpoch, designatedAt: seat.designatedAt } : null;
  },
  held: () => false, current: () => true,
  stopped: async (conversationId, since, cursor) => phase.startsWith("control-")
    ? readSeatQuotaControlPage({ effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after) }, conversationId, since, cursor) : false,
  observe: async () => ({ accountId: "account-a", path: "seat.jsonl", capacity: exhausted ? "exhausted" : "unknown",
    observedAt: exhausted ? now : null, resetsAt: exhausted ? null : reset / 1000,
    request: { operationId: "original-operation", clientMessageId: "original-submission", createdAt: new Date(cut - 1000).toISOString() },
    evidence: { turn: "terminal", message: null, promptHistoryComplete: true, requestedCutOpen: true,
      terminalProviderMessage: { ts: cut, text: "You've hit your session limit", errorClass: "rate_limit", usageLimit: { resetsAt: reset / 1000 } } } }),
  send: async request => {
    const result = journal.executeOperation({ kind: "send", operationId: request.operationId, idempotencyKey: request.clientMessageId!,
      conversationId: request.conversationId!, text: request.text, origin: request.origin });
    replayed = result.replayed;
    if (phase === "ack-lost") throw new Error("ack lost after journal commit");
  },
};
if (phase === "alias-control-persist") {
  const at = new Date(cut - 60_000).toISOString();
  beginOrchestratorSeatIntent({ project, mandate: "coordinate work", clientRequestId: "alias-seat", mode: "existing", now: at });
  completeOrchestratorSeatIntent({ project, clientRequestId: "alias-seat", conversationId: "conversation_seat", path: "seat.jsonl", now: at });
}
try { await recoverSeatQuota(project, ports); }
catch (error) { if (phase !== "ack-lost" && phase !== "control-page") throw error; }
let refused = false;
if (phase === "exhaustion-persist") { now = reset + 1; exhausted = true; }
if (phase === "exhaustion-reopen") now = reset + 600_000;
if (phase === "alias-control-persist") {
  setSystemTime(cut + 1); await cancelSeatQuotaOnControl("conversation_seat"); setSystemTime();
  if (!persistProjectAliases([{ source: project, target: "current", displayName: "Project" }])) throw new Error("alias refused");
}
if (phase === "alias-control-reopen") { project = "current"; await recoverSeatQuota(project, ports); }
if (phase.startsWith("exhaustion-") || phase.startsWith("alias-control-")) {
  try { await seatQuotaDispatchGuard(project, ports); }
  catch (error) {
    if (!(error instanceof StructuredDispatchDeferredError || error instanceof StructuredSendRefusedError)) throw error;
    refused = true;
  }
}
const row = readSeatQuotaObligation(project);
console.log(JSON.stringify({ id: row?.id, state: row?.state, cursor: row?.controlCursor, refused, replayed, count: journal.effectBatch(100, ["runtime.send"]).length }));
journal.close();
