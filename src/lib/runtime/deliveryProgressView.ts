import { deliveryProgressStore, readDeliveryProgress, type DeliveryProgressRecord } from "./deliveryProgress";

const RECENT_TERMINAL_MS = 30 * 60_000;
const RECORD_LIMIT = 64;

export interface DeliveryProgressView {
  serverTime: string;
  records: DeliveryProgressRecord[];
}

/**
 * The records the composer and the receipt tools read: every record of the
 * named conversations held by this Viewer, and the named operations wherever
 * they are recorded. A record carries ids, codes and times only.
 */
export function deliveryProgressView(query: { conversationIds?: readonly string[]; operationIds?: readonly string[] }): DeliveryProgressView {
  const records = new Map<string, DeliveryProgressRecord>();
  try {
    if (query.conversationIds?.length) {
      for (const record of deliveryProgressStore().forConversation(query.conversationIds)) records.set(record.operationId, record);
    }
    if (query.operationIds?.length) {
      for (const [operationId, record] of readDeliveryProgress(query.operationIds)) records.set(operationId, record);
    }
  } catch (error) {
    console.error("[delivery progress] read failed", { error: error instanceof Error ? error.message : String(error) });
  }
  /* Open records, and settled ones recent enough to explain an answer the
     operator is still looking at. */
  const recentSince = Date.now() - RECENT_TERMINAL_MS;
  const shown = [...records.values()]
    .filter((record) => !record.terminal || Date.parse(record.terminal.at) >= recentSince
      || query.operationIds?.includes(record.operationId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECORD_LIMIT);
  return { serverTime: new Date().toISOString(), records: shown };
}
