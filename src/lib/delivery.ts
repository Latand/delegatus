import { orchestratorRecipientRefusal, orchestratorRecipientRefusalAsync } from "@/lib/orchestrator/seats";
import { DeliveryAdmissionRefusedError, type DeliveryAdmissionGuard } from "@/lib/deliveryAdmission";
import type { AgentEngine } from "@/lib/agent/cli";
import { agentRegistry, conversationIdsResolvingTo, resolveConversationAlias, REGISTRY_WRITER_BUSY, type AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import type { AccountOverrideNotice } from "@/lib/accounts/accountOverrides";
import { admitTranscriptConversationOffLoop } from "@/lib/conversation/transcriptAdmission";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import { transcriptLiveOwnership, type TranscriptLiveOwnership } from "@/lib/scanner/transcripts";
import { recoverDeadStructuredConversation, StructuredResumeUnpublishedError } from "@/lib/runtime/structuredRecovery";
import type { MessageOrigin } from "@/lib/runtime/messageOrigin";
import type { ActuationLease } from "@/lib/deliveryActuation";
import { ownedDeliveryProgressStore } from "@/lib/runtime/deliveryProgress";
import type { DeliveryProgressPort } from "@/lib/runtime/recordWait";
import type { SendResendGuidance } from "@/lib/runtime/sendSettlement";
import type { RuntimeOperationReceipt } from "@/lib/runtime/contracts";
import type { RuntimeImageUpload } from "@/lib/runtime/runtimeImageStore";
import type { FileEntry } from "@/lib/types";

/**
 * Conversation-level sends and resumes. Both resolve or recover the
 * conversation's structured host; a conversation with no host that recovery
 * can raise is refused. The route maps HTTP to these calls.
 */

export interface DeliveryFailure {
  code?: string;
  ok: false;
  outcome: "failed";
  error: string;
  status: number;
  actuation?: "started";
  /** #1131: the accepted send this refusal is about, so a caller holding it can
      ask `message_receipt` what became of it. */
  operationId?: string;
  /** #1131: set when the refusal is ABSORBING — an earlier attempt under this
      same request began actuating and nothing can say whether it arrived, so
      the instruction must be verified rather than repeated. */
  resend?: SendResendGuidance;
  /** Set on a superseded-round rejection (issue #383): the live chain end the
      caller should redirect to instead of forking retired work. */
  successorConversationId?: string;
  /** Set when the refusal came before anything was reserved or dispatched,
      so the send provably did not happen (#2020). */
  admission?: "refused";
}

async function recipientSeatRefusal(registry: AgentRegistry, conversation: Pick<RegistryConversation, "id"> | null) {
  if (!conversation) return null;
  const snapshot = registry.conversationDeliverySnapshot({ conversationId: conversation.id });
  return orchestratorRecipientRefusalAsync(conversationIdsResolvingTo(snapshot, conversation.id),
    id => resolveConversationAlias(snapshot, id as `conversation_${string}`));
}

function seatRefusalSync(conversation: Pick<RegistryConversation, "id"> | null) {
  if (!conversation) return null;
  // This guard runs inside registry admission's synchronous transaction. The
  // identity is already resolved at the async boundary; reading a registry
  // snapshot here can wait on the writer whose transaction is calling us.
  return orchestratorRecipientRefusal([conversation.id]);
}

function seatRefusalFailure(refusal: NonNullable<Awaited<ReturnType<typeof recipientSeatRefusal>>>): DeliveryFailure {
  return { ok: false, outcome: "failed", admission: "refused", ...refusal };
}

/** A send or resume addressed to a terminally superseded round (issue #383)
    must never implicitly fork it through recovery — it answers with a
    redirectable pointer to the live chain end instead. Explicit "resume here"
    clears the edge first and never reaches this guard. */

function supersededRejection(
  registry: AgentRegistry,
  conversation: Pick<RegistryConversation, "id" | "supersededBy"> | null,
): DeliveryFailure | null {
  if (!conversation?.supersededBy) return null;
  return {
    ok: false,
    outcome: "failed",
    error: "superseded",
    status: 409,
    successorConversationId: registry.supersedenceChainTail(conversation.id),
    admission: "refused",
  };
}

export interface DeliverySuccess {
  ok: true;
  target: string | null;
  outcome?: "delivered-to-live" | "resumed" | "held" | "pending" | "reconfigured" | "queued" | "delivering" | "delivered";
  imagePaths?: string[];
  /** Set when delivery started a successor host for a finished conversation. */
  spawned?: boolean;
  structured?: true;
  operationId?: string;
  receipt?: RuntimeOperationReceipt;
  /** Set when an account switch named an account outside the project's pool:
      the switch was carried out and attributed, and the answer says so. */
  accountOverride?: AccountOverrideNotice;
}

export type DeliveryOutcome = DeliverySuccess | DeliveryFailure;

export function migrationDeliveryOutcome(outcome: DeliveryOutcome): "delivered" | "failed" | "delivery-uncertain" | "held" {
  if (!outcome.ok) return outcome.actuation === "started" ? "delivery-uncertain" : "failed";
  return outcome.outcome === "held" ? "held" : "delivered";
}

function failure(error: unknown, status = 500, actuation?: "started"): DeliveryFailure {
  if (error instanceof DeliveryAdmissionRefusedError) return { ok: false, outcome: "failed", error: error.message, code: error.code, status: 409, admission: "refused" };
  if (error instanceof StructuredResumeUnpublishedError) return { ok: false, outcome: "failed", error: error.message, code: "structured_revival_impossible", status: 503 };
  return {
    ok: false,
    outcome: "failed",
    error: error instanceof Error ? error.message : String(error),
    status,
    ...(actuation ? { actuation } : {}),
  };
}

interface ResumeConversationOverrides {
  pathAllowed?: typeof pathAllowed;
  listFiles?: typeof listFiles;
  registry?: AgentRegistry;
  recover?: typeof recoverDeadStructuredConversation;
  admit?: (registry: Parameters<typeof admitTranscriptConversationOffLoop>[0], entry: Parameters<typeof admitTranscriptConversationOffLoop>[1], dependencies: Parameters<typeof admitTranscriptConversationOffLoop>[2]) => Awaited<ReturnType<typeof admitTranscriptConversationOffLoop>> | ReturnType<typeof admitTranscriptConversationOffLoop>;
  liveOwnership?: (entry: FileEntry) => TranscriptLiveOwnership | null;
}

/**
 * Reopens a conversation from the viewer, whatever its first host was.
 *
 * A registered conversation reaches its structured host through recovery. A
 * transcript the registry never inventoried — born by typing `claude` in a
 * plain terminal, or aged past the scan's recency cap — is admitted from its
 * own provenance first (issue #935), so birth mode does not decide whether
 * continuation exists. A conversation recovery cannot raise is refused with
 * the condition that failed.
 */
export async function resumeConversation(
  filePath: string,
  overrides: ResumeConversationOverrides = {},
): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) {
    return failure("the conversation path is required to open", 400);
  }
  const registry = overrides.registry ?? agentRegistry();
  const known = registry.conversationForPath(filePath);
  const seatRefusal = await recipientSeatRefusal(registry, known);
  if (seatRefusal) return { ok: false, outcome: "failed", admission: "refused", ...seatRefusal };
  const rejected = supersededRejection(registry, known);
  if (rejected) return rejected;
  const recover = overrides.recover ?? recoverDeadStructuredConversation;
  const bridged = (recovered: NonNullable<Awaited<ReturnType<typeof recover>>>): DeliveryOutcome => ({
    ok: true,
    target: null,
    outcome: recovered.hold ? "held" : "resumed",
    spawned: recovered.spawned,
    structured: true,
  });
  try {
    const recovered = await recover({ path: filePath }, { registry });
    if (recovered) return bridged(recovered);
  } catch (error) {
    return failure(error);
  }
  if (known?.agentRole === "curator") {
    return failure("curator recovery is unavailable until its designated seat is admitted", 409);
  }
  /* Pinned: the resumable transcript may have aged past the scan's recency
     cap — a conversation the operator can still open must stay resumable. */
  const entry = (await (overrides.listFiles ?? listFiles)({ pin: filePath })).find((item) => item.path === filePath);
  if (!entry) return failure("the viewer knows no transcript at this path", 403);
  /* #935: a transcript the registry never inventoried — born by typing
     `claude` in a plain terminal, or aged past the scan's recency cap — holds
     no identity for recovery to own, so continuation used to depend on how
     the first host was born. Admit it from its own provenance and let
     recovery take it. */
  let admissionRefusal: string | null = null;
  if (!known) {
    /* Liveness uses the uncapped destructive-operation probe the delete routes
       use: the scanner's `entry.proc` misses an idle or aged-out terminal
       owner, which is this population exactly. */
    const admitted = await (overrides.admit ?? admitTranscriptConversationOffLoop)(registry, entry, {
      liveOwnership: overrides.liveOwnership ?? transcriptLiveOwnership,
    });
    if (!admitted.ok && admitted.blocking) return failure(admitted.reason, 409);
    if (!admitted.ok) admissionRefusal = admitted.reason;
    else {
      try {
        const recovered = await recover({ path: filePath, conversationId: admitted.conversationId }, { registry });
        if (recovered) return bridged(recovered);
      } catch (error) {
        return failure(error);
      }
    }
  }
  return { ...failure(admissionRefusal ?? NO_DELIVERY_HOST_REASON, 409), ...(admissionRefusal ? {} : { code: NO_DELIVERY_HOST_CODE }) };
}

export interface ConversationMessage {
  pid: number | null;
  path: string;
  conversationId?: string | null;
  clientMessageId?: string | null;
  reservedDeliveryId?: string | null;
  /** In-process fence checked after waits before a fresh local reservation. */
  admissionGuard?: DeliveryAdmissionGuard;
  /** Recheck autonomous seat authority while its replacement host is publishing. */
  recoveryAuthorityGuard?: () => void;
  text: string;
  images: RuntimeImageUpload[];
  /** Message authorship stamped by the admitting surface (#1117). Rides the
      structured enqueue. */
  origin?: MessageOrigin;
  /** How a structured host treats a turn already running. Absent keeps the
      send default, which interrupts it; `queue` waits until the host is idle,
      and `context-or-queue` adds native context to a supported active host. */
  policy?: "queue" | "context-or-queue" | "steer-or-queue";
}

export interface DeliveryOverrides {
  recover?: typeof recoverDeadStructuredConversation;
  enqueueStructured?: typeof import("@/lib/runtime/structuredMessageDelivery")["enqueueStructuredMessage"];
  /** The actuation section the migration drain holds for this conversation, when it delivers a reservation it claimed. */
  actuationLease?: ActuationLease;
  listFiles?: typeof listFiles;
  /** Where a drained reservation's ending is recorded; the Viewer's own store by default. */
  progress?: DeliveryProgressPort | null;
}

/** The answer a send gets when no structured host holds the conversation and
    recovery could not raise one. */
export const NO_DELIVERY_HOST_REASON = "this conversation has no host to deliver to";
export const NO_DELIVERY_HOST_CODE = "no_delivery_host";

/**
 * The transcript a request addresses when the registry knows no conversation
 * for it (docs/design/delivery-progress-and-drain.md, A9): its path, else the
 * scanner entry of its pid. A pid or path that names no agent transcript
 * (Claude, Codex or Copilot) is refused before anything is reserved or sent.
 */
async function addressedTranscript(
  message: ConversationMessage,
  overrides: DeliveryOverrides,
): Promise<{ entry: AgentTranscript } | { refused: DeliveryFailure } | null> {
  if (message.path) {
    const entry = (await (overrides.listFiles ?? listFiles)({ pin: message.path })).find((item) => item.path === message.path);
    if (!entry) return { refused: failure("file is unknown to the viewer", 403) };
    return agentTranscript(entry) ? { entry } : null;
  }
  if (message.pid === null) return null;
  const entry = (await (overrides.listFiles ?? listFiles)()).find((item) => item.pid === message.pid && item.proc === "running");
  if (!entry) return { refused: failure("process is unknown to the viewer", 403) };
  return agentTranscript(entry) ? { entry } : null;
}

type AgentTranscript = FileEntry & { engine: AgentEngine };

/** A transcript of an engine the registry keeps conversations for. */
function agentTranscript(entry: FileEntry): entry is AgentTranscript {
  return entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot";
}

/**
 * A send resolves or recovers the conversation's structured host and enqueues
 * the message there. A conversation with no such host, and none that recovery
 * can raise, is refused with {@link NO_DELIVERY_HOST_REASON}.
 */
export async function deliverConversationMessage(message: ConversationMessage, overrides: DeliveryOverrides = {}): Promise<DeliveryOutcome> {
  const { images } = message;
  const text = message.text.trim();
  const registry = agentRegistry();
  let conversation = message.conversationId?.startsWith("conversation_")
    ? registry.conversation(message.conversationId as `conversation_${string}`)
    : registry.conversationForPath(message.path);
  /* A9: a request the registry knows no conversation for (a pid only, a
     transcript nothing registered, or a conversation id the registry does not
     hold) resolves the transcript it addresses and registers its conversation
     the way a resume of it would, so recovery below can raise its host. */
  if (!conversation && !message.reservedDeliveryId) {
    const addressed = await addressedTranscript(message, overrides);
    if (addressed && "refused" in addressed) return addressed.refused;
    if (addressed) {
      const { entry } = addressed;
      conversation = registry.conversationForPath(entry.path);
      if (!conversation) {
        const ensured = await registry.deliveryWrite({ label: "conversation.ensure" },
          () => registry.ensureConversation(entry.engine, entry.path, null));
        /* Nothing is reserved yet, and the answer says so: the sender's
           request closes as not executed instead of unknown for ever (#3782). */
        if (!ensured.acquired) return { ...failure(REGISTRY_WRITER_BUSY, 503), admission: "refused" };
        conversation = ensured.value;
      }
    }
    /* A request that addresses nothing the registry can hold a conversation
       for is refused before anything is sent. */
    if (!conversation) return failure(message.conversationId ? "conversation is unknown to the viewer" : "delivery target is unavailable", 404);
  }
  const seatRefusal = await recipientSeatRefusal(registry, conversation);
  if (seatRefusal) return { ok: false, outcome: "failed", admission: "refused", ...seatRefusal };
  const seatAdmissionGuard: DeliveryAdmissionGuard = () => {
    const refusal = seatRefusalSync(conversation);
    if (refusal) throw new DeliveryAdmissionRefusedError(refusal.error);
  };
  const admissionGuard: DeliveryAdmissionGuard = reconciledDeadHost => {
    seatAdmissionGuard();
    message.admissionGuard?.(reconciledDeadHost);
  };
  const recoveryAuthorityGuard = () => {
    seatAdmissionGuard();
    message.recoveryAuthorityGuard?.();
  };
  const rejected = supersededRejection(registry, conversation);
  if (rejected) return rejected;
  if (conversation) {
    try {
      admissionGuard();
      const recovered = await (overrides.recover ?? recoverDeadStructuredConversation)(
        { path: message.path, conversationId: conversation.id, admissionGuard,
          authorityGuard: recoveryAuthorityGuard, origin: message.origin },
        { registry },
      );
      const afterRecoveryRefusal = await recipientSeatRefusal(registry, conversation);
      if (afterRecoveryRefusal) return seatRefusalFailure(afterRecoveryRefusal);
      if (!recovered && conversationAgentRole(registry.readOnlySnapshot(), conversation.id) === "curator") {
        return failure("curator recovery is unavailable until its designated seat is admitted", 409);
      }
      if (recovered) {
        const enqueue = overrides.enqueueStructured
          ?? (await import("@/lib/runtime/structuredMessageDelivery")).enqueueStructuredMessage;
        const structured = await enqueue({
          path: recovered.path,
          conversationId: recovered.conversationId,
          clientMessageId: message.clientMessageId,
          // Our admitted successor changes the receipt and host identity. Seat
          // authority still applies when reserving its original-key message.
          admissionGuard: recovered.admissionGuard ?? (recovered.spawned ? recoveryAuthorityGuard : admissionGuard),
          recoveryAuthorityGuard,
          text,
          hasImages: images.length > 0,
          ...(message.origin ? { origin: message.origin } : {}),
          ...(message.policy ? { policy: message.policy } : {}),
        }, {
          registry: () => registry,
          /* Handed down by the migration drain that holds this conversation's section, never inherited. */
          ...(overrides.actuationLease ? { actuationLease: overrides.actuationLease } : {}),
        });
        if (!structured) return failure("structured delivery ownership is unavailable", 503);
        if (!structured.ok) {
          /* An accepted send keeps its handle on a refusal, and one whose fate
             is unknown says so: the caller can ask what became of it, and
             never reads it as refused before anything was reserved. */
          const uncertain = structured.transportUncertain && structured.operationId;
          return {
            ...failure(structured.error, structured.status, uncertain ? "started" : undefined),
            ...(structured.code ? { code: structured.code } : {}),
            ...(structured.operationId ? { operationId: structured.operationId } : {}),
            ...(uncertain ? { resend: "verify-first" as const } : {}),
          };
        }
        if (structured.outcome === "held") {
          return {
            ok: true,
            target: recovered.spawned ? null : structured.target,
            outcome: "held",
            spawned: recovered.spawned,
            structured: true,
            operationId: structured.operationId,
          };
        }
        return {
          ok: true,
          target: recovered.spawned ? null : structured.target,
          outcome: structured.outcome,
          spawned: recovered.spawned,
          structured: true,
          operationId: structured.operationId,
          receipt: structured.receipt,
        };
      }
    } catch (error) {
      return failure(error);
    }
  }
  /* No structured host holds this conversation and recovery could not raise
     one, so there is nothing to deliver to. Nothing was reserved by this call.
     A reservation the migration drain already claimed keeps its registry
     ending with the drain; its progress record ends here. */
  const drained = message.reservedDeliveryId ? registry.readOnlySnapshot().heldDeliveries[message.reservedDeliveryId] ?? null : null;
  if (drained) {
    const progress = overrides.progress === undefined ? ownedDeliveryProgressStore() : overrides.progress;
    try { progress?.settle?.(drained.command.operationId, "failed", NO_DELIVERY_HOST_REASON); }
    catch { /* A progress record never fails an answer. */ }
    return failure(NO_DELIVERY_HOST_REASON, 409);
  }
  return { ...failure(NO_DELIVERY_HOST_REASON, 409), code: NO_DELIVERY_HOST_CODE, admission: "refused" };
}
