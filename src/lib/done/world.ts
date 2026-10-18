import path from "node:path";
import { claudeAccountsForPrivacy } from "@/lib/accounts/claude";
import { codexAccountsForPrivacy } from "@/lib/accounts/codex";
import { evidenceRoots, underRoot } from "@/lib/artifact/localFile";
import { readBridgeReportLog } from "@/lib/bridge/store";
import { readForgeCache } from "@/lib/forge/cache";
import { pipelineRepository } from "@/lib/forge/resolve";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { readHistory } from "@/lib/limitsHistoryStore";
import { loadArchivedPipelines, loadPipelinesForList } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { recordedProjectRemotes } from "@/lib/projects/aliases";
import { namedProjectDirectory, resolveNamedProject, type NamedProjectDirectory } from "@/lib/projects/nameResolution";
import { readPrototypeReviews } from "@/lib/prototypeReview/read";
import { ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { ALBUM_PAGE_MAX, readTaskAlbum } from "@/lib/taskAlbum/album";
import { productionAlbumDeps } from "@/lib/taskAlbum/world";
import { loadTasksForList } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import type { DoneWorld } from "./project";
import { preserveDoneFrame, removeDoneMedia } from "./media";
import { copyDoneFrameSource, prepareDoneFrameSource } from "./source";
import { recoverDoneFrame } from "./recover";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

/*
 * The «Готово» projection's view of the Viewer's own records, read-only and
 * lease-free (docs/design/done-section.md §2): the forge cache, live and
 * archived lanes, the board's tasks, the deployment ledger, the bridge report
 * log, the limits history, prototype reviews and the task album. A source
 * that cannot be read contributes nothing this time; the next projection reads
 * it again.
 */

/* Settled lanes move to the archive after three days and still finished their
   work; the archive is cold, so it is read at most once a minute. */
const ARCHIVE_TTL_MS = 60_000;
const archive = globalThis as typeof globalThis & { __llvDoneArchive?: { at: number; pipelines: readonly Pipeline[] } | null };
function archivedPipelines(): readonly Pipeline[] {
  const held = archive.__llvDoneArchive;
  if (held && Date.now() - held.at <= ARCHIVE_TTL_MS) return held.pipelines;
  let pipelines: readonly Pipeline[] = held?.pipelines ?? [];
  try {
    pipelines = loadArchivedPipelines();
  } catch { /* the last good read stands */ }
  archive.__llvDoneArchive = { at: Date.now(), pipelines };
  return pipelines;
}

function quietly<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The path an album picture served from an evidence root names. */
function evidenceFile(src: string): string | null {
  if (!src.startsWith("/api/artifact?")) return null;
  const file = new URLSearchParams(src.slice("/api/artifact?".length)).get("path");
  return file && evidenceRoots().some((root) => underRoot(file, root)) ? file : null;
}

export function productionDoneWorld(options: { recover?: boolean } = {}): DoneWorld {
  let tasks: Map<string, BoardTask> | null = null;
  const taskList = () => {
    tasks ??= new Map(quietly(() => loadTasksForList(), [] as readonly BoardTask[]).map((task) => [task.id, task] as const));
    return tasks;
  };
  let pipelines: readonly Pipeline[] | null = null;
  const laneList = () => (pipelines ??= [...quietly(() => loadPipelinesForList(), [] as readonly Pipeline[]), ...archivedPipelines()]);
  let repositories: NamedProjectDirectory | null = null;
  const labels = new Map<string, Map<string, string>>();
  return {
    async preserveFrame(key, frame, refs, replaceProvisional = false, observedAt = Date.now()) {
      return withViewerOperation("done.frame-source", async () => {
        if (!await prepareDoneFrameSource(frame.src)) return { frame, settled: false };
        let deferred = false;
        const saved = await preserveDoneFrame(key, frame, async (src, staging) => {
          const copy = await copyDoneFrameSource(src,staging);
          if (copy || src !== frame.src) return copy;
          // Network/git recovery runs on the background sweep. Reads keep
          // answering the persisted rows while that refinement is pending.
          if (!options.recover) { deferred = true; return null; }
          const lane = laneList().find(lane => lane.id === refs.pipelineId);
          if (!lane) return null;
          for (const taskId of refs.taskIds ?? []) {
            const page = await readTaskAlbum(taskId,{limit:ALBUM_PAGE_MAX},productionAlbumDeps());
            const alternative = page.items.find(item => item.source.stage?.pipelineId === lane.id && item.src !== src);
            if (alternative) {
              const found = await copyDoneFrameSource(alternative.src,staging);
              if (found) return found;
            }
          }
          let name = frame.caption;
          try {
            const sourcePath = new URL(frame.src, "http://localhost").searchParams.get("path");
            if (sourcePath) name = path.basename(sourcePath);
          } catch { /* no filename context; recovery requires an exact caption match */ }
          return refs.pr ? recoverDoneFrame({repository:refs.pr.repository,number:refs.pr.number,repoDir:lane.repoDir,branch:lane.branch,name},staging) : null;
        }, observedAt, replaceProvisional);
        return deferred ? { frame, settled:false } : { frame:saved, settled:true };
      });
    },
    removeFrames: removeDoneMedia,
    now: () => Date.now(),
    forge: () => quietly(() => readForgeCache().data, { schemaVersion: 1 as const, repositories: {} }),
    pipelines: laneList,
    tasks: () => [...taskList().values()],
    deployments: () => {
      const read = quietly(() => ledgerDeployments(20), { state: "unreadable" as const, error: "" });
      return read.state === "ok" ? read.value.map((deployment) => ({ deploymentId: deployment.deploymentId, revision: deployment.revision, phase: deployment.phase, terminal: deployment.terminal, updatedAt: deployment.updatedAt })) : [];
    },
    reports: () => quietly(() => readBridgeReportLog().reports, []),
    limits: () => quietly(() => readHistory().series, {}),
    pipelineRepository: (pipeline) => quietly(() => pipelineRepository(pipeline), null),
    repositoryProject(repository) {
      return quietly(() => {
        if (!repositories) {
          const remotes = recordedProjectRemotes();
          repositories = namedProjectDirectory({}, Object.keys(remotes));
          // This projection receives a full repository identifier from forge
          // records. Restrict its candidates to that identity vocabulary.
          repositories.names = new Map();
          for (const [project, remote] of Object.entries(remotes)) {
            const name = githubRepositoryOfRemote(remote)?.toLowerCase();
            if (!name) continue;
            const candidates = repositories.names.get(name) ?? new Set<string>();
            candidates.add(repositories.canonical(project)); repositories.names.set(name, candidates);
          }
        }
        return resolveNamedProject(repository, repositories);
      }, null);
    },
    accountLabel(engine, accountId) {
      if (!labels.has(engine)) {
        const list = quietly(() => (engine === "codex" ? codexAccountsForPrivacy() : engine === "claude" ? claudeAccountsForPrivacy() : []), []);
        labels.set(engine, new Map(list.filter((account) => account.label).map((account) => [account.id, account.label] as const)));
      }
      return labels.get(engine)!.get(accountId) ?? null;
    },
    rounds(taskId) {
      const task = taskList().get(taskId);
      return task ? quietly(() => readPrototypeReviews(task).rounds, []) : [];
    },
    async album(taskId, pipeline) {
      const page = await readTaskAlbum(taskId, { limit: ALBUM_PAGE_MAX }, productionAlbumDeps());
      const roles = new Map(pipeline.stages.map((stage) => [stage.id, stage.effectiveRole?.roleId ?? stage.role?.roleId ?? null] as const));
      const own = page.items.filter((item) => item.source.stage?.pipelineId === pipeline.id);
      const hit = own.find((item) => roles.get(item.source.stage!.stageId) === "visual-critic") ?? own.find((item) => evidenceFile(item.src) !== null);
      return { frame: hit ? { src: hit.src, caption: hit.name ?? "" } : null, settled: !page.indexing };
    },
  };
}
