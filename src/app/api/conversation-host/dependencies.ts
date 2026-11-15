import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { agentRegistry } from "@/lib/agent/registry";
import { applyConversationAction, CONVERSATION_ACTIONS } from "@/lib/conversation/actions";
import { deliverConversationMessage } from "@/lib/delivery";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import { admitRuntimeImagePayload as collectImagePayloads } from "@/lib/runtime/runtimeImageAdmission";
import type { PriorSubmission } from "@/lib/team";

export interface ConversationHostDependencies {
  applyConversationAction: typeof applyConversationAction;
  conversationActions: readonly string[];
  deliverConversationMessage: typeof deliverConversationMessage;
  completedFileScan: typeof completedFileScan;
  dispatchStructuredControl: typeof dispatchStructuredControl;
  enqueueStructuredMessage: typeof import("@/lib/runtime/structuredMessageDelivery").enqueueStructuredMessage;
  collectImagePayloads: typeof collectImagePayloads;

  /** The activity dashboard's request ledger; never throws. */
  recordOperatorRequest: typeof recordOperatorRequest;
  /** What the delivery record knows about a submission id before a send
      (sign-in-and-team §7.1); `admitted` when it cannot say. */
  priorSubmission(conversationId: string, clientMessageId: string): PriorSubmission;
}

const productionDependencies: ConversationHostDependencies = {
  applyConversationAction,
  conversationActions: CONVERSATION_ACTIONS,
  deliverConversationMessage,
  completedFileScan,
  dispatchStructuredControl,
  enqueueStructuredMessage: async (...args) => {
    const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
    return enqueueStructuredMessage(...args);
  },
  collectImagePayloads,

  recordOperatorRequest,
  priorSubmission: (conversationId, clientMessageId) => {
    try {
      return agentRegistry().deliveryAdmissionForKey(conversationId, clientMessageId).outcome;
    } catch {
      return "admitted";
    }
  },
};

let testDependencies: Partial<ConversationHostDependencies> | null = null;

export function conversationHostDependencies(): ConversationHostDependencies {
  return testDependencies === null
    ? productionDependencies
    : { ...productionDependencies, ...testDependencies };
}

export function setConversationHostDependenciesForTests(
  dependencies: Partial<ConversationHostDependencies> | null,
): void {
  testDependencies = dependencies;
}
