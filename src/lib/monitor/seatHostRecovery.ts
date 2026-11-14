import type { OriginalSendBinding, SendReceipt } from "@/lib/runtime/sendSettlement";
import { readDeliveryProgress } from "@/lib/runtime/deliveryProgress";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";
import { parseMessageOrigin, type MessageOrigin } from "@/lib/runtime/messageOrigin";
import { blockingHostActivityFlags } from "@/lib/runtime/hostActivityFlags";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { activeRestartGate } from "@/lib/selfUpdate/restartGate";
import { statePath } from "@/lib/configDir";
import { seatRequestControlled } from "./seatQuotaRecovery";
import { effectiveSeatTickSettings } from "./seatTickSettings";
import { SEAT_TICK_DELIVERY_ALARM_MS } from "./seatTickWatchdog";
import { assertSeatTickWork } from "./seatTickWork";
import type { SeatTickSources } from "./seatTickSources";
import type { SeatTickProjectState } from "./types";
import type { deliverConversationMessage } from "@/lib/delivery";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { createHash } from "node:crypto";
import type { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import type { SeatTickCard } from "./types";
import { redactMonitorText } from "./redact";

export interface SeatHostRecovery {
  id: string;
  conversationId: string;
  seatEpoch: number;
  at: string;
  state: "revived" | "pending" | "rotated" | "failed" | "superseded";
  detail: string;
  told: boolean;
  incoming?: { since: string; episodeId?: string; dispatchPhase?: "nudge" | "revive"; phase: "nudge" | "cleanup" | "revive"; attemptedAt: string; hostIdentity?: string; recovery?: { text: string; origin: MessageOrigin } };
}

export interface SeatHostRecoveryPorts {
  rotate?: typeof executeOrchestratorRotation;
  client?: import("@/lib/runtime/client").RuntimeHostClient | null;
  cleanup?: (conversationId: string, guard: () => boolean, idle: () => Promise<boolean>) => Promise<boolean>;
  delivery?: (binding: OriginalSendBinding) => Promise<{ kind: "absent" | "unknown" } | { kind: "found"; receipt: SendReceipt }>;

}

export function seatHostRecoveryKey(project: string, epoch: number, conversationId: string): string {
  return `seat-host-recovery-${createHash("sha256").update(JSON.stringify([project, epoch, conversationId])).digest("hex")}`;
}

export function normalizeSeatHostRecovery(value: unknown): SeatHostRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<SeatHostRecovery>;
  if (typeof v.id !== "string" || v.id.length > 200 || typeof v.conversationId !== "string"
    || !Number.isSafeInteger(v.seatEpoch) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))
    || !["revived", "pending", "rotated", "failed", "superseded"].includes(v.state ?? "") || typeof v.detail !== "string") return undefined;
  return { id: v.id, conversationId: v.conversationId, seatEpoch: v.seatEpoch!, at: v.at,
    state: v.state!, detail: redactMonitorText(v.detail).slice(0, 500), told: v.told === true,
    ...(v.incoming && Number.isFinite(Date.parse(v.incoming.since)) && Number.isFinite(Date.parse(v.incoming.attemptedAt))
      && ["nudge", "cleanup", "revive"].includes(v.incoming.phase) ? { incoming: { since: v.incoming.since,
        phase: v.incoming.phase, attemptedAt: v.incoming.attemptedAt,
        ...(typeof v.incoming.episodeId === "string" ? { episodeId: v.incoming.episodeId } : {}),
        ...(v.incoming.dispatchPhase === "nudge" || v.incoming.dispatchPhase === "revive" ? { dispatchPhase: v.incoming.dispatchPhase } : {}),
        ...(typeof v.incoming.hostIdentity === "string" && v.incoming.hostIdentity.length <= 500 ? { hostIdentity: v.incoming.hostIdentity } : {}),
        ...(v.incoming.recovery && typeof v.incoming.recovery.text === "string" && v.incoming.recovery.text.length <= 500
          && parseMessageOrigin(v.incoming.recovery.origin) ? { recovery: { text: v.incoming.recovery.text,
            origin: parseMessageOrigin(v.incoming.recovery.origin)! } } : {}) } } : {}) };
}

export function seatHostRecoveryCard(record: SeatHostRecovery, locale: "uk" | "en"): SeatTickCard {
  const title = locale === "uk" ? "Відновлення оркестратора" : "Orchestrator recovery";
  const states = locale === "uk"
    ? { revived: "Сесію відновлено. Стан MCP перевірено повторно; повідомлення зберігає початковий ключ.",
      pending: "Сесію не вдалося відновити. Ротацію розпочато; недоставлена робота залишається в обліку.",
      rotated: "Сесію не вдалося відновити. Оркестратора замінено; недоставлена робота залишається заборгованою.",
      failed: "Відновлення та ротація не вдалися. Потрібна допомога оператора; недоставлена робота збережена.",
      superseded: "Під час відновлення оркестратора вже замінено. Недоставлена робота збережена." }
    : { revived: "The session was revived. MCP health was checked again; delivery keeps its original key.",
      pending: "Revival failed. Rotation started; undelivered work remains accounted for.",
      rotated: "Revival failed. The orchestrator was replaced; undelivered work remains owed.",
      failed: "Revival and rotation failed. Operator help is needed; undelivered work is preserved.",
      superseded: "The orchestrator changed during recovery. Undelivered work is preserved." };
  // A successful revival is already recorded in seat state. Resolving its
  // notice creates no task; failures still need an actionable board card.
  // Success has already been persisted in the seat state. Give its resolved
  // acknowledgement a separate key so replay cannot close a legacy notice
  // found by the old recovery key; resolved cards with no match create nothing.
  const incomingText = record.incoming && locale === "uk"
    ? record.state === "revived" ? "Доставку відновлено. Повідомлення отримало підтвердження."
      : /held|withheld|unconfirmed|uncertain|unreadable|pending/.test(record.detail)
        ? "Відновлення очікує підтвердження стану сесії або завершення її роботи. Причину збережено в деталях."
        : record.incoming.phase === "nudge" ? "Повідомлення не доходять. Надсилаємо одне контрольне пробудження."
          : record.incoming.phase === "cleanup" ? "Контрольне пробудження не дійшло. Відновлюємо хост сесії після перевірки її роботи."
            : "Хост сесії завершено. Піднімаємо його знову; недоставлена робота залишається в обліку."
    : record.incoming ? record.detail : null;
  return { ref: record.state === "revived" ? "seat-host-recovery-success" : "seat-host-recovery", kind: "host-recovery", instance: record.id, state: record.state === "revived" ? "resolved" : "open",
    detail: `${title}\n${incomingText ?? states[record.state]}`, record: `${record.at}: ${record.state}; ${record.detail}` };
}

/** Incoming failures enter the existing hostRecovery owner before ordinary
 * agenda wakes. Keyed recipient reads and bounded liveness probes serve each pass.
 */
export async function recoverFailedSeatDeliveries(context: {
  project: string; sources: SeatTickSources;
  read(): SeatTickProjectState;
  persist(record: SeatHostRecovery): Promise<void>;
  tell(record: SeatHostRecovery): Promise<void>;
  deliver: typeof deliverConversationMessage;
  ports: SeatHostRecoveryPorts;
  rotate(seat: { conversationId: string; seatEpoch: number }, detail: string, guard: () => void): Promise<void>;
}): Promise<string | null> {
  const { project, sources } = context;
  const seat = sources.seatFor(project).active;
  if (!seat?.conversationId || !seat.path) return null;
  const registry = sources.registry();
  const health = registry.incomingDeliveryHealth?.(seat.conversationId);
  const previous = context.read().hostRecovery;
  if (previous?.incoming && previous.state === "pending" && previous.conversationId === seat.conversationId
    && previous.seatEpoch === seat.seatEpoch && health?.lastDeliveredAt
    && Date.parse(health.lastDeliveredAt) >= Date.parse(previous.incoming.since)) {
    await context.persist({ ...previous, state: "revived", detail: "Incoming delivery recovery: a later delivery arrived", told: false });
  }
  if (!health?.firstFailedAt || !health.episodeId || health.failures < 2
    || sources.now() - Date.parse(health.firstFailedAt) < SEAT_TICK_DELIVERY_ALARM_MS
    || seat.designatedAt && Date.parse(health.firstFailedAt) < Date.parse(seat.designatedAt)) return null;
  const since = health.firstFailedAt;
  const episodeId = health.episodeId;
  const refusal = health.lastOperationId ? readDeliveryProgress([health.lastOperationId]).get(health.lastOperationId)?.refusal : null;
  const cause = refusal ? `${refusal.component}/${refusal.stage}: ${refusal.reason}` : health.cause ?? "delivery-settlement: failed";
  const now = () => new Date(sources.now()).toISOString();
  const same = () => {
    assertSeatTickWork();
    const current = sources.seatFor(project);
    const row = context.read();
    const fresh = registry.incomingDeliveryHealth(seat.conversationId!);
    return current.active?.conversationId === seat.conversationId && current.active.seatEpoch === seat.seatEpoch
      && !current.pending && !activeDrain() && !activeRestartGate(statePath("self-update", "auto-admission.json"))
      && effectiveSeatTickSettings(sources.settings(project), sources.now(), 30 * 60_000).enabled
      && !(row.authIncident && row.authIncident.recoveredThrough === undefined)
      && !seatRequestControlled(project, { conversationId: seat.conversationId!, seatEpoch: seat.seatEpoch }, since)
      && fresh?.firstFailedAt === since && fresh.episodeId === episodeId && fresh.failures >= 2;
  };
  const workHeldNow = () => {
    const conversation = registry.conversation(seat.conversationId as never);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation || !["idle", "terminal"].includes(conversation.turn.state)
      || conversation.migration || conversation.switchHold || conversation.reconfigure?.status === "applying") return true;
    const entry = registry.hostEntry({ engine: conversation.engine, sessionId: generation.id });
    const host = entry?.structuredHost;
    return !!(entry?.host || entry?.pendingAction || host && (host.activeTurnRef !== null || host.pendingAttention.length
      || host.providerRetry || blockingHostActivityFlags(host.activeFlags).length));
  };
  let idleIdentity: string | null = null;
  const identityNow = () => {
    const conversation = registry.conversation(seat.conversationId as never);
    const generation = conversation?.generations.at(-1);
    const entry = conversation && generation ? registry.hostEntry({ engine: conversation.engine, sessionId: generation.id }) : null;
    return JSON.stringify([conversation?.turn, generation?.id, entry?.claimEpoch, entry?.claimOwner, entry?.structuredHost]);
  };
  const idle = async () => {
    if (!same() || (registry.incomingDeliveryHealth(seat.conversationId!)?.uncertain ?? 0) > 0) return false;
    const before = registry.conversation(seat.conversationId as never);
    const generation = before?.generations.at(-1);
    if (!before || !generation || before.turn.state !== "idle" || before.migration || before.switchHold
      || before.reconfigure?.status === "applying") return false;
    const key = { engine: before.engine, sessionId: generation.id };
    const entry = registry.hostEntry(key);
    const host = entry?.structuredHost;
    if (!entry || entry.host || entry.pendingAction || !host?.process || host.activeTurnRef !== null
      || host.pendingAttention.length || host.providerRetry || blockingHostActivityFlags(host.activeFlags).length) return false;
    const identity = JSON.stringify([before.turn, generation.id, entry.claimEpoch, entry.claimOwner, host]);
    const rows = await sources.liveness({ conversationId: seat.conversationId!, stallAfterMs: 0, limit: 1 });
    if (!same() || (registry.incomingDeliveryHealth(seat.conversationId!)?.uncertain ?? 0) > 0) return false;
    const current = registry.conversation(seat.conversationId as never);
    const currentEntry = registry.hostEntry(key);
    const row = rows.find(row => row.conversationId === seat.conversationId);
    const settled = JSON.stringify([current?.turn, current?.generations.at(-1)?.id, currentEntry?.claimEpoch,
      currentEntry?.claimOwner, currentEntry?.structuredHost]) === identity
      && row?.verified === true && row.host.state === "alive" && row.turnState === "idle"
      && row.reason === "host_alive_turn_idle" && row.activity?.state === "idle";
    idleIdentity = settled ? identity : null;
    return settled;
  };
  const hostIdentity = () => {
    const conversation = registry.conversation(seat.conversationId as never);
    const generation = conversation?.generations.at(-1);
    const entry = conversation && generation ? registry.hostEntry({ engine: conversation.engine, sessionId: generation.id }) : null;
    const captured = record?.incoming?.hostIdentity;
    if (captured && entry?.claimOwner === null && entry.structuredHost?.writerClaimEpoch === entry.claimEpoch) {
      try {
        const [sessionId, epoch, , process] = JSON.parse(captured) as [string, number, unknown, { pid: number; startIdentity: string; bootEpoch?: string }];
        if (sessionId === generation?.id && epoch === entry.claimEpoch && process
          && entry.structuredTerminationSurvivors?.some(row => row.pid === process.pid
            && row.startIdentity === process.startIdentity && row.bootEpoch === process.bootEpoch)) return captured;
      } catch { /* A malformed prior identity grants no cleanup authority. */ }
    }
    return JSON.stringify([generation?.id, entry?.claimEpoch, entry?.claimOwner, entry?.structuredHost?.process]);
  };
  let record = context.read().hostRecovery;
  if (record && record.state === "pending" && record.incoming?.episodeId !== episodeId)
    return "incoming delivery recovery held: another host recovery owns the seat";
  if (!record?.incoming || record.incoming.episodeId !== episodeId) record = {
    id: seatHostRecoveryKey(project, seat.seatEpoch, seat.conversationId), conversationId: seat.conversationId,
    seatEpoch: seat.seatEpoch, at: now(), state: "pending", told: false,
    incoming: { since, episodeId, phase: "nudge", attemptedAt: now(), hostIdentity: hostIdentity() }, detail: "",
  };
  const detail = (stage: string) => `Incoming delivery recovery: ${stage}; failures=${health.failures}; boundMs=${SEAT_TICK_DELIVERY_ALARM_MS}; cause=${cause}`;
  const tell = async (message: string) => {
    const active = sources.seatFor(project).active;
    if (active?.conversationId !== seat.conversationId || active.seatEpoch !== seat.seatEpoch) return detail("seat changed; recovery ownership withdrawn");
    record = { ...record!, detail: detail(message), told: false };
    await context.persist(record); await context.tell(record); return record.detail;
  };
  if (!same()) return tell("held by seat authority, operator control or release fence");
  if (record.state !== "pending") return record.detail;
  const phase = record.incoming!.phase;
  if (phase === "nudge" && record.incoming!.hostIdentity && hostIdentity() !== record.incoming!.hostIdentity)
    return tell("host owner changed; recovery withheld");
  const key = record.id + "-" + createHash("sha256").update(episodeId).digest("hex") + (phase === "nudge" ? "-nudge" : "-revive");
  const freshDispatch = record.incoming!.dispatchPhase !== phase;
  // Lost replies are reconciled under the same key before any new effect.
  const { lookupOriginalSend, resolveSendReceipt } = await import("@/lib/runtime/sendSettlement");
  const binding = { conversationId: seat.conversationId, clientMessageId: key };
  const evidence = phase === "cleanup" ? { kind: "absent" as const } : await (context.ports.delivery?.(binding) ?? (async () => {
    try {
      const snapshot = registry.deliverySnapshotForMessageKey(binding.conversationId, binding.clientMessageId);
      const found = lookupOriginalSend(snapshot, binding);
      if (found.kind === "absent") {
        const complete = Object.keys(snapshot.deliveryEvidenceCompactions).length === 0
          && Object.values(snapshot.conversations).every(row => row.deliveryEvidenceTracked);
        return { kind: freshDispatch || complete ? "absent" as const : "unknown" as const };
      }
      if (found.kind !== "found") return { kind: "unknown" as const };
      const receipt = await resolveSendReceipt(found.operationId, { registry, client: context.ports.client, now: sources.now,
        assertActive: () => { if (!same()) throw new DeliveryAdmissionRefusedError("seat-delivery-recovery-held"); } });
      return receipt ? { kind: "found" as const, receipt } : { kind: "unknown" as const };
    } catch { return { kind: "unknown" as const }; }
  })());
  if (!same()) return null;
  if (evidence.kind !== "found" && evidence.kind !== "absent") return tell("delivery evidence unreadable; same nudge retained");
  let dropped = false;
  if (evidence.kind === "found") {
    if (evidence.receipt.state === "delivered") {
      record = { ...record, state: "revived" }; return tell("recovery input delivered");
    }
    dropped = evidence.receipt.state === "failed" && evidence.receipt.resend === "safe";
    if (!dropped) return tell("recovery input pending or uncertain; original key retained");
  }
  let finishingCapturedCleanup = false;
  const capturedCleanupGone = async () => {
    if (!same() || hostIdentity() !== record!.incoming!.hostIdentity) return false;
    const conversation = registry.conversation(seat.conversationId as never);
    const generation = conversation?.generations.at(-1);
    const entry = conversation && generation ? registry.hostEntry({ engine: conversation.engine, sessionId: generation.id }) : null;
    if (!entry?.structuredHost?.process || conversation?.turn.state !== "idle") return false;
    const rows = await sources.liveness({ conversationId: seat.conversationId!, stallAfterMs: 0, limit: 1 });
    const row = rows.find(row => row.conversationId === seat.conversationId);
    return same() && hostIdentity() === record!.incoming!.hostIdentity && row?.verified === true
      && row.host.state === "gone" && row.reason === "host_gone_turn_settled";
  };
  if (phase === "cleanup") {
    const observedHost = hostIdentity();
    const rows = await sources.liveness({ conversationId: seat.conversationId, stallAfterMs: 0, limit: 1 });
    if (!same()) return null;
    if (hostIdentity() !== observedHost) return tell("host owner changed during cleanup observation; recovery withheld");
    const row = rows.find(row => row.conversationId === seat.conversationId);
    const conversation = registry.conversation(seat.conversationId as never);
    const generation = conversation?.generations.at(-1);
    const entry = conversation && generation ? registry.hostEntry({ engine: conversation.engine, sessionId: generation.id }) : null;
    if (row?.verified === true && row.host.state === "gone" && row.reason === "host_gone_turn_settled"
      && !entry?.structuredTerminationSurvivors?.length && !entry?.structuredHost?.process) {
      record = { ...record, incoming: { ...record.incoming!, phase: "revive" } };
      return tell("host loss verified after cleanup; revival is next");
    }
    if (record.incoming!.hostIdentity && hostIdentity() !== record.incoming!.hostIdentity)
      return tell("host owner changed; cleanup withheld");
    finishingCapturedCleanup = await capturedCleanupGone();
  }
  if (phase !== "revive" && !finishingCapturedCleanup && !await idle()) {
    // A host can exit between the last failed input and the first recovery
    // pass. Keep its captured cleanup authority instead of blocking ordinary
    // revival forever behind a nudge that requires a living idle writer.
    if (phase === "nudge" && same() && !workHeldNow()
      && (registry.incomingDeliveryHealth(seat.conversationId!)?.uncertain ?? 0) === 0) {
      const observed = hostIdentity();
      const rows = await sources.liveness({ conversationId: seat.conversationId!, stallAfterMs: 0, limit: 1 });
      const row = rows.find(row => row.conversationId === seat.conversationId);
      if (same() && !workHeldNow() && observed === hostIdentity()
        && (registry.incomingDeliveryHealth(seat.conversationId!)?.uncertain ?? 0) === 0
        && row?.verified === true && row.host.state === "gone" && row.reason === "host_gone_turn_settled") {
        record = { ...record!, incoming: { ...record!.incoming!, phase: "cleanup", attemptedAt: now() } };
        return tell("host loss verified before nudge; captured cleanup is next");
      }
    }
    return tell("held by active or unverified work");
  }
  if (!same()) return null;
  if (phase === "cleanup") {
    await tell("cleaning up the idle host after the failed nudge");
    const cleaned = await (context.ports.cleanup ?? cleanupFailedSeatHost)(seat.conversationId, () => same() && (registry.incomingDeliveryHealth(seat.conversationId!)?.uncertain ?? 0) === 0, finishingCapturedCleanup ? capturedCleanupGone : idle);
    if (!same()) return null;
    if (!cleaned) return tell("host cleanup unconfirmed; original deliveries remain fenced");
    record = { ...record!, incoming: { ...record!.incoming!, since, phase: "revive", attemptedAt: now() } };
    await context.persist(record);
    return tell("host cleanup confirmed; revival is next");
  }
  if (!dropped) {
    const recovery = record.incoming!.recovery ?? { text:
      "Continue the outstanding seat work. Report any delivery or host ownership hold.", origin: delegatusMessageOrigin("seat-tick", project) };
    record = { ...record, incoming: { ...record.incoming!, recovery } };
    await tell(phase === "nudge" ? "sending one durable nudge" : "reviving through shared composer delivery");
    if (!same()) return null;
    const guard = () => {
      if (!same() || workHeldNow() || phase === "nudge" && (idleIdentity === null || identityNow() !== idleIdentity))
        throw new DeliveryAdmissionRefusedError("seat-delivery-recovery-held");
    };
    if (phase === "nudge" && !await idle()) return tell("fresh work owns the seat; nudge withheld");
    if (phase === "revive") {
      if (workHeldNow() || (registry.incomingDeliveryHealth(seat.conversationId!)?.uncertain ?? 0) > 0)
        return tell("fresh or unverified work owns the seat; revival withheld");
      const observed = hostIdentity();
      const rows = await sources.liveness({ conversationId: seat.conversationId!, stallAfterMs: 0, limit: 1 });
      if (!same() || observed !== hostIdentity() || workHeldNow()) return tell("revival ownership changed during observation");
      const row = rows.find(row => row.conversationId === seat.conversationId);
      if (!(row?.verified === true && row.host.state === "gone" && row.reason === "host_gone_turn_settled") && !await idle())
        return tell("revival requires confirmed host loss or idle ownership");
    }
    const priorDispatchPhase = record.incoming!.dispatchPhase;
    try { guard(); } catch { return tell("fresh work owns the seat; recovery held before admission"); }
    record = { ...record, incoming: { ...record.incoming!, dispatchPhase: phase === "nudge" ? "nudge" : "revive" } };
    await context.persist(record);
    try { guard(); } catch {
      record = { ...record, incoming: { ...record.incoming!, dispatchPhase: priorDispatchPhase } };
      return tell("fresh work owns the seat; recovery held before admission");
    }
    const outcome = await context.deliver({ ...binding, path: seat.path, pid: null, text: recovery.text, images: [], policy: "queue",
      origin: recovery.origin, admissionGuard: guard, recoveryAuthorityGuard: guard });
    if (!same()) return null;
    if (outcome.ok && outcome.outcome === "delivered") {
      record = { ...record!, state: "revived" }; return tell("recovery input delivered");
    }
    if (!outcome.ok && outcome.admission === "refused" && outcome.code === "seat-delivery-recovery-held") {
      record = { ...record!, incoming: { ...record!.incoming!, dispatchPhase: priorDispatchPhase } };
      return tell("fresh work owns the seat; recovery admission withheld");
    }
    dropped = !outcome.ok && (outcome.admission === "refused" || outcome.resend === "safe")
      && outcome.actuation !== "started" && outcome.resend !== "verify-first";
    if (!dropped) return tell("recovery input pending or uncertain; original key retained");
  }
  if (phase === "nudge") {
    record = { ...record!, incoming: { ...record!.incoming!, since, phase: "cleanup", attemptedAt: now(), hostIdentity: record!.incoming!.hostIdentity ?? hostIdentity() } };
    return tell("nudge definitively failed; idle host cleanup is next");
  }
  await context.rotate({ conversationId: seat.conversationId, seatEpoch: seat.seatEpoch }, detail("revival failed; checking lost-host rotation"),
    () => { if (!same()) throw new Error("seat delivery recovery authority changed"); });
  return context.read().hostRecovery?.detail ?? detail("rotation withheld pending confirmed host loss");
}

/** Reuse the identity-fenced tree termination ladder and its durable capture.
 * The synchronous authority check is retained before each signal; the liveness
 * read is repeated asynchronously while the original host is still untouched.
 */
async function cleanupFailedSeatHost(conversationId: string, guard: () => boolean, idle: () => Promise<boolean>): Promise<boolean> {
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { recordedAgentScope } = await import("@/lib/runtime/agentScope");
  const { terminateStructuredHostTree } = await import("@/lib/runtime/structuredHostControl");
  const registry = agentRegistry();
  const conversation = registry.conversation(conversationId as never);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return false;
  const key = { engine: conversation.engine, sessionId: generation.id };
  const entry = registry.hostEntry(key);
  const process = entry?.structuredHost?.process;
  if (!entry || !process?.startIdentity || !process.bootEpoch) return false;
  const ref = { kind: "structured" as const, engine: conversation.engine, sessionId: generation.id, conversationId,
    pid: process.pid, startIdentity: process.startIdentity, bootEpoch: process.bootEpoch,
    seat: true, turnBusy: false, owned: false, lastActiveAt: entry.updatedAt };
  let effected = false;
  const identity = JSON.stringify([entry.claimEpoch, entry.claimOwner, entry.structuredHost]);
  const authorize = () => {
    if (!guard()) return { status: 409 as const, error: "seat recovery authority changed" };
    const current = registry.hostEntry(key);
    const currentConversation = registry.conversation(conversationId as never);
    if (!effected && (currentConversation?.turn.state !== "idle" || currentConversation.migration || currentConversation.switchHold
      || currentConversation.reconfigure?.status === "applying" || current?.pendingAction))
      return { status: 409 as const, error: "seat recovery work changed" };
    if (!effected && JSON.stringify([current?.claimEpoch, current?.claimOwner, current?.structuredHost]) !== identity)
      return { status: 409 as const, error: "seat recovery host changed" };
    return null;
  };
  const source = "seat-delivery-recovery";
  let capture: ReturnType<typeof registry.captureStructuredTerminationSurvivors> = null;
  const result = await terminateStructuredHostTree(ref, { stopOrigin: { path: source, operationId: conversationId },
    scope: recordedAgentScope(entry.structuredHost), retainedSurvivors: entry.structuredTerminationSurvivors ?? [],
    registryCustody: { claimEpoch: entry.claimEpoch, claimOwner: entry.claimOwner,
      writerClaimEpoch: entry.structuredHost?.writerClaimEpoch ?? null, process },
    terminateOwnedHost: async () => false,
    authorize, authorizeAsync: async () => authorize() ?? (!effected && !await idle()
      ? { status: 409 as const, error: "seat recovery work changed" } : null),
    onFirstEffect: () => { effected = true; },
    persistCapturedTree: identities => registry.deliveryWriteOrBusy({ label: source }, () => {
      if (authorize()) return false;
      capture = registry.captureStructuredTerminationSurvivors(key, ref, identities, source);
      return capture !== null;
    }),
    withdrawCapturedTree: async () => { if (capture) await registry.deliveryWriteOrBusy({ label: source }, () =>
      registry.withdrawStructuredTerminationSurvivors(key, ref, capture!, source)); },
  });
  return result.ok;
}
