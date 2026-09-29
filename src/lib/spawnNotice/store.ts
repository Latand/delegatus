import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";

/**
 * `spawn_notices` (docs/design/spawn-completion-notice.md §2, §3): one
 * obligation row per settled turn of a spawned child, written by the runtime
 * host's orchestration consumer and settled by the Viewer's notice sweep, and
 * one row per child holding when its last notice went out, which is what the
 * 30-second coalescing reads.
 *
 * The turn row is inserted only when absent, so a replayed `turn-ended` event
 * finds its row and changes nothing. Only a pending row is controller-active,
 * so the sweep's read is the open obligations and never the history.
 */

export type SpawnNoticeOutcome = "completed" | "interrupted" | "error";

export type SpawnNoticeSkip =
  /** The launcher is unknown to the registry or was superseded. */
  | "launcher-gone"
  /** The launcher is archived on its project's board. */
  | "launcher-closed"
  /** The launcher was a seat since retired, and its project holds none now. */
  | "no-seat"
  /** The recipient resolved to the child itself. */
  | "self";

export interface SpawnNoticeTurn {
  kind: "turn";
  childConversationId: string;
  turnId: string;
  launcherConversationId: string;
  outcome: SpawnNoticeOutcome;
  /** When the turn began, when the runtime can say; null otherwise. */
  startedAt: string | null;
  endedAt: string;
  state: "pending" | "sent" | "skipped" | "failed";
  /** Why a row was skipped or failed. */
  reason: string | null;
  /** Who the notice covering this turn went to (a retired seat's successor
      differs from the launcher). */
  recipientConversationId: string | null;
  clientMessageId: string | null;
  operationId: string | null;
  settledAt: string | null;
}

/** A notice handed to the delivery layer and not yet known to have arrived.
    Kept whole, so a retry after a restart or an uncertain answer sends the
    same text under the same key and the delivery layer answers it from its
    record instead of sending it twice. */
export interface SpawnNoticeAttempt {
  clientMessageId: string;
  recipientConversationId: string;
  recipientPath: string;
  text: string;
  turnIds: string[];
  attempts: number;
  firstAttemptAt: string;
}

export interface SpawnNoticeChild {
  kind: "child";
  childConversationId: string;
  lastSentAt: string | null;
  attempt: SpawnNoticeAttempt | null;
}

export type SpawnNoticeRecord = SpawnNoticeTurn | SpawnNoticeChild;

const COLLECTION = "spawn_notices";
export const spawnNoticeTurnKey = (child: string, turnId: string) => `t:${child}:${turnId}`;
const childKey = (child: string) => `c:${child}`;
const recordKey = (row: SpawnNoticeRecord) => row.kind === "turn"
  ? spawnNoticeTurnKey(row.childConversationId, row.turnId)
  : childKey(row.childConversationId);
const controllerActive = (row: SpawnNoticeRecord) => row.kind === "turn" && row.state === "pending";
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "spawn-completion-notice-v1", key: recordKey, controllerActive, loadRecords: (): SpawnNoticeRecord[] => [] };
const cache = new Map<string, SqliteStateCollection<SpawnNoticeRecord>>();

function decode(value: unknown): SpawnNoticeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SpawnNoticeTurn> & Partial<SpawnNoticeChild>;
  if (typeof row.childConversationId !== "string") return null;
  if (row.kind === "child") {
    return { kind: "child", childConversationId: row.childConversationId,
      lastSentAt: typeof row.lastSentAt === "string" ? row.lastSentAt : null,
      attempt: row.attempt && typeof row.attempt === "object" && typeof row.attempt.clientMessageId === "string" ? row.attempt : null };
  }
  return row.kind === "turn" && typeof row.turnId === "string" && typeof row.launcherConversationId === "string"
    && typeof row.state === "string" && typeof row.endedAt === "string"
    ? row as SpawnNoticeTurn
    : null;
}

function collection(create: boolean): SqliteStateCollection<SpawnNoticeRecord> | null {
  const file = statePath("state.sqlite");
  const held = cache.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<SpawnNoticeRecord>(file, {
    collection: COLLECTION, schemaVersion: 1, busyMessage: "spawn notices busy", key: recordKey,
    decode, clone: structuredClone, strictDecode: true, controllerActive,
  });
  cache.set(file, opened);
  return opened;
}

export interface SpawnNoticeObligation {
  childConversationId: string;
  turnId: string;
  launcherConversationId: string;
  outcome: SpawnNoticeOutcome;
  startedAt: string | null;
  endedAt: string;
}

/** Record that this child turn is owed a notice. True when the row is new;
    a replay of the same turn finds its row and writes nothing. */
export function recordSpawnNoticeObligation(obligation: SpawnNoticeObligation): boolean {
  return collection(true)!.boundedPatch(2, (tx) => {
    const key = spawnNoticeTurnKey(obligation.childConversationId, obligation.turnId);
    if (tx.get(key)) return false;
    tx.put({
      kind: "turn",
      ...obligation,
      state: "pending",
      reason: null,
      recipientConversationId: null,
      clientMessageId: null,
      operationId: null,
      settledAt: null,
    });
    return true;
  });
}

/** Every turn still owed a notice. */
export function pendingSpawnNotices(): SpawnNoticeTurn[] {
  return (collection(false)?.snapshotForController() ?? [])
    .filter((row): row is SpawnNoticeTurn => row.kind === "turn" && row.state === "pending");
}

export function readSpawnNoticeTurn(child: string, turnId: string): SpawnNoticeTurn | null {
  const row = collection(false)?.get(spawnNoticeTurnKey(child, turnId)) ?? null;
  return row?.kind === "turn" ? row : null;
}

/** When this child's last notice went out, and the notice in flight. */
export function readSpawnNoticeChild(child: string): SpawnNoticeChild | null {
  const row = collection(false)?.get(childKey(child)) ?? null;
  return row?.kind === "child" ? row : null;
}

/** Record the notice about to be handed to the delivery layer, before it is. */
export function recordSpawnNoticeAttempt(child: string, attempt: SpawnNoticeAttempt): void {
  collection(true)!.boundedPatch(2, (tx) => {
    const held = tx.get(childKey(child));
    tx.put({ kind: "child", childConversationId: child, lastSentAt: held?.kind === "child" ? held.lastSentAt : null, attempt });
  });
}

export type SpawnNoticeSettlement =
  | { state: "sent"; recipientConversationId: string; clientMessageId: string; operationId: string | null }
  | { state: "skipped"; reason: SpawnNoticeSkip }
  | { state: "failed"; reason: string; recipientConversationId: string | null; clientMessageId: string | null };

/** Settle the named pending turns of one child together and clear the notice
    in flight; on a send, stamp the child's last notice time. A row already
    settled is left as it is. */
export function settleSpawnNotices(child: string, turnIds: readonly string[], settlement: SpawnNoticeSettlement, at: string): void {
  collection(true)!.boundedPatch(turnIds.length * 2 + 2, (tx) => {
    for (const turnId of turnIds) {
      const held = tx.get(spawnNoticeTurnKey(child, turnId));
      if (!held || held.kind !== "turn" || held.state !== "pending") continue;
      tx.put({
        ...held,
        state: settlement.state,
        reason: settlement.state === "sent" ? null : settlement.reason,
        recipientConversationId: settlement.state === "skipped" ? null : settlement.recipientConversationId,
        clientMessageId: settlement.state === "skipped" ? null : settlement.clientMessageId,
        operationId: settlement.state === "sent" ? settlement.operationId : null,
        settledAt: at,
      });
    }
    const held = tx.get(childKey(child));
    const lastSentAt = settlement.state === "sent" ? at : held?.kind === "child" ? held.lastSentAt : null;
    if (held || lastSentAt) tx.put({ kind: "child", childConversationId: child, lastSentAt, attempt: null });
  });
}

/** Delete settled turn rows settled before `before`, at most `limit` per call,
    reading one bounded key page at a time. Pending rows are never touched. */
export function pruneSpawnNotices(before: string, limit = 256): number {
  const store = collection(false);
  if (!store) return 0;
  const stale: string[] = [];
  let after = "t:";
  while (stale.length < limit) {
    const page = store.keyRange(after, "t:\uffff", 256);
    for (const row of page) {
      if (row.kind === "turn" && row.state !== "pending" && row.settledAt !== null && row.settledAt < before) {
        stale.push(spawnNoticeTurnKey(row.childConversationId, row.turnId));
      }
    }
    if (page.length < 256) break;
    after = recordKey(page.at(-1)!);
  }
  const doomed = stale.slice(0, limit);
  if (doomed.length === 0) return 0;
  store.boundedPatch(doomed.length * 2, (tx) => {
    for (const key of doomed) {
      const held = tx.get(key);
      if (held?.kind === "turn" && held.state !== "pending") tx.delete(key);
    }
  });
  return doomed.length;
}
