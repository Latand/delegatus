import path from "node:path";
import fs from "node:fs";
import { cancelSeatQuotaOnControl, defaultSeatQuotaRecoveryPorts, readSeatQuotaControlPage, recoverSeatQuota, readSeatQuotaObligation, seatQuotaDispatchGuard, type SeatQuotaRecoveryPorts } from "../seatQuotaRecovery";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { StructuredDispatchDeferredError, StructuredSendRefusedError } from "@/lib/runtime/engineHost";
import { setSystemTime } from "bun:test";

const phase = process.argv[2];
const cut = Date.parse("2026-10-26T10:00:00Z");
const reset = cut + 600_000;
if (phase.startsWith("native-")) {
  await nativeQuotaReplay();
  process.exit(0);
}

async function nativeQuotaReplay() {
  const scenario = process.argv[3];
  const directory = process.env.LLV_STATE_DIR!;
  const transcript = path.join(directory, "33333333-3333-\x34333-8333-333333333333.jsonl");
  const later = reset + 3_600_000;
  const positive = scenario === "positive";
  const sampleAt = positive ? cut + 1000 : reset + 1;
  let now = phase === "native-persist" ? cut - 1000 : positive ? cut + 361_001 : reset + 360_001;
  if (phase === "native-release") now = positive ? reset : later;
  setSystemTime(now);
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  setAgentRegistryForTests(registry);
  const sample = (at: number, usedPercent: number) => registry.recordQuotaObservation({ engine: "claude", accountId: "account-a",
    authenticated: true, authCheckedAt: new Date(at).toISOString(), observedAt: new Date(at).toISOString(), bootId: "quota-replay",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: { usedPercent, resetsAt: scenario === "unknown" ? null : later / 1000 }, weekly: null,
      plan: "max", capturedAt: Math.floor(at / 1000) } });
  let count = 0;
  let refused = false;
  const ports: SeatQuotaRecoveryPorts = { ...defaultSeatQuotaRecoveryPorts(), held: () => false, stopped: async () => false,
    send: async (_request, allowed) => { if (await allowed()) count++; } };
  try {
    if (phase === "native-persist") {
      fs.writeFileSync(transcript, [
        { type: "user", timestamp: new Date(cut - 500).toISOString(), message: { role: "user", content: "check existing work" } },
        { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit",
          message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
            content: [{ type: "text", text: "You've hit your session limit · resets 10:10am (UTC)" }] } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      registry.reconcileConversations([{ engine: "claude", path: transcript, accountId: "account-a",
        launchProfile: emptyLaunchProfile({ cwd: directory, project: "fixture", model: "opus" }),
        turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date(now).toISOString() }]);
      const conversation = registry.conversationForPath(transcript)!;
      const delivery = registry.holdDelivery(conversation.id, "check existing work", "native-submission", "text", [], null,
        { operationId: "native-operation" });
      now = cut + 1; setSystemTime(now); registry.recordDeliveryOutcome(delivery.id, "delivered");
      const at = new Date(cut - 60_000).toISOString();
      beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate work", clientRequestId: "native-seat", mode: "existing", now: at });
      completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "native-seat", conversationId: conversation.id, path: transcript, now: at });
      await recoverSeatQuota("fixture", ports);
      // No recovery observes this sample until another process opens it after aging.
      sample(sampleAt, positive ? 20 : 100);
    } else {
      // Replacing the sample after retention proves the hold is in the obligation.
      if (phase === "native-replay") sample(cut + 1000, 20);
      if (phase === "native-release" && scenario === "unknown") sample(now, 20);
      if (phase === "native-recover") await recoverSeatQuota("fixture", ports);
      try { (await seatQuotaDispatchGuard("fixture", ports))(); }
      catch (error) {
        if (!(error instanceof StructuredDispatchDeferredError)) throw error;
        refused = true;
      }
      if (phase !== "native-guard" && phase !== "native-recover") await recoverSeatQuota("fixture", ports);
    }
    const row = readSeatQuotaObligation("fixture");
    console.log(JSON.stringify({ id: row?.id, state: row?.state, resetsAt: row?.resetsAt,
      capacityObservedAt: row?.capacityObservedAt, count, refused }));
  } finally { registry.close(); setAgentRegistryForTests(null); setSystemTime(); }
}

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
