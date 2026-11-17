import type { AgentRegistry } from "@/lib/agent/registry";

type Collection = "heldDeliveries" | "conversations" | "pendingSuccessorCleanups" | "migrationIntents";
interface Cursor {
  source: string;
  after: Record<Collection | "repairs", string>;
  intents: Set<string>;
  repair: Promise<void> | null;
  repairIds: Set<`conversation_${string}`>;
}
const owner = process as typeof process & { __llvMigrationCursors?: WeakMap<AgentRegistry, Cursor> };
const cursors = owner.__llvMigrationCursors ??= new WeakMap<AgentRegistry, Cursor>();

/** One small cursor per registry owner. A replaced store starts at its head.
 * Restart replays bounded discovery; durable original-key ownership, lanes
 * and idempotent repair markers decide what may act. No payload is cached. */
export function reconciliationCursor(registry: AgentRegistry): Cursor {
  let revision: string;
  try { revision = registry.livenessRevision(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    revision = "empty"; // A new JSON-backed registry has not written a file yet.
  }
  const source = revision.startsWith("sqlite:") ? revision.replace(/:\d+:\d+$/, "") : revision.split(":").slice(0, 3).join(":");
  let cursor = cursors.get(registry);
  if (!cursor || cursor.source !== source) {
    cursor = { source, after: { heldDeliveries: "", conversations: "", pendingSuccessorCleanups: "", migrationIntents: "", repairs: "" }, intents: new Set(), repair: null, repairIds: new Set() };
    cursors.set(registry, cursor);
  }
  return cursor;
}
