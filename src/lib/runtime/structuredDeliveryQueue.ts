import { blockingHostActivityFlags } from "./hostActivityFlags";
import { NativeQueueProtocolRefusal } from "./nativeCodexQueue";
import { RetryBackoff } from "./retryBackoff";
import { REGISTRY_WRITER_BUSY } from "@/lib/agent/registry";
import type { NativeQueueCommand } from "./nativeQueueContracts";
import { parseRuntimeCommand, parseRuntimeIdleKillFence, parseRuntimeProviderRecoveryRef, parseRuntimeSendSettings } from "./commands";
import { withConversationActuation, type ActuationLease } from "@/lib/deliveryActuation";
import { parseSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { parseMessageOrigin, type MessageOrigin } from "./messageOrigin";
import type { RuntimeRetirementClaim, RuntimeTransitionOptions, RuntimeInjectionBinding, RuntimeSendSettings, RuntimeTransitionDetails } from "./contracts";
import { captureProcessIdentity, processIdentityProvenDead, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { evidenceAgrees, readEvidence, readOptionalEvidence, type Evidence } from "./evidence";
import type { CompactCapableHost, DeliveryReceipt, EngineHost, FirstDispatchEvidence, HostState, QueueEntry, RuntimeInjectOutcome, RuntimeSteerOutcome } from "./engineHost";
import { hostSupportsCompact, hostSupportsInject, StructuredCompactError, StructuredInjectError, StructuredSendRefusedError } from "./engineHost";
import {
  parseStructuredImageRefs,
  structuredContent,
  type StructuredMessageContent,
} from "./structuredContent";
import { StructuredRecoveryContendedError } from "./structuredRecoveryContention";
import { StructuredRecoveryHeldForUpdateError, type StructuredRecoveryRequest } from "./structuredRecovery";
import type { DeliveryProgressNote, DeliveryProgressRecord, DeliveryProgressSink } from "./deliveryProgress";
import { ACTIVE_DELIVERY_PHASES, type DeliveryWaitReason } from "./deliveryWaitReason";

export interface StructuredDeliveryEffect {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  eventSeq: number;
}

export type StructuredDeliveryTransition = "queued" | "delivering" | "applying" | "delivered" | "applied" | "answered" | "interrupted" | "failed" | "uncertain";

interface StructuredOperationStatus {
  retirementClaim?: RuntimeRetirementClaim | null;
  status: string;
  revision?: number;
  reason?: string | null;
  /** Immutable admission time on current receipts; `at` supports older rows. */
  admittedAt?: string;
  at?: string;
  /** The interrupt-and-resend route recorded when this send's delivery began,
      so an executor that did not issue the interrupt still reports it. */
  delivery?: string | null;
  interruptedTurnId?: string | null;
}

export interface StructuredDeliveryQueuePort {
  /** Re-read the idle revision after claiming an automatic continuation. */
  idleContinuationCurrent?(conversationId: string, fence: import("./contracts").RuntimeIdleKillFence): Promise<boolean>;
  /** Pause durable effects while an automatic release handoff owns admission. */
  handoffHeld?(): boolean;
  /** Hold a fresh autonomous turn while original accepted work settles. */
  autonomousTurnHeld?(operationId: string, admittedAt?: string): boolean;
  /** A terminal provider turn engages an account pick immediately (#1983).
      Live host health still fences a newer turn before applying it. */
  terminalTurn?(conversationId: string): boolean;
  nativeQueueExecute?(
    command: NativeQueueCommand & { operationId: string; eventSeq: number },
    refusalReason?: string,
    note?: (reason: DeliveryWaitReason, detail?: string | null) => void,
    /** Tracks one read the entry waits on as the lane's `checking` step. */
    step?: <T>(detail: string, wait: () => Promise<T>) => Promise<T>,
    /** The durable settlement fence an add's first actuation must pass. */
    settled?: () => Promise<Evidence<boolean>>,
  ): Promise<void | false>;
  nativeQueueReconcile?(): Promise<void>;
  /** Startup owns recovery for hosts it has not registered yet. Leave their
   * original operations pending while already registered hosts keep serving. */
  deferTarget?(conversationId: string): boolean;
  /** A reconfigure withdrawn before its claim, or whose claimed switch was cancelled (#1705). */
  reconfigureCancelled?(effect: StructuredReconfigureEffect): boolean;
  /** The failed account switch holding this conversation's messages, or null (#1846). */
  switchHold?(conversationId: string): { accountId: string; reason: string } | null;
  /** Records that the account switch a message engaged failed, so that message and the ones after it stay held.
   * `false` means the registry refused the write: nothing was held. */
  holdForFailedSwitch?(effect: StructuredReconfigureEffect, reason: string): void | boolean | Promise<void | boolean>;
  effects(kinds?: readonly string[], afterEventSeq?: number): Promise<StructuredDeliveryEffect[]>;
  transition(
    operationId: string,
    status: StructuredDeliveryTransition,
    details?: RuntimeTransitionDetails,
    options?: RuntimeTransitionOptions,
  ): Promise<void>;
  /** Persist the concrete generation a fresh retry is about to reach. */
  bindDeliveryGeneration?(operationId: string, generationId: string): boolean | Promise<boolean>;
  /** The durable receipt state, when the port can read it. The compact control
      needs it to tell a control it must issue from one an earlier executor
      already issued and never settled (#862), and the message path reads the
      ownership its own `delivering` write recorded back off the reason.

      Every one of the three reads below is FAILABLE — as is the live host's
      own state, read through the same type — and none of them may be converted
      into a definite answer when it fails. An unreadable fence is not an open
      one: it blocks this pass instead of authorising it (#1131). */
  status?(operationId: string): Promise<StructuredOperationStatus | null>;
  /** Whether the durable DELIVERY RECORD has already ended this send (#1131).
      The journal cannot answer that during the outage in which it is written,
      which is exactly when it has to be honoured. */
  settled?(operationId: string): boolean | Promise<boolean>;
  /** Synchronous live cutoff at the engine call, after all journal/health waits. */
  authorizeDispatch?(operationId: string): void;
  /** Durable caller attribution for background queue diagnostics. */
  diagnosticError?(...args: unknown[]): void;
  /** The writer claim that currently owns this conversation's structured host —
      the durable answer to "who may write to the engine right now" (#1131).
      Recorded when a send enters delivery and compared when one is found still
      there, so a `delivering` row is called abandoned on evidence that
      ownership CHANGED rather than on its mere existence. Absent port, absent
      claim, or a read that throws: no evidence either way, which leaves the row
      with the executor that holds it rather than ending its send. */
  hostClaim?(conversationId: string): string | null | Promise<string | null>;
  /** Carries the outcome of a transition whose ACKNOWLEDGEMENT was lost into
      the durable delivery record (#1612).
   *
   * `transition` writes the journal and the delivery record in that order, so a
   * transport failure between them commits the outcome and drops the projection
   * — and the completing transition clears the effect in the same transaction,
   * which means no later drain pass can rediscover it. This queue holds the one
   * moment where that is still known, so it hands the operation back rather than
   * dropping it. The implementation reads the journal's own answer instead of
   * trusting what this call meant to write, and settles nothing it cannot read;
   * it must never throw and never actuate the message again.
   *
   * Answers whether the fate was ESTABLISHED — settled, or read and shown to
   * settle nothing. False means only that the journal could not be read, which
   * is what brings the operation back on the next pass. */
  projectTerminal?(operationId: string): Promise<boolean>;
  injectionBinding?(conversationId: string): RuntimeInjectionBinding | null;
  /** Where each held message's wait reason, attempt, progress and next wake are
      recorded (incident 2026-10-06). Absent records nothing. */
  progress?: DeliveryProgressSink;
  /** Open records whose wake is overdue for a message the journal does not
      hold yet: an accepted send still held before it, which another drain
      delivers. Absent leaves them to that drain's own schedule. */
  unlistedWakeDue?(records: readonly DeliveryProgressRecord[]): void;
  /** The host's own evidence that this operation's message reached the
      recipient, read by original key and never written by it: the Claude
      delivery ledger and transcript, the Codex thread. False when nothing
      proves it; a throw is unreadable evidence. */
  confirmedDelivery?(operationId: string): Promise<boolean>;
}

/** The clocks of the bounds below; tests shorten them. */
export interface StructuredDeliveryQueueTiming {
  /** How long one drain pass waits on its conversation lanes before it ends
      and leaves the slow ones running on their own. */
  passBudgetMs: number;
  /** An active phase (handing over, interrupting) that has lasted this long is
      recorded as stalled. */
  stallMs: number;
  /** An interrupt-active send without progress this long starts original-key
      reconciliation. */
  interruptReconcileMs: number;
  /** The watchdog runs a light pass at least this often while it is bound. */
  safetyPassMs: number;
  /** The delay of the controller's scheduled retry, recorded as the next wake. */
  retryMs: number;
  /** How long one original-key evidence read may stay unanswered before its
      lane may be reconciled again. */
  reconcileReadMs: number;
  now: () => number;
}

export const STRUCTURED_DELIVERY_TIMING: StructuredDeliveryQueueTiming = {
  passBudgetMs: 5_000,
  stallMs: 4_000,
  interruptReconcileMs: 30_000,
  safetyPassMs: 5_000,
  retryMs: 1_000,
  reconcileReadMs: 10_000,
  now: Date.now,
};

/** How often one open progress record of an unlisted operation is checked. */
const UNLISTED_CHECK_MS = 30_000;
/** Lost-wake detection tolerates this much lateness before it calls a wake lost. */
const WAKE_GRACE_MS = 2_000;

/**
 * One conversation's drain, running on its own (incident 2026-10-06).
 *
 * The queue used to await every conversation inside one global pass, and the
 * next admission awaited that pass, so one host that did not answer held every
 * other conversation's next delivery. Each conversation now drains in its own
 * lane: a pass starts the lanes that are free, waits for them only up to
 * {@link StructuredDeliveryQueueTiming.passBudgetMs}, and a lane that is still
 * running keeps its conversation to itself until it ends. Two lanes never
 * drain one conversation at once, and the durable `delivering` row fences an
 * operation even across executors.
 */
interface DeliveryLane {
  conversationId: string;
  startedAt: number;
  /** The message this lane is acting on, and since when in which phase. */
  current: {
    operationId: string;
    phase: DeliveryWaitReason;
    since: number;
    replacesTurn: boolean;
    /** A `checking` phase: the read or write the lane is waiting on, and the
        effect it is for. Kept here until it lasts long enough to record. */
    step?: { effect: DeliveryEffect; detail: string; recorded: boolean };
  } | null;
  /** A pass found more work for this conversation while the lane ran. */
  rerun: boolean;
  /** The lane held an operation that settled elsewhere and was let go; it
      acts on nothing further when it resumes. */
  released: boolean;
  /** When original-key reconciliation last looked at its current operation. */
  reconciledAt: number | null;
  /** The evidence read in flight for this lane; one at a time. */
  reconciling: object | null;
}

export type StructuredHostResolver = (conversationId: string) => EngineHost | null;
/** Starts a successor host for a conversation whose host is gone, answering
    whether it started one. A {@link StructuredRecoveryContendedError} says the
    attempt was refused before it reserved anything; the queue keeps the
    operation queued and tries again on a bounded schedule (#1716). */
export type StructuredHostRecovery = (conversationId: string, admission?: Pick<StructuredRecoveryRequest, "origin" | "operationId" | "admittedAt">) => Promise<boolean>;
export type StructuredKillRefusal = (conversationId: string) => string | null | Promise<string | null>;

const STRUCTURED_DELIVERY_BATCH_SIZE = 100;
const THREAD_READ_ATTEMPTS = 2;
/** Controls carry no message reservation to settle them outside the journal,
    so the queue itself gives every accepted control a terminal ceiling. */
export const CONTROL_SETTLEMENT_WINDOW_MS = 2 * 60_000;
/** How many terminal projections may be owed at once before the oldest is
    given up (#1612). The Viewer's side of the same bound the runtime journal
    keeps on the receipts themselves. */
const UNPROJECTED_TERMINAL_LIMIT = 128;
/** How many attempts a host recovery gets while account-mutation contention
    keeps refusing its successor reservation before the reservation exists
    (#1716). Attempts are spaced 1s, 2s, 4s, 8s and then 15s apart, about two
    minutes in all, after which the operation settles failed with the busy
    reason. */
const CONTENDED_RECOVERY_ATTEMPTS = 12;
const CONTENDED_RECOVERY_FIRST_SPACING_MS = 1_000;
const CONTENDED_RECOVERY_MAX_SPACING_MS = 15_000;
const TERMINAL_DELIVERY_STATUSES = new Set([
  "turn-started",
  "steered",
  "delivered",
  "applied",
  "interrupted",
  "answered",
  "rejected",
  "failed",
  "uncertain",
]);

interface SendEffect {
  operationId: string;
  conversationId: string;
  content: StructuredMessageContent;
  contentDigest: string;
  turnId?: string | null;
  onlyIfIdle?: import("./contracts").RuntimeIdleKillFence;
  policy?: "queue" | "steer-if-active" | "steer-or-queue" | "interrupt-active";
  kind: "send" | "steer";
  runtime?: RuntimeSendSettings;
  /** #844: the selected-card reference the operator submitted with. Replayed
      from the durable payload, never re-read from a live view. */
  selectedContext?: SelectedContextRef;
  /** #1117: authorship stamped at admission, replayed from the durable payload. */
  origin?: MessageOrigin;
  eventSeq: number;
}

/**
 * One native history injection (#1560).
 *
 * Deliberately its OWN effect type rather than a `SendEffect` with a third
 * kind: the send effect carries a delivery policy and an image list, and
 * injection has neither. Keeping them apart is what makes it impossible for a
 * policy to be read off an injection and acted on, which is the exact mistake
 * that would turn "add this without interrupting" into an interrupt.
 */
interface InjectEffect {
  binding: RuntimeInjectionBinding | null;
  operationId: string;
  conversationId: string;
  kind: "inject";
  text: string;
  contentDigest: string;
  /** The caller's fence, replayed verbatim. A string requires that turn to
      still be running; `null` requires an idle thread; absent accepts either. */
  turnId?: string | null;
  selectedContext?: SelectedContextRef;
  origin?: MessageOrigin;
  eventSeq: number;
}

interface ControlEffect {
  operationId: string;
  conversationId: string;
  kind: "answer" | "interrupt" | "kill";
  onlyIfIdle?: import("./contracts").RuntimeIdleKillFence;
  providerRecovery?: import("./contracts").RuntimeProviderRecoveryRef;
  attentionId?: string;
  resolution?: unknown;
  turnId?: string | null;
  sessionKey?: { engine: "codex" | "claude"; sessionId: string };
  eventSeq: number;
}

/** A manual compaction (#862): a control fenced to one owned generation that
    carries no content, so nothing on it can be replayed as user input. */
interface CompactEffect {
  operationId: string;
  conversationId: string;
  kind: "compact";
  sessionKey: { engine: "codex" | "claude"; sessionId: string };
  eventSeq: number;
}

export interface StructuredReconfigureEffect {
  operationId: string;
  conversationId: string;
  kind: "reconfigure";
  sessionKey?: { engine: "codex" | "claude" | "copilot"; sessionId: string };
  model: string;
  effort: string;
  fast: boolean | null;
  accountId?: string;
  previousProfile?: { model: string | null; effort: string | null; fast: boolean | null };
  eventSeq: number;
}

export interface StructuredReconfigureOwnership {
  isCurrent(): Promise<boolean>;
  /** The conversation's sends this switch holds back that no host was ever
      handed: the switch carries them to the successor. */
  carriedSends?: readonly string[];
}

export type StructuredReconfigureHandler = (
  effect: StructuredReconfigureEffect,
  ownership: StructuredReconfigureOwnership,
) => Promise<void | "applied" | "pending" | "writer-busy">;

type NativeEffect = NativeQueueCommand & { operationId: string; eventSeq: number };
type DeliveryEffect = NativeEffect | SendEffect | InjectEffect | ControlEffect | CompactEffect | StructuredReconfigureEffect;

interface ControlDrainResult {
  blocked: boolean;
  terminated: boolean;
}

interface SuccessfulKillBoundary {
  operationId: string;
  conversationId: string;
  eventSeq: number;
}

function isControlEffect(effect: DeliveryEffect): effect is ControlEffect | CompactEffect {
  return effect.kind === "answer" || effect.kind === "interrupt" || effect.kind === "kill" || effect.kind === "compact";
}

function isCompactEffect(effect: DeliveryEffect): effect is CompactEffect {
  return effect.kind === "compact";
}

function isReconfigureEffect(effect: DeliveryEffect): effect is StructuredReconfigureEffect {
  return effect.kind === "reconfigure";
}

/** An account pick that has not started moving the conversation: it waits for the next engagement (#1846). */
function isParkableSwitch(effect: DeliveryEffect, receipt: StructuredOperationStatus | null): boolean {
  return isReconfigureEffect(effect) && Boolean(effect.accountId) && receipt?.status !== "applying";
}

/** A receipt still at its admission revision: queued and never moved, so no
    host was handed the operation. The first-dispatch evidence reads the same. */
function neverDispatched(receipt: StructuredOperationStatus | null | undefined): boolean {
  return receipt?.revision === 1 && (receipt.status === "queued" || receipt.status === "pending");
}

/** What engages a conversation: a message for its next turn. */
function isEngagement(effect: DeliveryEffect): boolean {
  return effect.kind === "send" || effect.kind === "steer" || effect.kind === "native-queue";
}

function isRuntimeControlEffect(
  effect: DeliveryEffect,
): effect is ControlEffect | CompactEffect | StructuredReconfigureEffect {
  return isControlEffect(effect) || isReconfigureEffect(effect);
}

function controlSettlementDeadlineAt(receipt: StructuredOperationStatus | null): number | null {
  if (!receipt) return null;
  const admittedAt = Date.parse(receipt.admittedAt ?? receipt.at ?? "");
  return Number.isFinite(admittedAt) ? admittedAt + CONTROL_SETTLEMENT_WINDOW_MS : null;
}

function expiredControlSettlement(
  effect: ControlEffect | CompactEffect | StructuredReconfigureEffect,
  receipt: StructuredOperationStatus | null,
  now = Date.now(),
): { status: "failed" | "uncertain"; reason: string } | null {
  if (!receipt) return null;
  const deadlineAt = controlSettlementDeadlineAt(receipt);
  if (deadlineAt === null || now < deadlineAt) return null;
  const action = effect.kind;
  if (receipt.status === "delivering" || receipt.status === "applying") {
    return {
      status: "uncertain",
      reason: `${action} control exceeded its 2-minute settlement deadline after actuation began; verify the conversation state before retrying`,
    };
  }
  return {
    status: "failed",
    reason: `${action} control exceeded its 2-minute settlement deadline; retry from the current conversation state`,
  };
}

function sendEffect(effect: StructuredDeliveryEffect): SendEffect | null {
  if (effect.kind !== "runtime.send" && effect.kind !== "runtime.steer") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const text = typeof effect.payload.text === "string" ? effect.payload.text : "";
  const images = effect.payload.images === undefined ? [] : parseStructuredImageRefs(effect.payload.images, 16);
  if (!operationId || !conversationId || !images) return null;
  let content;
  try { content = structuredContent(text, images); } catch { return null; }
  if (typeof effect.payload.contentDigest === "string" && effect.payload.contentDigest !== content.contentDigest) return null;
  const turnId = typeof effect.payload.turnId === "string" || effect.payload.turnId === null
    ? effect.payload.turnId
    : undefined;
  const policy = effect.payload.policy === "queue"
    || effect.payload.policy === "steer-if-active"
    || effect.payload.policy === "steer-or-queue"
    || effect.payload.policy === "interrupt-active"
    ? effect.payload.policy
    : undefined;
  let runtime: RuntimeSendSettings | undefined;
  /* A SETTINGS BLEMISH MUST NEVER STRAND THE MESSAGE ITSELF (#390 §10). The
     admission validated this payload with this same function, so a throw here
     can only describe a durable record no admission produced; absent settings
     mean today's behaviour, and dropping the words with them would lose the one
     thing the outbox exists to keep. */
  try { runtime = parseRuntimeSendSettings(effect.payload.runtime); } catch { runtime = undefined; }
  /* A malformed selection reference is omitted; the message retains its
     independent content and runtime profile. */
  const selectedContext = parseSelectedContextRef(effect.payload.selectedContext);
  const origin = parseMessageOrigin(effect.payload.origin);
  let onlyIfIdle: import("./contracts").RuntimeIdleKillFence | undefined;
  try {
    if (effect.payload.onlyIfIdle !== undefined) onlyIfIdle = parseRuntimeIdleKillFence(effect.payload.onlyIfIdle);
  } catch { return null; }
  if (onlyIfIdle && (effect.kind !== "runtime.send" || policy !== "queue" || turnId !== null)) return null;
  return {
    operationId,
    conversationId,
    content: content.content,
    contentDigest: content.contentDigest,
    kind: effect.kind === "runtime.steer" ? "steer" : "send",
    eventSeq: effect.eventSeq,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(policy ? { policy } : {}),
    ...(runtime ? { runtime } : {}),
    ...(selectedContext ? { selectedContext } : {}),
    ...(origin ? { origin } : {}),
    ...(onlyIfIdle ? { onlyIfIdle } : {}),
  };
}

function parseInjectionBinding(value: unknown): RuntimeInjectionBinding | null {
  if (!value || typeof value !== "object") return null;
  const binding = value as Partial<RuntimeInjectionBinding>;
  return typeof binding.threadId === "string" && !!binding.threadId
    && (typeof binding.accountId === "string" || binding.accountId === null)
    && typeof binding.writerClaim === "string" && !!binding.writerClaim
    ? binding as RuntimeInjectionBinding : null;
}

function injectEffect(effect: StructuredDeliveryEffect): InjectEffect | null {
  if (effect.kind !== "runtime.inject") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const text = typeof effect.payload.text === "string" ? effect.payload.text : "";
  if (!operationId || !conversationId || !text) return null;
  /* An injection that somehow carries images is DROPPED, not stripped: the
     operator asked for that payload, and executing a silently reduced version
     of it is worse than leaving the operation for its admission-time refusal.
     Admission refuses images, so a record reaching here with them is corrupt. */
  if (Array.isArray(effect.payload.images) && effect.payload.images.length > 0) return null;
  let content;
  try { content = structuredContent(text, []); } catch { return null; }
  if (typeof effect.payload.contentDigest === "string" && effect.payload.contentDigest !== content.contentDigest) return null;
  const turnId = typeof effect.payload.turnId === "string" || effect.payload.turnId === null
    ? effect.payload.turnId
    : undefined;
  const selectedContext = parseSelectedContextRef(effect.payload.selectedContext);
  const origin = parseMessageOrigin(effect.payload.origin);
  return {
    operationId,
    conversationId,
    kind: "inject",
    binding: parseInjectionBinding(effect.payload.binding),
    text: content.content.text,
    contentDigest: content.contentDigest,
    eventSeq: effect.eventSeq,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(selectedContext ? { selectedContext } : {}),
    ...(origin ? { origin } : {}),
  };
}

function controlEffect(effect: StructuredDeliveryEffect): ControlEffect | null {
  if (effect.kind !== "runtime.answer" && effect.kind !== "runtime.interrupt" && effect.kind !== "runtime.kill") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  if (!operationId || !conversationId) return null;
  if (effect.kind === "runtime.answer") {
    const attentionId = typeof effect.payload.attentionId === "string" ? effect.payload.attentionId : "";
    if (!attentionId || !("resolution" in effect.payload)) return null;
    return { operationId, conversationId, kind: "answer", attentionId, resolution: effect.payload.resolution, eventSeq: effect.eventSeq };
  }
  if (effect.kind === "runtime.kill") {
    if (effect.payload.providerRecovery !== undefined && effect.payload.onlyIfIdle === undefined) return null;
    const key = effect.payload.sessionKey;
    if (!key || typeof key !== "object" || Array.isArray(key)) return null;
    const candidate = key as Record<string, unknown>;
    if ((candidate.engine !== "codex" && candidate.engine !== "claude") || typeof candidate.sessionId !== "string") return null;
    return {
      operationId,
      conversationId,
      kind: "kill",
      sessionKey: { engine: candidate.engine, sessionId: candidate.sessionId },
      ...(effect.payload.onlyIfIdle !== undefined
        ? { onlyIfIdle: parseRuntimeIdleKillFence(effect.payload.onlyIfIdle) } : {}),
      ...(effect.payload.providerRecovery !== undefined
        ? { providerRecovery: parseRuntimeProviderRecoveryRef(effect.payload.providerRecovery) } : {}),
      eventSeq: effect.eventSeq,
    };
  }
  const turnId = typeof effect.payload.turnId === "string" || effect.payload.turnId === null
    ? effect.payload.turnId
    : undefined;
  return { operationId, conversationId, kind: "interrupt", eventSeq: effect.eventSeq, ...(turnId !== undefined ? { turnId } : {}) };
}

function compactEffect(effect: StructuredDeliveryEffect): CompactEffect | null {
  if (effect.kind !== "runtime.compact") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const key = effect.payload.sessionKey;
  if (!operationId || !conversationId || !key || typeof key !== "object" || Array.isArray(key)) return null;
  const candidate = key as Record<string, unknown>;
  if ((candidate.engine !== "codex" && candidate.engine !== "claude") || typeof candidate.sessionId !== "string") return null;
  return {
    operationId,
    conversationId,
    kind: "compact",
    sessionKey: { engine: candidate.engine, sessionId: candidate.sessionId },
    eventSeq: effect.eventSeq,
  };
}

function reconfigureEffect(effect: StructuredDeliveryEffect): StructuredReconfigureEffect | null {
  if (effect.kind !== "runtime.reconfigure") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const model = typeof effect.payload.model === "string" ? effect.payload.model : "";
  const effort = typeof effect.payload.effort === "string" ? effect.payload.effort : "";
  const fast = typeof effect.payload.fast === "boolean" || effect.payload.fast === null ? effect.payload.fast : undefined;
  const accountId = typeof effect.payload.accountId === "string" ? effect.payload.accountId : undefined;
  const key = effect.payload.sessionKey;
  const sessionKey = key && typeof key === "object" && !Array.isArray(key)
    && ((key as Record<string, unknown>).engine === "codex" || (key as Record<string, unknown>).engine === "claude" || (key as Record<string, unknown>).engine === "copilot")
    && typeof (key as Record<string, unknown>).sessionId === "string"
    ? key as StructuredReconfigureEffect["sessionKey"]
    : undefined;
  if (key !== undefined && !sessionKey) return null;
  const previous = effect.payload.previousProfile;
  const previousProfile = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as StructuredReconfigureEffect["previousProfile"]
    : undefined;
  if (!operationId || !conversationId || !model || !effort || fast === undefined) return null;
  return {
    operationId,
    conversationId,
    kind: "reconfigure",
    ...(sessionKey ? { sessionKey } : {}),
    model,
    effort,
    fast,
    ...(accountId ? { accountId } : {}),
    ...(previousProfile ? { previousProfile } : {}),
    eventSeq: effect.eventSeq,
  };
}

function deliveryEffect(effect: StructuredDeliveryEffect): DeliveryEffect | null {
  if (effect.kind === "runtime.native-queue") {
    try {
      const command = parseRuntimeCommand("native-queue", effect.payload) as NativeQueueCommand;
      if (!command.operationId) return null;
      return { ...command, operationId: command.operationId, eventSeq: effect.eventSeq };
    } catch { return null; }
  }
  return injectEffect(effect) ?? controlEffect(effect) ?? compactEffect(effect) ?? reconfigureEffect(effect) ?? sendEffect(effect);
}

function successfulKillBoundary(effect: StructuredDeliveryEffect): SuccessfulKillBoundary | null {
  if (effect.kind !== "runtime.kill-boundary") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const admissionEventSeq = effect.payload.admissionEventSeq;
  if (!operationId || !conversationId
    || !Number.isSafeInteger(admissionEventSeq)
    || admissionEventSeq !== effect.eventSeq) return null;
  return { operationId, conversationId, eventSeq: effect.eventSeq };
}

/**
 * Written when a send was handed to the engine and the executor could not learn
 * what became of it. Both say the same thing to a reader and to the receipt:
 * actuation started, the outcome is unknown, and re-sending the same
 * instruction may deliver it twice.
 *
 * They are also what makes the journal's own words exact for a message effect:
 * `failed` is written only where the send never reached the engine, and
 * `uncertain` wherever it may have. Settlement reads that distinction back —
 * it is the difference between telling a caller a resend is safe and telling
 * them to verify the recipient first.
 */
export const DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR =
  "delivery was started by an earlier executor; whether it reached the recipient is unverified";
/**
 * The four reasons a native injection ends with (#1560), kept as constants
 * because the composer, the receipt projection and the MCP surface all have to
 * say the same thing about the same outcome.
 *
 * The split that matters is between the last two. `delivered` with
 * INJECTION_INTO_RUNNING_TURN or INJECTION_INTO_HISTORY means the insertion was
 * found in canonical history; neither says the model has read it, and the
 * operator-facing wording keeps that distinction. The unobserved reason is
 * written on `uncertain`, because an empty acknowledgement is a statement about
 * the request and not about the thread.
 */
export const INJECTION_INTO_RUNNING_TURN =
  "injected input was observed in canonical history for the running turn";
export const INJECTION_INTO_HISTORY =
  "injected input was observed in conversation history; no turn was started";
export const INJECTION_ACKNOWLEDGED_BUT_UNOBSERVED =
  "injection was acknowledged and did not appear in canonical history; whether it reached the thread is unverified";
export const INJECTION_UNVERIFIED_AFTER_ACTUATION =
  "injection was issued and the structured host did not answer; whether it reached the thread is unverified";
export const DELIVERY_UNVERIFIED_AFTER_ACTUATION =
  "delivery was started and the structured host did not answer; whether it reached the recipient is unverified";
/**
 * Written when the durable delivery record has already ended this send.
 *
 * That happens while the runtime host is unreachable: a caller asks what became
 * of an accepted send, the settlement cannot ask the journal, and past the
 * deadline it answers `failed` rather than leaving `queued` as the last word.
 * Delivering the effect once the socket comes back would put the instruction in
 * front of the recipient long after the sender was told it had not arrived, so
 * the settled record fences it here (#1131).
 */
export const DELIVERY_FENCED_BY_SETTLEMENT =
  "delivery was settled before this executor reached it; whether it reached the recipient is unverified";

/**
 * Who took a send into delivery, written where the durable row can carry it.
 *
 * A `delivering` row is the fence that stops a send from being written to the
 * engine twice, and it used to be read as proof of an ABANDONED executor on its
 * own. It is not: a send another executor is actuating right now looks exactly
 * the same, and terminalizing it drops work that is still going somewhere —
 * during a release succession, where two executors are briefly alive over one
 * journal, that is the ordinary case rather than the rare one.
 *
 * So the executor stamps itself and the writer claim it is delivering under
 * onto the transition, and a later executor calls the row abandoned only when
 * that ownership has actually CHANGED: a different executor whose claim on the
 * host is no longer the current one can no longer write to the engine at all,
 * so nothing is left to settle the row but this pass. The receipt reason is the
 * carrier — the journal already persists it per transition, and inventing a
 * durable column for one token would be a schema for a fact one string holds.
 *
 * The comparison has three outcomes, not two, and the third is the one that
 * bites: a claim that cannot be READ is not a claim that has moved. A transient
 * gap in the projection used to read as a handover and terminalize a send
 * another executor was actuating at that moment, so only an explicitly named
 * differing claim proves abandonment now; unreadable evidence leaves the row
 * where it is.
 *
 * That has to hold at the WRITE too, and it is where the rule was still
 * escaping: the stamp used to be omitted whenever the claim could not be read,
 * so a claim projection that was unavailable for the one moment this row was
 * written produced a row carrying no ownership at all — and an unstamped row
 * read as abandoned, which is the same unreadable evidence deciding the same
 * question, one step earlier. The executor identity is always recorded now, and
 * the claim beside it is recorded as UNKNOWN when it could not be read. An
 * unknown recorded claim is nothing to compare against, so it leaves the row
 * with its executor exactly as an unreadable current claim does.
 *
 * The absorbing rule is untouched by any of it: no branch here sends anything
 * again and no branch returns the row to `queued`. Ownership only decides
 * whether this pass ends the send as unverified or leaves it to its owner —
 * and a send left to an owner that never comes back is still ended by the
 * settlement deadline a receipt query applies, so leaving it can delay an
 * answer but can never withhold one.
 */
const DELIVERING_OWNERSHIP_PREFIX = "delivering-owner:";

/** The recorded claim of a row whose writer could not read one. Not a claim any
    projection can ever produce — claims are `<owner>:<epoch>` — so it can never
    be mistaken for one that matches or one that differs. */
const UNKNOWN_HOST_CLAIM = "?";

interface DeliveringOwnership {
  executorId: string;
  /** The claim the row was written under, or null when it was unreadable then. */
  hostClaim: string | null;
}

function deliveringOwnershipReason(executorId: string, hostClaim: Evidence<string | null>): string {
  const recorded = hostClaim.readable ? hostClaim.value ?? UNKNOWN_HOST_CLAIM : UNKNOWN_HOST_CLAIM;
  return `${DELIVERING_OWNERSHIP_PREFIX}${executorId}@${recorded}`;
}

/** Ownership off a durable reason, or null where the row carries none — a row
    written before this evidence existed, or by a path that recorded none. */
function deliveringOwnership(reason: string | null | undefined): DeliveringOwnership | null {
  if (typeof reason !== "string" || !reason.startsWith(DELIVERING_OWNERSHIP_PREFIX)) return null;
  const recorded = reason.slice(DELIVERING_OWNERSHIP_PREFIX.length);
  const separator = recorded.indexOf("@");
  if (separator < 1) return null;
  const hostClaim = recorded.slice(separator + 1);
  if (!hostClaim) return null;
  return {
    executorId: recorded.slice(0, separator),
    hostClaim: hostClaim === UNKNOWN_HOST_CLAIM ? null : hostClaim,
  };
}

function isMessageEffect(effect: DeliveryEffect): effect is SendEffect | InjectEffect {
  return effect.kind === "send" || effect.kind === "steer" || effect.kind === "inject";
}

/** A message handed to Codex's own queue: an ordinary queue send the journal
    converted, or a Queue-for-Codex hand-off. Its add operation carries the
    message's progress record (A6). */
function isNativeAddEffect(effect: DeliveryEffect): boolean {
  return effect.kind === "native-queue" && effect.action === "add";
}

function progressTerminalState(status: string): "delivered" | "failed" | "uncertain" {
  if (status === "uncertain") return "uncertain";
  return status === "failed" || status === "rejected" ? "failed" : "delivered";
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "structured host delivery failed").slice(0, 240);
}

function isThreadReadTimeout(error: unknown): boolean {
  return /thread\/read.*timed out|request timed out:\s*thread\/read/i.test(failureReason(error));
}

async function sendWithReadRetry(host: EngineHost, entry: QueueEntry, firstDispatch?: FirstDispatchEvidence, authorize?: () => void): Promise<DeliveryReceipt> {
  for (let attempt = 1; attempt <= THREAD_READ_ATTEMPTS; attempt += 1) {
    try {
      authorize?.();
      return await (attempt === 1 && firstDispatch ? host.send(entry, firstDispatch, authorize) : host.send(entry, undefined, authorize));
    } catch (error) {
      if (attempt === THREAD_READ_ATTEMPTS || !isThreadReadTimeout(error)) throw error;
    }
  }
  throw new Error("structured delivery retry budget exhausted");
}

interface RetirementExecutor {
  claim: RuntimeRetirementClaim;
  retired: boolean;
  draining: boolean;
  pendingClaims: Set<string>;
}

// Keep unfinished claim custody across controller/module replacement in this
// Viewer process. A retired executor cannot drain again; its final drain's
// completion proves that none of its signal ladders can still act.
const retirementProcess = process as typeof process & {
  __llvStructuredRetirementExecutors?: Map<string, RetirementExecutor>;
};
const retirementExecutors = retirementProcess.__llvStructuredRetirementExecutors ??= new Map<string, RetirementExecutor>();

function forgetRetirementOperation(operationId: string, executorId?: string): void {
  for (const [id, executor] of retirementExecutors) {
    if (executorId !== undefined && executorId !== id) continue;
    executor.pendingClaims.delete(operationId);
    if (!executor.draining && executor.pendingClaims.size === 0) retirementExecutors.delete(id);
  }
}

export class StructuredDeliveryQueue {
  private activeDrain: Promise<void> | null = null;
  private rerun = false;
  private readonly targetErrors = new Map<string, string>();
  private readonly passRetry = new RetryBackoff();
  private readonly reconfigureRetries = new Map<string, RetryBackoff>();
  /** Failed switches whose hold is still owed, by operation: the reason to hold with. */
  private readonly owedSwitchHolds = new Map<string, string>();
  private readonly nativeExecutionRetries = new Map<string, RetryBackoff>();
  private lastPassError: string | null = null;
  /** This executor's identity, minted per instance and never persisted beyond
      the `delivering` rows it writes. A successor instance — in this process or
      in the one that replaced it — is a different executor by construction,
      which is what a recovered row has to be able to tell (#1131). */
  private readonly executorId = crypto.randomUUID();
  private readonly retirementClaim: RuntimeRetirementClaim = { executorId: this.executorId, process: captureProcessIdentity(process.pid) };
  private readonly retirementExecutor: RetirementExecutor = {
    claim: this.retirementClaim, retired: false, draining: false, pendingClaims: new Set(),
  };
  private readonly interruptAcknowledged = new Set<string>();
  private readonly refusedSteerTurns = new Map<string, string | null>();
  private readonly activeSteers = new Map<string, { conversationId: string; turnId: string; settling: Promise<void> }>();
  /** An interrupt can need several drain passes before any message is handed
   * over. Keep that first-dispatch evidence only in this executor and claim;
   * eviction or restart returns to the conservative recovery path. */
  private readonly firstDispatches = new Map<string, FirstDispatchEvidence>();
  private readonly successfulKillBoundaries = new Map<string, SuccessfulKillBoundary>();
  /** Compactions whose engine control is issued and whose evidence has not
      arrived. The effect stays pending in the journal meanwhile, so every later
      drain pass must find it here and leave it alone (#862). */
  private readonly activeCompactions = new Map<string, Promise<void>>();
  /** Operations the journal ended and whose projection is still owed (#1612).
      Nothing else remembers them: the completing transition cleared their
      effects, so they can never come back through `effects()`. Bounded, and
      restarted at the head of every later pass — the drain is the clock — and
      each repair runs on its own, so one that hangs delays no conversation's
      delivery and no other repair. */
  private readonly unprojectedTerminals = new Set<string>();
  /** The repair attempt in flight for each owed projection; one at a time,
      and one that outlasts its bound gives the next pass a fresh attempt. */
  private readonly projectingTerminals = new Map<string, object>();
  /** Operations whose host recovery contention refused before the successor
      reservation existed (#1716): the attempts made so far and when the next
      one is due. Executor memory, like the first-dispatch evidence: a successor
      executor starts its own bounded count. The map has no size cap: dropping
      an entry while its operation is pending would hand that operation a fresh
      count and an immediate attempt. Each pass drops the entries of operations
      the journal no longer lists. */
  private readonly contendedRecoveries = new Map<string, { attempts: number; nextAt: number }>();
  /** #1560: injections whose engine write is done and whose canonical evidence
      is still being read, detached from the pass that issued them. */
  private readonly activeInjections = new Map<string, Promise<void>>();
  /** The conversations those compactions belong to. Reads block on this rather
      than on a whole-group barrier, so an unfinished compaction holds messages
      without holding kill, interrupt, or answer. */
  private readonly compactingConversations = new Set<string>();
  private readonly lanes = new Map<string, DeliveryLane>();
  /** Open progress records whose operation left the listing, and when this
      executor last asked the journal how they ended. */
  private readonly unlistedChecks = new Map<string, number>();
  /** The operations the last pass listed: what the watchdog compares open
      progress records against. */
  private lastListed: ReadonlySet<unknown> | null = null;
  /** When the interrupt for an interrupt-active send was last issued (or last
      reconciled): the clock of the thirty-second reconciliation. */
  private readonly interruptIssuedAt = new Map<string, number>();
  private readonly timing: StructuredDeliveryQueueTiming;
  private lastPassStartedAt = 0;

  constructor(
    private readonly port: StructuredDeliveryQueuePort,
    private readonly resolveHost: StructuredHostResolver,
    private readonly terminateHost: (
      conversationId: string,
      sessionKey: { engine: "codex" | "claude"; sessionId: string },
      onlyIfIdle?: import("./contracts").RuntimeIdleKillFence,
      authority?: { operationId: string; claim: RuntimeRetirementClaim },
      providerRecovery?: import("./contracts").RuntimeProviderRecoveryRef,
    ) => Promise<boolean> = async () => false,
    private readonly retrySoon: () => void = () => {},
    private readonly recoverHost: StructuredHostRecovery | null = null,
    private readonly reconfigure: StructuredReconfigureHandler = async () => {
      throw new Error("structured host reconfigure is unavailable");
    },
    /** Why this conversation's turn is severed, when evidence says it is
        (#1281). Null means "not shown to be severed", which is what every
        caller here treats as a reason to keep waiting — and so is a read that
        could not be made at all, which {@link readSeveredHostReason} keeps
        separate rather than letting it out as a thrown drain pass (#1131). */
    private readonly severedHostReason: (conversationId: string) => Promise<string | null> = async () => null,
    /** Refuses historical branch kills during recovery before host resolution. */
    private readonly killRefusal: StructuredKillRefusal = () => null,
    timing: Partial<StructuredDeliveryQueueTiming> = {},
  ) {
    this.timing = { ...STRUCTURED_DELIVERY_TIMING, ...timing };
  }

  drain(options: { safety?: boolean } = {}): Promise<void> {
    if (this.retirementExecutor.retired) return Promise.resolve();
    if (!this.passRetry.ready()) { this.retrySoon(); return Promise.resolve(); }
    if (this.activeDrain) {
      /* A watchdog pass is a safety net: one already running covers it. */
      if (options.safety) return this.activeDrain;
      this.rerun = true;
      return this.activeDrain;
    }
    this.retirementExecutor.draining = true;
    this.activeDrain = this.drainUntilSettled(options.safety === true).finally(() => {
      this.activeDrain = null;
      this.retirementExecutor.draining = false;
      if (this.retirementExecutor.pendingClaims.size === 0) retirementExecutors.delete(this.executorId);
    });
    return this.activeDrain;
  }

  retire(): void {
    this.retirementExecutor.retired = true;
    this.rerun = false;
  }

  lastTargetError(conversationId: string): string | null {
    return this.targetErrors.get(conversationId) ?? this.lastPassError;
  }

  /** Guarantees a drain pass whose journal read starts after this request. */
  async drainAfterAdmission(): Promise<void> {
    const precedingDrain = this.activeDrain;
    /* The preceding drain owner reports its own failure. This barrier still
       evaluates the journal state created by the completed admission. */
    if (precedingDrain) await precedingDrain.catch(() => undefined);
    await this.drain();
  }

  private async drainUntilSettled(safety = false): Promise<void> {
    let first = true;
    do {
      this.rerun = false;
      try {
        await this.drainPass(safety && first);
        first = false;
        this.passRetry.reset();
      } catch (error) {
        this.passRetry.fail();
        this.lastPassError = failureReason(error);
        throw error;
      }
    } while (this.rerun && !this.retirementExecutor.retired);
  }

  private async drainPass(safety = false): Promise<void> {
    this.lastPassStartedAt = this.timing.now();
    let rawEffects: StructuredDeliveryEffect[];
    try {
      /* A watchdog pass reads only the journal: native queue reconciliation reads
         every Codex thread, and that stays with the regular drain. */
      if (!safety) await this.port.nativeQueueReconcile?.();
      this.projectOwedTerminals();
      rawEffects = await this.listEffects();
    } catch (error) {
      this.noteUnlisted(error);
      throw error;
    }
    /* #1716: contention history lasts as long as its operation is pending. One
       the journal no longer lists has settled, whether through recovery or
       another path such as a discard, a kill or delivery on a host that came
       back, and its entry goes with it. */
    if (this.contendedRecoveries.size > 0) {
      const listed = new Set(rawEffects.map((effect) => effect.payload.operationId));
      for (const operationId of this.contendedRecoveries.keys()) {
        if (!listed.has(operationId)) this.contendedRecoveries.delete(operationId);
      }
    }
    const listed = new Set(rawEffects.map((effect) => effect.payload.operationId));
    for (const operationId of this.reconfigureRetries.keys()) {
      if (!listed.has(operationId)) this.reconfigureRetries.delete(operationId);
    }
    for (const operationId of this.owedSwitchHolds.keys()) {
      if (!listed.has(operationId)) this.owedSwitchHolds.delete(operationId);
    }
    const pendingIds = new Set(rawEffects.map(effect => effect.payload.operationId));
    for (const id of this.refusedSteerTurns.keys()) if (!pendingIds.has(id)) this.refusedSteerTurns.delete(id);
    for (const id of this.interruptIssuedAt.keys()) if (!pendingIds.has(id)) this.interruptIssuedAt.delete(id);
    this.releaseSettledLanes(pendingIds);
    this.lastListed = pendingIds;
    if (rawEffects.length === 0) { this.nativeExecutionRetries.clear(); return; }
    const grouped = new Map<string, DeliveryEffect[]>();
    const targetPreparations = new Map<string, Array<() => Promise<void>>>();
    const prepareTarget = (conversationId: string, prepare: () => Promise<void>) => {
      const preparations = targetPreparations.get(conversationId) ?? [];
      preparations.push(prepare);
      targetPreparations.set(conversationId, preparations);
    };
    const effects: DeliveryEffect[] = [];
    for (const rawEffect of rawEffects) {
      if (rawEffect.kind === "runtime.kill-boundary") {
        const boundary = successfulKillBoundary(rawEffect);
        if (!boundary) {
          const conversationId = typeof rawEffect.payload.conversationId === "string"
            ? rawEffect.payload.conversationId
            : `effect-${rawEffect.eventSeq}`;
          prepareTarget(conversationId, async () => {
            throw new Error(`structured kill boundary ${rawEffect.eventSeq} is invalid`);
          });
          continue;
        }
        const current = this.successfulKillBoundaries.get(boundary.conversationId);
        if (!current || boundary.eventSeq > current.eventSeq) {
          this.successfulKillBoundaries.set(boundary.conversationId, boundary);
        }
        continue;
      }
      const effect = deliveryEffect(rawEffect);
      if (effect) {
        effects.push(effect);
        continue;
      }
      const operationId = typeof rawEffect.payload.operationId === "string" ? rawEffect.payload.operationId : "";
      const conversationId = typeof rawEffect.payload.conversationId === "string"
        ? rawEffect.payload.conversationId
        : `effect-${rawEffect.eventSeq}`;
      prepareTarget(conversationId, async () => {
        if (!operationId) throw new Error(`structured delivery effect ${rawEffect.eventSeq} is invalid`);
        await this.transitionUnlessSettled(operationId, "failed", { reason: "structured delivery effect is invalid" });
      });
    }
    effects.sort((left, right) => {
      const leftControl = isControlEffect(left);
      const rightControl = isControlEffect(right);
      const leftReconfigure = isReconfigureEffect(left);
      const rightReconfigure = isReconfigureEffect(right);
      return Number(rightControl) - Number(leftControl)
        || Number(rightReconfigure) - Number(leftReconfigure)
        || (leftReconfigure && rightReconfigure
          ? right.eventSeq - left.eventSeq
          : left.eventSeq - right.eventSeq);
    });
    for (const effect of effects) {
      const target = grouped.get(effect.conversationId) ?? [];
      target.push(effect);
      grouped.set(effect.conversationId, target);
    }
    const nativeTargets = new Set(effects.filter(effect => effect.kind === "native-queue").map(effect => effect.conversationId));
    for (const id of this.nativeExecutionRetries.keys()) {
      if (!nativeTargets.has(id)) this.nativeExecutionRetries.delete(id);
    }
    const conversationIds = new Set([...grouped.keys(), ...targetPreparations.keys()]);
    if (safety) this.noteLostWakes(effects);
    const targets: Array<[string, Promise<boolean>]> = [];
    for (const conversationId of conversationIds) {
      const busy = this.lanes.get(conversationId);
      if (busy) {
        /* The conversation's previous drain is still running. It keeps the
           conversation; this pass leaves it alone and its end runs another. */
        busy.rerun = true;
        for (const effect of grouped.get(conversationId) ?? []) {
          if (effect.operationId !== busy.current?.operationId) {
            this.noteWait(effect, "conversation-busy", { wake: "event" });
          }
        }
        continue;
      }
      targets.push([conversationId, this.startLane(conversationId, async (lane) => {
        if (this.port.deferTarget?.(conversationId)) {
          for (const effect of grouped.get(conversationId) ?? []) this.noteWait(effect, "startup", { wake: "event" });
          return true;
        }
        for (const prepare of targetPreparations.get(conversationId) ?? []) await prepare();
        return this.drainTarget(grouped.get(conversationId) ?? [], lane);
      })]);
    }
    /* Bounded: a lane that outlasts the budget keeps running, and only its own
       conversation waits for it. */
    const settledLanes = Promise.allSettled(targets.map(([, run]) => run));
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    const budget = new Promise<null>((resolve) => {
      budgetTimer = setTimeout(() => resolve(null), this.timing.passBudgetMs);
      (budgetTimer as { unref?: () => void }).unref?.();
    });
    const raced = await Promise.race([settledLanes, budget]);
    if (budgetTimer) clearTimeout(budgetTimer);
    if (raced === null) {
      /* Lanes still running report their own errors and wake the queue when
         they end; the conversations that finished are judged below. */
      this.retrySoon();
      return;
    }
    const outcomes = raced;
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length === outcomes.length && failures.length > 0) {
      const reason = failures.at(-1)!.reason;
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `structured delivery failed for every target: ${failureReason(reason)}`,
      );
    }
    if (failures.length > 0) this.retrySoon();
  }

  private async listEffects(): Promise<StructuredDeliveryEffect[]> {
    const rawEffects: StructuredDeliveryEffect[] = [];
    let afterEventSeq = 0;
    while (true) {
      const page = await this.port.effects(
        ["runtime.native-queue", "runtime.send", "runtime.steer", "runtime.inject", "runtime.answer", "runtime.interrupt", "runtime.kill", "runtime.kill-boundary", "runtime.reconfigure", "runtime.compact"],
        afterEventSeq,
      );
      if (page.length === 0) break;
      rawEffects.push(...page);
      const nextCursor = Math.max(...page.map((effect) => effect.eventSeq));
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= afterEventSeq) {
        throw new Error("structured delivery effect page did not advance");
      }
      if (page.length < STRUCTURED_DELIVERY_BATCH_SIZE) break;
      afterEventSeq = nextCursor;
    }
    return rawEffects;
  }

  private diagnosticError(...args: unknown[]): void {
    if (this.port.diagnosticError) this.port.diagnosticError(...args);
    else console.error(...args);
  }

  /**
   * A pass that could not list the journal reached no message, so every open
   * record says so, with the moment the next pass will try (incident
   * 2026-10-06: an accepted send must never wait without a reason). A lane
   * still running from an earlier pass keeps its own phase.
   */
  private noteUnlisted(error: unknown): void {
    const progress = this.port.progress;
    if (!progress) return;
    const held = new Set([...this.lanes.values()].filter((lane) => !lane.released).map((lane) => lane.current?.operationId));
    const note: DeliveryProgressNote = {
      waitReason: "evidence-unreadable",
      detail: `the delivery journal could not be listed: ${failureReason(error)}`,
      nextWakeMs: this.passRetry.nextDelayMs(),
      executorId: this.executorId,
    };
    try {
      for (const record of progress.open()) {
        if (held.has(record.operationId) || this.activeSteers.has(record.operationId)
          || this.activeInjections.has(record.operationId)) continue;
        progress.note(record.operationId, record.conversationId, note);
      }
    } catch (noteError) {
      this.diagnosticError("[structured delivery] progress record failed", { error: failureReason(noteError) });
    }
  }

  /** Starts one conversation's lane; it leaves the lane map when it ends. */
  private startLane(conversationId: string, drain: (lane: DeliveryLane) => Promise<boolean>): Promise<boolean> {
    const lane: DeliveryLane = {
      conversationId, startedAt: this.timing.now(), current: null, rerun: false, released: false, reconciledAt: null,
      reconciling: null,
    };
    this.lanes.set(conversationId, lane);
    return (async () => {
      try {
        const blocked = await drain(lane);
        if (blocked === false) this.targetErrors.delete(conversationId);
        return blocked;
      } catch (error) {
        this.targetErrors.set(conversationId, failureReason(error));
        this.diagnosticError("[structured delivery] conversation drain failed", {
          conversationId,
          error: failureReason(error),
        });
        throw error;
      } finally {
        if (this.lanes.get(conversationId) === lane) this.lanes.delete(conversationId);
        /* Work found while it ran, or a lane that outlived its pass, gets a
           pass of its own as soon as it ends. */
        if (lane.rerun || this.timing.now() - lane.startedAt >= this.timing.passBudgetMs) this.retrySoon();
      }
    })();
  }

  /**
   * Lets go of a lane whose operation the journal no longer lists.
   *
   * A completing transition clears an operation's effect in the same commit,
   * so an operation absent from the listing has ended — settled by the
   * background deadline, by reconciliation, or by the lane's own late answer.
   * A lane still holding it past the stall bound is waiting on a host that has
   * not answered; its conversation's next messages need not wait with it. The
   * released lane acts on nothing else when it resumes, so the conversation is
   * never drained twice at once.
   */
  private releaseSettledLanes(listed: ReadonlySet<unknown>): void {
    const now = this.timing.now();
    for (const lane of [...this.lanes.values()]) {
      const current = lane.current;
      if (!current || listed.has(current.operationId) || now - current.since < this.timing.stallMs) continue;
      lane.released = true;
      if (this.lanes.get(lane.conversationId) === lane) this.lanes.delete(lane.conversationId);
      console.warn("[structured delivery] released a lane whose operation settled while its host call ran", {
        conversationId: lane.conversationId, operationId: current.operationId, heldMs: now - current.since,
      });
    }
  }

  /** Open progress records whose operation left the journal's listing ended
      somewhere this executor did not see; their record says so. */
  private settleUnlistedProgress(listed: ReadonlySet<unknown>): void {
    const progress = this.port.progress;
    if (!progress) return;
    const now = this.timing.now();
    for (const [operationId, checkedAt] of this.unlistedChecks) {
      if (now - checkedAt >= UNLISTED_CHECK_MS) this.unlistedChecks.delete(operationId);
    }
    for (const record of progress.open()) {
      if (listed.has(record.operationId) || this.unlistedChecks.has(record.operationId)) continue;
      const laneHolds = [...this.lanes.values()].some((lane) => lane.current?.operationId === record.operationId && !lane.released);
      if (laneHolds) continue;
      /* One journal read per record per interval: the record says how it
         ended, and nothing waits on it. */
      this.unlistedChecks.set(record.operationId, now);
      void this.readStatus(record.operationId).then((durable) => {
        if (!durable.readable || !durable.value || !TERMINAL_DELIVERY_STATUSES.has(durable.value.status)) return;
        progress.settle(record.operationId, progressTerminalState(durable.value.status), durable.value.reason ?? null);
      });
    }
  }

  /** A watchdog pass that finds a message nobody looked at when it was due
      records that its wake was lost. A conversation whose lane is running was
      looked at: whatever that lane waits on is its own phase. So was a message
      already handed over whose arrival is still being read back. */
  private noteLostWakes(effects: readonly DeliveryEffect[]): void {
    const progress = this.port.progress;
    if (!progress) return;
    const now = this.timing.now();
    for (const effect of effects) {
      if (!isMessageEffect(effect) || this.lanes.has(effect.conversationId)
        || this.activeSteers.has(effect.operationId) || this.activeInjections.has(effect.operationId)) continue;
      const record = progress.get(effect.operationId);
      const due = record?.nextWakeAt ? Date.parse(record.nextWakeAt) : null;
      if (record && (due === null || due + WAKE_GRACE_MS > now)) continue;
      this.noteWait(effect, "wake-lost", { wake: "retry", detail: record ? `due ${Math.round((now - due!) / 1000)}s earlier` : "admitted without a wake" });
    }
  }

  /** Records why a message effect is waiting. Controls carry no reservation and
      are not recorded. */
  private noteWait(
    effect: DeliveryEffect,
    reason: DeliveryWaitReason,
    options: {
      wake?: "retry" | "event" | "none";
      detail?: string | null;
      attempted?: boolean;
      progressed?: boolean;
      lane?: DeliveryLane;
      /** When the wait began, for one recorded after the fact. */
      sinceMs?: number;
    } = {},
  ): void {
    const message = isMessageEffect(effect);
    if (!message && !isNativeAddEffect(effect)) return;
    if (options.lane) {
      const current = options.lane.current;
      if (!current || current.operationId !== effect.operationId || current.phase !== reason) {
        options.lane.current = {
          operationId: effect.operationId,
          phase: reason,
          since: this.timing.now(),
          replacesTurn: message && effect.kind !== "inject" && effect.policy === "interrupt-active",
        };
      }
    }
    const progress = this.port.progress;
    if (!progress) return;
    const note: DeliveryProgressNote = {
      waitReason: reason,
      ...(message ? { kind: effect.kind } : {}),
      executorId: this.executorId,
      /* A wait the queue scheduled a retry for is looked at within the retry
         delay; every other wait ends with an event, and the watchdog's
         safety pass looks at it if that event never comes. */
      nextWakeMs: options.wake === "none" ? null
        : options.wake === "retry" ? this.timing.retryMs : this.timing.safetyPassMs,
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
      ...(options.attempted ? { attempted: true } : {}),
      ...(options.progressed ? { progressed: true } : {}),
      ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
    };
    try { progress.note(effect.operationId, effect.conversationId, note); }
    catch (error) { this.diagnosticError("[structured delivery] progress record failed", { error: failureReason(error) }); }
  }

  private settleProgress(operationId: string, status: string, reason: string | null | undefined): void {
    const progress = this.port.progress;
    if (!progress || !TERMINAL_DELIVERY_STATUSES.has(status)) return;
    try { progress.settle(operationId, progressTerminalState(status), reason ?? null); }
    catch (error) { this.diagnosticError("[structured delivery] progress record failed", { error: failureReason(error) }); }
  }

  /**
   * Runs one read or write a message's delivery depends on, with the lane
   * saying which one it is waiting on.
   *
   * Journal status, the durable record, host state, the writer claim, the
   * generation binding and the `delivering` write all come before the first
   * recorded phase of a hand-over, and any of them can stay unanswered. The
   * step is kept on the lane, which costs nothing on the ordinary pass where
   * each answers at once; the watchdog records one that outlasts the stall
   * bound, with the moment it actually began.
   */
  private async checking<T>(lane: DeliveryLane | undefined, effect: DeliveryEffect, detail: string, wait: () => Promise<T>): Promise<T> {
    /* A native add carries its message's record (A6), so its steps are
       tracked too; it never replaces a turn. */
    const message = isMessageEffect(effect);
    if (!lane || (!message && !isNativeAddEffect(effect))) return wait();
    const previous = lane.current;
    const mine: NonNullable<DeliveryLane["current"]> = {
      operationId: effect.operationId,
      phase: "checking",
      since: this.timing.now(),
      replacesTurn: message && effect.kind !== "inject" && effect.policy === "interrupt-active",
      step: { effect, detail, recorded: false },
    };
    lane.current = mine;
    try {
      return await wait();
    } finally {
      if (lane.current === mine) lane.current = previous;
    }
  }

  /**
   * The watchdog, run every couple of seconds by the controller and never
   * dependent on a browser being open.
   *
   * It marks an active phase that ran past the stall bound, starts original-key
   * reconciliation for a lane that made no progress for the reconciliation
   * bound, and runs a light pass when a recorded wake is overdue or no pass ran
   * for {@link StructuredDeliveryQueueTiming.safetyPassMs}: a turn-end event
   * or an admission wake that never arrived costs a few seconds, and nothing
   * waits for the next unrelated message.
   *
   * Marking and starting are synchronous and awaited by nothing, so one
   * conversation's unanswered evidence read never delays another's stall
   * mark, reconciliation or replacement wake.
   */
  async tick(): Promise<void> {
    if (this.retirementExecutor.retired) return;
    const now = this.timing.now();
    const progress = this.port.progress;
    for (const lane of [...this.lanes.values()]) {
      const current = lane.current;
      if (!current) continue;
      const held = now - current.since;
      /* A step is kept off the record until it lasts; one that did is
         recorded from when it began. */
      if (held >= this.timing.stallMs && current.step && !current.step.recorded) {
        current.step.recorded = true;
        this.noteWait(current.step.effect, "checking", { detail: current.step.detail, sinceMs: current.since });
      }
      /* A lane still checking has handed nothing to a host. */
      if (held >= this.timing.interruptReconcileMs && current.phase !== "checking"
        && (lane.reconciledAt === null || now - lane.reconciledAt >= this.timing.interruptReconcileMs)) {
        this.reconcileHeldLane(lane);
      }
    }
    /* The stall mark reads the record, the one thing that outlives the lane
       and the executor that wrote it: an acknowledged interrupt whose turn
       keeps running, a hand-over whose arrival is still being read back, an
       inherited `delivering` fence. Each is dated from its own phase and last
       progress, and marking it changes nothing about the delivery itself. */
    for (const record of progress?.open() ?? []) {
      if (!ACTIVE_DELIVERY_PHASES.has(record.waitReason) || record.stalledSince) continue;
      const quietSince = Math.max(Date.parse(record.phaseSince), Date.parse(record.lastProgressAt));
      if (!(now - quietSince >= this.timing.stallMs)) continue;
      try { progress?.stalled(record.operationId); }
      catch (error) { this.diagnosticError("[structured delivery] progress record failed", { error: failureReason(error) }); }
    }
    if (this.lastListed) this.settleUnlistedProgress(this.lastListed);
    let wake = now - this.lastPassStartedAt >= this.timing.safetyPassMs;
    const unlistedDue: DeliveryProgressRecord[] = [];
    for (const record of progress?.open() ?? []) {
      if (this.lanes.has(record.conversationId) || !record.nextWakeAt) continue;
      if (Date.parse(record.nextWakeAt) + WAKE_GRACE_MS > now) continue;
      /* A record the last listing did not hold, and that has not moved
         since, is a message the journal does not have yet: a pass of this
         queue cannot reach it, and its wake belongs to the drain that holds it. */
      const movedAt = Math.max(Date.parse(record.phaseSince), Date.parse(record.lastProgressAt));
      if (this.lastListed && !this.lastListed.has(record.operationId)
        && movedAt < this.lastPassStartedAt) unlistedDue.push(record);
      else wake = true;
    }
    if (unlistedDue.length > 0) {
      try { this.port.unlistedWakeDue?.(unlistedDue); }
      catch (error) { this.diagnosticError("[structured delivery] unlisted wake failed", { error: failureReason(error) }); }
    }
    if (wake && !this.activeDrain) await this.drain({ safety: true }).catch(() => undefined);
  }

  /**
   * Original-key reconciliation for a lane whose host call has not answered.
   *
   * Reads the host's own evidence for this operation and nothing else: when
   * it proves the message arrived the operation settles delivered, and the
   * next pass lets the lane go. When it proves nothing the operation keeps its
   * `delivering` fence — execution cannot be disproved, so nothing is sent
   * again and the settlement deadline still ends it.
   *
   * Started and never awaited. One read per lane is in flight at a time; one
   * that has not answered within
   * {@link StructuredDeliveryQueueTiming.reconcileReadMs} frees the lane for
   * its next reconciliation, and its answer is still honoured when it comes:
   * it settles the same operation under the same key and writes no input.
   */
  private reconcileHeldLane(lane: DeliveryLane): void {
    const current = lane.current;
    if (!current || !this.port.confirmedDelivery || lane.reconciling) return;
    const fence = {};
    lane.reconciling = fence;
    lane.reconciledAt = this.timing.now();
    const { operationId, phase } = current;
    const note = (detail: string, attempted: boolean) => {
      /* The lane moved on: its record says what it waits on now. */
      if (lane.current?.operationId !== operationId || lane.current.phase !== phase) return;
      try { this.port.progress?.note(operationId, lane.conversationId, { waitReason: phase, detail, attempted }); }
      catch (error) { this.diagnosticError("[structured delivery] progress record failed", { error: failureReason(error) }); }
    };
    const release = () => { if (lane.reconciling === fence) lane.reconciling = null; };
    let overdue = false;
    const bound = setTimeout(() => {
      overdue = true;
      note("reconciling: host evidence has not answered; the send is still held", true);
      release();
    }, this.timing.reconcileReadMs);
    (bound as { unref?: () => void }).unref?.();
    void readEvidence(() => this.port.confirmedDelivery!(operationId), "host delivery evidence is unavailable")
      .then(async (evidence) => {
        clearTimeout(bound);
        note(!evidence.readable ? "reconciling: host evidence unreadable"
          : evidence.value ? "reconciling: host evidence shows it arrived" : "reconciling: no host evidence yet; the send is still held",
        !overdue);
        if (evidence.readable && evidence.value) {
          await this.transitionUnlessSettled(operationId, "delivered", {});
          this.retrySoon();
        }
      })
      .catch((error) => {
        this.diagnosticError("[structured delivery] lane reconciliation failed", { operationId, error: failureReason(error) });
      })
      .finally(() => { clearTimeout(bound); release(); });
  }

  /**
   * Original-key reconciliation for an interrupt-active send whose interrupt
   * made no progress for {@link StructuredDeliveryQueueTiming.interruptReconcileMs}.
   *
   * The interrupt was issued and the turn kept running, so nothing was handed
   * to the engine under this operation by this executor. The host's evidence is
   * read first, because an earlier executor may have handed it over: proof of
   * arrival settles it delivered. Without proof the interrupt is issued again,
   * on the turn running now, under the same operation, which the host
   * deduplicates; a message is never written twice by this path.
   *
   * The evidence read waits at most
   * {@link StructuredDeliveryQueueTiming.reconcileReadMs}. One that has not
   * answered by then is unreadable evidence: the lane ends, the operation
   * keeps its fences, and the next pass takes it from there under the same
   * key — interrupting again while the turn runs, handing it over once the
   * host is idle. The late answer is still honoured: proof of arrival settles
   * the same operation, and the `delivering` write's
   * `fromStatuses` fence refuses any later hand-over of it.
   */
  private async reconcileStalledInterrupt(effect: SendEffect): Promise<"delivered" | "reissue" | "wait"> {
    const now = this.timing.now();
    const issuedAt = this.interruptIssuedAt.get(effect.operationId);
    if (issuedAt === undefined) {
      this.interruptIssuedAt.set(effect.operationId, now);
      return "wait";
    }
    if (now - issuedAt < this.timing.interruptReconcileMs) return "wait";
    this.interruptIssuedAt.set(effect.operationId, now);
    let evidence: Evidence<boolean> | null = null;
    if (this.port.confirmedDelivery) {
      this.noteWait(effect, "interrupt-reconciling", {
        attempted: true, wake: "retry", detail: "reading the host's evidence for this message",
      });
      const read = readEvidence(() => this.port.confirmedDelivery!(effect.operationId), "host delivery evidence is unavailable");
      let bound: ReturnType<typeof setTimeout> | null = null;
      const overdue = new Promise<null>((resolve) => {
        bound = setTimeout(() => resolve(null), this.timing.reconcileReadMs);
        (bound as { unref?: () => void }).unref?.();
      });
      const answered = await Promise.race([read, overdue]);
      if (bound) clearTimeout(bound);
      if (answered === null) {
        void read.then(async (late) => {
          if (late.readable && late.value && await this.transitionUnlessSettled(effect.operationId, "delivered", {}).catch(() => false)) {
            this.retrySoon();
          }
        });
        evidence = { readable: false, reason: "host delivery evidence did not answer in time" };
      } else {
        evidence = answered;
      }
    }
    if (evidence?.readable && evidence.value) {
      if (await this.transitionUnlessSettled(effect.operationId, "delivered", {})) return "delivered";
      return "wait";
    }
    this.interruptAcknowledged.delete(effect.operationId);
    this.noteWait(effect, "interrupt-reconciling", {
      ...(evidence === null ? { attempted: true } : {}),
      wake: "retry",
      detail: evidence === null ? "no host evidence reader; interrupting the running turn again"
        : evidence.readable ? "no host evidence it arrived; interrupting the running turn again"
          : "host evidence unreadable or unanswered; interrupting the running turn again",
    });
    this.retrySoon();
    return "reissue";
  }

  /** Native execution has its own target budget: a parked pick or a successful
      send elsewhere must not reset a failed journal read. Keep the original
      effect/receipt in custody, and let controls reach their own drain. */
  private async executeNative(effect: Extract<DeliveryEffect, { kind: "native-queue" }>, reason?: string, lane?: DeliveryLane): Promise<boolean> {
    const retry = this.nativeExecutionRetries.get(effect.conversationId) ?? new RetryBackoff();
    this.nativeExecutionRetries.set(effect.conversationId, retry);
    if (!retry.ready()) { this.retrySoon(); return false; }
    try {
      if (!this.port.nativeQueueExecute) throw new Error("native queue executor is unavailable");
      const note = (wait: DeliveryWaitReason, detail?: string | null) =>
        this.noteWait(effect, wait, { wake: wait === "awaiting-turn" ? "event" : "retry", ...(detail !== undefined ? { detail } : {}) });
      /* The executor's own reads (status, the native journal, the input, the
         host's health) come before its first recorded phase, and each is
         tracked on the lane the same way the queue's own reads are. */
      const step = <T>(detail: string, wait: () => Promise<T>) => this.checking(lane, effect, detail, wait);
      /* The fence every message send passes before its first actuation, asked
         under the add's own operation id (#1131). */
      const settled = () => this.checking(lane, effect, "reading the durable delivery record", () => this.readSettled(effect.operationId));
      if (await this.port.nativeQueueExecute(effect, reason, note, step, settled) === false) {
        this.retrySoon();
        return false;
      }
      this.nativeExecutionRetries.delete(effect.conversationId);
      return true;
    } catch (error) {
      retry.fail();
      this.retrySoon();
      throw error;
    }
  }

  private async drainTarget(effects: DeliveryEffect[], lane?: DeliveryLane, guardedLease?: ActuationLease): Promise<boolean> {
    let updateHeld = false;
    const waitAll = (reason: DeliveryWaitReason, wake: "retry" | "event" = "event", detail?: string | null) => {
      for (const effect of effects) this.noteWait(effect, reason, { wake, ...(detail !== undefined ? { detail } : {}) });
    };
    if (this.port.handoffHeld?.()) { waitAll("update-handoff"); return true; }
    if (effects.length > 0 && effects.every(effect => effect.kind === "native-queue")
      && this.nativeExecutionRetries.get(effects[0]!.conversationId)?.ready() === false) {
      this.retrySoon();
      return true;
    }
    const latestSwitch = effects.filter(isReconfigureEffect).reduce<StructuredReconfigureEffect | null>(
      (latest, effect) => !latest || effect.eventSeq > latest.eventSeq ? effect : latest, null);
    const switchDeferred = latestSwitch
      && this.reconfigureRetries.get(latestSwitch.operationId)?.ready() === false;
    if (switchDeferred) {
      this.retrySoon();
      waitAll("switching-accounts", "retry");
      effects = effects.filter(isControlEffect);
      if (effects.length === 0) return true;
    }
    const openEffects: DeliveryEffect[] = [];
    const durableStatuses = new Map<string, StructuredOperationStatus | null>();
    let nativeReceiptUnavailable = false;
    for (const effect of effects) {
      if (effect.kind === "native-queue" && this.nativeExecutionRetries.get(effect.conversationId)?.ready() === false) {
        nativeReceiptUnavailable = true;
        continue;
      }
      const durable = await this.checking(lane, effect, "reading the delivery journal status", () => this.readStatus(effect.operationId));
      if (!durable.readable) {
        if (isReconfigureEffect(effect)) {
          const retry = this.reconfigureRetries.get(effect.operationId) ?? new RetryBackoff();
          retry.fail();
          this.reconfigureRetries.set(effect.operationId, retry);
        }
        if (effect.kind === "native-queue") {
          const retry = this.nativeExecutionRetries.get(effect.conversationId) ?? new RetryBackoff();
          retry.fail();
          this.nativeExecutionRetries.set(effect.conversationId, retry);
          nativeReceiptUnavailable = true;
          this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: "delivery journal status is unavailable" });
          continue;
        }
        this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: "delivery journal status is unavailable" });
        return this.fenceUnavailable();
      }
      if (durable.value && TERMINAL_DELIVERY_STATUSES.has(durable.value.status)) {
        this.settleProgress(effect.operationId, durable.value.status, durable.value.reason);
        forgetRetirementOperation(effect.operationId);
        this.firstDispatches.delete(effect.operationId);
        this.contendedRecoveries.delete(effect.operationId);
        continue;
      }
      if (effect.kind === "kill" && effect.onlyIfIdle && durable.value?.status === "delivering") {
        const owner = durable.value.retirementClaim;
        const localOwner = owner ? retirementExecutors.get(owner.executorId) : undefined;
        const finishedLocalOwner = !!owner && !!localOwner && localOwner.retired && !localOwner.draining
          && localOwner.pendingClaims.has(effect.operationId)
          && sameRecordedProcessIdentity(owner.process, localOwner.claim.process);
        if (!owner || (owner.executorId !== this.executorId && !finishedLocalOwner && !processIdentityProvenDead(owner.process))) {
          this.retrySoon();
          return true;
        }
        await this.port.transition(effect.operationId, "queued", { reason: "retirement executor ended" },
          { retirementClaim: finishedLocalOwner ? localOwner!.claim : this.retirementClaim, fromStatuses: ["delivering"] });
        forgetRetirementOperation(effect.operationId, owner.executorId);
        this.retrySoon();
        return true;
      }
      /* An account pick is an intent, and it waits for the next engagement however long that is (#1846):
         the settlement window is for a control that got stuck, which a switch nobody has engaged is not. */
      const expired = isRuntimeControlEffect(effect) && !isParkableSwitch(effect, durable.value)
        ? expiredControlSettlement(effect, durable.value)
        : null;
      if (expired) {
        if (isReconfigureEffect(effect)) {
          await this.transitionReconfigure(effect, expired.status, { reason: expired.reason }, latestSwitch ?? effect);
        } else {
          await this.transitionUnlessSettled(effect.operationId, expired.status, { reason: expired.reason });
        }
        continue;
      }
      durableStatuses.set(effect.operationId, durable.value);
      openEffects.push(effect);
    }
    // An unreadable native receipt retains the message/switch barrier, while
    // interrupt/answer/kill can still use their independently readable receipts.
    effects = nativeReceiptUnavailable ? openEffects.filter(isControlEffect) : openEffects;
    if (nativeReceiptUnavailable) this.retrySoon();
    const killedGenerations = new Set<string>();
    const reconfigures = effects.filter(isReconfigureEffect);
    const currentReconfigure = reconfigures.reduce<StructuredReconfigureEffect | null>(
      (current, effect) => !current || effect.eventSeq > current.eventSeq ? effect : current,
      null,
    );
    /* A pick after a terminal provider turn applies now (#1983). Other idle
       picks retain the next-engagement behavior from #1846. */
    const engaged = effects.some(isEngagement)
      || Boolean(currentReconfigure && this.port.terminalTurn?.(currentReconfigure.conversationId));
    const conversationId = effects[0]?.conversationId;
    const readHold = () => conversationId ? this.port.switchHold?.(conversationId) ?? null : null;
    let hold = readHold();
    for (const [index, effect] of effects.entries()) {
      /* Everything after a blocking step waits on this conversation. */
      const blockRest = (reason: DeliveryWaitReason, wake: "retry" | "event" = "event", detail?: string | null) => {
        for (const later of effects.slice(index + 1)) {
          this.noteWait(later, reason, { wake, ...(detail !== undefined ? { detail } : {}) });
        }
      };
      /* A released lane, or an executor a successor replaced, leaves the rest
         of the conversation to whoever drains it now. */
      if (lane?.released || this.retirementExecutor.retired) return true;
      /* The lane is on this message now; a phase it records below replaces this. */
      if (lane && isMessageEffect(effect) && lane.current?.operationId !== effect.operationId) {
        lane.current = { operationId: effect.operationId, phase: "conversation-busy", since: this.timing.now(),
          replacesTurn: effect.kind !== "inject" && effect.policy === "interrupt-active" };
      }
      if (this.port.handoffHeld?.()) { blockRest("update-handoff"); this.noteWait(effect, "update-handoff"); return true; }
      if (effect.kind === "send" && effect.onlyIfIdle && !guardedLease) {
        const blocked = await withConversationActuation(effect.conversationId,
          lease => this.drainTarget([effect], lane, lease));
        if (blocked) return true;
        continue;
      }
      /* #862: a compaction in flight holds back everything that would write to
         the thread — messages and reconfigures — but never another control.
         Kill is the operator's safety valve and interrupt/answer are how a turn
         is reached at all; leaving them inert for the length of a compaction
         would be a worse failure than the one the barrier prevents. Controls
         sort ahead of these, so by here every one of them has already run. */
      if (!isControlEffect(effect) && this.compactingConversations.has(effect.conversationId)) {
        this.noteWait(effect, "compacting");
        blockRest("compacting");
        return true;
      }
      if (isReconfigureEffect(effect)) {
        if (effect !== currentReconfigure) continue;
        // Controls above have independent receipts and must remain usable even
        // when clearing an older choice cannot reach the journal.
        for (const previous of reconfigures) {
          if (previous !== effect) {
            await this.transitionReconfigure(previous, "failed", { reason: "superseded" }, effect);
          }
        }
        if (effect.sessionKey
          ? killedGenerations.has(`${effect.sessionKey.engine}:${effect.sessionKey.sessionId}`)
          : killedGenerations.size > 0) {
          await this.transitionReconfigure(effect, "failed", { reason: "conversation-killed" });
          continue;
        }
        if (effect.accountId && !engaged && !this.port.reconfigureCancelled?.(effect)
          && durableStatuses.get(effect.operationId)?.status !== "applying") continue;
        /* Every later message of this conversation waits behind the switch, so
           a send already claimed on the predecessor that was never dispatched
           can only go out after it. The switch carries those to the successor
           (2026-10-07, run 3: ten minutes of neither moving). */
        const carriedSends = effect.accountId
          ? effects.filter((later) => (later.kind === "send" || later.kind === "steer")
            && neverDispatched(durableStatuses.get(later.operationId))).map((later) => later.operationId)
          : [];
        const blocked = await this.drainReconfigure(effect, carriedSends);
        if (blocked) {
          this.scheduleControlSettlementCheck(durableStatuses.get(effect.operationId) ?? null);
          blockRest("switching-accounts");
          return true;
        }
        /* A switch that moved releases the hold an earlier failed one left. */
        hold = readHold();
        continue;
      }
      if (isControlEffect(effect)) {
        const result = isCompactEffect(effect)
          ? await this.drainCompact(effect)
          : await this.drainControl(effect);
        if (result.blocked) {
          this.scheduleControlSettlementCheck(durableStatuses.get(effect.operationId) ?? null);
          blockRest("conversation-busy", "event", `a ${effect.kind} control on this conversation is still settling`);
          return true;
        }
        if (result.terminated && effect.kind === "kill") {
          if (effect.sessionKey) {
            killedGenerations.add(`${effect.sessionKey.engine}:${effect.sessionKey.sessionId}`);
          }
          const current = this.successfulKillBoundaries.get(effect.conversationId);
          if (!current || effect.eventSeq > current.eventSeq) {
            this.successfulKillBoundaries.set(effect.conversationId, {
              operationId: effect.operationId,
              conversationId: effect.conversationId,
              eventSeq: effect.eventSeq,
            });
          }
        }
        continue;
      }
      /* Failed switches settle unactuated messages with the hold's explanation.
         The operator can clear the hold and explicitly resend (#1983). */
      if (hold && isEngagement(effect)) {
        const reason = `account switch failed: ${hold.reason}`;
        if (effect.kind === "native-queue") {
          if (!await this.executeNative(effect, reason, lane)) return true;
        } else if (durableStatuses.get(effect.operationId)?.status === "delivering") {
          // A switch failure cannot establish the fate of an earlier actuation.
          this.noteWait(effect, "switch-failed", { wake: "retry", detail: hold.reason });
          this.retrySoon();
          return true;
        } else {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason });
        }
        continue;
      }
      if (effect.kind === "native-queue") {
        const admission = durableStatuses.get(effect.operationId);
        const startsWork = effect.action === "add" || effect.action === "start" || effect.action === "send-now";
        if (startsWork && effect.origin?.kind === "agent" && admission?.status !== "delivering"
          && this.port.autonomousTurnHeld?.(effect.operationId, admission?.admittedAt ?? admission?.at)) {
          updateHeld = true;
          continue;
        }
        const boundary = this.successfulKillBoundaries.get(effect.conversationId);
        if (!await this.executeNative(effect, boundary && effect.eventSeq <= boundary.eventSeq
          ? "conversation was intentionally terminated" : undefined, lane)) return true;
        continue;
      }
      const killBoundary = this.successfulKillBoundaries.get(effect.conversationId);
      if (killBoundary && effect.eventSeq <= killBoundary.eventSeq) {
        await this.transitionUnlessSettled(effect.operationId, "failed", {
          reason: "structured host was intentionally terminated; retry the operation",
        });
        continue;
      }
      /* An executor already handed this effect to the engine. Delivering it
         again would be a SECOND instruction on a channel that carries
         deployment control, so this pass never writes it — the durable
         `delivering` row IS the fence, and it holds across a Viewer restart, a
         runtime-host restart, and a socket that was gone for hours.
         What it settles depends on WHO holds it, and that is a question with
         THREE answers rather than two. An executor that still owns the writer
         claim on this host can answer for the send, so its row is left where it
         is. One whose claim has explicitly moved on cannot write to the engine
         and cannot settle the row either, so this pass ends it unverified. And
         where the claim cannot be read at all the row is left alone too: a gap
         in the claim projection says nothing about who is delivering, and the
         receipt deadline ends the send anyway if its owner never comes back.

         The fence itself is a failable read, and a fence that could not be read
         is not an open one. It used to become `null` here and fall straight
         through to the engine call, so a send an executor was already
         delivering could be delivered a SECOND time by whichever pass caught
         the journal at a bad moment. */
      const durable = durableStatuses.get(effect.operationId) ?? null;
      if (effect.kind === "inject" && this.activeInjections.has(effect.operationId)) continue;
      if (this.activeSteers.has(effect.operationId)) continue;
      if (durable?.status === "delivering") {
        if (await this.checking(lane, effect, "reading who holds the delivering fence",
          () => this.deliveringOwnerDisposition(effect.conversationId, durable.reason)) !== "abandoned") {
          /* Another executor, or an earlier step of this one, is handing it over. */
          this.noteWait(effect, "dispatching", { wake: "event", detail: "held by the executor that began its delivery" });
          continue;
        }
        await this.terminalizeUnverified(effect.operationId, DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR);
        continue;
      }
      /* And the same fence from the other store: a receipt query already ended
         this send — the only answer available while the runtime host was
         unreachable — so actuating it now would deliver an instruction the
         sender was told had not arrived (#1131). Asked under the effect's OWN
         operation id, which is what makes a deliberate retry a different send:
         it is admitted as a new operation, so the settled record of the attempt
         it replaces does not fence it. Unreadable for the same reason as above:
         a record that cannot be read has not said this send is unsettled. */
      const settled = await this.checking(lane, effect, "reading the durable delivery record", () => this.readSettled(effect.operationId));
      if (!settled.readable) {
        this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: "durable delivery record is unavailable" });
        return this.fenceUnavailable();
      }
      if (settled.value) {
        await this.terminalizeUnverified(effect.operationId, DELIVERY_FENCED_BY_SETTLEMENT);
        continue;
      }
      const host = this.resolveHost(effect.conversationId);
      const heldForUpdate = () => (effect.kind === "send" || effect.kind === "steer") && effect.origin?.kind === "agent"
        && !!this.port.autonomousTurnHeld?.(effect.operationId, durableStatuses.get(effect.operationId)?.admittedAt
          ?? durableStatuses.get(effect.operationId)?.at);
      if (!host) {
        if (effect.kind === "send" && effect.onlyIfIdle) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "idle-continuation-cancelled" });
          continue;
        }
        if (heldForUpdate()) { updateHeld = true; this.noteWait(effect, "update-drain"); continue; }
        if (this.awaitingContendedRecovery(effect.operationId)) {
          this.noteWait(effect, "recovery-contended", { wake: "retry" });
          blockRest("awaiting-host");
          return true;
        }
        if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) continue;
        this.noteWait(effect, "recovering-host", { lane });
        blockRest("awaiting-host");
        await this.recoverUnavailableHost(effect, durableStatuses.get(effect.operationId));
        this.noteWait(effect, "awaiting-host", { lane });
        return true;
      }
      /* The live host's state, and the fence that decides whether this message
         may be handed over at all. Unreadable is not idle and not dead: it
         proves neither that the host can take the message nor that recovery is
         owed one, so the pass writes nothing and comes back. */
      const state = await this.checking(lane, effect, "reading the host state", () => this.readHealth(host));
      if (!state.readable) {
        this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: "structured host state is unavailable" });
        blockRest("conversation-busy", "retry");
        return this.fenceUnavailable();
      }
      const health = state.value;
      if (health.status === "dead" || health.status === "unhosted") {
        if (effect.kind === "send" && effect.onlyIfIdle) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "idle-continuation-cancelled" });
          continue;
        }
        if (heldForUpdate()) { updateHeld = true; this.noteWait(effect, "update-drain"); continue; }
        if (this.awaitingContendedRecovery(effect.operationId)) {
          this.noteWait(effect, "recovery-contended", { wake: "retry" });
          blockRest("awaiting-host");
          return true;
        }
        if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) continue;
        this.noteWait(effect, "recovering-host", { lane });
        blockRest("awaiting-host");
        await this.recoverUnavailableHost(effect, durableStatuses.get(effect.operationId));
        this.noteWait(effect, "awaiting-host", { lane });
        return true;
      }
      /* #1560: injection leaves the group here, before a single line of the
         steer/interrupt machinery below can look at it. That machinery decides
         between ending the running turn and joining it; injection does neither,
         so running it through those branches is how a "do not interrupt" action
         would quietly acquire an interrupt. Any state the host can take the
         write in — active, attention, idle — is a state injection can be
         executed in, because it does not contend for the turn. */
      if (effect.kind === "inject") {
        if (!await this.executeInjection(effect, host, health, lane)) return true;
        continue;
      }
      const steerOrQueue = effect.policy === "steer-or-queue";
      const steerRequested = effect.kind === "steer" || effect.policy === "steer-if-active"
        || (steerOrQueue && host.supportsSteer === true
          && this.refusedSteerTurns.get(effect.operationId) !== health.activeTurnRef);
      const maySteer = health.status === "active" && steerRequested;
      /* A host without steer that DECLARED an interrupt fallback (Copilot over
         ACP) takes a steer the way `interrupt-active` takes a send: the running
         turn is interrupted and the message starts the next one; a turn that
         already ended leaves nothing to interrupt and the message simply starts
         one. It is never delivered as `steered` (docs/design/copilot-engine.md 3.4). */
      const steerByInterrupt = !steerOrQueue && steerRequested && host.steerFallback === "interrupt";
      // Only in-turn steering joins the original cohort. Interrupt fallback
      // replaces that turn and must wait along with other fresh turn starts.
      if ((!maySteer || steerByInterrupt) && heldForUpdate()) { updateHeld = true; this.noteWait(effect, "update-drain"); continue; }
      /* A host that DECLARED it cannot steer, which is the Claude broker: its
         write would land as an interrupt the operator never asked for, so the
         message is refused here rather than delivered as something else.
         An undeclared capability is unknown and is no refusal — a host that says
         nothing about steering keeps the delivery path it has always had. */
      if (maySteer && host.supportsSteer === false && !steerByInterrupt) {
        await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "unsupported-steering" });
        continue;
      }
      const replacesTurn = effect.policy === "interrupt-active" || steerByInterrupt;
      const replacementIsActive = replacesTurn
        && (health.status === "active" || health.status === "attention")
        && Boolean(health.activeTurnRef);
      const shouldInterrupt = replacementIsActive
        && (effect.turnId === undefined || effect.turnId === health.activeTurnRef)
        && !this.interruptAcknowledged.has(effect.operationId);
      const steersIntoTurn = maySteer && !steerByInterrupt;
      /* An engine without steer (Copilot) reports a message that interrupted
         the running turn as interrupt-then-turn-started. The route is written
         with the `delivering` transition that precedes the interrupt, so it is
         durable before the interrupt is issued and a successor executor reads
         it back from the receipt; Claude and Codex receipts carry no route. */
      const recordsRoute = host.steerFallback === "interrupt";
      const clearedRoute: RuntimeTransitionDetails = recordsRoute ? { delivery: null, interruptedTurnId: null } : {};
      if (effect.onlyIfIdle && (health.status !== "idle" || health.activeTurnRef !== null)) {
        await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "idle-continuation-cancelled" });
        continue;
      }
      if (health.status !== "idle" && !steersIntoTurn && !shouldInterrupt) {
        const interrupted = replacementIsActive && this.interruptAcknowledged.has(effect.operationId);
        const reconciled = interrupted ? await this.reconcileStalledInterrupt(effect) : "wait";
        if (reconciled === "delivered") continue;
        if (reconciled === "wait") this.noteWait(effect, interrupted ? "interrupting" : "awaiting-turn", { lane: interrupted ? lane : undefined });
        blockRest("awaiting-turn");
        return true;
      }
      if (!replacesTurn && [...this.activeSteers.values()].some(steer =>
        steer.conversationId === effect.conversationId
        && (!steersIntoTurn || steer.turnId !== health.activeTurnRef))) {
        this.noteWait(effect, "conversation-busy", { detail: "a steer into the running turn is still settling" });
        blockRest("conversation-busy");
        return true;
      }
      if (health.status === "idle") this.interruptAcknowledged.delete(effect.operationId);
      const deliveryFence = shouldInterrupt
        ? effect.turnId ?? health.activeTurnRef
        : replacesTurn
          ? effect.turnId ?? null
          : effect.turnId !== undefined
            ? effect.turnId
            : health.activeTurnRef;
      const entry: QueueEntry = {
        id: effect.operationId,
        content: effect.content,
        contentDigest: effect.contentDigest,
        text: effect.content.text,
        images: effect.content.images,
        expectedTurnId: replacesTurn ? null : deliveryFence,
        ...(effect.runtime ? { runtime: effect.runtime } : {}),
        ...(effect.selectedContext ? { selectedContext: effect.selectedContext } : {}),
        ...(effect.origin ? { origin: effect.origin } : {}),
      };
      /* Always stamped, claim or no claim: the executor identity is what tells
         a row this instance is actuating right now from one it dropped, and
         omitting the whole stamp because the claim read failed produced an
         unstamped row that a later pass read as abandonment. An unreadable
         claim is recorded as unknown instead, which proves nothing to anybody
         and is exactly what it should prove. */
      const claim = await this.checking(lane, effect, "reading the host writer claim", () => this.readHostClaim(effect.conversationId));
      const retainedDispatch = this.firstDispatches.get(effect.operationId);
      const firstDispatch: FirstDispatchEvidence | undefined = claim.readable && typeof claim.value === "string"
        && !!claim.value && claim.value !== UNKNOWN_HOST_CLAIM
        && ((durable?.revision === 1 && (durable.status === "queued" || durable.status === "pending"))
          || retainedDispatch?.writerClaim === claim.value)
        ? {operationId: effect.operationId, writerClaim: claim.value, firstDispatch: true}
        : undefined;
      if (!firstDispatch) this.firstDispatches.delete(effect.operationId);
      const routedTurnId = recordsRoute && shouldInterrupt ? health.activeTurnRef! : null;
      if (this.port.bindDeliveryGeneration) {
        try {
          if (!await this.checking(lane, effect, "binding the host generation in the delivery record",
            async () => this.port.bindDeliveryGeneration!(effect.operationId, health.sessionKey))) {
            this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: "the delivery record would not bind the host generation" });
            this.retrySoon();
            return true;
          }
        } catch (error) {
          this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: `the delivery record could not be written: ${failureReason(error)}` });
          this.retrySoon();
          return true;
        }
      }
      if (!await this.checking(lane, effect, "writing the delivering fence to the journal", () => this.transitionUnlessSettled(
        effect.operationId,
        "delivering",
        {
          turnId: deliveryFence,
          reason: deliveringOwnershipReason(this.executorId, claim),
          ...(routedTurnId ? { delivery: "interrupt-then-turn-started" as const, interruptedTurnId: routedTurnId } : {}),
        },
        /* Only from a state nobody is delivering it in: a second executor that
           read the same queued row is refused here, so its write can never be
           taken as a replay and send the message again. */
        { fromStatuses: ["pending", "queued"] },
      ))) continue;
      this.noteWait(effect, shouldInterrupt ? "interrupting" : "dispatching", { lane, attempted: true, wake: "event" });
      if (effect.onlyIfIdle) {
        const claimed = await this.readStatus(effect.operationId);
        if (!claimed.readable || claimed.value?.status !== "delivering") {
          if (!claimed.readable) this.retrySoon();
          continue;
        }
        const current = await readEvidence(() => this.port.idleContinuationCurrent?.(effect.conversationId, effect.onlyIfIdle!) ?? false);
        if (!current.readable) {
          // The claim succeeded and no host call began. Retry this same fenced
          // operation when its session evidence is readable again.
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "idle continuation fence unavailable" });
          this.retrySoon();
          return true;
        }
        if (!current.value) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "idle-continuation-cancelled" });
          continue;
        }
      }
      if (firstDispatch) {
        this.firstDispatches.set(effect.operationId, firstDispatch);
        while (this.firstDispatches.size > 128) this.firstDispatches.delete(this.firstDispatches.keys().next().value!);
      }
      if (shouldInterrupt) {
        if (lane?.released) return true;
        try {
          await host.interrupt(health.activeTurnRef!);
          this.interruptAcknowledged.add(effect.operationId);
          this.interruptIssuedAt.set(effect.operationId, this.timing.now());
        } catch (error) {
          this.interruptAcknowledged.delete(effect.operationId);
          const reason = failureReason(error);
          /* Nothing was handed to the engine yet — the interrupt that would
             have cleared the way for it is what failed — so both branches only
             put the message back in the queue it came from, and an unreadable
             state is grouped with the one that waits rather than retries. No
             branch here converts it into a claim about the host. */
          const afterFailure = await this.readHealth(host);
          /* The interrupt did not happen, so the route written with
             `delivering` is withdrawn with it. */
          if (!afterFailure.readable
            || afterFailure.value.status === "dead"
            || afterFailure.value.status === "unhosted") {
            await this.transitionUnlessSettled(effect.operationId, "queued", { reason, ...clearedRoute });
            this.noteWait(effect, afterFailure.readable ? "awaiting-host" : "evidence-unreadable", { detail: `interrupt failed: ${reason}` });
            return true;
          }
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "interrupt-auto-retry", ...clearedRoute });
          this.noteWait(effect, "awaiting-turn", { wake: "retry", detail: `interrupt failed: ${reason}` });
          this.retrySoon();
          return true;
        }
        /* The interrupt was issued; whether the turn it ended left the host
           idle is the question this read answers. Unreadable answers nothing,
           so the message is not handed over on it: the row stays `delivering`
           and this instance's own next pass ends it as unverified rather than
           sending after an interrupt whose outcome nothing established. */
        const afterInterruptState = await this.readHealth(host);
        if (!afterInterruptState.readable) {
          this.noteWait(effect, "evidence-unreadable", { wake: "retry", detail: "host state after the interrupt is unavailable" });
          return this.fenceUnavailable();
        }
        const afterInterrupt = afterInterruptState.value;
        if (afterInterrupt.status === "dead" || afterInterrupt.status === "unhosted") {
          this.interruptAcknowledged.delete(effect.operationId);
          this.interruptIssuedAt.delete(effect.operationId);
          if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) continue;
          this.noteWait(effect, "awaiting-host");
          return true;
        }
        if (afterInterrupt.status !== "idle") {
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "interrupt-requested" });
          this.noteWait(effect, "interrupting", { lane });
          return true;
        }
        this.interruptAcknowledged.delete(effect.operationId);
      }
      let receipt;
      try {
        if (this.port.handoffHeld?.()) {
          this.firstDispatches.delete(effect.operationId);
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "automatic-update-handoff" });
          this.noteWait(effect, "update-handoff");
          return true;
        }
        /* A lane let go while it waited must not hand anything over. */
        if (lane?.released) return true;
        this.noteWait(effect, "dispatching", { lane, progressed: true, wake: "event" });
        // Consume before entering the host. A read retry, thrown result or
        // later queued retry must establish its own canonical evidence.
        this.firstDispatches.delete(effect.operationId);
        if (steersIntoTurn && host.steer) {
          this.port.authorizeDispatch?.(effect.operationId);
          const outcome = await host.steer(entry, firstDispatch, () => this.port.authorizeDispatch?.(effect.operationId));
          const settling = this.settleObservedSteer(effect, outcome).finally(() => {
            this.activeSteers.delete(effect.operationId);
            this.retrySoon();
          });
          this.activeSteers.set(effect.operationId, { conversationId: effect.conversationId, turnId: outcome.turnId, settling });
          /* The lane ends here and the observation carries on without it. It
             has no wake of its own to lose: its own answer ends it. */
          this.noteWait(effect, "dispatching", { wake: "none", detail: "handed over; its arrival has not been confirmed yet" });
          void settling.catch(() => undefined);
          continue;
        }
        receipt = await sendWithReadRetry(host, entry, firstDispatch, () => this.port.authorizeDispatch?.(effect.operationId));
      } catch (error) {
        const reason = failureReason(error);
        if (error instanceof StructuredSendRefusedError || error instanceof NativeQueueProtocolRefusal) {
          if (steerOrQueue && steersIntoTurn) {
            this.refusedSteerTurns.set(effect.operationId, health.activeTurnRef);
            await this.transitionUnlessSettled(effect.operationId, "queued", { reason: `steer-refused: ${reason}` });
            this.retrySoon();
            return true;
          }
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason });
          continue;
        }
        /* The one resend below is allowed only where the host is READ to be
           alive, so an unreadable state is grouped with the host being gone:
           the grouping that resends nothing. It costs a drain pass on a
           conversation whose host may be fine, and buys never issuing a second
           delivery on evidence nobody could read. */
        const afterFailure = await this.readHealth(host);
        const hostIsGone = !afterFailure.readable
          || afterFailure.value.status === "dead"
          || afterFailure.value.status === "unhosted";
        if (!hostIsGone && isThreadReadTimeout(error)) {
          /* The one resend this path issues, and the host dedupes it by
             queue-entry id: it reads the thread back and returns the confirmed
             receipt rather than writing a second message. Its own operation is
             retried, so this is the one failure after actuation that may go
             back to `queued`. */
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "delivery-auto-retry" });
          this.noteWait(effect, "dispatching", { wake: "retry", detail: "the host's thread read timed out; retried under the same key" });
          this.retrySoon();
          return true;
        }
        /* The message was handed to the engine and the engine did not answer.
           It may have been taken — whether the host then died or is still
           standing, the only thing that could say is the confirmed-delivery
           record this call failed to get — so it must not go back to `queued`,
           which says the send was never executed and is what let a later resend
           look safe on a send the recipient had already received (#1131), and
           it must not settle `failed`, which the receipt reads as fenced and
           answers `resend: "safe"`. A resend is issued under a NEW request id,
           so nothing on the host side would dedupe it against this attempt.
           `uncertain` is absorbing — the journal refuses every transition out
           of it and clears the outbox row in the same transaction — so no
           drain and no fresh request can produce a second delivery, and the
           receipt says the fate is unknown instead of inventing one. That is
           what keeps `failed` on a message effect meaning "never reached the
           engine": the distinction settlement reads to decide whether a resend
           is safe. The cost is that a precondition the host refused by throwing
           reads as unverified too; one verification is the cheaper error. */
        await this.terminalizeUnverified(effect.operationId, `${DELIVERY_UNVERIFIED_AFTER_ACTUATION}: ${reason}`);
        /* A host that is gone takes the rest of this conversation's queue with
           it; a live one keeps draining behind the send it could not answer. */
        if (hostIsGone) return true;
        continue;
      }
      if (receipt.outcome === "rejected") {
        if (receipt.reason === "stale-turn") {
          /* An interrupt-and-resend that lost a race with a new turn goes back
             to the queue: the interrupt path is retried, nothing is dropped. */
          if ((effect.kind === "send" && effect.policy !== "steer-if-active") || steerByInterrupt) {
            await this.transitionUnlessSettled(effect.operationId, "queued", { reason: receipt.reason });
            this.noteWait(effect, "awaiting-turn", { detail: "a new turn started before the hand-over" });
            return true;
          }
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: receipt.reason });
          continue;
        }
        await this.transitionUnlessSettled(effect.operationId, "queued", { reason: receipt.reason });
        this.noteWait(effect, "awaiting-turn", { detail: receipt.reason ?? "the host declined the hand-over" });
        return true;
      }
      /* The route this pass recorded, or the one an earlier pass or executor
         recorded before this message went back to the queue. */
      const interruptedTurnId = routedTurnId
        ?? (recordsRoute && durable?.delivery === "interrupt-then-turn-started" ? durable.interruptedTurnId ?? null : null);
      await this.transitionUnlessSettled(effect.operationId, "delivered", {
        turnId: receipt.turnId,
        /* A message that ended a running turn to start its own says so; the
           Copilot path never reads `steered`. */
        ...(interruptedTurnId
          ? receipt.outcome === "turn-started"
            ? { delivery: "interrupt-then-turn-started" as const, interruptedTurnId }
            : clearedRoute
          : {}),
      });
    }
    return Boolean(switchDeferred) || nativeReceiptUnavailable || updateHeld;
  }

  private async settleObservedSteer(effect: SendEffect, outcome: RuntimeSteerOutcome): Promise<void> {
    let observed: "landed" | "dropped" | "unknown";
    try { observed = await outcome.observe(); }
    catch { observed = "unknown"; }
    if (observed === "landed") {
      await this.transitionUnlessSettled(effect.operationId, "delivered", { turnId: outcome.turnId });
    } else if (observed === "dropped") {
      if (effect.policy === "steer-or-queue") this.refusedSteerTurns.set(effect.operationId, outcome.turnId);
      await this.transitionUnlessSettled(effect.operationId, effect.policy === "steer-or-queue" ? "queued" : "failed", {
        reason: "steer-dropped",
      });
    } else {
      await this.terminalizeUnverified(effect.operationId, `${DELIVERY_UNVERIFIED_AFTER_ACTUATION}: steer observation unknown`);
    }
  }

  /**
   * Executes a durable compact receipt (#862). The pass never waits for the
   * compaction itself: it issues the control, records the conversation as
   * compacting so no message can slip past an unfinished compaction, and lets
   * the evidence terminalize the receipt out of band. Duplicate execution is
   * impossible because the operation is registered in flight before the control
   * is issued and the outbox row is only cleared by the terminal transition.
   *
   * It never reports the group blocked, in any branch: compact is the first
   * control that can occupy this slot for minutes, and a kill sorted behind it
   * must still run in the same pass. Messages are held by the per-conversation
   * barrier instead, which is read only for non-control effects.
   */
  private async drainCompact(effect: CompactEffect): Promise<ControlDrainResult> {
    if (this.activeCompactions.has(effect.operationId)) return { blocked: false, terminated: false };
    /* A second compaction admitted for a thread that is already compacting is
       left pending, untouched. The operator's second request is legitimate once
       the first lands — journal admission cannot refuse it, because a
       compaction is not a turn — but issuing both would compact the thread
       twice and settle both receipts on one piece of evidence. The `retrySoon`
       fired when the first settles brings this effect back. Holding it does not
       block the group: kill must still get through. */
    if (this.compactingConversations.has(effect.conversationId)) return { blocked: false, terminated: false };
    /* An unreadable receipt is not evidence of anything, and this control is a
       second COMPACTION if the row it cannot read is already `delivering` — the
       same duplicate actuation the message path is fenced against. The pass
       issues nothing and comes back; the group is not reported blocked, because
       a kill sorted behind this effect must still run. */
    const status = await this.readStatus(effect.operationId);
    if (!status.readable) {
      this.retrySoon();
      return { blocked: false, terminated: false };
    }
    const durable = status.value;
    if (durable?.status === "delivering") {
      /* An earlier executor issued this control and never settled it — a Viewer
         restart, or a terminal transition that never landed. This process
         cannot know whether the thread was compacted, and issuing the control
         again could compact it twice, so the receipt terminalizes unverified. */
      await this.terminalizeUnverified(
        effect.operationId,
        "compaction was issued by an earlier executor; its outcome is unverified",
      );
      return { blocked: false, terminated: false };
    }
    /* A conversation the operator deliberately terminated must not be brought
       back to compact it. A compact admitted between a kill's admission and its
       execution is still pending afterwards — kill admission does not move the
       session's host axis — and the recovery below would otherwise respawn the
       host purely to run this control. Sends are fenced the same way. */
    const killBoundary = this.successfulKillBoundaries.get(effect.conversationId);
    if (killBoundary && effect.eventSeq <= killBoundary.eventSeq) {
      await this.transitionUnlessSettled(effect.operationId, "failed", {
        reason: "structured host was intentionally terminated; retry the operation",
      });
      return { blocked: false, terminated: false };
    }
    const host = this.resolveHost(effect.conversationId);
    /* Controls sort ahead of sends, and a compaction can hold that slot for
       minutes, so an unavailable host must start the same recovery a send would
       — otherwise every message queued behind this control waits on a host
       nobody asked to come back. The group is not reported blocked: recovery is
       asynchronous, and a kill behind this effect must not wait a whole pass
       for it. */
    if (!host) {
      if (this.awaitingContendedRecovery(effect.operationId)) return { blocked: false, terminated: false };
      if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) {
        return { blocked: false, terminated: false };
      }
      await this.recoverUnavailableHost(effect);
      return { blocked: false, terminated: false };
    }
    if (!hostSupportsCompact(host)) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "unsupported-capability" });
      return { blocked: false, terminated: false };
    }
    /* Same fence as the message path, and the same answer to an unreadable
       one: a compaction is issued against a host this pass could read as idle,
       never against one it could not read at all. */
    const state = await this.readHealth(host);
    if (!state.readable) {
      this.retrySoon();
      return { blocked: false, terminated: false };
    }
    const health = state.value;
    if (health.status === "dead" || health.status === "unhosted") {
      if (this.awaitingContendedRecovery(effect.operationId)) return { blocked: false, terminated: false };
      if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) {
        return { blocked: false, terminated: false };
      }
      await this.recoverUnavailableHost(effect);
      return { blocked: false, terminated: false };
    }
    /* Admission fenced the durable turn axis; this re-reads the live host, so a
       turn that started in between fails the control instead of racing it. */
    if (health.status !== "idle" || health.activeTurnRef) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "busy-turn" });
      return { blocked: false, terminated: false };
    }
    /* Durable marker first: a restart that finds the receipt in `delivering`
       knows the control may already have reached the engine and terminalizes it
       as unverified instead of compacting the thread a second time. */
    if (!await this.transitionUnlessSettled(effect.operationId, "delivering")) {
      return { blocked: false, terminated: false };
    }
    /* Marked before the run exists: a compaction that settles immediately would
       otherwise clear the barrier before it was ever raised. */
    this.compactingConversations.add(effect.conversationId);
    const run = this.runCompaction(host, effect).finally(() => {
      this.activeCompactions.delete(effect.operationId);
      this.compactingConversations.delete(effect.conversationId);
      this.retrySoon();
    });
    this.activeCompactions.set(effect.operationId, run);
    void run.catch(() => undefined);
    return { blocked: false, terminated: false };
  }

  private async runCompaction(host: CompactCapableHost, effect: CompactEffect): Promise<void> {
    try {
      const outcome = await host.compact({
        operationId: effect.operationId,
        threadId: effect.sessionKey.sessionId,
      });
      /* The receipt records which compaction closed it: the only durable place
         the lifecycle evidence survives alongside the operation. */
      await this.transitionUnlessSettled(effect.operationId, "delivered", {
        reason: outcome.compactionId ? `compaction:${outcome.compactionId}` : null,
      });
    } catch (error) {
      if (error instanceof StructuredCompactError && error.phase === "unverified") {
        await this.terminalizeUnverified(effect.operationId, failureReason(error));
        return;
      }
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: failureReason(error) });
    }
  }

  /**
   * The five failable reads this queue decides on, each keeping whether it
   * could be read at all.
   *
   * A port method that is not wired answers as a completed read: the fence does
   * not exist in that deployment, which is a fact about the configuration. Only
   * an attempted read that threw is unreadable, and the callers above never let
   * one of those authorise anything.
   */
  private readStatus(operationId: string): Promise<Evidence<StructuredOperationStatus | null>> {
    const read = this.port.status?.bind(this.port);
    return readOptionalEvidence(read && (() => read(operationId)), null, "delivery journal status is unavailable");
  }

  private readSettled(operationId: string): Promise<Evidence<boolean>> {
    const read = this.port.settled?.bind(this.port);
    return readOptionalEvidence(read && (() => read(operationId)), false, "durable delivery record is unavailable");
  }

  private async transitionUnlessSettled(
    operationId: string,
    status: StructuredDeliveryTransition,
    details?: RuntimeTransitionDetails,
    options?: RuntimeTransitionOptions,
  ): Promise<boolean> {
    try {
      await this.port.transition(operationId, status, details, options);
      this.settleProgress(operationId, status, details?.reason);
      return true;
    } catch (error) {
      const durable = await this.readStatus(operationId);
      if (durable.readable && durable.value && TERMINAL_DELIVERY_STATUSES.has(durable.value.status)) {
        this.settleProgress(operationId, durable.value.status, durable.value.reason);
        /* The journal ended this operation and only the answer was lost, so the
           delivery record's projection — which rides on that answer — never
           happened. Nothing else will come back for it: the effect is cleared
           and this pass is the last one that sees the operation at all (#1612).
           Owed from here and repaired on its own, so its conversation's next
           message does not wait on the store that lost the answer. */
        this.repairTerminalProjection(operationId);
        return false;
      }
      /* Unreadable: whether the transition applied at all is unknown, and an
         unknown is not settled here. The repair is asked for anyway — it reads
         the journal itself and settles only what it can prove — and this pass
         still fails exactly as before. */
      this.repairTerminalProjection(operationId);
      throw error;
    }
  }

  /**
   * Owes the projection of an operation whose terminal acknowledgement was
   * lost, and starts one bounded repair attempt unless one is in flight.
   *
   * Never awaited: the repair goes to the same journal and registry whose
   * answer was just lost, and a pass that waited on it would hold every
   * conversation's next delivery and the watchdog's replacement pass behind
   * one slow store. The operation stays owed until a repair says its fate is
   * established; an attempt that has not answered within
   * {@link StructuredDeliveryQueueTiming.reconcileReadMs} frees the slot for
   * the next pass, and its own late answer still counts. A repair never
   * actuates the message, so running it beside delivery changes no input.
   */
  private repairTerminalProjection(operationId: string): void {
    /* The cap releases the OLDEST owed projection, which has had every pass
       since it was recorded to be established and is the one the journal's own
       bounded retention gives up on first. */
    if (!this.unprojectedTerminals.has(operationId) && this.unprojectedTerminals.size >= UNPROJECTED_TERMINAL_LIMIT) {
      const oldest = this.unprojectedTerminals.values().next();
      if (!oldest.done) {
        this.unprojectedTerminals.delete(oldest.value);
        this.projectingTerminals.delete(oldest.value);
        this.diagnosticError("[structured delivery] owed terminal projection released at the retry cap", { operationId: oldest.value });
      }
    }
    this.unprojectedTerminals.add(operationId);
    if (this.projectingTerminals.has(operationId)) return;
    const attempt = {};
    this.projectingTerminals.set(operationId, attempt);
    const release = () => {
      if (this.projectingTerminals.get(operationId) === attempt) this.projectingTerminals.delete(operationId);
    };
    /* Nothing else will wake an owed repair: the effect is gone, so without a
       scheduled pass a quiet queue would wait for the next message to repair
       the last. */
    const bound = setTimeout(() => { release(); this.retrySoon(); }, this.timing.reconcileReadMs);
    (bound as { unref?: () => void }).unref?.();
    void (async () => {
      let established = false;
      try {
        established = await this.port.projectTerminal?.(operationId) ?? true;
      } catch (error) {
        this.diagnosticError("[structured delivery] terminal projection after a lost acknowledgement failed", {
          operationId,
          error: failureReason(error),
        });
      }
      clearTimeout(bound);
      release();
      if (established) {
        this.unprojectedTerminals.delete(operationId);
        return;
      }
      this.retrySoon();
    })();
  }

  /** The owed projections, restarted once per pass in the order they were
      recorded. Reported unreadable again, they simply stay owed. */
  private projectOwedTerminals(): void {
    for (const operationId of [...this.unprojectedTerminals]) this.repairTerminalProjection(operationId);
  }

  private readHostClaim(conversationId: string): Promise<Evidence<string | null>> {
    const read = this.port.hostClaim?.bind(this.port);
    return readOptionalEvidence(read && (() => read(conversationId)), null, "host claim projection is unavailable");
  }

  /**
   * The live host's own state, which is a read like any other.
   *
   * It decides whether a message may be handed over at all, whether a control
   * may be issued, and — after an actuation that threw — whether the host is
   * gone. It used to be read bare, so a throw took the whole pass down with it,
   * or converted at the call site with `.catch(() => null)` into the host being
   * GONE, which is a fact nothing read. Being gone is what lets a control be
   * issued a second time, so that conversion was the same duplicate-actuation
   * hazard as an unreadable journal fence one step further along.
   */
  private readHealth(host: EngineHost): Promise<Evidence<HostState>> {
    return readEvidence(() => host.health(), "structured host state is unavailable");
  }

  /**
   * Whether the evidence says this conversation's turn is severed, when a
   * control has no host left to resolve (#1281).
   *
   * The liveness decision behind it already refuses to answer `severed` from
   * anything it could not read — that is the whole of what it is for — so a
   * null here means only "not shown to be severed". The read reaching it can
   * still fail, though: it goes to the registry snapshot and to a transcript on
   * disk, and letting that failure out would abort the drain pass for every
   * other conversation sharing it. Unreadable joins `unknown` on the side that
   * settles nothing, which is the same answer both this fence and the liveness
   * decision give the question separately.
   */
  private readSeveredHostReason(conversationId: string): Promise<Evidence<string | null>> {
    return readEvidence(
      () => this.severedHostReason(conversationId),
      "structured host liveness evidence is unavailable",
    );
  }

  /** A blocked control may produce no journal or host event of its own. Keep
      one bounded retry alive so a later pass observes its settlement deadline;
      a control settled in this pass never reaches this helper. */
  private scheduleControlSettlementCheck(receipt: StructuredOperationStatus | null): void {
    if (controlSettlementDeadlineAt(receipt) !== null) this.retrySoon();
  }

  /**
   * What the drain does with a fence it could not read: nothing, and again
   * shortly.
   *
   * Reporting the group blocked leaves the effect exactly as it was — no
   * transition, no engine write, nothing durable to undo — and the scheduled
   * retry brings the pass back once the store answers. A send whose executor
   * never returns is ended by the receipt deadline meanwhile, so a fence that
   * stays unreadable delays an answer without ever withholding one.
   */
  private fenceUnavailable(): boolean {
    this.retrySoon();
    return true;
  }

  /**
   * Executes one native injection (#1560). Returns whether the pass may carry
   * on with the rest of this conversation's queue.
   *
   * Three things this deliberately does NOT do, each because the operator asked
   * for injection and not for something adjacent to it:
   *
   * - It never interrupts, steers or starts a turn. A host that cannot inject
   *   ends the operation with that reason. There is no fallback, because a
   *   fallback here would silently deliver a different action than the one the
   *   label promised.
   * - It never settles on the acknowledgement. `thread/inject_items` answers
   *   `{}`, and on the active path it can answer while the items are still only
   *   pending input with the rollout flush still to come. `delivered` therefore
   *   requires the insertion to have been READ BACK out of canonical history;
   *   an accepted-but-unobserved insertion settles `uncertain`, which is the
   *   status that means exactly "this may have landed and nothing proved it".
   * - It never issues a second insertion. The engine does not deduplicate, so
   *   an unknown outcome is absorbed rather than retried: the host scans for
   *   this operation's dedup marker before writing, and `uncertain` is a
   *   terminal the journal refuses to transition out of.
   */
  private async executeInjection(effect: InjectEffect, host: EngineHost, health: HostState, lane?: DeliveryLane): Promise<boolean> {
    /* Its acknowledgement already came back and its evidence is still being
       read. Re-issuing here would be a second insertion, which the engine does
       not deduplicate. */
    if (this.activeInjections.has(effect.operationId)) return true;
    const binding = effect.binding;
    const current = await readEvidence(() => this.port.injectionBinding?.(effect.conversationId) ?? null);
    if (!current.readable) {
      this.retrySoon();
      return false;
    }
    if (!binding || !current.value || binding.threadId !== health.sessionKey
      || binding.threadId !== current.value.threadId || binding.accountId !== current.value.accountId
      || binding.writerClaim !== current.value.writerClaim) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "stale-generation" });
      return true;
    }
    if (!hostSupportsInject(host)) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "unsupported-injection" });
      return true;
    }
    /* The fence is re-read here because admission's verdict is older than this
       pass. `null` asks for the idle placement and a running turn refuses it;
       a named turn must still be the one running. Refused BEFORE `delivering`,
       so a stale fence costs no durable actuation record at all. */
    if (effect.turnId !== undefined && effect.turnId !== health.activeTurnRef) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "stale-turn" });
      return true;
    }
    /* The reads above can outlast this executor: a successor that replaced it,
       or a pass that let its lane go, may be handing this operation over now. */
    if (lane?.released || this.retirementExecutor.retired) return false;
    if (!await this.transitionUnlessSettled(effect.operationId, "delivering", {
      turnId: health.activeTurnRef,
      reason: deliveringOwnershipReason(this.executorId, { readable: true, value: binding.writerClaim }),
    },
    /* Only from a state nobody is delivering it in, as for a send: the journal
       answers a second `delivering` write as a replay, and the engine does not
       deduplicate an insertion, so a second executor has to be refused here. */
    { fromStatuses: ["pending", "queued"] })) {
      return true;
    }
    if (lane?.released) return false;
    if (this.retirementExecutor.retired) {
      /* Replaced while the fence was being written. Nothing was handed over,
         so the operation goes back to the queue for the executor that drains
         this conversation now. */
      await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "executor-retired" }, { fromStatuses: ["delivering"] });
      return false;
    }
    this.noteWait(effect, "dispatching", { lane, attempted: true, wake: "event" });
    let outcome;
    try {
      outcome = await host.inject({
        operationId: effect.operationId,
        threadId: binding.threadId,
        text: effect.text,
        contentDigest: effect.contentDigest,
        ...(effect.turnId !== undefined ? { expectedTurnId: effect.turnId } : {}),
        ...(effect.selectedContext ? { selectedContext: effect.selectedContext } : {}),
        ...(effect.origin ? { origin: effect.origin } : {}),
      });
    } catch (error) {
      const reason = failureReason(error);
      /* A REFUSED injection wrote nothing and can say so plainly. Anything else
         may have written, and saying `failed` there would tell a caller the
         context is absent when it may be sitting in the thread. */
      if (error instanceof StructuredInjectError && error.phase === "refused") {
        await this.transitionUnlessSettled(effect.operationId, "failed", { reason });
        return true;
      }
      await this.terminalizeUnverified(effect.operationId, `${INJECTION_UNVERIFIED_AFTER_ACTUATION}: ${reason}`);
      return true;
    }
    /* THE ENGINE WRITE IS DONE; WHAT IS LEFT IS READING IT BACK.
       That read waits for the turn to reach its next model request, which can
       be minutes into a single tool call — and this pass must not be inside it.
       `drainAfterAdmission` awaits the drain already running, so an observation
       held here would make every later admission, on every OTHER conversation,
       wait out the window before it was even looked at. A compaction is
       detached for the same reason.

       No conversation barrier goes with it, unlike compaction: a compaction is
       still MUTATING the thread, while this is a read of history that has
       already been written. Ordering on the thread was fixed when the request
       returned, so a send admitted a moment later neither overtakes the
       injection nor needs to wait for its evidence. */
    const settle = this.settleObservedInjection(effect, outcome).finally(() => {
      this.activeInjections.delete(effect.operationId);
      this.retrySoon();
    });
    this.activeInjections.set(effect.operationId, settle);
    this.noteWait(effect, "dispatching", { wake: "none", detail: "handed over; its arrival has not been confirmed yet" });
    void settle.catch(() => undefined);
    return true;
  }

  /**
   * Records what the canonical transcript turned out to say about one
   * injection (#1560). Runs detached from the delivery pass; see the note at
   * its call site for why that is required rather than merely tidy.
   */
  private async settleObservedInjection(effect: InjectEffect, outcome: RuntimeInjectOutcome): Promise<void> {
    let observed: boolean;
    try {
      observed = await outcome.observe();
    } catch (error) {
      /* The evidence read failed. The insertion itself was acknowledged, so its
         fate is unknown rather than failed. */
      await this.terminalizeUnverified(
        effect.operationId,
        `${INJECTION_ACKNOWLEDGED_BUT_UNOBSERVED}: ${failureReason(error)}`,
      );
      return;
    }
    if (!observed) {
      await this.terminalizeUnverified(effect.operationId, INJECTION_ACKNOWLEDGED_BUT_UNOBSERVED);
      return;
    }
    await this.transitionUnlessSettled(effect.operationId, "delivered", {
      turnId: outcome.turnId,
      reason: outcome.placement === "pending-input"
        ? INJECTION_INTO_RUNNING_TURN
        : INJECTION_INTO_HISTORY,
    });
  }

  /**
   * What a `delivering` row's recorded ownership proves about its executor.
   *
   * Three answers, because two were one too few. The row says actuation began;
   * whether the executor that began it is still there is a separate question,
   * and an unreadable answer to that question is not a `no`.
   *
   * - `live`: a DIFFERENT executor wrote the row and the writer claim it wrote
   *   under is still the claim that owns the host. It can still write to the
   *   engine, so the row is its to settle.
   * - `abandoned`: the host is owned by a DIFFERENT, explicitly named claim, so
   *   the recorded executor can no longer write to the engine and nothing but
   *   this pass is left to end the row. A row this executor wrote itself is
   *   abandoned too: no other pass of this instance can be actuating it, so
   *   finding it here means an earlier pass of ours dropped it.
   * - `unproven`: the two claims could not be COMPARED — the row carries no
   *   ownership at all, it was written under a claim its writer could not read,
   *   or the claim now cannot be read. That is a gap in the evidence and not a
   *   handover, so the row stays with the executor that holds it. Nothing is
   *   withheld by waiting: an owner that never comes back leaves the send to
   *   the receipt deadline, which ends it from the durable record alone, and no
   *   branch here sends anything again.
   *
   * A row carrying no ownership used to be `abandoned` — every row looked like
   * that before this evidence existed, and terminalizing them was how the
   * evidence was rolled out. It is `unproven` now, because the only rows that
   * can still look like that are ones whose writer could not read the claim,
   * which is the projection gap this fence exists for.
   */
  private async deliveringOwnerDisposition(
    conversationId: string,
    reason: string | null | undefined,
  ): Promise<"live" | "abandoned" | "unproven"> {
    const owner = deliveringOwnership(reason);
    if (!owner) return "unproven";
    if (owner.executorId === this.executorId) return "abandoned";
    switch (evidenceAgrees(await this.readHostClaim(conversationId), owner.hostClaim)) {
      case "matches": return "live";
      case "differs": return "abandoned";
      default: return "unproven";
    }
  }

  /**
   * Terminalizes an operation whose outcome nothing proved — a send an executor
   * took and could not answer for, a compaction an earlier one issued. `uncertain` is a
   * newer transition than the rest of this channel, so a runtime-host from
   * before #862 rejects it; the operation must still settle rather than wedge
   * the conversation's queue behind a receipt no pass can ever clear.
   */
  private async terminalizeUnverified(operationId: string, reason: string): Promise<void> {
    try {
      await this.transitionUnlessSettled(operationId, "uncertain", { reason });
    } catch {
      await this.transitionUnlessSettled(operationId, "failed", { reason });
    }
  }

  /** Journal failure leaves the switch's outcome unknown. Every transition,
   * including cleanup of an older choice, consumes the pending choice's budget.
   * Healthy/parked peers cannot reset that operation's deadline. */
  private async transitionReconfigure(
    effect: StructuredReconfigureEffect,
    status: StructuredDeliveryTransition,
    details?: { turnId?: string | null; reason?: string | null },
    retryOwner = effect,
  ): Promise<boolean> {
    try {
      return await this.transitionUnlessSettled(effect.operationId, status, details);
    } catch (error) {
      const retry = this.reconfigureRetries.get(retryOwner.operationId) ?? new RetryBackoff();
      retry.fail();
      this.reconfigureRetries.set(retryOwner.operationId, retry);
      this.retrySoon();
      throw error;
    }
  }

  private async drainReconfigure(effect: StructuredReconfigureEffect, carriedSends: readonly string[] = []): Promise<boolean> {
    const retry = this.reconfigureRetries.get(effect.operationId) ?? new RetryBackoff();
    this.reconfigureRetries.set(effect.operationId, retry);
    if (!retry.ready()) { this.retrySoon(); return true; }
    /* #1705: cancellation settles without waiting for a turn boundary. The
       claim checks the same record again in its own transaction. */
    if (this.port.reconfigureCancelled?.(effect)) {
      this.owedSwitchHolds.delete(effect.operationId);
      await this.transitionReconfigure(effect, "failed", { reason: "cancelled" });
      return false;
    }
    /* A switch that already failed here and whose hold the lock refused is
       not applied again: only its hold and its failure are still owed. */
    const owedHold = this.owedSwitchHolds.get(effect.operationId);
    if (owedHold !== undefined) return this.failSwitch(effect, owedHold, true, retry);
    const host = this.resolveHost(effect.conversationId);
    if (host) {
      /* A switch is applied at a turn boundary, and an unreadable state is not
         one: it cannot show the host busy, and treating it as idle would apply
         the switch across a turn that may be running. */
      const state = await this.readHealth(host);
      if (!state.readable) { retry.fail(); this.retrySoon(); return true; }
      const health = state.value;
      if (health.status === "active" || health.status === "attention" || health.activeTurnRef) return true;
    }
    if (!await this.transitionReconfigure(effect, "applying")) return false;
    let outcome: Awaited<ReturnType<typeof this.reconfigure>>;
    try {
      outcome = await this.reconfigure(effect, {
        isCurrent: () => this.isCurrentReconfigure(effect),
        ...(carriedSends.length ? { carriedSends } : {}),
      });
    } catch (error) {
      /* A registry write the lock refused changed nothing: the switch is
         neither failed nor applied, and it stays listed for a later pass
         (docs/design/delivery-progress-and-drain.md, C3). */
      if (error instanceof Error && error.message === REGISTRY_WRITER_BUSY) {
        await this.transitionReconfigure(effect, "queued", { reason: REGISTRY_WRITER_BUSY });
        retry.fail();
        this.retrySoon();
        return true;
      }
      /* Keep the failed account hold; the unactuated messages below settle
         with its reason. Supersedence and cancellation create no failure hold. */
      const holds = Boolean(effect.accountId && !this.port.reconfigureCancelled?.(effect)
        && error instanceof Error && error.name !== "StructuredReconfigureSupersededError" && error.name !== "StructuredReconfigureCancelledError");
      return this.failSwitch(effect, failureReason(error), holds, retry);
    }
    // Journal timeouts after the executor returns cannot turn its outcome into
    // a failed switch. Read/reconcile the original receipt on a bounded retry.
    /* `writer-busy`: the switch found the delivery record's write lock held
       past its bound and wrote nothing. The reason rides on the switch's own
       receipt, so the composer says why the switch is waiting. */
    if (outcome === "pending" || outcome === "writer-busy") {
      await this.transitionReconfigure(effect, "queued", { reason: outcome === "writer-busy" ? "switch-writer-busy" : "turn-boundary" });
      retry.fail();
      this.retrySoon();
      return true;
    }
    await this.transitionReconfigure(effect, "applied");
    this.reconfigureRetries.delete(effect.operationId);
    return false;
  }

  /**
   * Ends a failed switch: its hold first, then its failure. The hold is the
   * barrier the conversation's later messages wait on once the effect is no
   * longer listed, so a hold the registry refused leaves the effect listed as
   * it is (`applying`), still blocking them, and owed for the next pass. A
   * restart before then finds the same listed effect and applies it again,
   * as after a crash inside the switch (docs/design/delivery-progress-and-drain.md, C3).
   */
  private async failSwitch(effect: StructuredReconfigureEffect, reason: string, holds: boolean, retry: RetryBackoff): Promise<boolean> {
    if (holds) {
      this.owedSwitchHolds.set(effect.operationId, reason);
      if (this.port.holdForFailedSwitch && await this.port.holdForFailedSwitch(effect, reason) === false) {
        retry.fail();
        this.retrySoon();
        return true;
      }
    }
    await this.transitionReconfigure(effect, "failed", { reason });
    this.owedSwitchHolds.delete(effect.operationId);
    return false;
  }

  private async isCurrentReconfigure(effect: StructuredReconfigureEffect): Promise<boolean> {
    let latest = effect;
    let afterEventSeq = 0;
    while (true) {
      const page = await this.port.effects(["runtime.reconfigure"], afterEventSeq);
      for (const raw of page) {
        const candidate = reconfigureEffect(raw);
        if (candidate?.conversationId === effect.conversationId && candidate.eventSeq > latest.eventSeq) {
          latest = candidate;
        }
      }
      if (page.length < STRUCTURED_DELIVERY_BATCH_SIZE) break;
      const nextCursor = Math.max(...page.map((item) => item.eventSeq));
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= afterEventSeq) {
        throw new Error("structured reconfigure ownership page did not advance");
      }
      afterEventSeq = nextCursor;
    }
    return latest.operationId === effect.operationId && latest.eventSeq === effect.eventSeq;
  }

  /**
   * Starts recovery for a conversation whose host is unavailable, and settles
   * the operation that asked for it when recovery cannot start.
   *
   * Account-mutation contention gets a bounded retry (#1716). When the lock
   * refused the successor reservation before it existed, recovery left nothing
   * behind: no receipt, no process, no engine write. The operation stays
   * `queued` exactly as it was admitted, and the retry wake brings recovery
   * back on a doubling spacing until the attempts run out. The recovery layer
   * marks that case at the reservation call; the same busy error raised later
   * in recovery arrives unmarked and settles failed with every other failure,
   * since trying again there could reserve a second successor.
   */
  private async recoverUnavailableHost(effect: Pick<DeliveryEffect, "conversationId" | "operationId"> & { origin?: MessageOrigin }, status?: StructuredOperationStatus | null): Promise<void> {
    if (!this.recoverHost) return;
    try {
      const recovered = await this.recoverHost(effect.conversationId, {
        operationId: effect.operationId,
        origin: effect.origin,
        admittedAt: status?.admittedAt ?? status?.at,
      });
      this.contendedRecoveries.delete(effect.operationId);
      if (recovered) {
        this.rerun = true;
        return;
      }
      await this.transitionUnlessSettled(effect.operationId, "failed", {
        reason: "structured host recovery did not start; retry the operation",
      });
    } catch (error) {
      if (error instanceof StructuredRecoveryHeldForUpdateError) {
        this.retrySoon();
        return;
      }
      let reason = `structured host recovery failed: ${failureReason(error)}`;
      if (error instanceof StructuredRecoveryContendedError) {
        const attempts = (this.contendedRecoveries.get(effect.operationId)?.attempts ?? 0) + 1;
        if (attempts < CONTENDED_RECOVERY_ATTEMPTS) {
          this.deferContendedRecovery(effect, attempts);
          return;
        }
        reason = `structured host recovery failed after ${attempts} contended attempts: ${failureReason(error)}`;
      }
      this.contendedRecoveries.delete(effect.operationId);
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: reason.slice(0, 240) });
    }
  }

  /**
   * Whether the operation is still inside the spacing before its next contended
   * recovery attempt (#1716). Such a pass writes nothing for it, neither the
   * `dead-host` requeue nor a recovery attempt, and asks for the retry wake. A
   * due time further out than the largest spacing can only come from a clock
   * that moved backwards, and counts as due.
   */
  private awaitingContendedRecovery(operationId: string): boolean {
    const contended = this.contendedRecoveries.get(operationId);
    if (!contended) return false;
    const remainingMs = contended.nextAt - Date.now();
    if (remainingMs <= 0 || remainingMs > CONTENDED_RECOVERY_MAX_SPACING_MS) return false;
    this.retrySoon();
    return true;
  }

  /** Records one contended recovery attempt and asks for the wake that brings
      the next one (#1716). */
  private deferContendedRecovery(effect: Pick<DeliveryEffect, "conversationId" | "operationId">, attempts: number): void {
    const spacingMs = Math.min(CONTENDED_RECOVERY_FIRST_SPACING_MS * 2 ** (attempts - 1), CONTENDED_RECOVERY_MAX_SPACING_MS);
    this.contendedRecoveries.set(effect.operationId, { attempts, nextAt: Date.now() + spacingMs });
    this.diagnosticError("[structured delivery] host recovery deferred by account mutation contention", {
      conversationId: effect.conversationId,
      operationId: effect.operationId,
      attempts,
      retryInMs: spacingMs,
    });
    this.retrySoon();
  }

  private async drainControl(effect: ControlEffect): Promise<ControlDrainResult> {
    if (effect.kind === "kill") {
      if (effect.onlyIfIdle && this.retirementExecutor.retired) return { blocked: true, terminated: false };
      if (effect.onlyIfIdle) {
        this.retirementExecutor.pendingClaims.add(effect.operationId);
        retirementExecutors.set(this.executorId, this.retirementExecutor);
        // Acquire before awaited health/refusal reads. A CAS loser cannot
        // actuate or settle the winner, even if both observed queued together.
        try {
          await this.port.transition(effect.operationId, "delivering", undefined,
            { retirementClaim: this.retirementClaim, fromStatuses: ["pending", "queued"] });
        } catch { this.retrySoon(); return { blocked: true, terminated: false }; }
        const claimed = await this.readStatus(effect.operationId);
        if (!claimed.readable || !claimed.value) { this.retrySoon(); return { blocked: true, terminated: false }; }
        if (claimed.value.status !== "delivering") {
          forgetRetirementOperation(effect.operationId, this.executorId);
          return { blocked: false, terminated: false };
        }
        if (claimed.value.retirementClaim?.executorId !== this.executorId) {
          forgetRetirementOperation(effect.operationId, this.executorId);
          // An older host cannot grant exclusivity; no actuation has begun.
          if (!claimed.value.retirementClaim) await this.transitionUnlessSettled(effect.operationId, "failed",
            { reason: "retirement claim protocol unavailable" });
          return { blocked: true, terminated: false };
        }
      }
      const transition = async (status: StructuredDeliveryTransition, details?: RuntimeTransitionDetails) => {
        const settled = await this.transitionUnlessSettled(effect.operationId, status, details,
          effect.onlyIfIdle ? { retirementClaim: this.retirementClaim } : undefined);
        if (effect.onlyIfIdle && settled && status !== "delivering") forgetRetirementOperation(effect.operationId, this.executorId);
        return settled;
      };
      const authority = effect.onlyIfIdle ? { operationId: effect.operationId, claim: this.retirementClaim } : undefined;
      const refusal = await this.killRefusal(effect.conversationId);
      if (refusal) {
        await transition("failed", { reason: refusal });
        return { blocked: false, terminated: false };
      }
      const host = this.resolveHost(effect.conversationId);
      if (effect.onlyIfIdle && host) {
        const state = await this.readHealth(host);
        if (!state.readable || state.value.status !== "idle" || state.value.activeTurnRef !== null
          || state.value.pendingAttention.length > 0 || blockingHostActivityFlags(state.value.activeFlags).length > 0) {
          await transition("failed", { reason: "idle-retirement-deferred" });
          return { blocked: false, terminated: false };
        }
      }
      if (!effect.sessionKey) {
        await transition("failed", { reason: "structured host termination target is unavailable" });
        return { blocked: false, terminated: false };
      }
      if (!host) {
        try {
          if (!await this.terminateHost(effect.conversationId, effect.sessionKey, effect.onlyIfIdle, authority, effect.providerRecovery)) {
            if (effect.onlyIfIdle) {
              await transition("failed", { reason: "idle-retirement-deferred" });
              return { blocked: false, terminated: false };
            }
            return { blocked: true, terminated: false };
          }
          if (!effect.onlyIfIdle && !await transition("delivering")) {
            return { blocked: false, terminated: true };
          }
          await transition("delivered");
          return { blocked: false, terminated: true };
        } catch (error) {
          await transition("queued", { reason: failureReason(error) });
          throw error;
        }
      }
      if (!effect.onlyIfIdle && !await transition("delivering")) {
        return { blocked: false, terminated: false };
      }
      try {
        if (!await this.terminateHost(effect.conversationId, effect.sessionKey, effect.onlyIfIdle, authority, effect.providerRecovery)) {
          await transition("failed", { reason: "structured host termination is unavailable" });
          return { blocked: false, terminated: false };
        }
        await transition("delivered");
        return { blocked: false, terminated: true };
      } catch (error) {
        await transition("queued", { reason: failureReason(error) });
        throw error;
      }
    }
    const host = this.resolveHost(effect.conversationId);
    if (!host) {
      /* Holding the control was right while a host might still come back to
         answer it, and wrong once nothing can: the effect stays pending, the
         group never drains, and every message queued behind it waits on a turn
         no process is running (#1281). Evidence of a severed turn settles it
         instead — an interrupt has nothing left to interrupt, and an attention
         nothing left to answer. Evidence is also all it is: `unknown` and a
         read that could not be made both leave the control held, which is what
         this queue does with every other unreadable fence (#1131). */
      const severed = await this.readSeveredHostReason(effect.conversationId);
      if (!severed.readable) {
        this.retrySoon();
        return { blocked: true, terminated: false };
      }
      if (!severed.value) return { blocked: true, terminated: false };
      await this.transitionUnlessSettled(
        effect.operationId,
        effect.kind === "interrupt" ? "interrupted" : "failed",
        { reason: `structured host is severed: ${severed.value}`.slice(0, 240) },
      );
      return { blocked: false, terminated: false };
    }
    /* An answer and an interrupt are engine writes like a message, so the same
       rule holds one step earlier: a state that could not be read authorises
       neither the control nor the `dead-host` requeue that would reissue it. */
    const state = await this.readHealth(host);
    if (!state.readable) {
      this.retrySoon();
      return { blocked: true, terminated: false };
    }
    const health = state.value;
    if (health.status === "dead" || health.status === "unhosted") {
      await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" });
      return { blocked: true, terminated: false };
    }
    if (!await this.transitionUnlessSettled(effect.operationId, "delivering", {
      ...(effect.kind === "interrupt" ? { turnId: effect.turnId ?? health.activeTurnRef } : {}),
    })) return { blocked: false, terminated: false };
    try {
      if (effect.kind === "answer") {
        await host.answer(effect.attentionId!, effect.resolution);
        await this.transitionUnlessSettled(effect.operationId, "answered");
      } else {
        const turnId = effect.turnId ?? health.activeTurnRef;
        if (!turnId || (health.activeTurnRef && health.activeTurnRef !== turnId)) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "stale-turn" });
          return { blocked: false, terminated: false };
        }
        await host.interrupt(turnId);
        await this.transitionUnlessSettled(effect.operationId, "interrupted", { turnId });
      }
      return { blocked: false, terminated: false };
    } catch (error) {
      const reason = failureReason(error);
      /* The control was issued and threw. `queued` here says it never reached
         the engine and hands it to a later pass to issue AGAIN, which is only
         honest where the host is read to be gone — a departed host answered
         nothing and kept nothing. An unreadable state is not that proof, and
         converting it into one let an answer or an interrupt be delivered a
         second time to a host that was alive the whole time. It settles like
         any other control this host refused instead. */
      const afterFailure = await this.readHealth(host);
      if (afterFailure.readable
        && (afterFailure.value.status === "dead" || afterFailure.value.status === "unhosted")) {
        await this.transitionUnlessSettled(effect.operationId, "queued", { reason });
        return { blocked: true, terminated: false };
      }
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason });
      return { blocked: false, terminated: false };
    }
  }
}
