import type { RuntimeHostClient } from "./client";
import type { RuntimeReceiptStatus, RuntimeSession } from "./contracts";
import type { SessionKey } from "@/lib/agent/sessionKey";

export const TERMINAL_SPAWN_RECEIPTS = new Set(["completed", "failed", "conflicted"]);
export const OPEN_SPAWN_RECEIPTS = ["starting", "path-pending", "pane-bound", "host-verified", "prompt-delivered"];
export const OPEN_RETIREMENT_DELIVERIES = ["held", "assigned", "delivery-uncertain"];

export type RetirementOperationRead = Pick<RuntimeHostClient, "operationStatus">["operationStatus"];
type JournalStatus = RuntimeReceiptStatus | "absent";
export type RetirementJournalEvidence =
  | { settled: true; operation: JournalStatus; firstMessage: JournalStatus }
  | { settled: false; reason: string };

// Uncertain delivery and retry/redirect chains retain custody. A settled
// receipt proves delivery settlement, while the retirement predicate
// independently checks that the turn and every other obligation have ended.
const SETTLED = new Set<RuntimeReceiptStatus>(["delivered", "applied", "rejected", "failed",
  "turn-started", "steered", "interrupted", "answered"]);

export function idleRetirementSession(session: RuntimeSession, conversationId: string, key: SessionKey, artifactPath: string): boolean {
  const idle = session.host === "hosted" && session.turn === "idle";
  const released = (session.host === "dead" || session.host === "unhosted")
    && session.turn === "unknown" && session.writerClaim === null;
  return session.conversationId === conversationId && session.sessionKey.engine === key.engine
    && session.sessionKey.sessionId === key.sessionId && session.artifactPath === artifactPath
    && (idle || released) && session.activeTurnId === null && session.attentionIds.length === 0
    && session.retirementBlocked === false && session.nativeTurnClaims?.length === 0 && !session.pendingReconfigure;
}

export async function retirementJournalEvidence(
  read: RetirementOperationRead,
  operationId: string,
  conversationId: string,
  stillCurrent: () => boolean,
): Promise<RetirementJournalEvidence> {
  const inspect = async (id: string, firstMessage: boolean): Promise<{ status: JournalStatus } | { reason: string }> => {
    if (!stillCurrent()) return { reason: "operation custody changed" };
    const result = await read(id, { timeoutMs: 500, currentRetryLeaf: true });
    if (!stillCurrent()) return { reason: "operation custody changed" };
    if (result === null) return { status: "absent" };
    const { receipt } = result;
    if (result.operationId !== id || receipt.operationId !== id || receipt.conversationId !== conversationId
      || receipt.redirectedTo || (firstMessage ? receipt.kind !== "send" : !["spawn", "reconfigure"].includes(receipt.kind))) {
      return { reason: "operation identity or retry custody is unresolved" };
    }
    if (!SETTLED.has(receipt.status)) return { reason: `operation ${receipt.kind} journal status is ${receipt.status}` };
    return { status: receipt.status };
  };
  try {
    const operation = await inspect(operationId, false);
    if ("reason" in operation) return { settled: false, reason: operation.reason };
    const firstMessage = await inspect(`spawn_message_${operationId}`, true);
    if ("reason" in firstMessage) return { settled: false, reason: firstMessage.reason };
    return { settled: true, operation: operation.status, firstMessage: firstMessage.status };
  } catch {
    return { settled: false, reason: "journal work or custody could not be verified" };
  }
}
