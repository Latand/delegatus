import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { BRANCH_SHARED_HOST_CODE, BRANCH_SHARED_HOST_ERROR, branchSharesRootHost } from "@/lib/conversation/branchControl";
import {
  answerDialogKey,
  compactConversation,
  interruptConversation,
  killConversation,
  resumeConversation,
  type DeliveryOutcome,
} from "@/lib/delivery";
import { DEPUTY_CONVERSATION_CLOSED, deputyDeliveryRefusal } from "@/lib/orchestrator/deputies";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import type { PendingQuestion } from "@/lib/types";

import { nativeAnswerResolution, type NativeAnswerInput } from "./nativeAnswer";

/* `permission` answers a structured host's pending tool permission request
   (#2215), and `answer` its pending native question or plan, named by the
   request id the board shows (docs/design/attention-auto-resolve.md).
   `dialog-key` stays the terminal-dialog control: a structured host has no
   terminal to press a key in, so it keeps refusing it. */
export const CONVERSATION_ACTIONS = ["interrupt", "kill", "resume", "compact", "dialog-key", "permission", "answer"] as const;
export type ConversationAction = typeof CONVERSATION_ACTIONS[number];

export type ConversationActionRequest = {
  actor?: import("@/lib/accounts/accountOverrides").AccountChoiceActor;
  controlOrigin?: import("@/lib/runtime/messageOrigin").MessageOrigin;
  operationId?: string;
  onlyIfIdle?: import("@/lib/runtime/contracts").RuntimeIdleKillFence;
  providerRecovery?: import("@/lib/runtime/contracts").RuntimeProviderRecoveryRef;
  conversationId: string;
  transcriptPath: string;
  action: string;
  key?: string;
  label?: unknown;
  question?: unknown;
  /** `permission` only: allow once or deny. */
  decision?: string;
  /** `permission`: the request to answer; the oldest pending one when absent.
      `answer`: the pending question or plan's id, required. */
  requestId?: string;
  /** `answer` only: the chosen options, a free answer, or a plan's approval. */
  answer?: NativeAnswerInput;
};

type ConversationActionBody =
  | Exclude<DeliveryOutcome, { ok: false }>
  | Omit<Extract<DeliveryOutcome, { ok: false }>, "status">
  | { ok: true; structured: true; target: string; outcome: "delivered" | "resumed"; spawned?: boolean }
  | { ok: true; structured: true; target: string; outcome: "withdrawn"; withdrawn: string | null }
  | { ok: true; structured: true; target: string; operationId: string; receipt: { operationId: string; status: string } }
  | { ok: false; outcome: "failed"; code: typeof BRANCH_SHARED_HOST_CODE; error: string }
  | { ok: false; outcome: "failed"; code: typeof DEPUTY_CONVERSATION_CLOSED; error: string; seatConversationId: string }
  | { error: string };

export type ConversationActionResult = { status: number; body: ConversationActionBody };

export interface ConversationActionDependencies {
  registry(): AgentRegistry;
  structuredEnabled(): boolean;
  dispatchStructuredControl: typeof dispatchStructuredControl;
  interruptConversation: typeof interruptConversation;
  killConversation: typeof killConversation;
  resumeConversation: typeof resumeConversation;
  compactConversation: typeof compactConversation;
  answerDialogKey: typeof answerDialogKey;
  /** The conversation's current native question or plan, read from its
      transcript, or null when none is pending. */
  pendingQuestion?(transcriptPath: string): Promise<PendingQuestion | null>;
}

async function currentPendingQuestion(transcriptPath: string): Promise<PendingQuestion | null> {
  const [{ listFiles }, { pendingQuestionFor }] = await Promise.all([import("@/lib/scanner"), import("@/lib/scanner/questions")]);
  const entry = (await listFiles()).find((item) => item.path === transcriptPath);
  return entry ? pendingQuestionFor(entry) : null;
}

const productionDependencies: ConversationActionDependencies = {
  registry: agentRegistry,
  structuredEnabled: () => structuredHostsEnabled(),
  dispatchStructuredControl,
  interruptConversation,
  killConversation,
  resumeConversation,
  compactConversation,
  answerDialogKey,
  pendingQuestion: currentPendingQuestion,
};

function failure(error: string, status: number): ConversationActionResult {
  return { status, body: { error } };
}

function deliveryResult(outcome: DeliveryOutcome): ConversationActionResult {
  if (outcome.ok) return { status: 200, body: outcome };
  const { status, ...body } = outcome;
  return { status, body };
}

export async function applyConversationAction(
  request: ConversationActionRequest,
  dependencies: ConversationActionDependencies = productionDependencies,
): Promise<ConversationActionResult> {
  if (request.providerRecovery && (request.action !== "kill" || !request.onlyIfIdle)) {
    return failure("provider recovery requires an idle-only kill", 400);
  }
  if (!(CONVERSATION_ACTIONS as readonly string[]).includes(request.action)) {
    return failure("unsupported conversation action", 400);
  }
  if (request.conversationId && !request.conversationId.startsWith("conversation_")) {
    return failure("invalid conversation id", 400);
  }
  const registry = dependencies.registry();
  const byId = request.conversationId
    ? registry.conversation(request.conversationId as `conversation_${string}`)
    : null;
  const byPath = request.transcriptPath ? registry.conversationForPath(request.transcriptPath) : null;
  if (request.conversationId && !byId) return failure("viewer conversation is unknown", 404);
  if (byId && request.transcriptPath) {
    const knownPaths = new Set([
      ...byId.generations.map((generation) => generation.path),
      ...byId.continuityPaths,
    ]);
    if (!knownPaths.has(request.transcriptPath) || byPath?.id !== byId.id) {
      return failure("conversation identity does not own transcript path", 409);
    }
  }
  const conversation = byId ?? byPath;
  const transcriptPath = conversation?.generations.at(-1)?.path ?? request.transcriptPath;

  /* A resume or a compaction starts a turn, and a seat's deputy has had its
     one (docs/design/ghost-seat.md §4). Interrupt, kill and answers stay. */
  if (request.action === "resume" || request.action === "compact") {
    const refusal = deputyDeliveryRefusal({ conversationId: conversation?.id ?? request.conversationId, path: transcriptPath });
    if (refusal) {
      return {
        status: refusal.status,
        body: { ok: false, outcome: "failed", code: refusal.code, error: refusal.error, seatConversationId: refusal.seatConversationId },
      };
    }
  }

  if (request.action === "kill" && branchSharesRootHost(registry, conversation)) {
    return {
      status: 409,
      body: {
        ok: false,
        outcome: "failed",
        code: BRANCH_SHARED_HOST_CODE,
        error: BRANCH_SHARED_HOST_ERROR,
      },
    };
  }

  if (request.action === "answer") return await answerNativeQuestion(request, conversation?.id ?? request.conversationId, transcriptPath, dependencies);

  if (dependencies.structuredEnabled()) {
    const structured = await dependencies.dispatchStructuredControl({
      path: transcriptPath,
      conversationId: conversation?.id ?? request.conversationId,
      action: request.action,
      operationId: request.operationId,
      ...(request.actor ? { actor: request.actor } : {}),
      ...(request.controlOrigin ? { controlOrigin: request.controlOrigin } : {}),
      ...(request.action === "kill" && request.onlyIfIdle ? { onlyIfIdle: request.onlyIfIdle } : {}),
      ...(request.action === "kill" && request.providerRecovery ? { providerRecovery: request.providerRecovery } : {}),
      ...(request.action === "permission" ? { decision: request.decision, requestId: request.requestId } : {}),
    });
    if (structured) return structured;
  }
  if (request.onlyIfIdle) return failure("automatic retirement requires the structured control channel", 409);
  if (!transcriptPath) return failure("conversationId or transcriptPath is required", 400);
  if (request.action === "permission") {
    return failure("no structured host holds this conversation; a terminal-hosted permission prompt is answered with dialog-key", 409);
  }

  if (request.action === "interrupt") return deliveryResult(await dependencies.interruptConversation(transcriptPath));
  if (request.action === "kill") {
    const outcome = await dependencies.killConversation(transcriptPath);
    if (outcome.ok && !outcome.target) {
      return deliveryResult({ ok: false, outcome: "failed", error: "kill resolved no registered pane", status: 409 });
    }
    return deliveryResult(outcome);
  }
  if (request.action === "resume") return deliveryResult(await dependencies.resumeConversation(transcriptPath));
  if (request.action === "compact") return deliveryResult(await dependencies.compactConversation(transcriptPath));
  return deliveryResult(await dependencies.answerDialogKey(
    transcriptPath,
    request.key ?? "",
    request.label,
    request.question,
  ));
}

/**
 * Answers the conversation's pending native question or plan, named by its
 * id: the seat answers a worker's question this way, on the exact request its
 * wake showed it (docs/design/attention-auto-resolve.md, acceptance 3). A
 * question that changed or was answered meanwhile is refused, so an answer
 * never lands on a request the caller did not read.
 */
async function answerNativeQuestion(
  request: ConversationActionRequest,
  conversationId: string,
  transcriptPath: string | undefined,
  dependencies: ConversationActionDependencies,
): Promise<ConversationActionResult> {
  const requestId = request.requestId?.trim();
  if (!requestId) return failure("answer names the question it answers: pass requestId, the reason id the wake or the read showed", 400);
  if (!transcriptPath) return failure("conversationId or transcriptPath is required", 400);
  const pending = await (dependencies.pendingQuestion ?? currentPendingQuestion)(transcriptPath);
  if (!pending || pending.toolUseId !== requestId) {
    return failure("that question is not pending on this conversation; it was answered, withdrawn or replaced by a newer one", 409);
  }
  const answer = nativeAnswerResolution(pending, request.answer ?? {});
  if ("error" in answer) return failure(answer.error, 400);
  const structured = dependencies.structuredEnabled()
    ? await dependencies.dispatchStructuredControl({
        path: transcriptPath,
        conversationId,
        action: "answer",
        operationId: request.operationId,
        requestId,
        resolution: answer.resolution,
        ...(request.actor ? { actor: request.actor } : {}),
      })
    : null;
  if (!structured) {
    return failure("no structured host holds this conversation; a terminal-hosted question is answered with dialog-key", 409);
  }
  return structured;
}
