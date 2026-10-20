import type { RuntimeHostClient } from "@/lib/runtime/client";
import { SEND_LOST_REASON } from "@/lib/runtime/sendSettlement";

export const FENCED_MESSAGE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

/** Require the original operation, including when a retry chain exists. Only the journal's
 * absorbing non-execution fence authorizes a fresh first-message identity. */
export async function fencedFirstMessageRetrySafe(
  client: Pick<RuntimeHostClient, "operationStatus"> | null,
  launchId: string,
  conversationId: string,
  eligible: () => boolean,
): Promise<boolean> {
  if (!client || !eligible()) return false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  timer.unref?.();
  try {
    const id = `spawn_message_${launchId}`;
    const operation = await client.operationStatus(id, { signal: abort.signal, currentRetryLeaf: true });
    if (!eligible() || abort.signal.aborted || !operation) return false;
    const receipt = operation.receipt;
    return operation.operationId === id && receipt.operationId === id
      && receipt.conversationId === conversationId && receipt.idempotencyKey === `spawn_${launchId}`
      && !receipt.redirectedTo && !receipt.retryOfOperationId && (receipt.resend === undefined || receipt.resend === "safe")
      && receipt.kind === "send" && receipt.status === "failed" && receipt.reason === SEND_LOST_REASON;
  } catch {
    return false;
  } finally { clearTimeout(timer); }
}
