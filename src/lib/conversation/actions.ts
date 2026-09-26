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

/* `permission` answers a structured host's pending tool permission request
   (#2215). `dialog-key` stays the terminal-dialog control: a structured host
   has no terminal to press a key in, so it keeps refusing it. */
export const CONVERSATION_ACTIONS = ["interrupt", "kill", "resume", "compact", "dialog-key", "permission"] as const;
export type ConversationAction = typeof CONVERSATION_ACTIONS[number];

export type ConversationActionRequest = {
  operationId?: string;
  conversationId: string;
  transcriptPath: string;
  action: string;
  key?: string;
  label?: unknown;
  question?: unknown;
  /** `permission` only: allow once or deny. */
  decision?: string;
  /** `permission` only: the request to answer; the oldest pending one when absent. */
  requestId?: string;
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

  if (dependencies.structuredEnabled()) {
    const structured = await dependencies.dispatchStructuredControl({
      path: transcriptPath,
      conversationId: conversation?.id ?? request.conversationId,
      action: request.action,
      operationId: request.operationId,
      ...(request.action === "permission" ? { decision: request.decision, requestId: request.requestId } : {}),
    });
    if (structured) return structured;
  }
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
