import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import { PrototypeError, PROTOTYPE_LIMITS } from "./input";
import type { PrototypeReviewRound } from "./types";

/*
 * The seat's own questions (docs/design/operator-decision-forms.md §2.2): a
 * round the project's orchestrator publishes without a task. It is the same
 * PrototypeReviewRound a task holds, with `taskId: null`, kept in one small
 * collection keyed by round id. Media copies share the prototype store's
 * directory; the decision path, its lock and its message are the task's.
 * Seat rounds stay on this installation: the task wire never carries them.
 */

export const SEAT_DECISIONS_COLLECTION = "seat-decisions";
/** Rounds the collection keeps; past it the oldest delivered one leaves first. */
export const SEAT_ROUNDS_LIMIT = PROTOTYPE_LIMITS.storedRounds;

const collections = new Map<string, { identity: string; collection: SqliteStateCollection<PrototypeReviewRound> }>();

function identity(filename: string): string {
  try {
    const stat = fs.statSync(filename);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "absent";
  }
}

function decode(value: unknown): PrototypeReviewRound | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const round = value as Partial<PrototypeReviewRound>;
  if (typeof round.id !== "string" || !/^pr_[a-f0-9]{32}$/.test(round.id) || round.taskId !== null
    || typeof round.project !== "string" || typeof round.title !== "string" || typeof round.createdAt !== "string"
    || !Array.isArray(round.variants) || !round.source || typeof round.publicationKey !== "string") return null;
  return round as PrototypeReviewRound;
}

const SEED: StateCollectionSeed<unknown> = {
  collection: SEAT_DECISIONS_COLLECTION,
  schemaVersion: 1,
  migrationId: "seat-decisions-v1",
  key: (raw) => (raw as PrototypeReviewRound).id,
  loadRecords: () => [],
};

/** The collection, created on its first write. A read before any seat asked
    creates nothing: no collection yet means no seat round yet. */
function collection(purpose: "read" | "write", filename = statePath("state.sqlite")): SqliteStateCollection<PrototypeReviewRound> | null {
  const held = collections.get(filename);
  if (held && held.identity === identity(filename)) return held.collection;
  if (purpose === "read" && (!fs.existsSync(filename) || !stateCollectionsInitialized(filename, [SEED]))) return null;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  initializeStateCollections(filename, [SEED]);
  const opened = new SqliteStateCollection<PrototypeReviewRound>(filename, {
    collection: SEAT_DECISIONS_COLLECTION,
    schemaVersion: 1,
    busyMessage: "seat decisions are busy",
    key: (round) => round.id,
    decode,
    clone: structuredClone,
    strictDecode: false,
    preserveRejectedRecords: true,
  });
  collections.set(filename, { identity: identity(filename), collection: opened });
  return opened;
}

/** Tests only: forget every seat round of the current state directory. */
export function clearSeatRoundsForTests(): void {
  const store = collection("read");
  const ids = store?.snapshot().map(round => round.id) ?? [];
  if (store && ids.length) store.boundedPatch(ids.length, tx => { for (const id of ids) tx.delete(id); });
  collections.clear();
}

/** Every seat round, oldest first; one project's when named. */
export function loadSeatRounds(project?: string): PrototypeReviewRound[] {
  const rounds = collection("read")?.snapshot() ?? [];
  const key = project ? canonicalProject(project) : null;
  return rounds.filter(round => !key || canonicalProject(round.project) === key)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Keyset page for the background worker; cold reads decode at most sixteen
    rounds, and a resumed cursor never needs a collection snapshot. */
export function seatRoundPage(after = "", limit = 16): PrototypeReviewRound[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("invalid seat round page limit");
  return collection("read")?.keyRange(after, "\uffff", limit) ?? [];
}

/** Raw-key continuation lets worker scans skip rejected legacy rows without
    losing valid rounds later in the collection. `scanned` is the page budget. */
export function seatRoundPageWithCursor(after = "", limit = 16): { rounds: PrototypeReviewRound[]; cursor: string; scanned: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("invalid seat round page limit");
  const page = collection("read")?.keyRangeEntries(after, "\uffff", limit) ?? [];
  return {
    rounds: page.flatMap(row => row.value === null ? [] : [row.value]),
    cursor: page.at(-1)?.key ?? after,
    scanned: page.length,
  };
}

export function findSeatRound(reviewId: string): PrototypeReviewRound | undefined {
  return collection("read")?.get(reviewId) ?? undefined;
}

/** One round's read-modify-write; nothing is written when the change leaves it as it was. */
export function mutateSeatRound<T>(reviewId: string, change: (round: PrototypeReviewRound) => T): T {
  const store = collection("write")!;
  return store.boundedPatch(2, tx => {
    const round = tx.get(reviewId);
    if (!round) throw new PrototypeError("review not found", 404);
    const before = JSON.stringify(round);
    const result = change(round);
    if (JSON.stringify(round) !== before) tx.put(round);
    return result;
  });
}

/** Store a new seat round. Past the limit the oldest delivered rounds leave,
    and their ids come back so their media goes with them; a collection full of
    unresolved decisions takes no further one. */
export function insertSeatRound(round: PrototypeReviewRound): string[] {
  if (round.taskId !== null) throw new PrototypeError("a seat round has no task");
  const store = collection("write")!;
  const held = store.snapshot().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const removed: string[] = [];
  let count = held.length + 1;
  for (const old of held) {
    if (count <= SEAT_ROUNDS_LIMIT) break;
    if (old.decision?.delivery.state !== "sent") continue;
    removed.push(old.id); count--;
  }
  if (count > SEAT_ROUNDS_LIMIT) throw new PrototypeError(`the orchestrator already has ${SEAT_ROUNDS_LIMIT} questions waiting; nothing was published`, 409);
  store.boundedPatch(removed.length + 2, tx => {
    for (const id of removed) tx.delete(id);
    if (tx.get(round.id)) throw new PrototypeError("publication key already belongs to another payload", 409);
    tx.put(round);
  });
  return removed;
}
