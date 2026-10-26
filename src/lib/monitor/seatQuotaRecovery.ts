import crypto from "node:crypto";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { orchestratorSeatFor, orchestratorSeatIdentityForConversation } from "@/lib/orchestrator/seats";
import { agentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { accountQuotaVerdict } from "@/lib/accounts/headlessSelection";
import { liveFreshObservation } from "@/lib/accounts/accountProjection";
import { durableStageTurnEvidence, stageTurnEvidenceCurrent, type StageTurnEvidence } from "@/lib/pipelines/durableEvidence";
import { classifyProviderCondition } from "@/lib/pipelines/providerConditions";
import { runtimeHostClient } from "@/lib/runtime/client";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { enqueueStructuredMessage, idleContinuationDeliveryRetryable, type StructuredMessageRequest } from "@/lib/runtime/structuredMessageDelivery";
import { StructuredDispatchDeferredError, StructuredSendRefusedError } from "@/lib/runtime/engineHost";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { SEAT_QUOTA_RECOVERY_ROLE } from "@/lib/runtime/recoveryNotices";
import { assertSeatTickWork } from "./seatTickWork";
import { effectiveSeatTickSettings, readSeatTickSettings } from "./seatTickSettings";

type Seat = { conversationId: string; seatEpoch: number; designatedAt: string };
export interface SeatQuotaObservation {
  accountId: string;
  path: string;
  evidence: StageTurnEvidence;
  request: { operationId: string; clientMessageId: string; createdAt: string } | null;
  capacity: "available" | "exhausted" | "unknown";
  observedAt: number | null;
  resetsAt: number | null;
  stillCurrent?: () => boolean;
}
export interface SeatQuotaObligation {
  version: 1;
  id: string;
  project: string;
  seat: Seat;
  accountId: string;
  cutAt: number;
  resetsAt: number | null;
  original: NonNullable<SeatQuotaObservation["request"]>;
  state: "owed" | "submitted" | "settled" | "cancelled";
  reason: string;
  controlCursor: number;
  capacityObservedAt: number;
}
export interface SeatQuotaRecoveryPorts {
  now(): number;
  seat(project: string): Seat | null;
  observe(project: string, seat: Seat, cutAt?: number): Promise<SeatQuotaObservation | null>;
  stopped(conversationId: string, since: string, cursor: number): Promise<boolean | { stopped: boolean; cursor: number; complete: boolean }>;
  current(observation: SeatQuotaObservation): boolean;
  send(request: StructuredMessageRequest, eligible: () => Promise<boolean>): Promise<void>;
  held(project: string): boolean;
  delivery?(row: SeatQuotaObligation): "absent" | "pending" | "delivered" | "failed" | "unknown"
    | Promise<"absent" | "pending" | "delivered" | "failed" | "unknown">;
}

/** Retained stop intents are read incrementally, at most one native page. */
export async function readSeatQuotaControlPage(client: Pick<RuntimeHostClient, "effectBatch">, conversationId: string, since: string, cursor: number) {
  const page = await client.effectBatch(["runtime.kill-boundary", "runtime.interrupt-boundary", "runtime.stop-boundary"], cursor);
  let next = cursor;
  for (const effect of page) {
    if (!Number.isSafeInteger(effect.eventSeq) || effect.eventSeq <= cursor) throw new Error("seat quota control page did not advance");
    next = Math.max(next, effect.eventSeq);
    if (effect.payload.conversationId !== conversationId || effect.payload.origin === "system") continue;
    const at = typeof effect.payload.admittedAt === "string" ? Date.parse(effect.payload.admittedAt) : NaN;
    if (Number.isFinite(at) && at < Date.parse(since)) continue;
    if (effect.payload.origin !== "operator" || (effect.payload.originAuthenticated !== true && effect.payload.originAuthenticated !== 1)
      || !Number.isFinite(at)) throw new Error("seat quota control authorship unavailable; recovery withheld");
    return { stopped: true, cursor: next, complete: true };
  }
  return { stopped: false, cursor: next, complete: page.length < 100 };
}

const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function filename(project: string): string { return statePath("seat-quota-recovery", `${digest(project)}.json`); }
function controlFilename(project: string): string { return statePath("seat-quota-recovery", `${digest(project)}.control.json`); }
function controlled(project: string, seat: Seat, since: string): boolean {
  let value: { seatEpoch: number; conversationId: string; at: string };
  try { value = JSON.parse(fs.readFileSync(controlFilename(project), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!value || !Number.isSafeInteger(value.seatEpoch) || typeof value.conversationId !== "string" || !Number.isFinite(Date.parse(value.at))) {
    throw new Error("seat quota control evidence unreadable");
  }
  return value.seatEpoch === seat.seatEpoch && value.conversationId === seat.conversationId && Date.parse(value.at) >= Date.parse(since);
}

/** Persist operator intent before awaiting a native control, including one
 * that fails. The tombstone also fences a cut the ticker has not seen yet. */
export async function cancelSeatQuotaOnControl(conversationId: string): Promise<void> {
  const identity = orchestratorSeatIdentityForConversation(conversationId);
  if (!identity) return;
  const seat = orchestratorSeatFor(identity.project).active;
  if (seat?.conversationId !== conversationId || seat.seatEpoch !== identity.seatEpoch) return;
  await withFileTransaction(filename(identity.project), "seat quota control busy", () => {
    writeJsonDurably(controlFilename(identity.project), { conversationId, seatEpoch: identity.seatEpoch, at: new Date().toISOString() });
    const row = readSeatQuotaObligation(identity.project);
    if (row && open(row) && row.seat.seatEpoch === identity.seatEpoch) {
      writeJsonDurably(filename(identity.project), { ...row, state: "cancelled", reason: "explicit operator control" });
    }
  });
}

/** One latest obligation/tombstone per project, independent of bounded receipts
 * and engine sessions. Replacing it requires a different, later logical ask. */
export function readSeatQuotaObligation(project: string): SeatQuotaObligation | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(filename(project), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const row = raw as SeatQuotaObligation;
  if (!row || row.version !== 1 || row.project !== project || !row.seat
    || !Number.isSafeInteger(row.seat.seatEpoch) || typeof row.seat.conversationId !== "string"
    || !Number.isFinite(Date.parse(row.seat.designatedAt)) || typeof row.accountId !== "string"
    || !Number.isFinite(row.cutAt) || row.cutAt <= 0
    || row.resetsAt !== null && (!Number.isFinite(row.resetsAt) || row.resetsAt <= 0)
    || !row.original || typeof row.original.operationId !== "string" || !row.original.operationId
    || typeof row.original.clientMessageId !== "string" || !row.original.clientMessageId
    || !Number.isFinite(Date.parse(row.original.createdAt))
    || !["owed", "submitted", "settled", "cancelled"].includes(row.state) || typeof row.reason !== "string"
    || !Number.isSafeInteger(row.controlCursor) || row.controlCursor < 0
    || !Number.isFinite(row.capacityObservedAt) || row.capacityObservedAt < row.cutAt
    || row.id !== obligationId(row)) throw new Error("invalid seat quota obligation; recovery withheld");
  return row;
}
function obligationId(row: Pick<SeatQuotaObligation, "project" | "seat" | "cutAt" | "original">): string {
  return `seat-quota-${digest([row.project, row.seat, row.cutAt, row.original])}`;
}
async function change(project: string, update: (row: SeatQuotaObligation | null) => SeatQuotaObligation | null) {
  return withFileTransaction(filename(project), "seat quota recovery busy", () => {
    assertSeatTickWork();
    const previous = readSeatQuotaObligation(project);
    const row = update(previous);
    if (row) writeJsonDurably(filename(project), row);
    return row;
  });
}
const sameSeat = (a: Seat | null, b: Seat) => !!a && a.conversationId === b.conversationId
  && a.seatEpoch === b.seatEpoch && a.designatedAt === b.designatedAt;
const open = (row: SeatQuotaObligation) => row.state === "owed" || row.state === "submitted";
const evidenceCache = new Map<string, StageTurnEvidence>();
const changingAccount = (conversation: RegistryConversation) => !!conversation.switchHold
  || conversation.reconfigure?.status === "applying"
  || !!conversation.migration && !["committed", "rolled-back"].includes(conversation.migration.phase);
async function stopped(row: SeatQuotaObligation, ports: SeatQuotaRecoveryPorts): Promise<boolean> {
  const answer = await ports.stopped(row.seat.conversationId, row.original.createdAt, row.controlCursor);
  if (answer === true || typeof answer === "object" && answer.stopped) {
    await change(row.project, current => current?.id === row.id && open(current)
      ? { ...current, state: "cancelled", reason: "operator control" } : current);
    return true;
  }
  if (answer === false) return false;
  if (!Number.isSafeInteger(answer.cursor) || answer.cursor < row.controlCursor) throw new Error("seat quota control cursor invalid");
  if (answer.cursor !== row.controlCursor) await change(row.project, current => current?.id === row.id && open(current)
    ? { ...current, controlCursor: Math.max(current.controlCursor, answer.cursor) } : current);
  if (!answer.complete && !answer.stopped) throw new StructuredDispatchDeferredError("seat quota control history still being verified");
  return answer.stopped;
}
function cut(observation: SeatQuotaObservation): number | null {
  const { evidence } = observation;
  const message = evidence.turn === "terminal" ? evidence.terminalProviderMessage : null;
  return message && classifyProviderCondition("claude", message.errorClass, message.text).kind === "usage_limit"
    ? message.ts : null;
}
function eligible(row: SeatQuotaObligation, observation: SeatQuotaObservation, now: number): boolean {
  // An elapsed label never overrides newer evidence that capacity is exhausted.
  if (observation.capacity === "exhausted" && (row.resetsAt === null || observation.observedAt === null
    || observation.observedAt >= row.resetsAt * 1000 || observation.resetsAt === null
    || observation.resetsAt * 1000 > now)) return false;
  return row.resetsAt !== null && now >= row.resetsAt * 1000
    || observation.capacity === "available" && observation.observedAt !== null && observation.observedAt > row.capacityObservedAt;
}

/** Reads are outside the store transaction. The final synchronous check is
 * carried into the host's own pre-write authorization callback. */
export async function seatQuotaDispatchGuard(project: string, ports = defaultSeatQuotaRecoveryPorts()): Promise<() => void> {
  const row = readSeatQuotaObligation(project);
  if (!row || !open(row) || !sameSeat(ports.seat(project), row.seat)) throw new StructuredSendRefusedError("seat quota recovery cancelled");
  const observation = await ports.observe(project, row.seat, row.cutAt);
  if (!observation) throw new StructuredDispatchDeferredError("seat quota evidence unavailable");
  if (observation.accountId !== row.accountId || cut(observation) !== row.cutAt
    || observation.evidence.externalPromptAfterCut || observation.evidence.requestedCutOpen === false) {
    throw new StructuredSendRefusedError("seat quota request answered or superseded");
  }
  if (await stopped(row, ports)) throw new StructuredSendRefusedError("seat quota recovery cancelled by control");
  const assert = () => {
    const current = readSeatQuotaObligation(project);
    if (!current || current.id !== row.id || !open(current) || !sameSeat(ports.seat(project), row.seat)) {
      throw new StructuredSendRefusedError("seat quota authority changed");
    }
    if (controlled(project, row.seat, row.original.createdAt)) throw new StructuredSendRefusedError("seat quota recovery cancelled by operator");
    if (ports.held(project) || !ports.current(observation) || !eligible(current, observation, ports.now())) {
      throw new StructuredDispatchDeferredError("seat quota recovery evidence changed or capacity exhausted");
    }
  };
  assert();
  return assert;
}

/** The durable delivery identity must name this obligation, including a retry
 * the delivery layer proved never executed. An origin tag alone grants none. */
export async function prepareSeatQuotaDispatch(operationId: string, conversationId: string, project: string): Promise<() => void> {
  const guard = await seatQuotaDispatchGuard(project);
  const assert = () => {
    guard();
    const row = readSeatQuotaObligation(project)!;
    const snapshot = agentRegistry().deliverySnapshotForOperation(operationId);
    const delivery = Object.values(snapshot.heldDeliveries).find(item => item.command.operationId === operationId);
    if (row.seat.conversationId !== conversationId || delivery?.clientMessageId !== row.id
      || delivery.conversationId !== conversationId || delivery.command.origin?.role !== SEAT_QUOTA_RECOVERY_ROLE) {
      throw new StructuredSendRefusedError("seat quota delivery identity changed");
    }
  };
  assert();
  return assert;
}

/** Driven by the existing authoritative-seat ticker; owns no timer. True
 * reserves this check for the unanswered request, including uncertain sends. */
export async function recoverSeatQuota(project: string, ports = defaultSeatQuotaRecoveryPorts()): Promise<boolean> {
  let row = readSeatQuotaObligation(project);
  const seat = ports.seat(project);
  if (row && open(row) && !sameSeat(seat, row.seat)) {
    await change(project, current => current?.id === row!.id ? { ...current, state: "cancelled", reason: "seat revoked or rotated" } : current);
    return false;
  }
  if (!seat || ports.held(project)) return !!row && open(row);
  let observation: SeatQuotaObservation | null;
  try { observation = await ports.observe(project, seat, row?.cutAt); }
  catch (error) {
    if (!(error instanceof StructuredSendRefusedError)) throw error;
    if (row && open(row)) await change(project, current => current?.id === row!.id
      ? { ...current, state: "cancelled", reason: error.message } : current);
    return false;
  }
  if (!sameSeat(ports.seat(project), seat)) return true;
  if (!observation) return !!row && open(row);
  const cutAt = cut(observation);
  if (observation.request && controlled(project, seat, observation.request.createdAt)) {
    if (row && open(row)) await change(project, current => current?.id === row!.id
      ? { ...current, state: "cancelled", reason: "explicit operator control" } : current);
    return false;
  }
  if (row && open(row) && (cutAt !== row.cutAt || observation.accountId !== row.accountId
    || observation.evidence.externalPromptAfterCut || observation.evidence.requestedCutOpen === false)) {
    await change(project, current => current?.id === row!.id ? { ...current, state: "cancelled", reason: "request answered, replaced or account changed" } : current);
    return false;
  }
  if (!cutAt || cutAt < Date.parse(seat.designatedAt)) return false;
  if (!row || row.cutAt !== cutAt) {
    // Never turn our own unsuccessful continuation into a new user request.
    if (!observation.request || row && observation.request.operationId === row.original.operationId
      || observation.evidence.promptHistoryComplete !== true || observation.evidence.externalPromptAfterCut) return !!row && open(row);
    const proposed: SeatQuotaObligation = { version: 1, id: "", project, seat, accountId: observation.accountId,
      cutAt, resetsAt: observation.evidence.terminalProviderMessage?.usageLimit?.resetsAt ?? observation.resetsAt,
      original: observation.request, state: "owed", reason: "provider usage limit", controlCursor: 0, capacityObservedAt: cutAt };
    proposed.id = obligationId(proposed);
    row = await change(project, current => sameSeat(ports.seat(project), seat) && ports.current(observation)
      && !controlled(project, seat, proposed.original.createdAt)
      && (!current || current.cutAt < cutAt && current.original.operationId !== proposed.original.operationId) ? proposed : current);
  }
  if (!row || !open(row)) return false;
  if (observation.capacity === "exhausted" && observation.observedAt !== null && observation.observedAt > row.capacityObservedAt) {
    row = await change(project, current => current?.id === row!.id && open(current) && observation.observedAt! > current.capacityObservedAt
      ? { ...current, capacityObservedAt: observation.observedAt!, resetsAt: observation.resetsAt !== null
        && observation.resetsAt * 1000 > observation.observedAt! ? observation.resetsAt : null } : current);
    if (!row || !open(row)) return false;
  }
  if (row.state === "submitted") {
    const delivery = await ports.delivery?.(row);
    if (delivery === "pending" || delivery === "unknown") return true;
    if (delivery === "delivered" || delivery === "failed") {
      await change(project, current => current?.id === row!.id && open(current) ? { ...current,
        state: delivery === "delivered" ? "settled" : "cancelled", reason: `continuation ${delivery}` } : current);
      return true;
    }
  }
  if (await stopped(row, ports)) {
    return false;
  }
  if (!eligible(row, observation, ports.now())) return true;
  const obligation = row;
  const allowed = async () => {
    assertSeatTickWork();
    try { await seatQuotaDispatchGuard(project, ports); return true; }
    catch (error) { if (error instanceof StructuredSendRefusedError || error instanceof StructuredDispatchDeferredError) return false; throw error; }
  };
  if (!await allowed()) return true;
  // Persist intent BEFORE calling delivery. A lost acknowledgement replays the
  // exact key; a submitted record is never replaced by a fresh operation.
  const submitted = await change(project, current => current?.id === obligation.id && open(current)
    ? { ...current, state: "submitted", reason: "continuation admitted or awaiting same-key reconciliation" } : current);
  if (submitted?.id !== obligation.id || !open(submitted) || !sameSeat(ports.seat(project), seat)) return true;
  assertSeatTickWork();
  await ports.send({ path: observation.path, conversationId: seat.conversationId,
    clientMessageId: obligation.id, operationId: obligation.id, policy: "queue", turnId: null,
    cohortAt: obligation.original.createdAt,
    origin: { kind: "agent", role: SEAT_QUOTA_RECOVERY_ROLE, project },
    text: `Provider capacity interrupted the unanswered request already in this transcript (operation ${obligation.original.operationId}, submission ${obligation.original.clientMessageId}). Continue that same request from its existing context.` }, allowed);
  return true;
}

export function defaultSeatQuotaRecoveryPorts(): SeatQuotaRecoveryPorts {
  const registry = agentRegistry();
  const seatFor = (project: string): Seat | null => {
    const seat = orchestratorSeatFor(project).active;
    return seat?.conversationId && seat.path && seat.state === "active"
      ? { conversationId: seat.conversationId, seatEpoch: seat.seatEpoch, designatedAt: seat.designatedAt } : null;
  };
  return {
    now: Date.now, seat: seatFor, held: project => !!activeDrain()
      || !effectiveSeatTickSettings(readSeatTickSettings(project), Date.now(), 3_600_000).enabled,
    observe: async (project, seat, cutAt) => {
      const conversation = registry.conversation(seat.conversationId as ViewerConversationId);
      const generation = conversation?.generations.at(-1);
      if (!conversation || conversation.engine !== "claude" || !generation?.accountId) return null;
      if (changingAccount(conversation)) return null;
      const allowed = allowedAccountIdsForProject(project, "claude");
      if (allowed && !allowed.includes(generation.accountId)) throw new StructuredSendRefusedError("seat account binding revoked");
      const snapshot = registry.conversationDeliverySnapshot({ conversationId: seat.conversationId });
      if (snapshot.memberships[seat.conversationId]?.some(row => row.kind === "pipeline")) return null;
      const key = JSON.stringify([statePath("state.sqlite"), generation.path, cutAt, seat.designatedAt]);
      let evidence = evidenceCache.get(key) ?? null;
      if (stageTurnEvidenceCurrent(evidence) !== true) {
        evidence = await durableStageTurnEvidence("claude", generation.path, undefined, seat.designatedAt, undefined, cutAt);
        if (evidence) {
          evidenceCache.set(key, evidence);
          while (evidenceCache.size > 64) evidenceCache.delete(evidenceCache.keys().next().value!);
        }
      }
      if (!evidence) return null;
      const failureAt = evidence.terminalProviderMessage?.ts ?? 0;
      const requests = Object.values(snapshot.heldDeliveries).filter(row => row.conversationId === seat.conversationId
        && row.state === "delivered" && row.command.kind === "send" && row.command.origin?.role !== SEAT_QUOTA_RECOVERY_ROLE
        && (row.generationId === null || row.generationId === generation.id)
        && evidence.turnStartedAt != null && Date.parse(row.createdAt) <= evidence.turnStartedAt
        && Date.parse(row.deliveredAt ?? "") >= evidence.turnStartedAt
        && Date.parse(row.createdAt) <= failureAt).sort((a, b) => (b.admissionSeq ?? 0) - (a.admissionSeq ?? 0) || b.createdAt.localeCompare(a.createdAt));
      const request = requests[0];
      const observations = registry.quotaObservations("claude");
      const quota = accountQuotaVerdict(observations, generation.accountId, Date.now(), generation.launchProfile.model);
      const fresh = liveFreshObservation(observations.find(row => row.accountId === generation.accountId), Date.now());
      const quotaStamp = JSON.stringify(observations.find(row => row.accountId === generation.accountId));
      return { accountId: generation.accountId, path: generation.path, evidence,
        request: request?.clientMessageId ? { operationId: request.command.operationId, clientMessageId: request.clientMessageId, createdAt: request.createdAt } : null,
        capacity: fresh && quota.capacity === "available" ? "available" : fresh && quota.capacity === "exhausted" ? "exhausted" : "unknown",
        observedAt: quota.observedAt ? Date.parse(quota.observedAt) : null, resetsAt: quota.resetsAt,
        stillCurrent: () => {
          const current = registry.conversation(seat.conversationId as ViewerConversationId);
          const bound = allowedAccountIdsForProject(project, "claude");
          return current?.generations.at(-1)?.id === generation.id && current.generations.at(-1)?.accountId === generation.accountId
            && !changingAccount(current) && (!bound || bound.includes(generation.accountId!))
            && JSON.stringify(registry.quotaObservations("claude").find(row => row.accountId === generation.accountId)) === quotaStamp
            && (!fresh || liveFreshObservation(registry.quotaObservations("claude").find(row => row.accountId === generation.accountId), Date.now()));
        } };
    },
    stopped: async (conversationId, since, cursor) => {
      const client = runtimeHostClient();
      if (!client) throw new Error("runtime control evidence unavailable");
      // The existing retained stop intents survive receipt compaction. Advance
      // one durable page per check instead of re-reading global stop history.
      return readSeatQuotaControlPage(client, conversationId, since, cursor);
    },
    current: observation => observation.stillCurrent?.() === true && stageTurnEvidenceCurrent(observation.evidence) === true,
    delivery: async row => {
      const admission = registry.deliveryAdmissionForKey(row.seat.conversationId, row.id);
      if (admission.outcome === "not-executed") return "absent";
      if (admission.outcome !== "admitted") return "unknown";
      if (admission.state === "failed" && await idleContinuationDeliveryRetryable(row.seat.conversationId, row.id)) return "absent";
      return admission.state === "delivered" ? "delivered" : admission.state === "failed" ? "failed" : "pending";
    },
    send: async (request, allowed) => {
      const authority = await seatQuotaDispatchGuard(request.origin!.project!);
      const result = await enqueueStructuredMessage({ ...request, admissionGuard: authority, recoveryAuthorityGuard: authority },
        { idleContinuationAllowed: allowed });
      if (!result?.ok) throw new Error(result?.error ?? "seat quota structured delivery unavailable");
    },
  };
}
