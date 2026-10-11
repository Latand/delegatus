import type { BridgeReportV1 } from "@/lib/bridge/types";
import type { ForgeCacheFile } from "@/lib/forge/cache";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { LimitSample } from "@/lib/types";

import { doneCandidates, type DoneCandidate, type DoneDeployment } from "./candidates";
import { lookupDoneFrame, type DoneFramePorts } from "./frames";
import { doneActivation, doneDatabase, doneFloor, readDoneRows, writeDoneProjection } from "./store";
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
     not hold is inserted only past the settled floor (§3). */
  const floor = doneFloor(now);
  const candidates = doneCandidates({
    now,
    floor: activation,
    forge: world.forge(),
    pipelines: world.pipelines(),
    tasks: world.tasks(),
    deployments: world.deployments(),
    reports: world.reports(),
    limits: world.limits(),
    pipelineRepository: (pipeline) => world.pipelineRepository(pipeline),
    repositoryProject: (repository) => world.repositoryProject(repository),
    accountLabel: (engine, accountId) => world.accountLabel(engine, accountId),
  });
  const held = new Map(readDoneRows().map((row) => [row.key, row] as const));
  const at = new Date(now).toISOString();
  const upserts: DoneItemV1[] = [];
  let albumLookups = 0;
  for (const candidate of candidates) {
    const row = held.get(candidate.key);
    if (row?.acknowledgedAt) continue;
    if (!row && !(Date.parse(candidate.at) >= floor)) continue;
    let frame = row?.frame ?? null;
    let frameCheckedAt = row?.frameCheckedAt ?? null;
    if (candidate.subject && !frameCheckedAt) {
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
    }
    upserts.push(itemOf(candidate, row, frame, frameCheckedAt, at));
  }
  return { projected: true, ...writeDoneProjection({ upserts }, now) };
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
