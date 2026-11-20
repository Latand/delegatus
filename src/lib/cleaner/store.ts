import { createHash, randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { waitForStateLock } from "@/lib/state/lockWait";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import type { DiskPressure } from "@/lib/state/diskPressure";
import type { CleanerReport } from "./text";

export const CLEANER_DAILY_INTERVAL_MS = 24 * 60 * 60_000;
export const CLEANER_DAILY_START_DELAY_MS = 10 * 60_000;
const RETAIN_RUNS = 60;
export const CLEANER_RUN_TIMEOUT_MS = 90 * 60_000;

export type CleanerTrigger = `disk-pressure:${string}` | `daily:${string}`;
export type CleanerDiskEvidence = {
  volumes: Pick<DiskPressure["volumes"][number], "roles" | "freeBytes" | "totalBytes" | "level">[];
  categories: { name: string; bytes: number }[];
};
export type CleanerLaunchBody = {
  role: "cleaner"; roleParams: { mode: "disk" }; cwd: string; project: string; prompt: string;
  taskId: string; clientAttemptId: string; mcpServers: ["viewer"]; notifyLauncher: false;
};
export type CleanerRun = {
  kind: "run"; runId: string; trigger: CleanerTrigger; mode: "dry-run"; project: string; cwd: string;
  claimedAt: string; launchedAt: string | null; taskId: string; launchBody: CleanerLaunchBody | null;
  launchAcknowledged: boolean; launchId: string | null; conversationId: string | null; transcriptPath: string | null;
  evidence: CleanerDiskEvidence; removalJournal: []; report: CleanerReport | null;
  settledAt: string | null; failure: { kind: string; detail: string } | null;
  quiescedAt?: string | null;
};
type Schedule = {
  kind: "schedule"; mode: "dry-run"; activeRunId: string | null; lastDailyClaimAt: number | null;
  lastPressureEpisode: string | null; runIds: string[]; pendingCards: string[];
};
type Row = CleanerRun | Schedule;
const COLLECTION = "cleaner-runs";
const SCHEDULE = "schedule";
const EMPTY: Schedule = {
  kind: "schedule", mode: "dry-run", activeRunId: null, lastDailyClaimAt: null,
  lastPressureEpisode: null, runIds: [], pendingCards: [],
};
const runKey = (id: string) => `run:${id}`;
const pressureRunId = (episode: string) => `cleaner_pressure_${createHash("sha256").update(episode).digest("hex").slice(0, 32)}`;
const key = (row: Row) => row.kind === "run" ? runKey(row.runId) : SCHEDULE;
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "cleaner-runs-v1", key, loadRecords: (): Row[] => [] };

function decode(value: unknown): Row | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Row;
  if (row.mode !== "dry-run") return null;
  if (row.kind === "schedule" && Array.isArray(row.runIds) && row.runIds.length <= RETAIN_RUNS
    && Array.isArray(row.pendingCards) && row.pendingCards.length <= row.runIds.length) return row;
  if (row.kind === "run" && typeof row.runId === "string" && typeof row.taskId === "string"
    && typeof row.trigger === "string" && Number.isFinite(Date.parse(row.claimedAt))
    && (row.quiescedAt == null || Number.isFinite(Date.parse(row.quiescedAt)))
    && Array.isArray(row.removalJournal) && (!row.launchBody || row.launchBody.clientAttemptId === row.runId)) return row;
  return null;
}

let cached: SqliteStateCollection<Row> | null = null;
function collection(create = false): SqliteStateCollection<Row> | null {
  const file = statePath("state.sqlite");
  if (cached?.filename === file) return cached;
  if (!stateCollectionsInitialized(file, [seed])) {
    if (!create) return null;
    initializeStateCollections(file, [seed]);
  }
  cached?.close();
  cached = new SqliteStateCollection<Row>(file, {
    collection: COLLECTION, schemaVersion: 1, key, decode, clone: structuredClone,
    strictDecode: true, busyMessage: "cleaner runs busy",
  });
  return cached;
}

function schedule(): Schedule {
  return (collection()?.get(SCHEDULE) as Schedule | null) ?? EMPTY;
}
export function readCleanerRun(id: string): CleanerRun | null {
  return (collection()?.get(runKey(id)) as CleanerRun | null) ?? null;
}
/** Queued disk-cleaner reservations may actuate only while their exact durable
 * run still owns the slot and its original launch deadline has not elapsed. */
export function cleanerAttemptMayStart(id: string, now = Date.now()): boolean {
  const run = readCleanerRun(id);
  const held = schedule();
  if (!run || held.activeRunId !== id || run.settledAt) return false;
  return now - Date.parse(run.launchedAt ?? run.claimedAt) < CLEANER_RUN_TIMEOUT_MS;
}
export function activeCleanerRun(): CleanerRun | null {
  const id = schedule().activeRunId;
  return id ? readCleanerRun(id) : null;
}
export function pendingCleanerCard(): CleanerRun | null {
  const [id] = schedule().pendingCards;
  return id ? readCleanerRun(id) : null;
}
export function previousCleanerRun(runId: string): CleanerRun | null {
  const ids = schedule().runIds;
  const index = ids.indexOf(runId);
  return index > 0 ? readCleanerRun(ids[index - 1]!) : null;
}
export function cleanerPressureRun(episode: string): CleanerRun | null {
  return readCleanerRun(pressureRunId(episode));
}

function dailyCleanerDue(lastClaimAt: number | null, now: number, trafficSince: number): boolean {
  return lastClaimAt === null
    ? now - trafficSince >= CLEANER_DAILY_START_DELAY_MS
    : now - lastClaimAt >= CLEANER_DAILY_INTERVAL_MS;
}

export function cleanerDailyDue(now: number, trafficSince: number): boolean {
  return dailyCleanerDue(schedule().lastDailyClaimAt, now, trafficSince);
}

type Claim = { project: string; cwd: string; now: () => number; evidence: CleanerDiskEvidence; allowed: () => boolean }
  & ({ episode: string } | { trafficSince: number | (() => number) });

/** The schedule and run commit together. The episode receipt survives run pruning. */
export function claimCleanerRun(input: Claim): Promise<CleanerRun | "already-claimed" | "held"> {
  return waitForStateLock("cleaner.claim", () => {
    if (!input.allowed()) return "held";
    return collection(true)!.boundedPatch(5, tx => {
      if (!input.allowed()) return "held";
      const held = (tx.get(SCHEDULE) as Schedule | null) ?? EMPTY;
      const now = input.now();
      const trafficSince = "trafficSince" in input
        ? (typeof input.trafficSince === "function" ? input.trafficSince() : input.trafficSince)
        : null;
      const claimedAt = new Date(now).toISOString();
      const episode = "episode" in input ? input.episode : null;
      const trigger: CleanerTrigger = episode === null ? `daily:${claimedAt.slice(0, 10)}` : `disk-pressure:${episode}`;
      const pressureId = episode === null ? null : pressureRunId(episode);
      if (pressureId && (held.lastPressureEpisode === episode || tx.get(runKey(pressureId)))) return "already-claimed";
      if (held.activeRunId || (trafficSince !== null && !dailyCleanerDue(held.lastDailyClaimAt, now, trafficSince))) return "held";
      const runIds = [...held.runIds];
      if (runIds.length >= RETAIN_RUNS) {
        const index = runIds.findIndex(id => !held.pendingCards.includes(id));
        if (index === -1) throw new Error("cleaner run history is full of unsettled cards");
        tx.delete(runKey(runIds.splice(index, 1)[0]!));
      }
      const taskId = randomUUID();
      const runId = pressureId ?? `cleaner_${taskId}`;
      const run: CleanerRun = {
        kind: "run", runId, trigger, mode: held.mode, project: input.project, cwd: input.cwd, claimedAt,
        launchedAt: null, taskId, launchBody: null, launchAcknowledged: false, launchId: null,
        conversationId: null, transcriptPath: null, evidence: input.evidence, removalJournal: [],
        report: null, settledAt: null, failure: null,
      };
      tx.put(run);
      tx.put({
        ...held, activeRunId: runId, runIds: [...runIds, runId],
        lastDailyClaimAt: episode === null ? now : held.lastDailyClaimAt,
        lastPressureEpisode: episode ?? held.lastPressureEpisode,
      });
      return run;
    });
  }, { subject: COLLECTION });
}

export function updateActiveCleanerRun(
  runId: string, allowed: () => boolean, change: (run: CleanerRun) => CleanerRun | null,
): Promise<CleanerRun | null> {
  return collection()!.boundedPatchAsync(4, tx => {
    if (!allowed()) return null;
    const held = tx.get(SCHEDULE) as Schedule | null;
    if (held?.activeRunId !== runId) return null;
    const run = tx.get(runKey(runId)) as CleanerRun;
    const next = change(run);
    if (!next) return run;
    tx.put(next);
    if (next.settledAt) {
      tx.put({ ...held, activeRunId: next.quiescedAt ? null : held.activeRunId,
        pendingCards: held.pendingCards.includes(runId) ? held.pendingCards : [...held.pendingCards, runId] });
    }
    return next;
  });
}

export function recordCleanerCardAttempt(runId: string, allowed: () => boolean, completed: boolean): Promise<void> {
  return collection()!.boundedPatchAsync(2, tx => {
    if (!allowed()) return;
    const held = tx.get(SCHEDULE) as Schedule | null;
    if (!held?.pendingCards.includes(runId)) return;
    if (!completed && held.pendingCards.at(-1) === runId) return;
    const pendingCards = held.pendingCards.filter(id => id !== runId);
    if (!completed) pendingCards.push(runId);
    tx.put({ ...held, pendingCards });
  });
}
