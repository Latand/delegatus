import path from "node:path";
import { readSeatQuotaControlPage, recoverSeatQuota, readSeatQuotaObligation, type SeatQuotaRecoveryPorts } from "../seatQuotaRecovery";
import { RuntimeJournal } from "@/runtime-host/journal";

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
const ports: SeatQuotaRecoveryPorts = {
  now: () => phase === "before-reset" ? cut + 1 : reset,
  seat: () => ({ conversationId: "conversation_seat", seatEpoch: 7, designatedAt: new Date(cut - 60_000).toISOString() }),
  held: () => false, current: () => true,
  stopped: async (conversationId, since, cursor) => phase.startsWith("control-")
    ? readSeatQuotaControlPage({ effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after) }, conversationId, since, cursor) : false,
  observe: async () => ({ accountId: "account-a", path: "seat.jsonl", capacity: "unknown", observedAt: null, resetsAt: reset / 1000,
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
try { await recoverSeatQuota("fixture", ports); }
catch (error) { if (phase !== "ack-lost" && phase !== "control-page") throw error; }
const row = readSeatQuotaObligation("fixture");
console.log(JSON.stringify({ id: row?.id, state: row?.state, cursor: row?.controlCursor, replayed, count: journal.effectBatch(100, ["runtime.send"]).length }));
journal.close();
