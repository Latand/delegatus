import type { BridgeReportV1 } from "@/lib/bridge/types";
import type { ForgeCacheFile } from "@/lib/forge/cache";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { LimitSample } from "@/lib/types";

import { doneCandidates, type DoneCandidate, type DoneDeployment } from "./candidates";
import { lookupDoneFrame, type DoneFramePorts } from "./frames";
import { doneActivation, doneDatabase, doneFloor, readDoneMemory, readDoneRows, writeDoneProjection } from "./store";
import type { DoneItemV1 } from "./types";

/*
 * The «Готово» projection (docs/design/done-section.md §3): read the sources
 * since the store's activation, insert the keys the store has never seen,
 * refresh what an unacknowledged row may show, and leave every acknowledged
 * row alone. The release that owns traffic runs it every minute (`sweep.ts`)
 * and the read route runs it too, each at most once every 30 s per process, so
 * an outcome reaches the store while its source still holds it, tab or no tab.
 */

/** A projection runs at most this often per process. */
export const DONE_PROJECTION_THROTTLE_MS = 30_000;
/** Album lookups one projection may run; the rest wait for the next one. */
const ALBUM_LOOKUPS_PER_PROJECTION = 4;

export interface DoneWorld extends DoneFramePorts {
  preserveFrame?(key: string, frame: NonNullable<DoneItemV1["frame"]>, refs: DoneItemV1["refs"], replaceProvisional?: boolean, observedAt?: number): Promise<{ frame: NonNullable<DoneItemV1["frame"]>; settled: boolean }>;
  removeFrames?(keys: readonly string[]): Promise<void>;
  now(): number;
  forge(): ForgeCacheFile;
  pipelines(): readonly Pipeline[];
  tasks(): readonly BoardTask[];
  deployments(): readonly DoneDeployment[];
  reports(): readonly BridgeReportV1[];
  limits(): Readonly<Record<string, readonly LimitSample[]>>;
  pipelineRepository(pipeline: Pipeline): string | null;
  repositoryProject(repository: string): string | null;
  accountLabel(engine: string, accountId: string): string | null;
}

/* On `globalThis` because Next bundles route handlers separately: a module
   singleton could become two in a standalone build. */
const throttle = globalThis as typeof globalThis & { __llvDoneProjectedAt?: Record<string, number> };

export function resetDoneProjectionThrottleForTests(): void {
  throttle.__llvDoneProjectedAt = {};
}

export interface DoneProjection {
  projected: boolean;
  inserted: number;
  updated: number;
  deleted: number;
}

export async function projectDoneItems(world: DoneWorld, options: { force?: boolean } = {}): Promise<DoneProjection> {
  const now = world.now();
  const stamps = (throttle.__llvDoneProjectedAt ??= {});
  const database = doneDatabase();
  if (!options.force && now - (stamps[database] ?? Number.NEGATIVE_INFINITY) < DONE_PROJECTION_THROTTLE_MS) {
    return { projected: false, inserted: 0, updated: 0, deleted: 0 };
  }
  stamps[database] = now;
  const activation = Date.parse(doneActivation(now));
  /* Rows the store holds keep refreshing whatever their age; a key it does
     not hold is inserted unless retention settled it (§3). */
  const floor = doneFloor(now);
  const memory = readDoneMemory();
  const { candidates, limitEpisodes } = doneCandidates({
    now,
    floor: activation,
    forge: world.forge(),
    pipelines: world.pipelines(),
    tasks: world.tasks(),
    deployments: world.deployments(),
    reports: world.reports(),
    limits: world.limits(),
    limitEpisodes: memory.limitEpisodes,
    pipelineRepository: (pipeline) => world.pipelineRepository(pipeline),
    repositoryProject: (repository) => world.repositoryProject(repository),
    accountLabel: (engine, accountId) => world.accountLabel(engine, accountId),
  });
  const held = new Map(readDoneRows().map((row) => [row.key, row] as const));
  const at = new Date(now).toISOString();
  const upserts: DoneItemV1[] = [];
  let albumLookups = 0;
  let copies = 0;
  const migrated = new Set<string>();
  // Migrate persisted frames even when their PR/lane source has left the
  // current candidate window. Four owners per pass bound cold album indexing.
  for (const row of held.values()) {
    if (!row.frame || row.frame.unavailable || row.frame.src.startsWith("/api/image?done=") || row.acknowledgedAt || !world.preserveFrame || copies >= ALBUM_LOOKUPS_PER_PROJECTION) continue;
    copies += 1;
    migrated.add(row.key);
    const saved = await world.preserveFrame(row.key, row.frame, row.refs);
    const updated = { ...row, frame: saved.frame, frameCheckedAt: row.frameCheckedAt && saved.settled ? at : null };
    held.set(row.key, updated);
    upserts.push(updated);
  }
  for (const candidate of candidates) {
    const row = held.get(candidate.key);
    if (row?.acknowledgedAt) continue;
    if (!row && (memory.settled.has(candidate.key) || !(Date.parse(candidate.at) >= floor))) continue;
    let frame = row?.frame ?? null;
    let frameCheckedAt = row?.frameCheckedAt ?? null;
    if (candidate.subject && !frameCheckedAt && !migrated.has(candidate.key)) {
      // Wait to record a new framed outcome until it can own its bytes.
      // Never persist a fresh lane URL merely because this pass spent its cap.
      if (world.preserveFrame && copies >= ALBUM_LOOKUPS_PER_PROJECTION) continue;
      const albumAllowed = albumLookups < ALBUM_LOOKUPS_PER_PROJECTION;
      const answer = await lookupDoneFrame(candidate.subject, {
        rounds: (taskId) => world.rounds(taskId),
        album: async (taskId, pipeline) => {
          if (!albumAllowed) return { frame: null, settled: false };
          albumLookups += 1;
          return world.album(taskId, pipeline);
        },
      });
      frame = answer.frame;
      frameCheckedAt = answer.settled ? at : null;
      if (frame && world.preserveFrame) {
        copies += 1;
        const saved = await world.preserveFrame(candidate.key, frame, candidate.refs, Boolean(row?.frame && !row.frame.unavailable && row.frame.src.startsWith("/api/image?done=") && !row.frameCheckedAt && answer.settled), now);
        frame = saved.frame;
        frameCheckedAt = answer.settled && saved.settled ? at : null;
      }
    }
    upserts.push(itemOf(candidate, row, frame, frameCheckedAt, at));
  }
  const unique = [...new Map(upserts.map(row => [row.key,row])).values()];
  const { removedKeys, ...counts } = writeDoneProjection({ upserts: unique, limitEpisodes }, now);
  if (removedKeys.length) await world.removeFrames?.(removedKeys);
  return { projected: true, ...counts };
}

function itemOf(candidate: DoneCandidate, row: DoneItemV1 | undefined, frame: DoneItemV1["frame"], frameCheckedAt: string | null, at: string): DoneItemV1 {
  return {
    key: candidate.key,
    kind: candidate.kind,
    look: frame && (candidate.kind === "pr" || candidate.kind === "pipeline") ? "visible" : candidate.look,
    project: candidate.project,
    at: candidate.at,
    createdAt: row?.createdAt ?? at,
    title: candidate.title,
    icon: candidate.icon,
    refs: candidate.refs,
    frame,
    frameCheckedAt,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}
