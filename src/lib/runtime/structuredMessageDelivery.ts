import crypto from "node:crypto";

import {
  agentRegistry,
  DeliveryReservationConflictError,
  REGISTRY_WRITER_BUSY,
  type AgentRegistry,
  type RegistryConversation,
} from "@/lib/agent/registry";
import { structuredHostsEnabled } from "./flags";
import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { advanceConversationMigration, deliveryFence } from "@/lib/accounts/migration/coordinator";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { actuationBusy, withConversationActuation, type ActuationLease } from "@/lib/deliveryActuation";
import { deputyDeliveryRefusal } from "@/lib/orchestrator/deputies";
import type { HeldDelivery, HeldDeliveryCommand, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import type { SelectedContextRef } from "@/lib/selection/selectedContext";
import {
  conversationDeliverabilityFromRecord,
  deliverabilityFailureMessage,
  type ConversationDeliverabilityCondition,
} from "@/lib/conversation/deliverability";

import type { MessageOrigin } from "./messageOrigin";
import { isRuntimeHostTransportFailure, readRuntimeSession, runtimeHostClient, type RuntimeHostClient } from "./client";
import {
  isStructuredHostKind,
  RUNTIME_IDEMPOTENCY_KEY_LIMIT,
  runtimeIdempotencyKeyAdmissible,
  type RuntimeOperationReceipt,
  type RuntimeOperationResult,
  type RuntimeSendSettings,
  type RuntimeSession,
} from "./contracts";
import { republishStructuredDeliveryHost } from "./structuredDeliveryController";
import { recoverDeadStructuredConversation, StructuredRecoveryHeldForUpdateError, StructuredResumeUnpublishedError } from "./structuredRecovery";
import { runtimeImageCapability, runtimeImageRefsForUploads, runtimeImageStore, type RuntimeImageCapability, type RuntimeImageUpload } from "./runtimeImageStore";
import { admitRuntimeImagePayload } from "./runtimeImageAdmission";
import {
  assertStructuredTextEnvelope,
  structuredContent,
  StructuredEnvelopeTooLargeError,
  type StructuredImageRef,
} from "./structuredContent";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { ownedDeliveryProgressStore, type DeliveryProgressRecord } from "./deliveryProgress";
import type { DeliveryWaitReason } from "./deliveryWaitReason";
import { recordWait, stillAtStep, type DeliveryProgressPort, type RecordedWait } from "./recordWait";
import { STRUCTURED_DELIVERY_TIMING } from "./structuredDeliveryQueue";
import { markStructuredRuntimeSessionRecovered } from "./startupStatus";
import { isInterruptionObligationId } from "./interruptionObligations";
import { RECOVERY_NOTICE_ORIGIN } from "./recoveryNotices";

export interface StructuredMessageRequest {
  path: string;
  conversationId?: string | null;
  clientMessageId?: string | null;
  operationId?: string;
  kind?: "send" | "steer" | "inject";
  policy?: "queue" | "steer-if-active" | "steer-or-queue" | "interrupt-active";
  turnId?: string | null;
  text: string;
  images?: RuntimeImageUpload[];
  imageRefs?: StructuredImageRef[];
  hasImages?: boolean;
  /** Per-turn runtime settings snapshot (issue #390 §10): rides the durable
      send effect so a replayed key re-delivers with identical settings. A
      migration hold drops the override (absent = today's behavior) — the held
      command format predates it and stays untouched. */
  runtime?: RuntimeSendSettings;
  /** The Viewer card selected at submission (#844): rides the durable send
      effect so a replayed key re-delivers naming the SAME card, and the
      transcript record keeps the reference the operator actually submitted. */
  selectedContext?: SelectedContextRef;
  /** Message authorship stamped by the admitting surface (#1117): rides the
      durable send effect onto the delivery evidence (Claude ledger record,
      Codex structured-user marker). A migration hold persists it on the held
      command and replays it at drain time, so a held operator message never
      resurfaces as a system row nor a held relay as an operator bubble. */
  origin?: MessageOrigin;
  /** Set only by a spawn delivering its own first message: the launch whose
      account choice the lazy move onto the routed account leaves standing
      (#2051). The registry honours it only for the launch that created the
      conversation's current generation, on that generation's account. */
  launchId?: string;
  /** Admission time of the work this message continues (a stage attempt the
      controller follows up on). Kept on the reservation so an update drain
      treats the message as part of that cohort. */
  cohortAt?: string;
}

export type StructuredMessageResult =
  | { ok: true; structured: true; target: string | null; outcome: "queued" | "delivering" | "delivered"; operationId: string; receipt: RuntimeOperationReceipt; spawned?: boolean }
  /* #1131: `held` is an ACCEPTED send — it has a durable reservation and an
     operation id — so it answers with that id like every other accepted send.
     Without it a hold was the one acceptance a caller could never ask about
     afterwards, which put `queued` back at the end of the story. */
  | { ok: true; structured: true; target: string | null; outcome: "held"; operationId: string; spawned?: boolean }
  | { ok: false; structured: true; outcome: "failed"; error: string; status: number; operationId?: string; receipt?: RuntimeOperationReceipt; successorConversationId?: string; transportUncertain?: true; code?: string; seatConversationId?: string; admission?: "refused" };

export interface StructuredMessageDependencies {
  /** The actuation section a caller already holds for this conversation (the migration drain), handed down
      explicitly; without it the send waits for the section like any other actuator. */
  actuationLease?: ActuationLease;
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void;
  requestMigrationTick?: () => void;
  startupFailed?: () => boolean;
  startupRecovered?: () => void;
  recover?: typeof recoverDeadStructuredConversation;
  republish?: (key: RuntimeSession["sessionKey"]) => Promise<boolean>;
  storeImages?: (images: readonly RuntimeImageUpload[]) => StructuredImageRef[];
  /** The refs `storeImages` would publish, computed without writing — used by
      the same-key conflict preflight so a changed payload rejects blob-free. */
  previewImageRefs?: (images: readonly RuntimeImageUpload[]) => StructuredImageRef[];
  /** Cross-process fence spanning image publication and durable reservation. */
  withImageAdmissionLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  executeSwitch?: (conversationId: ViewerConversationId, registry: AgentRegistry) => Promise<RegistryConversation>;
  /** Set only by startup recovery when it delivers the continuation an
      interruption obligation is owed (#1835). A dependency on purpose: nothing
      a request body carries can set it. It admits that continuation to a
      seat's live deputy, whose one job the release cut. */
  interruptionContinuation?: boolean;
  /** Where the admitted operation's waits are recorded; the Viewer's own
      store by default, and nothing in a process that holds none. */
  progress?: DeliveryProgressPort | null;
}

function progressPort(progress: DeliveryProgressPort | null | undefined): DeliveryProgressPort | null {
  return progress === undefined ? ownedDeliveryProgressStore() : progress;
}

/**
 * A step after a command left the process (rule a, step 4): it may race the
 * delivery queue, which continues the same record once the journal lists the
 * operation, so it writes only while the record is still the one this request
 * wrote last.
 */
function recordWaitUnlessContinued(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  reservation: HeldDelivery,
  written: DeliveryProgressRecord | null,
  wait: RecordedWait,
): DeliveryProgressRecord | null {
  if (!progress || !written) return null;
  try {
    if (!stillAtStep(progress.get(reservation.command.operationId), written)) return null;
  } catch {
    return null;
  }
  return recordWait(progress, registry, reservation, wait);
}

/** The ending a request decided for its own send, on its record. */
function settleRecord(progress: DeliveryProgressPort | null, operationId: string, state: "delivered" | "failed" | "uncertain", reason: string | null): void {
  if (!progress) return;
  try {
    progress.settle?.(operationId, state, reason);
  } catch (error) {
    console.error("[structured delivery] progress record failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Whether a payload can be handed to a host with this image capability
 * (Note 2). Admission and the account-migration drain both ask it, from the
 * stored refs, so a rejection admission decided but could not write is
 * enforced again before the drain's command.
 */
export function payloadRefusal(
  capability: RuntimeImageCapability,
  engine: "claude" | "codex" | "copilot",
  refs: readonly StructuredImageRef[],
  wantsImages = refs.length > 0,
): { error: string; status: number } | null {
  if (!wantsImages) return null;
  if (!capability.supported && engine !== "codex") {
    return { error: capability.reason ?? "structured image delivery is unavailable", status: 409 };
  }
  const encodedBytes = refs.reduce((total, ref) => total + 4 * Math.ceil(ref.bytes / 3), 0);
  if (encodedBytes > capability.maxEncodedBytesPerRequest) {
    return { error: "runtime image request encoding is too large", status: 413 };
  }
  return null;
}

/**
 * Ends a reservation the request itself decided cannot be delivered: a resume
 * that cannot publish, a payload the recovered host cannot take. The write
 * waits for the lock off the loop (rule c). Refused, nothing was written and
 * the send stays accepted: the request answers it held, its record names the
 * ending still owed, and the drain reaches the same ending (Note 2).
 */
async function endReservationForRequest(
  registry: AgentRegistry,
  progress: DeliveryProgressPort | null,
  reservation: HeldDelivery,
  failure: string,
  refusedReason: DeliveryWaitReason = "awaiting-host",
): Promise<{ ended: true; error: string } | { ended: false }> {
  const operationId = reservation.command.operationId;
  const ended = await registry.deliveryWrite({ label: "delivery.terminalize", operationId },
    () => registry.terminalizeHeldDelivery(reservation.id, failure));
  if (!ended.acquired) {
    recordWait(progress, registry, reservation, { reason: refusedReason, detail: `its ending could not be written yet (${failure})` });
    return { ended: false };
  }
  const error = ended.value.error ?? failure;
  settleRecord(progress, operationId, "failed", error);
  return { ended: true, error };
}

function acceptedHeld(operationId: string, target: string | null = null, spawned = false): StructuredMessageResult {
  return { ok: true, structured: true, target, outcome: "held", operationId, ...(spawned ? { spawned: true } : {}) };
}

/** The reservation behind one accepted operation, read by its key. */
function reservationFor(registry: AgentRegistry, operationId: string): HeldDelivery | null {
  return Object.values(registry.deliverySnapshotForOperation(operationId).heldDeliveries)
    .find((candidate) => candidate.command.operationId === operationId) ?? null;
}

/** Serializes preflight → publication → reservation per (conversation,
    client message id) within this process. Two racing changed payloads see a
    durable winner before the losing request publishes anything. */
const admissionSections = new Map<string, Promise<unknown>>();

async function withAdmissionSection<T>(key: string | null, run: () => T | Promise<T>): Promise<T> {
  if (!key) return run();
  const queued = (admissionSections.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  admissionSections.set(key, queued);
  try {
    return await queued;
  } finally {
    if (admissionSections.get(key) === queued) admissionSections.delete(key);
  }
}

export interface HeldStructuredMessageRequest {
  conversationId: string;
  runtimeConversationId?: string;
  path: string;
  deliveryId: string;
  clientMessageId: string;
  text: string;
  imageRefs?: StructuredImageRef[];
  command?: HeldDeliveryCommand;
  /** The coordinator is reconciling an attempt that may have reached the host. */
  reconcileUncertain?: boolean;
}

export interface HeldStructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void | Promise<void>;
  startupFailed?: () => boolean;
  startupRecovered?: () => void;
  republish?: (key: RuntimeSession["sessionKey"]) => Promise<boolean>;
  recover?: typeof recoverDeadStructuredConversation;
  /** Where each drain attempt's wait is recorded; the Viewer's own store by default. */
  progress?: DeliveryProgressPort | null;
}

/** A held delivery that never reached dispatch, left queued with the reason
    (#1974). The drain retries it as unactuated and fails it, naming this
    cause, once it has waited out its bound. */
export interface HeldForRetry {
  outcome: "held";
  cause: string;
  /** What the send waits on meanwhile, for its progress record. */
  waitReason?: DeliveryWaitReason;
}

/** A payload the host the drain reached cannot take (Note 2): never
    dispatched, so it ends `failed` with the cause and may be sent again. */
export interface HeldRejection {
  outcome: "rejected";
  cause: string;
}

export type HeldStructuredMessageOutcome = "delivered" | "failed" | "delivery-uncertain" | "held" | HeldForRetry | HeldRejection | null;

function heldForRetry(cause: string, waitReason: DeliveryWaitReason = "awaiting-host"): HeldForRetry {
  return { outcome: "held", cause, waitReason };
}

/**
 * Marks a refusal given before anything was reserved or dispatched (#2020).
 *
 * Nothing under the send's key exists when one of these answers, so the
 * caller may record the send as not executed and say why. Without the mark a
 * 503 with no operation id reads as "may have run", and every later lookup of
 * the send answered `outcome_unknown` for ever.
 */
function refusedBeforeReservation<T extends Extract<StructuredMessageResult, { ok: false }>>(result: T): T {
  return { ...result, admission: "refused" };
}

function ownershipUnavailable(condition: ConversationDeliverabilityCondition = "synchronizing"): Extract<StructuredMessageResult, { ok: false }> {
  return refusedBeforeReservation({
    ok: false,
    structured: true,
    outcome: "failed",
    error: deliverabilityFailureMessage({ condition }),
    status: 503,
  });
}

function legacyCommandUnavailable(): StructuredMessageResult {
  return refusedBeforeReservation({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "legacy delivery cannot preserve structured command semantics",
    status: 409,
  });
}

/** A send addressed to a terminally superseded round (issue #383) never forks
    it through implicit recovery — it answers with the live chain end. */
function supersededRejection(
  registry: AgentRegistry,
  conversation: Pick<RegistryConversation, "id" | "supersededBy"> | null,
): StructuredMessageResult | null {
  if (!conversation?.supersededBy) return null;
  return refusedBeforeReservation({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "superseded",
    status: 409,
    successorConversationId: registry.supersedenceChainTail(conversation.id),
  });
}

function requiresStructuredCommand(request: StructuredMessageRequest): boolean {
  return request.operationId !== undefined
    || (request.kind ?? "send") !== "send"
    || (request.policy !== "steer-or-queue" && (request.policy ?? "interrupt-active") !== "interrupt-active")
    || request.turnId !== undefined;
}

function requiresStructuredHeldCommand(request: HeldStructuredMessageRequest): boolean {
  const command = request.command;
  return command !== undefined
    && (command.operationId !== request.deliveryId
      || command.kind !== "send"
      || (command.policy !== "steer-or-queue" && command.policy !== "interrupt-active")
      || command.turnId !== undefined);
}

function deliveryFailure(error: unknown): Extract<StructuredMessageResult, { ok: false }> {
  return {
    ok: false,
    structured: true,
    outcome: "failed",
    error: error instanceof Error ? error.message : "structured host delivery failed",
    status: error instanceof DeliveryReservationConflictError
      ? 409
      : error instanceof StructuredEnvelopeTooLargeError
        ? 413
        : 503,
    ...(isRuntimeHostTransportFailure(error) ? { transportUncertain: true } : {}),
  };
}

/**
 * A key the runtime journal could never admit, refused here instead (#1771).
 *
 * The journal's bound is checked inside its own admission, before it opens a
 * transaction — so an over-bound key used to be discovered one step too late:
 * the reservation was already held and CLAIMED, the throw came back from
 * transport, and the claimed reservation was left at `delivery-uncertain` for
 * ever. That is the worst of both readings — nothing was delivered and nothing
 * could prove it, so the key stayed bound to an attempt no evidence could
 * settle and its sender was fenced behind it.
 *
 * Asked before anything is reserved, so the refusal is definitive: nothing is
 * written, nothing is claimed, and the caller is told what it has to change.
 * Every composer still owes its own bound — see the seat tick's
 * `boundedWakeIdentity` — because a refused send is still a send that did not
 * happen.
 */
function refusedIdempotencyKey(key: string): Extract<StructuredMessageResult, { ok: false }> | null {
  if (runtimeIdempotencyKeyAdmissible(key)) return null;
  return refusedBeforeReservation({
    ok: false,
    structured: true,
    outcome: "failed",
    error: `clientMessageId is longer than the ${RUNTIME_IDEMPOTENCY_KEY_LIMIT} characters the runtime journal admits, so no send was reserved`,
    status: 400,
  });
}

function commandInput(request: StructuredMessageRequest) {
  return {
    ...(request.operationId ? { operationId: request.operationId } : {}),
    ...(request.kind ? { kind: request.kind } : {}),
    ...(request.policy ? { policy: request.policy } : {}),
    ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    ...(request.cohortAt ? { cohortAt: request.cohortAt } : {}),
  };
}

type PersistedMessageOwner = {
  kind: "structured" | "legacy";
  conversation: RegistryConversation;
};

function persistedCurrentOwner(
  request: Pick<StructuredMessageRequest, "conversationId" | "path">,
  registry: AgentRegistry,
): PersistedMessageOwner | null {
  const conversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as ViewerConversationId)
    : registry.conversationForPath(request.path);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const snapshot = registry.conversationDeliverySnapshot(request);
  const entry = snapshot.entries[`${conversation.engine}:${generation.id}`];
  if (!entry || entry.artifactPath !== generation.path) return null;
  const deliverability = conversationDeliverabilityFromRecord(snapshot, {
    conversationId: conversation.id,
    transcriptPath: generation.path,
  });
  /* A current legacy host wins over retained structured adapter metadata, the
     same verdict conversation_deliverability exposes. This keeps a stale
     runtime projection from recovering over the pane resume just settled. */
  if (deliverability.deliverable && deliverability.transport === "legacy") {
    return { kind: "legacy", conversation };
  }
  if (entry.host === null && entry.structuredHost !== null && entry.structuredHost !== undefined) {
    return { kind: "structured", conversation };
  }
  return null;
}

function heldOutcomeDuringRuntimeSynchronization(
  request: HeldStructuredMessageRequest,
  registry: AgentRegistry,
  cause: string,
): HeldStructuredMessageOutcome {
  // A failed read while reconciling a command that may already have reached
  // the journal cannot authorize another attempt. Newly assigned rows have
  // not dispatched yet and must keep a reason-bearing bounded deferral.
  if (request.reconcileUncertain) return "delivery-uncertain";
  const owner = persistedCurrentOwner(request, registry);
  // This path runs before command dispatch. Legacy ownership still belongs to
  // its fallback path; every structured or unresolved owner gets a bounded
  // retry that retains the runtime-read cause.
  if (owner?.kind === "legacy") return requiresStructuredHeldCommand(request) ? "failed" : null;
  const ownerHint = owner?.kind === "structured" ? "structured runtime owner is synchronizing" : "runtime owner is unavailable";
  return heldForRetry(`${ownerHint}: ${cause}`, "evidence-unreadable");
}

/**
 * What a hold needs to make an IMAGE payload durable: the same blob
 * publication the live send takes, under the same cross-process lock. A hold
 * runs where no host can be asked anything, so the bytes have to be published
 * here or the operator's photo exists only in a browser tab (#1932).
 */
interface SynchronizationImageAdmission {
  rawImages?: readonly RuntimeImageUpload[];
  storeImages?: StructuredMessageDependencies["storeImages"];
  previewImageRefs?: StructuredMessageDependencies["previewImageRefs"];
  withImageAdmissionLock?: StructuredMessageDependencies["withImageAdmissionLock"];
}

/** What a send held at admission waits on, and where that is recorded. */
interface HeldAdmissionWait {
  progress: DeliveryProgressPort | null;
  reason: DeliveryWaitReason;
  detail?: string | null;
}

async function holdDuringRuntimeSynchronization(
  request: StructuredMessageRequest,
  registry: AgentRegistry,
  requestTick: () => void,
  allowReclaimed = false,
  admission: SynchronizationImageAdmission = {},
  wait: HeldAdmissionWait = { progress: null, reason: "awaiting-host" },
): Promise<StructuredMessageResult | null> {
  const owner = persistedCurrentOwner(request, registry);
  const unresolvedConversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as ViewerConversationId)
    : registry.conversationForPath(request.path);
  const unresolvedGeneration = unresolvedConversation?.generations.at(-1);
  const activeAccountId = unresolvedConversation
    ? registry.engineRouting(unresolvedConversation.engine).activeAccountId
    : null;
  const accountReseatWithoutOwner = !owner
    && unresolvedConversation !== null
    && unresolvedConversation !== undefined
    && unresolvedGeneration?.accountId !== null
    && unresolvedGeneration?.accountId !== undefined
    && activeAccountId !== null
    && unresolvedGeneration.accountId !== activeAccountId;
  if (!owner && !accountReseatWithoutOwner && !allowReclaimed) {
    const deliverability = conversationDeliverabilityFromRecord(registry.conversationDeliverySnapshot(request), {
      conversationId: request.conversationId,
      transcriptPath: request.path,
    });
    return ownershipUnavailable(deliverability.condition);
  }
  const persistedConversation = owner?.conversation ?? unresolvedConversation!;
  const rejectedHold = supersededRejection(registry, persistedConversation);
  if (rejectedHold) return rejectedHold;
  if (owner?.kind === "legacy") return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  let conversation = persistedConversation;
  /**
   * #1560: the last way an injection could become a held reservation.
   *
   * Everything this function admits is drained by the migration coordinator
   * alone, which replays it against the SUCCESSOR generation — a different
   * thread. That is right for a message and wrong for an injection, whose whole
   * meaning is "put this into the history of the thread I am looking at". The
   * refusal further down covers a switch that is already pending; this covers
   * the other way in, where the runtime-host socket is unavailable at admission
   * and a switch commits before the drain. Refused before any reservation
   * exists, so nothing is written and the operator can inject again once the
   * runtime is reachable.
   */
  if (request.kind === "inject") {
    return refusedBeforeReservation({
      ok: false,
      structured: true,
      outcome: "failed",
      error: "structured delivery ownership is unavailable; injected context cannot be held for a later generation",
      status: 503,
    });
  }
  /* The whole message is held, photo included. This used to be a flat 409 —
     "structured host image delivery is unavailable" — because publishing blobs
     wants the admission lock and this function was synchronous. That refusal
     landed on exactly the send the dead-host composer now offers: a reclaimed
     conversation has no session to inspect, so a text-plus-photo message came
     here and was rejected whole, with nothing reserved and nothing to retry.
     The admission below is the live path's own, lock and publication included,
     so text and bytes become durable under ONE key before any host is raised. */
  const rawImages = admission.rawImages ?? [];
  const suppliedRefs = request.imageRefs ?? [];
  if (rawImages.length > 0 && suppliedRefs.length > 0) {
    return refusedBeforeReservation(deliveryFailure(new Error("structured image payload is ambiguous")));
  }
  if (request.hasImages && rawImages.length === 0 && suppliedRefs.length === 0) {
    return refusedBeforeReservation({ ok: false, structured: true, outcome: "failed", error: "structured image payload is unavailable", status: 409 });
  }
  try {
    assertStructuredTextEnvelope(request.text);
  } catch (error) {
    return refusedBeforeReservation(deliveryFailure(error));
  }
  try {
    const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
    const overlong = refusedIdempotencyKey(idempotencyKey);
    if (overlong) return overlong;
    const refs = rawImages.length > 0
      ? (admission.previewImageRefs ?? runtimeImageRefsForUploads)(rawImages)
      : suppliedRefs;
    if (!request.text && refs.length === 0) throw new Error("held delivery must contain at most 32000 characters");
    const content = refs.length ? structuredContent(request.text, refs) : null;
    const deliveryText = content?.content.text ?? request.text;
    const contentDigest = content?.contentDigest ?? null;
    const payloadKind = refs.length ? "runtime-images" : "text";
    /* Conflict and terminal replay outcomes remain side-effect free. Accepted
       sends establish the durable account fence before reservation placement. */
    const replay = registry.preflightDeliveryReservation(
      conversation.id,
      deliveryText,
      idempotencyKey,
      payloadKind,
      refs,
      contentDigest,
      commandInput(request),
    );
    if (replay?.state === "delivered") {
      return deliveredReservationReplay(replay, idempotencyKey, conversation.id, false);
    }
    if (replay?.state === "failed") {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: replay.error || "delivery target is unavailable",
        status: 409,
      };
    }
    const generation = conversation.generations.at(-1);
    const activeAccountId = registry.engineRouting(conversation.engine).activeAccountId;
    if (activeAccountId && generation?.accountId && generation.accountId !== activeAccountId) {
      /* Off the loop; refused before anything is reserved (rule c). */
      const reseatFor = conversation.id;
      const reseat = await registry.deliveryWrite({ label: "migration.reseat-request" },
        () => registry.requestConversationMigrationToActiveAccount(reseatFor, { launchId: request.launchId }));
      if (!reseat.acquired) return refusedBeforeReservation(deliveryFailure(new Error(REGISTRY_WRITER_BUSY)));
      conversation = reseat.value;
    }
    /* The write lock is waited for off the event loop and kept for the write;
       one another writer keeps past its deadline reserves nothing. */
    const place = async (): Promise<HeldDelivery> => {
      const held = await registry.holdDeliveryOffLoop(
        conversation.id,
        deliveryText,
        idempotencyKey,
        payloadKind,
        refs,
        contentDigest,
        commandInput(request),
        { recoveryIntent: allowReclaimed ? "reclaimed-host" : null },
      );
      if (!held) throw new Error(REGISTRY_WRITER_BUSY);
      return held;
    };
    /* Publication and reservation are one section per key, as on the live
       path: two racing attempts under the same client message id see a durable
       winner, and the bytes are published once, before the row that names
       them. A replay found inside the lock is answered from the row that
       already exists rather than publishing over it. */
    const admissionKey = request.clientMessageId?.trim()
      ? `${conversation.id}\u0000${request.clientMessageId.trim()}`
      : null;
    const reservation = await withAdmissionSection(admissionKey, async () => {
      if (rawImages.length === 0) return place();
      return (admission.withImageAdmissionLock ?? withAccountMutationLockAsync)(async () => {
        const raced = registry.preflightDeliveryReservation(
          conversation.id,
          deliveryText,
          idempotencyKey,
          payloadKind,
          refs,
          contentDigest,
          commandInput(request),
        );
        if (raced) return raced;
        (admission.storeImages ?? ((images) => runtimeImageStore().putMany(images)))(rawImages);
        return place();
      });
    });
    if (reservation.state === "delivered") {
      return deliveredReservationReplay(reservation, idempotencyKey, conversation.id, false);
    }
    if (reservation.state === "failed") {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: reservation.error || "delivery target is unavailable",
        status: 409,
      };
    }
    recordWait(wait.progress, registry, reservation, wait);
    requestTick();
    return {
      ok: true,
      structured: true,
      target: conversation.id,
      outcome: "held",
      operationId: reservation.command.operationId,
    };
  } catch (error) {
    return deliveryFailure(error);
  }
}

/** The image half of an admission, carried from the request's dependencies to
    whichever hold ends up making the payload durable. */
function synchronizationImageAdmission(
  dependencies: StructuredMessageDependencies,
  rawImages: readonly RuntimeImageUpload[],
): SynchronizationImageAdmission {
  return {
    rawImages,
    ...(dependencies.storeImages ? { storeImages: dependencies.storeImages } : {}),
    ...(dependencies.previewImageRefs ? { previewImageRefs: dependencies.previewImageRefs } : {}),
    ...(dependencies.withImageAdmissionLock ? { withImageAdmissionLock: dependencies.withImageAdmissionLock } : {}),
  };
}

function recordStructuredRuntimeRecovery(
  session: RuntimeSession | null,
  recovered: () => void,
): void {
  if (session && isStructuredHostKind(session.hostKind)) {
    recovered();
  }
}

async function refreshRepublishedSession(
  session: RuntimeSession,
  client: RuntimeHostClient,
  republish: (key: RuntimeSession["sessionKey"]) => Promise<boolean>,
): Promise<{ session: RuntimeSession; republished: boolean }> {
  if (session.host !== "dead" && session.host !== "unhosted") return { session, republished: false };
  if (!await republish(session.sessionKey)) return { session, republished: false };
  const refreshed = await readRuntimeSession(client, { conversationId: session.conversationId, artifactPath: session.artifactPath ?? undefined });
  return {
    session: refreshed ?? session,
    republished: true,
  };
}

function requiresDeadConversationRecovery(
  session: RuntimeSession,
  registry: AgentRegistry,
  conversation: RegistryConversation,
): boolean {
  if (session.host === "dead" || session.host === "unhosted") return true;
  if (session.host !== "registering" || session.artifactPath !== null) return false;
  const generation = conversation.generations.at(-1);
  if (!generation) return false;
  const entry = registry.conversationDeliverySnapshot({ conversationId: conversation.id }).entries[`${conversation.engine}:${generation.id}`];
  /* Production #389 retained a pre-artifact runtime placeholder after the
     durable current generation had already lost its host and process. */
  return entry?.status === "dead"
    && entry.host === null
    && entry.pendingAction === null
    && entry.structuredHost?.process === null;
}

/** Whether the structured queue's reconfigure executor owns this switch, and
    with it the predecessor teardown that follows the commit (issue #1028). It
    is woken by a drain, never executed a second time from here. */
function reconfigureOwnsSwitch(conversation: RegistryConversation): boolean {
  return conversation.reconfigure?.status === "applying"
    && conversation.reconfigure.accountId === conversation.migration?.targetId;
}

/** The runtime session that owns the conversation once a forced switch has
    settled (issue #1028): the successor when its host is published, the
    unchanged source when the switch failed and left it in place. */
async function sessionAfterSwitch(
  client: RuntimeHostClient,
  conversation: RegistryConversation,
): Promise<RuntimeSession | null> {
  const current = conversation.generations.at(-1);
  try {
    const refreshed = await readRuntimeSession(client, { conversationId: conversation.id });
    return refreshed && (!current || refreshed.artifactPath === current.path) ? refreshed : null;
  } catch {
    return null;
  }
}

function requestMigrationProgress(
  registry: AgentRegistry,
  conversationId: ViewerConversationId,
  requestTick: () => void,
): void {
  const phase = registry.conversation(conversationId)?.migration?.phase;
  if (phase && !["committed", "rolled-back"].includes(phase)) requestTick();
}

function deliveredReservationReplay(
  reservation: HeldDelivery,
  idempotencyKey: string,
  target: ViewerConversationId | null,
  spawned: boolean,
): StructuredMessageResult {
  const receipt: RuntimeOperationReceipt = {
    operationId: reservation.command.operationId,
    idempotencyKey,
    conversationId: reservation.runtimeConversationId,
    kind: reservation.command.kind,
    status: "delivered",
    ...(reservation.command.turnId !== undefined ? { turnId: reservation.command.turnId } : {}),
    reason: null,
    at: reservation.deliveredAt ?? reservation.createdAt,
    revision: 1,
  };
  return {
    ok: true,
    structured: true,
    target,
    outcome: "delivered",
    operationId: reservation.command.operationId,
    receipt,
    ...(spawned ? { spawned: true } : {}),
  };
}

function uncertainReservationFailure(reservation: HeldDelivery): StructuredMessageResult {
  return {
    ok: false,
    structured: true,
    outcome: "failed",
    error: reservation.error || "the previous delivery outcome is unknown; verify its receipt before sending again",
    status: 409,
    operationId: reservation.command.operationId,
    transportUncertain: true,
  };
}

function requestDeliveryDrain(kick: () => void | Promise<void>): void {
  try {
    void Promise.resolve(kick()).catch((error) => {
      console.error("[structured delivery] reclaimed host drain request failed", error);
    });
  } catch (error) {
    console.error("[structured delivery] reclaimed host drain request failed", error);
  }
}

/**
 * A reclaimed current generation has no deliverable runtime host to inspect.
 * Admission therefore starts from the durable conversation, reserves the
 * instruction, and only then asks the existing recovery path to publish a host.
 * The durable delivery queue remains the reserved operation's sole actuator
 * after recovery. A resume still waiting for a process leaves that same
 * operation held there.
 */
async function recoverReclaimedMessage(
  request: StructuredMessageRequest,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  dependencies: StructuredMessageDependencies,
  rawImages: readonly RuntimeImageUpload[] = [],
): Promise<StructuredMessageResult> {
  const conversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as ViewerConversationId)
    : registry.conversationForPath(request.path);
  if (!conversation) return ownershipUnavailable("unknown");
  const progress = progressPort(dependencies.progress);
  const admitted = await holdDuringRuntimeSynchronization(
    request,
    registry,
    dependencies.requestMigrationTick ?? requestAccountMigrationTick,
    true,
    synchronizationImageAdmission(dependencies, rawImages),
    { progress, reason: "recovering-host", detail: "the conversation's host was reclaimed" },
  );
  if (!admitted) return ownershipUnavailable("unknown");
  if (!admitted.ok || admitted.outcome === "delivered") return admitted;
  const reservation = reservationFor(registry, admitted.operationId);
  if (reservation?.state === "delivery-uncertain") {
    return uncertainReservationFailure(reservation);
  }
  if (!reservation || reservation.state === "held") return admitted;

  let recovered: Awaited<ReturnType<typeof recoverDeadStructuredConversation>>;
  try {
    recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)({
      path: request.path || conversation.generations.at(-1)?.path || "",
      conversationId: conversation.id,
      origin: reservation.command.origin,
      operationId: reservation.command.operationId,
      admittedAt: reservation.createdAt,
    }, {
      registry,
      client,
    });
  } catch (error) {
    const failure = `${deliverabilityFailureMessage({ condition: "reclaimed" })}: ${error instanceof Error ? error.message : String(error)}`;
    if (error instanceof StructuredResumeUnpublishedError) {
      const settled = await endReservationForRequest(registry, progress, reservation, failure);
      if (!settled.ended) return acceptedHeld(admitted.operationId);
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: settled.error,
        status: 503,
        operationId: admitted.operationId,
      };
    }
    recordWait(progress, registry, reservation, {
      reason: "awaiting-host",
      detail: `starting a host failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    requestDeliveryDrain(dependencies.kick ?? kickStructuredDeliveryQueue);
    return {
      ok: true,
      structured: true,
      target: null,
      outcome: "held",
      operationId: admitted.operationId,
    };
  }
  if (!recovered) {
    const failure = deliverabilityFailureMessage({ condition: "reclaimed" });
    const settled = await endReservationForRequest(registry, progress, reservation, failure);
    if (!settled.ended) return acceptedHeld(admitted.operationId);
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: settled.error,
      status: 503,
      operationId: admitted.operationId,
    };
  }

  requestDeliveryDrain(dependencies.kick ?? kickStructuredDeliveryQueue);
  return {
    ok: true,
    structured: true,
    target: null,
    outcome: "held",
    operationId: admitted.operationId,
    ...(recovered.spawned ? { spawned: true } : {}),
  };
}

/**
 * The progress record of one drain attempt on a reservation the journal does
 * not hold yet. The attempt is counted once, on its first note; a drain that
 * only reconciles an earlier attempt records nothing, since the queue or the
 * settlement owns that record.
 */
function heldDrainProgress(
  progress: DeliveryProgressPort | null,
  registry: AgentRegistry,
  request: HeldStructuredMessageRequest,
) {
  const operationId = request.command?.operationId ?? request.deliveryId;
  let delivery: HeldDelivery | null | undefined;
  let attempted = false;
  let written: DeliveryProgressRecord | null = null;
  const wait = (reason: DeliveryWaitReason, detail: string | null = null) => {
    if (!progress || request.reconcileUncertain) return;
    if (delivery === undefined) {
      try { delivery = reservationFor(registry, operationId); }
      catch { delivery = null; }
    }
    if (!delivery) return;
    written = recordWait(progress, registry, delivery, { reason, detail, attempted: !attempted });
    attempted = true;
  };
  return {
    wait,
    /** A reconcile whose runtime read failed: the queue cannot list the
        journal either, so the reconcile, acting on this operation, says so. */
    unreadable(cause: string) {
      if (!progress || !request.reconcileUncertain) return;
      let reservation: HeldDelivery | null = null;
      try { reservation = reservationFor(registry, operationId); }
      catch { reservation = null; }
      if (reservation) recordWait(progress, registry, reservation, { reason: "evidence-unreadable", detail: `the runtime journal could not be read: ${cause}` });
    },
    /** The payload was refused before any command. */
    rejected(cause: string) {
      settleRecord(progress, operationId, "failed", cause);
    },
    /** The journal admitted the attempt: the record says so unless the queue,
        further along, already wrote it. */
    admitted() {
      if (!progress || !written) return;
      try {
        if (!stillAtStep(progress.get(operationId), written)) return;
        progress.note(operationId, written.conversationId, {
          waitReason: "queued",
          nextWakeMs: STRUCTURED_DELIVERY_TIMING.retryMs,
        });
      } catch (error) {
        console.error("[structured delivery] progress record failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export async function deliverHeldStructuredMessage(
  request: HeldStructuredMessageRequest,
  dependencies: HeldStructuredMessageDependencies = {},
): Promise<HeldStructuredMessageOutcome> {
  if (!(dependencies.enabled ?? structuredHostsEnabled)()) return null;
  const registry = (dependencies.registry ?? agentRegistry)();
  const progress = heldDrainProgress(progressPort(dependencies.progress), registry, request);
  const outcome = await deliverHeldAttempt(request, dependencies, registry, progress);
  if (typeof outcome === "object" && outcome) {
    if (outcome.outcome === "rejected") progress.rejected(outcome.cause);
    else progress.wait(outcome.waitReason ?? "awaiting-host", outcome.cause);
  }
  return outcome;
}

async function deliverHeldAttempt(
  request: HeldStructuredMessageRequest,
  dependencies: HeldStructuredMessageDependencies,
  registry: AgentRegistry,
  progress: ReturnType<typeof heldDrainProgress>,
): Promise<HeldStructuredMessageOutcome> {
  const client = (dependencies.client ?? runtimeHostClient)();
  if (!client) {
    progress.unreadable("runtime host client is unavailable");
    return heldOutcomeDuringRuntimeSynchronization(request, registry, "runtime host client is unavailable");
  }
  let session: RuntimeSession | null;
  try {
    session = await readRuntimeSession(client, { conversationId: request.conversationId ?? undefined, artifactPath: request.path || undefined });
  } catch (error) {
    console.error("[structured delivery] runtime session read failed", error);
    progress.unreadable(error instanceof Error ? error.message : String(error));
    return heldOutcomeDuringRuntimeSynchronization(request, registry, error instanceof Error ? error.message : String(error));
  }
  recordStructuredRuntimeRecovery(session, dependencies.startupRecovered ?? markStructuredRuntimeSessionRecovered);
  if (!session || (isStructuredHostKind(session.hostKind) && (session.host === "dead" || session.host === "unhosted"))) {
    const owner = persistedCurrentOwner(request, registry);
    if (owner?.kind === "legacy") {
      return heldOutcomeDuringRuntimeSynchronization(request, registry, "runtime session is unavailable");
    }
    const deliverability = conversationDeliverabilityFromRecord(registry.conversationDeliverySnapshot(request), {
      conversationId: request.conversationId,
      transcriptPath: request.path,
    });
    /* A resume already publishing ownership keeps this reservation held. A
       second recovery would race the first host before either one could own
       the operation. Only the durable reclaimed condition starts recovery.

       Every return from here to `client.command` below is made before
       anything was dispatched, so the reservation goes back to the queue with
       its message, attachments and operation id, and the reason (#1974). It
       used to be recorded `delivery-uncertain`, which settlement must treat
       as possibly executed, for a message that provably never left. */
    if (deliverability.condition !== "reclaimed") return heldForRetry(deliverability.reason);
    try {
      const recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)({
        path: request.path,
        conversationId: request.conversationId,
        origin: request.command?.origin,
        operationId: request.command?.operationId ?? request.deliveryId,
      }, {
        registry,
        client,
        requestDeliveryDrain: () => {
          void (dependencies.kick ?? kickStructuredDeliveryQueue)();
        },
      });
      if (recovered) progress.wait("recovering-host", "the conversation's host was reclaimed");
      return recovered ? "held" : heldForRetry(deliverabilityFailureMessage({ condition: "reclaimed" }));
    } catch (error) {
      if (error instanceof StructuredRecoveryHeldForUpdateError) {
        progress.wait("update-handoff");
        return "held";
      }
      return heldForRetry(`${deliverabilityFailureMessage({ condition: "reclaimed" })}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const refreshed = await refreshRepublishedSession(
      session,
      client,
      dependencies.republish ?? republishStructuredDeliveryHost,
    );
    session = refreshed.session;
    if (refreshed.republished && (session.host === "dead" || session.host === "unhosted")) {
      return heldForRetry("the recipient's host was republished without a live process");
    }
  } catch (error) {
    return heldForRetry(`the recipient's host could not be made ready: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (session.hostKind === "tmux-legacy") return requiresStructuredHeldCommand(request) ? "failed" : null;
  if (!isStructuredHostKind(session.hostKind)) return heldForRetry("the recipient's runtime session is not a structured host");
  try {
    const refs = request.imageRefs ?? [];
    const imageCapability = session.capabilities.imageInput
      ?? runtimeImageCapability(session.sessionKey.engine, false);
    /* The same predicate admission asks (Note 2): a rejection admission
       decided and could not write is reached again here, before any command. */
    const refusal = payloadRefusal(imageCapability, session.sessionKey.engine, refs);
    if (refusal) return { outcome: "rejected", cause: refusal.error };
    const content = structuredContent(request.text, refs);
    const command = request.command ?? {
      operationId: request.deliveryId,
      kind: "send" as const,
      policy: "interrupt-active" as const,
    };
    progress.wait("dispatching");
    const result = await client.command({
      kind: command.kind,
      operationId: command.operationId,
      conversationId: request.runtimeConversationId ?? request.conversationId,
      idempotencyKey: request.clientMessageId,
      text: content.content.text,
      ...(refs.length ? { images: refs } : {}),
      contentDigest: content.contentDigest,
      /* Same rule on the drain path (#1560). `canonicalHeldDeliveryCommand`
         always fills a policy in, so a persisted injection replayed from before
         holds were refused would die here too. */
      ...(command.kind === "inject" ? {} : { policy: command.policy }),
      ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
      /* #1117: the authorship persisted on the held record survives the
         migration hold — the drained message re-attributes exactly as admitted. */
      ...(command.origin ? { origin: command.origin } : {}),
    });
    if (result.receipt.status === "queued" || result.receipt.status === "pending") progress.admitted();
    try {
      await (dependencies.kick ?? kickStructuredDeliveryQueue)();
    } catch {
      // The journal receipt below remains authoritative after a drain failure.
    }
    const latest = await client.operationStatus(result.operationId) ?? result;
    if (["delivered", "turn-started", "steered"].includes(latest.receipt.status)) return "delivered";
    if (latest.receipt.status === "failed" || latest.receipt.status === "rejected") return "failed";
    return "delivery-uncertain";
  } catch {
    return "delivery-uncertain";
  }
}

export async function enqueueStructuredMessage(
  request: StructuredMessageRequest,
  dependencies: StructuredMessageDependencies = {},
): Promise<StructuredMessageResult | null> {
  /* A seat's deputy takes its one ask and nothing after it, whoever sends and
     whether it is live or ended (docs/design/ghost-seat.md §4). Refused before
     anything is reserved, so no host is resumed for it. The one exception is
     startup recovery's continuation of the turn a release cut, while the
     deputy is live: that turn is still its one job. */
  const deputyRefusal = deputyDeliveryRefusal({
    ...request,
    interruptionContinuation: dependencies.interruptionContinuation === true
      && request.origin?.role === RECOVERY_NOTICE_ORIGIN.role
      && isInterruptionObligationId(request.clientMessageId),
  });
  if (deputyRefusal) return refusedBeforeReservation({ ok: false, structured: true, outcome: "failed", ...deputyRefusal });
  if (!(dependencies.enabled ?? structuredHostsEnabled)()) return null;
  const imageAdmission = admitRuntimeImagePayload({ images: request.images ?? [] });
  if (imageAdmission.error) {
    return refusedBeforeReservation({ ok: false, structured: true, outcome: "failed", error: imageAdmission.error.error, status: imageAdmission.error.status });
  }
  const rawImages = imageAdmission.images;
  const registry = (dependencies.registry ?? agentRegistry)();
  const durableOwner = persistedCurrentOwner(request, registry);
  if (durableOwner?.kind === "legacy") {
    return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  }
  const progress = progressPort(dependencies.progress);
  const client = (dependencies.client ?? runtimeHostClient)();
  if (!client) {
    return holdDuringRuntimeSynchronization(
      request,
      registry,
      dependencies.requestMigrationTick ?? requestAccountMigrationTick,
      false,
      synchronizationImageAdmission(dependencies, rawImages),
      { progress, reason: "evidence-unreadable", detail: "the runtime host is unreachable" },
    );
  }
  let session: RuntimeSession | null;
  try {
    session = await readRuntimeSession(client, { conversationId: request.conversationId ?? undefined, artifactPath: request.path || undefined });
  } catch (error) {
    console.error("[structured delivery] runtime session read failed", error);
    return holdDuringRuntimeSynchronization(
      request,
      registry,
      dependencies.requestMigrationTick ?? requestAccountMigrationTick,
      false,
      synchronizationImageAdmission(dependencies, rawImages),
      { progress, reason: "evidence-unreadable", detail: `the runtime session could not be read: ${error instanceof Error ? error.message : String(error)}` },
    );
  }
  recordStructuredRuntimeRecovery(session, dependencies.startupRecovered ?? markStructuredRuntimeSessionRecovered);
  if (!session) {
    const deliverability = conversationDeliverabilityFromRecord(registry.conversationDeliverySnapshot(request), {
      conversationId: request.conversationId,
      transcriptPath: request.path,
    });
    if (deliverability.condition === "reclaimed") {
      return recoverReclaimedMessage(request, registry, client, dependencies, rawImages);
    }
    return holdDuringRuntimeSynchronization(
      request,
      registry,
      dependencies.requestMigrationTick ?? requestAccountMigrationTick,
      false,
      synchronizationImageAdmission(dependencies, rawImages),
      { progress, reason: "awaiting-host", detail: "no runtime session is registered for the conversation" },
    );
  }
  if (session.hostKind === "tmux-legacy") return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  if (!isStructuredHostKind(session.hostKind)) {
    const deliverability = conversationDeliverabilityFromRecord(registry.conversationDeliverySnapshot(request), {
      conversationId: request.conversationId,
      transcriptPath: request.path,
    });
    if (deliverability.condition === "reclaimed") {
      return recoverReclaimedMessage(request, registry, client, dependencies, rawImages);
    }
    return ownershipUnavailable(deliverability.condition);
  }
  try {
    assertStructuredTextEnvelope(request.text);
  } catch (error) {
    return refusedBeforeReservation(deliveryFailure(error));
  }
  const suppliedRefs = request.imageRefs ?? [];
  const wantsImages = request.hasImages === true || rawImages.length > 0 || suppliedRefs.length > 0;
  if (request.hasImages && rawImages.length === 0 && suppliedRefs.length === 0) {
    return refusedBeforeReservation({ ok: false, structured: true, outcome: "failed", error: "structured image payload is unavailable", status: 409 });
  }
  if (rawImages.length > 0 && suppliedRefs.length > 0) {
    return refusedBeforeReservation(deliveryFailure(new Error("structured image payload is ambiguous")));
  }
  if (!session.conversationId.startsWith("conversation_")) return ownershipUnavailable();
  /* The superseded guard runs BEFORE dead-host recovery below: an implicit
     recovery of a retired round would silently fork it (issue #383). */
  const rejected = supersededRejection(registry, registry.conversation(session.conversationId as ViewerConversationId));
  if (rejected) return rejected;
  let conversation = registry.conversation(session.conversationId as ViewerConversationId);
  if (!conversation) return ownershipUnavailable();
  const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
  const overlong = refusedIdempotencyKey(idempotencyKey);
  if (overlong) return overlong;
  let refs: StructuredImageRef[];
  let content: ReturnType<typeof structuredContent>;
  let terminalReplay: HeldDelivery | null;
  try {
    refs = suppliedRefs.length > 0
      ? suppliedRefs
      : (dependencies.previewImageRefs ?? runtimeImageRefsForUploads)(rawImages);
    content = structuredContent(request.text, refs);
    terminalReplay = registry.preflightDeliveryReservation(
      conversation.id,
      content.content.text,
      idempotencyKey,
      refs.length ? "runtime-images" : "text",
      refs,
      content.contentDigest,
      commandInput(request),
    );
  } catch (error) {
    return deliveryFailure(error);
  }
  if (terminalReplay?.state === "delivered") {
    return deliveredReservationReplay(terminalReplay, idempotencyKey, conversation.id, false);
  }
  if (terminalReplay?.state === "failed") {
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: terminalReplay.error || "delivery target is unavailable",
      status: 409,
    };
  }
  const generation = conversation.generations.at(-1);
  const activeAccountId = registry.engineRouting(conversation.engine).activeAccountId;
  /* Request an active-account reseat before any predecessor host republish or
     recovery. An accepted migration fence assigns this send to the successor. */
  if (activeAccountId && generation?.accountId && generation.accountId !== activeAccountId) {
    try {
      /* Off the loop; refused before anything is reserved (rule c). */
      const reseatFor = conversation.id;
      const reseat = await registry.deliveryWrite({ label: "migration.reseat-request" },
        () => registry.requestConversationMigrationToActiveAccount(reseatFor, { launchId: request.launchId }));
      if (!reseat.acquired) return refusedBeforeReservation(deliveryFailure(new Error(REGISTRY_WRITER_BUSY)));
      conversation = reseat.value;
    } catch (error) {
      return deliveryFailure(error);
    }
  }
  /**
   * #1560: an injection is never parked behind an account switch.
   *
   * A held delivery is replayed against the SUCCESSOR generation, which is a
   * different thread. That is right for a message — the operator wants it said
   * to whoever is answering now — and wrong for an injection, whose whole
   * meaning is "put this into the history of the thread I am looking at".
   * Replaying it elsewhere would write the operator's context into a thread
   * they never aimed at, and dropping it would lose it silently. Refused here,
   * before any reservation exists, so nothing is written and the operator can
   * simply inject again once the switch has landed.
   */
  if (request.kind === "inject" && deliveryFence(conversation) === "held") {
    return refusedBeforeReservation({
      ok: false,
      structured: true,
      outcome: "failed",
      error: "an account switch is pending for this conversation; injected context cannot be held across it",
      status: 409,
    });
  }
  let migrationOwnsSend = deliveryFence(conversation) === "held";
  /* Belt and braces for issue #1028: a send arriving while a switch is pending
     FORCES it. "After current turn" is only an honest promise while a turn is
     actually running — an idle host has nothing left to wait for, and parking
     the operator's message behind that wait is how a queued send becomes
     permanently stranded, whatever woke the coordinator or failed to.

     Forcing means waking the executor that OWNS this switch, never running a
     second one: a reconfigure-owned switch is driven by the structured queue,
     which commits and then retires the predecessor host, so the send kicks
     that drain and waits for it. Only a switch nobody owns — an engine drain,
     the active-account reseat above — is advanced here directly. Either way
     the message is admitted after the switch lands, so it is the successor's
     first input instead of input queued against a session being retired.

     Only an idle host forces it. A running turn keeps the promise the banner
     made, and an unknown turn axis — recovering, degraded, gone — is not
     evidence that anything finished, so those sends keep waiting rather than
     tear down a session that may still be working. */
  let successorAwaitsItsHost = false;
  if (migrationOwnsSend && session.turn === "idle") {
    try {
      await (dependencies.kick ?? kickStructuredDeliveryQueue)();
    } catch {
      /* A drain failure is not this send's to report; the fallback below still
         advances a switch the drain did not settle. */
    }
    conversation = registry.conversation(conversation.id) ?? conversation;
    if (deliveryFence(conversation) === "held" && !reconfigureOwnsSwitch(conversation)) {
      try {
        conversation = await (dependencies.executeSwitch ?? advanceConversationMigration)(conversation.id, registry);
      } catch {
        conversation = registry.conversation(conversation.id) ?? conversation;
      }
    }
    migrationOwnsSend = deliveryFence(conversation) === "held";
    if (!migrationOwnsSend) {
      /* Deliveries held earlier in the same pending window are the successor's
         too, and only the coordinator drains those. */
      (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
      const switched = await sessionAfterSwitch(client, conversation);
      /* The successor owns the conversation but has not published its host
         yet. This message still becomes a durable reservation against the
         successor generation below — payload, images and all — and the
         coordinator's drain delivers it; only the in-request command is
         skipped, because there is nothing yet to aim it at. */
      if (!switched) successorAwaitsItsHost = true;
      else session = switched;
    }
  }
  /* A session left over from the retired predecessor is not this send's target
     and must not be republished or recovered into one: the successor is the
     conversation's session now, and its own publication is already under way
     (#1028). */
  if (!migrationOwnsSend && !successorAwaitsItsHost) {
    try {
      const refreshed = await refreshRepublishedSession(
        session,
        client,
        dependencies.republish ?? republishStructuredDeliveryHost,
      );
      session = refreshed.session;
    } catch (error) {
      /* A transport read can fail after the dead host was republished. Keep
         the known dead projection and continue into durable reservation plus
         bounded recovery, so an original-key lookup can find the operation.
         A deterministic refusal before admission closes the MCP receipt with
         its actual reason instead of leaving it unknown forever. */
      if (!isRuntimeHostTransportFailure(error)) {
        return refusedBeforeReservation(deliveryFailure(error));
      }
    }
  }
  const recoveryRequired = !migrationOwnsSend
    && !successorAwaitsItsHost
    && requiresDeadConversationRecovery(session, registry, conversation);
  /* Conflict preflight computes candidate refs and digest before writing.
     A changed payload under an existing client message id rejects with zero
     blob publication, GC, or registry effects. First admissions publish
     before the reservation references them. */
  const admissionKey = request.clientMessageId?.trim()
    ? `${conversation.id}\u0000${request.clientMessageId.trim()}`
    : null;
  /* The attachment bytes are published ONCE per request, however many times
     the admission is entered. A dead-host send enters it twice — before the
     resume to make the payload durable, and after it to read the reservation
     the drain may have assigned — and re-publishing on the second pass is
     duplicated work against the blob store for bytes that are already there
     under the same content address. */
  let publishedImages = false;
  const admitDurably = () => withAdmissionSection(admissionKey, async () => {
    const admit = async (): Promise<HeldDelivery> => {
      const replay = registry.preflightDeliveryReservation(
        conversation.id,
        content.content.text,
        idempotencyKey,
        refs.length ? "runtime-images" : "text",
        refs,
        content.contentDigest,
        commandInput(request),
      );
      if (replay) return replay;
      if (rawImages.length > 0 && !publishedImages) {
        (dependencies.storeImages ?? ((images) => runtimeImageStore().putMany(images)))(rawImages);
        publishedImages = true;
      }
      /* A reservation race can follow publication when another process runs
         older code or when a structured spawn published the same digest.
         The grace-period collector owns orphan cleanup. Synchronous removal
         cannot distinguish this admission's blob from a deduplicated blob
         whose durable reservation is still pending.

         The write lock is waited for off the event loop and kept for the
         write (incident 2026-10-06); one another writer keeps past its
         deadline reserves nothing and refuses the send. */
      const held = await registry.holdDeliveryOffLoop(
        conversation.id,
        content.content.text,
        idempotencyKey,
        refs.length ? "runtime-images" : "text",
        refs,
        content.contentDigest,
        commandInput(request),
      );
      if (!held) throw new Error(REGISTRY_WRITER_BUSY);
      return held;
    };
    if (rawImages.length === 0) return withAccountMutationLockAsync(admit, { holder: "send admission", caller: "send admission" });
    return (dependencies.withImageAdmissionLock
      ?? ((operation) => withAccountMutationLockAsync(operation, { holder: "image send admission", caller: "send" })))(admit);
  });
  let recoveryReservation: HeldDelivery | null = null;
  if (recoveryRequired) {
    /* The WHOLE message is reserved before the host is raised — the text and
       the attachment bytes, under one key, through the one admission every
       other send takes.

       It used to be text only, and the reason was the image STORE: publishing
       blobs wants the admission lock, and the pre-recovery hold ran outside
       it. The consequence was the operator's, not the code's: a message with a
       photo reached recovery with nothing durable behind it, so a resume that
       failed answered 503 with no operation id at all and the queue had
       nothing to retry with or to show. The admission below is the same
       closure, lock included, so the payload that survives a failed resume is
       the whole message rather than the half of it that needed no bytes. */
    try {
      recoveryReservation = await admitDurably();
    } catch (error) {
      return deliveryFailure(error);
    }
    if (recoveryReservation.state === "delivery-uncertain") {
      return uncertainReservationFailure(recoveryReservation);
    }
    /* Accepted from here: its record says the host is being resumed for it. */
    recordWait(progress, registry, recoveryReservation, {
      reason: "recovering-host",
      detail: "the conversation's host is being resumed",
      nextWakeMs: null,
    });
  }
  let recoveredHost = false;
  /* Ownership recovery comes BEFORE capability evaluation: a dead projection
     carries no image capability, and judging the payload against it would 409
     a session whose recovered host advertises image input. */
  let activeSession = session;
  if (recoveryRequired) {
    let recovered;
    try {
      recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)({
        path: request.path || session.artifactPath || "",
        conversationId: session.conversationId as ViewerConversationId,
        origin: recoveryReservation?.command.origin,
        operationId: recoveryReservation?.command.operationId,
        admittedAt: recoveryReservation?.createdAt,
      }, { registry, client });
    } catch (error) {
      const failure = `${deliverabilityFailureMessage({ condition: "reclaimed" })}: ${error instanceof Error ? error.message : "structured host recovery failed"}`;
      if (recoveryReservation && error instanceof StructuredResumeUnpublishedError) {
        const settled = await endReservationForRequest(registry, progress, recoveryReservation, failure);
        if (!settled.ended) return acceptedHeld(recoveryReservation.command.operationId);
        return {
          ok: false,
          structured: true,
          outcome: "failed",
          error: settled.error,
          status: 503,
          operationId: recoveryReservation.command.operationId,
        };
      }
      if (!recoveryReservation) return ownershipUnavailable("reclaimed");
      /* Accepted, and its resume failed: the drain retries it. */
      recordWait(progress, registry, recoveryReservation, {
        reason: "awaiting-host",
        detail: `starting a host failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      requestDeliveryDrain(dependencies.kick ?? kickStructuredDeliveryQueue);
      return {
        ok: true,
        structured: true,
        target: null,
        outcome: "held",
        operationId: recoveryReservation.command.operationId,
      };
    }
    if (!recovered) {
      /* Past the reservation: a recovery ran, so this is no pre-admission refusal. */
      const failure = deliverabilityFailureMessage({ condition: "reclaimed" });
      const settled = recoveryReservation
        ? await endReservationForRequest(registry, progress, recoveryReservation, failure)
        : null;
      if (recoveryReservation && settled && !settled.ended) return acceptedHeld(recoveryReservation.command.operationId);
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: settled?.ended ? settled.error : failure,
        status: 503,
        ...(recoveryReservation ? { operationId: recoveryReservation.command.operationId } : {}),
      };
    }
    recoveredHost = recovered.spawned;
    try {
      activeSession = await readRuntimeSession(client, { conversationId: session.conversationId, artifactPath: session.artifactPath ?? undefined }) ?? session;
    } catch {
      /* The pre-recovery projection remains the conservative capability source. */
    }
  }
  /* A send the switch owns is judged against what the SUCCESSOR can accept,
     which is not knowable from the session in hand — the predecessor's, or
     none at all while the successor's host is still publishing (#1028). Either
     way the payload is admitted durably and the drain judges it against the
     real host, so a capability this projection cannot see must not 409 an
     image the operator already handed over. */
  const imageCapability = migrationOwnsSend || successorAwaitsItsHost
    ? runtimeImageCapability(activeSession.sessionKey.engine, true)
    : activeSession.capabilities.imageInput
      ?? runtimeImageCapability(activeSession.sessionKey.engine, false);
  /* A payload the recovered host cannot accept is refused on the reservation
     that already holds it, not merely on this response: the record exists from
     before recovery now, so leaving it held would park an impossible message
     in the queue forever. Terminalizing it names the real reason on the
     operator's bubble and releases the key. */
  /* An ending the lock refused leaves the send accepted and answered held;
     the drain asks the same predicate before its command (Note 2). */
  const refuseReservedPayload = async (error: string, status: number): Promise<StructuredMessageResult> => {
    if (recoveryReservation) {
      const settled = await endReservationForRequest(registry, progress, recoveryReservation, error, "checking");
      if (!settled.ended) return acceptedHeld(recoveryReservation.command.operationId, null, recoveredHost);
      return { ok: false, structured: true, outcome: "failed", error, status, operationId: recoveryReservation.command.operationId };
    }
    return { ok: false, structured: true, outcome: "failed", error, status };
  };
  const payloadRefused = payloadRefusal(imageCapability, activeSession.sessionKey.engine, refs, wantsImages);
  if (payloadRefused) return refuseReservedPayload(payloadRefused.error, payloadRefused.status);
  let commandResult: RuntimeOperationResult | null = null;
  /* The operation a claimed reservation was accepted under. The claim leaves
     the reservation `delivery-uncertain`, so from here a throw is an accepted
     send whose fate is unknown, and it answers with this handle. */
  let claimedOperationId: string | null = null;
  try {
    /* The same admission the recovery branch already ran. Re-entering it is
       how the reservation's CURRENT state is read: a hold the drain assigned
       to the host that just came back comes back `assigned`, and the command
       below delivers it in this request. */
    let reservation = await admitDurably();
    let claimedReservationId: string | null = null;
    if (reservation.state === "delivery-uncertain") {
      /* The same-key resend re-arms its reservation (P16), off the loop; one
         the lock refused stays uncertain and answers so. */
      const uncertain = reservation;
      const rearmed = await registry.deliveryWrite({ label: "delivery.rearm", operationId: uncertain.command.operationId },
        () => registry.retryUncertainDelivery(uncertain.id));
      if (!rearmed.acquired) return uncertainReservationFailure(uncertain);
      reservation = rearmed.value;
    }
    if (reservation.state === "held") {
      /* The switch landed between the check above and the reservation. The
         reservation exists but nothing has been handed to any engine, so
         releasing it leaves the thread untouched (#1560). */
      if (request.kind === "inject") {
        const injected = reservation;
        const released = await registry.deliveryWrite({ label: "delivery.terminalize", operationId: injected.command.operationId },
          () => registry.terminalizeHeldDelivery(injected.id, "injected context cannot be held across an account switch"));
        /* Refused for the lock: it stays held, and the switch's commit fails a
           held injection with its own reason, or a rollback returns it to
           this thread. Never replayed into the successor's. */
        if (!released.acquired) {
          recordWait(progress, registry, injected, { reason: "switching-accounts" });
          return acceptedHeld(injected.command.operationId, recoveredHost ? null : conversation.id, recoveredHost);
        }
        settleRecord(progress, injected.command.operationId, "failed", "injected context cannot be held across an account switch");
        return {
          ok: false,
          structured: true,
          outcome: "failed",
          error: "an account switch is pending for this conversation; injected context cannot be held across it",
          status: 409,
          operationId: reservation.command.operationId,
        };
      }
      recordWait(progress, registry, reservation, { reason: "switching-accounts" });
      (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
      return acceptedHeld(reservation.command.operationId, recoveredHost ? null : conversation.id, recoveredHost);
    }
    if (reservation.state === "delivered") {
      return deliveredReservationReplay(
        reservation,
        idempotencyKey,
        recoveredHost ? null : conversation.id,
        recoveredHost,
      );
    }
    if (reservation.state === "assigned" && successorAwaitsItsHost) {
      recordWait(progress, registry, reservation, {
        reason: "awaiting-host",
        detail: "the account switch's successor has not published its host yet",
      });
      (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
      return acceptedHeld(reservation.command.operationId, conversation.id);
    }
    if (reservation.state !== "assigned" || !reservation.generationId) {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: reservation.error || "delivery target is unavailable",
        status: 409,
      };
    }
    const assigned = { id: reservation.id, generationId: reservation.generationId, command: reservation.command, runtimeConversationId: reservation.runtimeConversationId };
    const accepted = reservation;
    /* Rule (a): the record exists from the reservation on, and each step of
       this request writes its wait on it. None of these waits has a next
       wake: the request itself is in them, and every one is bounded (the
       lock 5 s, the socket call 3 s, the section by its holder's bounds). */
    let written = recordWait(progress, registry, accepted, {
      reason: "checking",
      detail: "claiming the delivery record",
      nextWakeMs: null,
    });
    if (!dependencies.actuationLease && actuationBusy(conversation.id)) {
      written = recordWait(progress, registry, accepted, {
        reason: "conversation-busy",
        detail: "an earlier send on this conversation is being admitted",
        nextWakeMs: null,
      }) ?? written;
    }
    /* #1709: the claim and the command's admission to the journal run in the conversation's actuation section,
       so a send claimed after another reaches the journal after it. */
    /* A claim whose write lock another writer kept past its deadline changed
       nothing: the reservation stays assigned for the drain. */
    let claimDeferred = false;
    const admitted = await withConversationActuation(conversation.id, async (lease) => {
      lease.act(assigned.command.operationId);
      const claim = await registry.beginDeliveryAttemptOffLoop(assigned.command.operationId, assigned.id, assigned.generationId);
      if (!claim.acquired) claimDeferred = true;
      const claimed = claim.acquired ? claim.value : null;
      if (!claimed) return null;
      claimedReservationId = claimed.id;
      claimedOperationId = claimed.command.operationId;
      written = recordWait(progress, registry, claimed, {
        reason: "checking",
        detail: "admitting to the runtime journal",
        nextWakeMs: null,
      }) ?? written;
      commandResult = await client.command({
        kind: assigned.command.kind,
        operationId: assigned.command.operationId,
        conversationId: assigned.runtimeConversationId,
        idempotencyKey,
        text: content.content.text,
        ...(refs.length ? { images: refs } : {}),
        contentDigest: content.contentDigest,
        /* #1560: an injection carries NO policy. There is no interrupt to choose
           and no queue to fall back to, and the parser refuses one — so stamping
           the send default here refused every injection at the journal, with
           `thread/inject_items` never called. The default stays exactly what it
           was for every other kind. */
        ...(assigned.command.kind === "inject" ? {} : { policy: request.policy ?? "interrupt-active" }),
        ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
        ...(request.runtime ? { runtime: request.runtime } : {}),
        ...(request.selectedContext ? { selectedContext: request.selectedContext } : {}),
        ...(request.origin ? { origin: request.origin } : {}),
      });
      return commandResult;
    }, dependencies.actuationLease ?? null);
    if (!admitted) {
      /* A migration took the conversation, or an earlier admission still waits: the drain delivers this one in order.
         The requeue waits for the lock off the loop; refused, the reservation stays assigned and unclaimed. */
      let requeueRefused = false;
      let requeued = accepted;
      if (!claimDeferred) {
        const requeue = await registry.deliveryWrite({ label: "delivery.requeue", operationId: accepted.command.operationId },
          () => registry.requeueHeldDelivery(accepted.id));
        if (requeue.acquired) requeued = requeue.value;
        else requeueRefused = true;
      }
      recordWait(progress, registry, requeued, claimDeferred
        ? { reason: "checking", detail: "the writer claim waited past its lock deadline" }
        : requeueRefused
          ? { reason: "checking", detail: "the requeue waited past its lock deadline" }
          : { reason: "conversation-busy", detail: "an earlier delivery on this conversation is still being claimed" });
      (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
      return acceptedHeld(reservation.command.operationId, recoveredHost ? null : conversation.id, recoveredHost);
    }
    const result = admitted;
    const receipt = result.receipt;
    if (receipt.status === "rejected" || receipt.status === "failed" || receipt.status === "uncertain") {
      if (claimedReservationId && receipt.status !== "uncertain") {
        /* Off the loop; refused, the reservation stays `delivery-uncertain`
           and the drain or the sweep projects the journal's receipt. */
        const settledId = claimedReservationId;
        await registry.deliveryWrite({ label: "delivery.settle", operationId: result.operationId },
          () => registry.recordDeliveryOutcome(settledId, "failed", receipt.reason || "structured host delivery failed"));
        requestMigrationProgress(registry, conversation.id, dependencies.requestMigrationTick ?? requestAccountMigrationTick);
      }
      settleRecord(progress, result.operationId, receipt.status === "uncertain" ? "uncertain" : "failed", receipt.reason || "structured host delivery failed");
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: receipt.reason || "structured host delivery failed",
        status: 409,
        operationId: result.operationId,
        receipt,
      };
    }
    if (claimedReservationId && ["delivered", "turn-started", "steered"].includes(receipt.status)) {
      const settledId = claimedReservationId;
      await registry.deliveryWrite({ label: "delivery.settle", operationId: result.operationId },
        () => registry.recordDeliveryOutcome(settledId, "delivered"));
      requestMigrationProgress(registry, conversation.id, dependencies.requestMigrationTick ?? requestAccountMigrationTick);
      settleRecord(progress, result.operationId, "delivered", null);
    }
    /* The journal holds it now. The queue may already continue the record,
       so this answer is written only over the record this request wrote. */
    if (receipt.status === "queued" || receipt.status === "pending") {
      recordWaitUnlessContinued(progress, registry, accepted, written, {
        reason: "queued",
        nextWakeMs: STRUCTURED_DELIVERY_TIMING.retryMs,
      });
    }
    (dependencies.kick ?? kickStructuredDeliveryQueue)();
    const outcome = receipt.status === "delivering" || receipt.status === "delivered" ? receipt.status : "queued";
    return {
      ok: true,
      structured: true,
      target: recoveredHost ? null : conversation.id,
      outcome,
      operationId: result.operationId,
      receipt,
      ...(recoveredHost ? { spawned: true } : {}),
    };
  } catch (error) {
    const failure = deliveryFailure(error);
    /* Assigned inside the actuation section's callback, which control-flow narrowing does not follow. */
    const handedOver = commandResult as RuntimeOperationResult | null;
    const claimedOperation = claimedOperationId as string | null;
    if (!handedOver) {
      /* Thrown before the runtime answered, after the claim: the command may
         have reached the journal, so the send stays uncertain and keeps the
         operation it was accepted with (P7). Its record says so, counts the
         attempt, and the queue is woken: nobody else would before its safety
         pass, and if the journal did admit it the queue continues the same
         record within one pass. */
      if (claimedOperation) {
        const claimedReservation = reservationFor(registry, claimedOperation);
        if (claimedReservation) {
          recordWait(progress, registry, claimedReservation, {
            reason: "evidence-unreadable",
            detail: `the runtime journal did not acknowledge the admission: ${failure.error}`,
            attempted: true,
            nextWakeMs: STRUCTURED_DELIVERY_TIMING.retryMs,
          });
        }
        requestDeliveryDrain(dependencies.kick ?? kickStructuredDeliveryQueue);
      }
      return claimedOperation
        ? { ...failure, operationId: claimedOperation, transportUncertain: true }
        : failure;
    }
    const receipt = handedOver.receipt;
    const definitiveFailure = receipt.status === "failed" || receipt.status === "rejected";
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: failure.error,
      status: failure.status,
      operationId: handedOver.operationId,
      receipt,
      ...(!definitiveFailure ? { transportUncertain: true } : {}),
    };
  }
}
