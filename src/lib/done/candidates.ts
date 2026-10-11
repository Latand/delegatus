import type { BridgeReportV1 } from "@/lib/bridge/types";
import type { ForgeCacheFile, StoredPullRequest } from "@/lib/forge/cache";
import { isMergeBatchHead, parseMergeBatchTitle } from "@/lib/forge/mergeBatchTitle";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { LimitSample } from "@/lib/types";

import type { DoneItemKind, DoneItemLook, DoneItemRefs } from "./types";

/*
 * The «Готово» candidates (docs/design/done-section.md §2): one per finished
 * unit of work, read from records Delegatus already keeps, keyed
 * deterministically so a repeated event finds the row it made before. Pure:
 * the projector hands it the records and the window, and it reads nothing
 * itself.
 */

export interface DoneDeployment {
  deploymentId: string;
  revision: string;
  phase: string;
  terminal: boolean;
  updatedAt: string;
}

export interface DoneSources {
  /** Epoch ms. */
  now: number;
  /** Epoch ms: no event before it makes an item (§2.2). */
  floor: number;
  forge: ForgeCacheFile;
  /** Live and archived lanes alike. */
  pipelines: readonly Pipeline[];
  tasks: readonly BoardTask[];
  deployments: readonly DoneDeployment[];
  reports: readonly BridgeReportV1[];
  /** The limits history's series, `<engine>|<accountId>|<window>` → samples. */
  limits: Readonly<Record<string, readonly LimitSample[]>>;
  /** `<owner>/<repo>` a lane delivers to. */
  pipelineRepository(pipeline: Pipeline): string | null;
  /** The project whose records live in a repository no lane of the PR names. */
  repositoryProject(repository: string): string | null;
  accountLabel?(engine: string, accountId: string): string | null;
}

export interface DoneCandidate {
  key: string;
  kind: DoneItemKind;
  /** Before the thumbnail lookup: `pr` and `pipeline` become `visible` once it finds a frame. */
  look: DoneItemLook;
  project: string | null;
  at: string;
  title: string;
  icon: string | null;
  refs: DoneItemRefs;
  /** What the thumbnail lookup reads (§4.2); null for items that never show one. */
  subject: { pipeline: Pipeline | null; taskIds: string[] } | null;
}

const TITLE_MAX = 200;
const TERMINAL_ATTEMPTS: ReadonlySet<PipelineStageAttempt["state"]> = new Set(["passed", "failed", "skipped"]);
const TERMINAL_DEPLOY_PHASES: ReadonlySet<string> = new Set(["succeeded", "failed", "rolled-back"]);

export function firstLine(text: string | null | undefined): string {
  const line = (text ?? "").split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const inWindow = (iso: string | null | undefined, sources: DoneSources) => {
  const at = ms(iso);
  return Number.isFinite(at) && at >= sources.floor && at <= sources.now + 60_000;
};

interface LandedPullRequest {
  repository: string;
  number: number;
  pr: StoredPullRequest;
  at: string;
}

/**
 * Every PR that reached its base branch (§2.1): merged on its own, or closed
 * by a merge batch whose merged PR names it in its title, at the batch's
 * merge. The batch's own PR is never one.
 */
export function landedPullRequests(forge: ForgeCacheFile): LandedPullRequest[] {
  const landed = new Map<string, LandedPullRequest>();
  for (const [name, entry] of Object.entries(forge.repositories)) {
    /* A renamed repository can sit under both names; one key per PR. */
    const repository = (entry.canonical ?? name).toLowerCase();
    const viaBatch = new Map<number, string>();
    for (const pr of Object.values(entry.prs)) {
      if (pr.state !== "merged" || !isMergeBatchHead(pr.headRefName) || !pr.mergedAt) continue;
      for (const number of parseMergeBatchTitle(pr.title)) {
        const held = viaBatch.get(number);
        if (!held || ms(pr.mergedAt) < ms(held)) viaBatch.set(number, pr.mergedAt);
      }
    }
    for (const [key, pr] of Object.entries(entry.prs)) {
      const number = Number(key);
      if (!Number.isSafeInteger(number) || isMergeBatchHead(pr.headRefName)) continue;
      const at = pr.state === "merged" && pr.mergedAt ? pr.mergedAt : pr.state === "closed" ? viaBatch.get(number) : undefined;
      if (!at) continue;
      landed.set(`${repository}#${number}`, { repository, number, pr, at });
    }
  }
  return [...landed.values()];
}

/** A lane whose work is finished: completed, or closed after its last
    attempt passed with nothing left pending. A discarded or failed lane is
    no outcome. */
export function pipelineFinished(pipeline: Pipeline): boolean {
  if (pipeline.state === "completed") return true;
  if (pipeline.state !== "closed") return false;
  const attempts = pipeline.runs.flatMap((run) => run.attempts).filter((attempt) => !attempt.historical && !attempt.legacyReview);
  if (!attempts.length || attempts.some((attempt) => !TERMINAL_ATTEMPTS.has(attempt.state))) return false;
  const last = attempts.reduce((newest, attempt) => (ms(attempt.completedAt) > ms(newest.completedAt) ? attempt : newest));
  return last.state === "passed";
}

export function doneCandidates(sources: DoneSources): DoneCandidate[] {
  const tasks = new Map(sources.tasks.map((task) => [task.id, task] as const));
  const repositoryOf = new Map<string, string | null>();
  const repoOf = (pipeline: Pipeline) => {
    if (!repositoryOf.has(pipeline.id)) repositoryOf.set(pipeline.id, sources.pipelineRepository(pipeline)?.toLowerCase() ?? null);
    return repositoryOf.get(pipeline.id)!;
  };
  /* Newest lane first, so a branch reused by a later lane names the later one. */
  const lanes = [...sources.pipelines].sort((left, right) => ms(right.createdAt) - ms(left.createdAt));
  const byBranch = new Map<string, Pipeline>();
  const byNumber = new Map<string, Pipeline>();
  for (const lane of lanes) {
    const repository = repoOf(lane);
    if (!repository) continue;
    if (lane.branch && !byBranch.has(`${repository} ${lane.branch}`)) byBranch.set(`${repository} ${lane.branch}`, lane);
    for (const number of [lane.delivery?.target.pr, lane.merge?.prNumber]) {
      if (number && !byNumber.has(`${repository}#${number}`)) byNumber.set(`${repository}#${number}`, lane);
    }
  }
  const prsOnBranch = new Set<string>();
  for (const [name, entry] of Object.entries(sources.forge.repositories)) {
    for (const pr of Object.values(entry.prs)) {
      prsOnBranch.add(`${name.toLowerCase()} ${pr.headRefName}`);
      if (entry.canonical) prsOnBranch.add(`${entry.canonical.toLowerCase()} ${pr.headRefName}`);
    }
  }
  const linkedTasks = new Map<string, string[]>();
  for (const task of sources.tasks) {
    for (const link of task.workLinks ?? []) {
      if (link.kind === "issue") continue;
      const key = `${link.repository.toLowerCase()}#${link.number}`;
      linkedTasks.set(key, [...(linkedTasks.get(key) ?? []), task.id]);
    }
  }

  const out: DoneCandidate[] = [];
  /* Tasks one of the items above already speaks for. */
  const covered = new Set<string>();
  for (const lane of sources.pipelines) for (const id of lane.taskIds) covered.add(id);

  const sentence = (taskIds: readonly string[], fallbacks: ReadonlyArray<string | null | undefined>) => {
    for (const id of taskIds) {
      const line = firstLine(tasks.get(id)?.text);
      if (line) return line;
    }
    for (const fallback of fallbacks) {
      const line = firstLine(fallback);
      if (line) return line;
    }
    return "";
  };
  const laneTasks = (lane: Pipeline | null) => (lane ? [...new Set([...(lane.finishesTaskIds ?? []), ...lane.taskIds])] : []);

  for (const landed of landedPullRequests(sources.forge)) {
    if (!inWindow(landed.at, sources)) continue;
    const lane = byBranch.get(`${landed.repository} ${landed.pr.headRefName}`) ?? byNumber.get(`${landed.repository}#${landed.number}`) ?? null;
    const taskIds = [...new Set([...laneTasks(lane), ...(linkedTasks.get(`${landed.repository}#${landed.number}`) ?? [])])].filter((id) => tasks.has(id) || lane?.taskIds.includes(id));
    for (const id of taskIds) covered.add(id);
    const first = taskIds.map((id) => tasks.get(id)).find(Boolean) ?? null;
    out.push({
      key: `pr:${landed.repository}#${landed.number}`,
      kind: "pr",
      look: "technical",
      project: lane?.project ?? first?.project ?? sources.repositoryProject(landed.repository),
      at: landed.at,
      title: sentence(taskIds, [lane?.task, landed.pr.title, `#${landed.number}`]),
      icon: first?.icon ?? null,
      refs: {
        ...(lane ? { pipelineId: lane.id } : {}),
        pr: { repository: landed.repository, number: landed.number, url: landed.pr.url },
        ...(taskIds.length ? { taskIds } : {}),
      },
      subject: { pipeline: lane, taskIds },
    });
  }

  for (const lane of sources.pipelines) {
    if (!pipelineFinished(lane) || !inWindow(lane.closedAt, sources)) continue;
    const repository = repoOf(lane);
    const namesPr = Boolean(lane.delivery?.target.pr || lane.merge
      || (repository && prsOnBranch.has(`${repository} ${lane.branch}`))
      || lane.workLinks?.some((link) => link.kind === "pr"));
    if (namesPr) continue;
    const taskIds = laneTasks(lane).filter((id) => tasks.has(id));
    const first = taskIds.map((id) => tasks.get(id)).find(Boolean) ?? null;
    out.push({
      key: `pipeline:${lane.id}:done`,
      kind: "pipeline",
      look: "closed",
      project: lane.project,
      at: lane.closedAt!,
      title: sentence(taskIds, [lane.task]),
      icon: first?.icon ?? null,
      refs: { pipelineId: lane.id, ...(taskIds.length ? { taskIds } : {}) },
      subject: { pipeline: lane, taskIds },
    });
  }

  for (const task of sources.tasks) {
    if (task.status !== "done" || covered.has(task.id) || !inWindow(task.doneAt, sources)) continue;
    out.push({
      key: `task:${task.id}`,
      kind: "task",
      look: "closed",
      project: task.project,
      at: task.doneAt!,
      title: firstLine(task.text),
      icon: task.icon ?? null,
      refs: { taskIds: [task.id] },
      subject: null,
    });
  }

  for (const deployment of sources.deployments) {
    if (!deployment.terminal || !TERMINAL_DEPLOY_PHASES.has(deployment.phase) || !inWindow(deployment.updatedAt, sources)) continue;
    out.push({
      key: `deploy:${deployment.deploymentId}`,
      kind: "deploy",
      look: deployment.phase === "succeeded" ? "deploy" : "incident",
      project: null,
      at: deployment.updatedAt,
      title: "",
      icon: null,
      refs: { deploymentId: deployment.deploymentId, sha: deployment.revision.slice(0, 40), phase: deployment.phase },
      subject: null,
    });
  }

  for (const report of sources.reports) {
    /* The marker is the orchestrator's own (§2.3); the store keeps it only on
       a manager row, and this reads it the same way. */
    if (!report.outcome || report.origin?.kind !== "manager" || !inWindow(report.at, sources)) continue;
    out.push({
      key: `report:${report.id}`,
      kind: "report",
      look: report.outcome.kind,
      project: report.project ?? null,
      at: report.at,
      title: firstLine(report.outcome.summary),
      icon: null,
      refs: { reportId: report.id },
      subject: null,
    });
  }

  out.push(...limitCandidates(sources));
  return out;
}

/** One item per exhausted usage window (§2.4): a run of samples at no room
    left is one episode, keyed by its first sample, which an append-only
    history never moves. */
function limitCandidates(sources: DoneSources): DoneCandidate[] {
  const out: DoneCandidate[] = [];
  for (const [series, raw] of Object.entries(sources.limits)) {
    const [engine, accountId, window, extra] = series.split("|");
    if (!engine || !accountId || !window || extra !== undefined) continue;
    const samples = [...raw].filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.remaining)).sort((left, right) => left.t - right.t);
    let from: number | null = null;
    const close = (to: number | null) => {
      if (from === null) return;
      const start = from;
      from = null;
      if (start * 1_000 < sources.floor) return;
      const label = sources.accountLabel?.(engine, accountId) ?? null;
      out.push({
        key: `limit:${engine}:${accountId}:${window}:${start}`,
        kind: "limit",
        look: "limit",
        project: null,
        at: new Date(start * 1_000).toISOString(),
        title: "",
        icon: null,
        refs: {
          account: { engine, accountId, window, ...(label ? { label } : {}) },
          limit: { from: new Date(start * 1_000).toISOString(), to: to === null ? null : new Date(to * 1_000).toISOString(), lanes: lanesWaiting(sources.pipelines, engine, accountId, start * 1_000, to === null ? sources.now : to * 1_000) },
        },
        subject: null,
      });
    };
    for (const sample of samples) {
      if (sample.remaining <= 0) from ??= sample.t;
      else close(sample.t);
    }
    close(null);
  }
  return out;
}

/** Lanes whose attempts recorded this account as limited inside the episode. */
function lanesWaiting(pipelines: readonly Pipeline[], engine: string, accountId: string, fromMs: number, toMs: number): number {
  let lanes = 0;
  for (const lane of pipelines) {
    const waited = lane.runs.some((run) => run.attempts.some((attempt) => (attempt.usageLimitedAccounts ?? []).some((entry) =>
      entry.accountId === accountId && (!entry.engine || entry.engine === engine)
      && typeof entry.limitedAt === "number" && entry.limitedAt >= fromMs && entry.limitedAt <= toMs)));
    if (waited) lanes += 1;
  }
  return lanes;
}
