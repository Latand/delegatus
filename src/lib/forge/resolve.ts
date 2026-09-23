import type { Pipeline } from "@/lib/pipelines/types";
import { recordedProjectRemote } from "@/lib/projects/aliases";
import type { TaskWorkLinkContext } from "@/lib/tasks/commands";
import type { BoardTask } from "@/lib/tasks/types";

import { forgeCacheView } from "./cache";
import {
  githubRepositoryOfRemote,
  resolvePipelineLinks,
  resolveTaskLinks,
  type FilesWorkLinks,
  type ForgeCacheView,
  type ResolvedWorkLinks,
  type WorkLinkKind,
} from "./workLinks";

/*
 * Read-time joins for the board and the MCP reads (#2059). Only in-memory
 * lookups against the cache view and the remotes ledger, both mtime-cached:
 * no `gh`, no lock, nothing written, which is what keeps them on `/api/files`.
 */

/** The GitHub repository a pipeline delivers to: its delivery remote, else the
    remote this machine recorded behind its project key. */
export function pipelineRepository(
  pipeline: Pick<Pipeline, "delivery" | "project">,
  recorded: (project: string) => string | null = recordedProjectRemote,
): string | null {
  return githubRepositoryOfRemote(pipeline.delivery?.target.remote)
    ?? githubRepositoryOfRemote(recorded(pipeline.project));
}

export function taskRepository(task: Pick<BoardTask, "project">): string | null {
  return githubRepositoryOfRemote(recordedProjectRemote(task.project));
}

/** What the cache says a number is, for normalizing a bare attach. */
export function cachedKindOf(cache: ForgeCacheView = forgeCacheView()) {
  return (repository: string, number: number): WorkLinkKind | null => {
    const view = cache.repository(repository);
    if (view?.pr(number)) return "pr";
    return view?.isIssue(number) ? "issue" : null;
  };
}

/** The canonical name of a repository, so a renamed one compares equal. */
export function canonicalRepository(cache: ForgeCacheView = forgeCacheView()) {
  return (repository: string) => cache.repository(repository)?.canonical ?? repository;
}

export function pipelineWorkLinks(
  pipeline: Pipeline,
  cache: ForgeCacheView = forgeCacheView(),
  recorded: (project: string) => string | null = recordedProjectRemote,
): ResolvedWorkLinks {
  return resolvePipelineLinks(pipeline, pipelineRepository(pipeline, recorded), cache);
}

export function taskWorkLinks(task: BoardTask, pipelines: readonly Pipeline[], cache: ForgeCacheView = forgeCacheView()): ResolvedWorkLinks {
  const carried = pipelines.filter((pipeline) => pipeline.taskIds?.includes(task.id)).map((pipeline) => pipelineWorkLinks(pipeline, cache));
  return resolveTaskLinks(task, carried, cache);
}

/** The compact list row's one string: `#2059 open`, `no PR`, or null. */
export function pullRequestSummary(resolved: ResolvedWorkLinks): string | null {
  const pr = resolved.links.find((link) => link.kind === "pr");
  if (pr) return `#${pr.number}${pr.state ? ` ${pr.state}` : ""}`;
  return resolved.noPr ? "no PR" : null;
}

/** `/api/files`' map, over exactly the records the response carries, keeping
    only the entries with something to draw. */
export function workLinksForBoard(pipelines: readonly Pipeline[], tasks: readonly BoardTask[], cache: ForgeCacheView = forgeCacheView()): FilesWorkLinks {
  const byPipeline = new Map<string, ResolvedWorkLinks>();
  const byTask = new Map<string, ResolvedWorkLinks[]>();
  const out: FilesWorkLinks = { pipelines: {}, tasks: {} };
  /* One ledger lookup per project, not per pipeline. */
  const remotes = new Map<string, string | null>();
  const recorded = (project: string) => {
    if (!remotes.has(project)) remotes.set(project, recordedProjectRemote(project));
    return remotes.get(project)!;
  };
  for (const pipeline of pipelines) {
    const resolved = pipelineWorkLinks(pipeline, cache, recorded);
    byPipeline.set(pipeline.id, resolved);
    if (resolved.links.length || resolved.noPr) out.pipelines[pipeline.id] = resolved;
    for (const taskId of pipeline.taskIds ?? []) {
      const list = byTask.get(taskId) ?? [];
      list.push(resolved);
      byTask.set(taskId, list);
    }
  }
  for (const task of tasks) {
    const carried = byTask.get(task.id) ?? [];
    if (!carried.length && !task.workLinks?.length) continue;
    const resolved = resolveTaskLinks(task, carried, cache);
    if (resolved.links.length) out.tasks[task.id] = resolved;
  }
  return out;
}

/** What `patchTask` needs for attachLinks/detachLinks. A task's repository is
    its project's remote, else the delivery repository of a pipeline it
    carries; the pipelines are read only when that is needed. */
export function taskWorkLinkContext(loadPipelines: () => readonly Pipeline[]): (task: BoardTask) => TaskWorkLinkContext {
  const cache = forgeCacheView();
  return (task) => {
    let carried: readonly Pipeline[] | null = null;
    const pipelines = () => (carried ??= loadPipelines().filter((pipeline) => pipeline.taskIds?.includes(task.id)));
    const canonical = canonicalRepository(cache);
    return {
      repository: taskRepository(task) ?? pipelines().map((pipeline) => pipelineRepository(pipeline)).find(Boolean) ?? null,
      kindOf: cachedKindOf(cache),
      canonical,
      autoVia: (link) => taskWorkLinks({ ...task, workLinks: [] }, pipelines(), cache).links
        .find((found) => found.number === link.number && found.repository === canonical(link.repository))?.via ?? null,
    };
  };
}
