import { createHash } from "node:crypto";
import type { SeatTickCheckInput } from "@/lib/monitor/types";
import type { CreatePipelineRequest } from "@/lib/pipelines/types";
import type { ReleaseInput } from "./policy";
import { releaseGapStart, releaseState } from "./policy";
import { releaseStages } from "./stages";
import { mutateReleaseProject, readReleaseProject, type ReleaseRun, type ReleaseProject } from "./store";
import type { ReleaseSetting } from "./settings";

export interface ReleasePorts {
  now: () => number;
  settings: (project: string) => ReleaseSetting | null | undefined;
  observe: (project: string, frozenCut?: string) => Promise<{ policy: ReleaseInput; repoDir: string; src: string }>;
  taskDone: (project: string, taskId: string) => boolean;
  supersedingTag: (project: string, run: ReleaseRun) => Promise<string | null>;
  task: (project: string, run: ReleaseRun, adopted?: string) => string;
  create: (request: CreatePipelineRequest, key: string) => Promise<string>;
  lookup?: (key: string) => string | null;
  pipeline: (id: string) => { state: string; merged: boolean; declined: boolean } | null;
}
export interface ReleaseController {
  reconcile: (project: string) => Promise<string | null>;
  launchIfDue: (input: SeatTickCheckInput) => Promise<string | null>;
}
const lockKey = Symbol.for("delegatus.release.controller");
const globalLocks = globalThis as typeof globalThis & { [lockKey]?: Map<string, Promise<string | null>> };
function serialized(project: string, work: () => Promise<string | null>): Promise<string | null> {
  const locks = globalLocks[lockKey] ??= new Map();
  const held = locks.get(project); if (held) return held;
  const next = work().finally(() => { if (locks.get(project) === next) locks.delete(project); });
  locks.set(project, next); return next;
}
/** Records the exact create payload before dispatch. The engine owns its durable replay key. */
async function admit(project: string, ports: ReleasePorts): Promise<string | null> {
  let row = readReleaseProject(project); let run = row.live;
  if (!run || run.pipelineId || !run.request) return null;
  const alreadyCreated = ports.lookup?.(run.key);
  if (alreadyCreated) {
    mutateReleaseProject(project, current => current.live?.key === run!.key ? { ...current, live: { ...current.live, pipelineId: alreadyCreated },
      request: current.request?.at === run!.requestedAt ? null : current.request } : current);
    return "release: recovered";
  }
  if (!ports.settings(project)?.enabled && run.trigger !== "requested") return "release: releases-off";
  // Recheck current safety evidence even when recovering a lost create receipt.
  const claim = run;
  const observed = await ports.observe(project, run.cut);
  row = readReleaseProject(project);
  run = row.live;
  if (!run || run.key !== claim.key || run.cut !== claim.cut || run.pipelineId || !run.request) return null;
  const safety = await releaseState({ ...observed.policy, requested: true, frozenCut: run.cut, hold: row.hold?.reason ?? null });
  if (safety.state !== "due") return `release: ${safety.reason}`;
  // An operator action can arrive during the ancestry reads inside the policy.
  row = readReleaseProject(project);
  run = row.live;
  if (!run || run.key !== claim.key || run.cut !== claim.cut || run.pipelineId || !run.request) return null;
  if (run.taskId && ports.taskDone(project, run.taskId)) {
    return settle(project, ports, run, "completed", "task-done") ? "release: completed" : null;
  }
  if (row.hold) return "release: hold";
  if (!ports.settings(project)?.enabled && run.trigger !== "requested") return "release: releases-off";
  if (!run.taskId) {
    const taskId = ports.task(project, run, row.request?.taskId);
    row = mutateReleaseProject(project, current => current.live?.key === run!.key
      ? { ...current, live: { ...current.live, taskId, request: { ...current.live.request!, taskIds: [taskId], finishesTask: true } } } : current);
    run = row.live;
  }
  if (!run?.request) return null;
  const pipelineId = await ports.create(run.request, run.key);
  mutateReleaseProject(project, current => current.live?.key === run!.key
    ? { ...current, live: { ...current.live, pipelineId }, request: current.request?.at === run!.requestedAt ? null : current.request, blocked: null } : current);
  return "release: launched";
}
/** Settle only the claim whose evidence was read, preserving later requests. */
function settle(project: string, ports: ReleasePorts, run: ReleaseRun, outcome: ReleaseProject["history"][number]["outcome"], reason?: string): boolean {
  let settled = false;
  mutateReleaseProject(project, current => {
    if (current.live?.key !== run.key || current.live.cut !== run.cut
      || current.live.taskId !== run.taskId || current.live.pipelineId !== run.pipelineId) return current;
    settled = true;
    return { ...current, live: null, blocked: null,
      request: current.request?.at === run.requestedAt ? null : current.request,
      history: [...current.history, { ...current.live, outcome, at: ports.now(), ...(reason ? { reason } : {}) }].slice(-10) };
  });
  return settled;
}
async function reconcileRun(project: string, ports: ReleasePorts): Promise<string | null> {
  const run = readReleaseProject(project).live;
  if (!run) return null;
  const lane = run.pipelineId ? ports.pipeline(run.pipelineId) : null;
  const outcome = lane?.state === "completed" && lane.merged ? "published"
    : lane?.state === "closed" ? lane.declined ? "declined" : "failed" : null;
  if (outcome) return settle(project, ports, run, outcome) ? `release: ${outcome}` : null;
  // Once a creation receipt binds the run, only the pipeline lifecycle can settle it.
  // A done task or a manually pushed tag may predate the pipeline's verification/merge.
  if (run.pipelineId) return lane ? null : "release: pipeline unreadable";
  if (run.taskId && ports.taskDone(project, run.taskId)) {
    return settle(project, ports, run, "completed", "task-done") ? "release: completed" : null;
  }
  const tag = await ports.supersedingTag(project, run);
  // Another process may bind or replace the run while the repository is read.
  const current = readReleaseProject(project).live;
  if (!current || current.key !== run.key || current.cut !== run.cut
    || current.taskId !== run.taskId || current.pipelineId !== run.pipelineId) return null;
  if (tag) return settle(project, ports, run, "superseded", `published-tag: ${tag}`) ? "release: superseded" : null;
  if (run.taskId && ports.taskDone(project, run.taskId)) {
    return settle(project, ports, run, "completed", "task-done") ? "release: completed" : null;
  }
  return admit(project, ports);
}
export function productionReleaseController(ports: ReleasePorts): ReleaseController {
  return {
    reconcile: project => serialized(project, () => reconcileRun(project, ports)),
    launchIfDue: input => serialized(input.project, async () => {
      const project = input.project;
      if (readReleaseProject(project).live) {
        const detail = await reconcileRun(project, ports);
        if (readReleaseProject(project).live) return detail;
      }
      const row = readReleaseProject(project); const setting = ports.settings(project);
      if ((!setting?.enabled && !row.request) || !input.settings.enabled || !input.seat) return null;
      const observed = await ports.observe(project);
      const decision = await releaseState({ ...observed.policy, hold: row.hold?.reason ?? null, requested: !!row.request,
        settled: row.history.at(-1) ?? null });
      const now = ports.now();
      mutateReleaseProject(project, current => ({ ...current, observation: { ...decision, at: now, lastTag: observed.policy.lastTag.name,
        nextEligibleAt: releaseGapStart(observed.policy.lastTag.at, row.history.at(-1)) + observed.policy.minGapHours * 3_600_000 },
        blocked: decision.blocker && (!!row.request || decision.count >= observed.policy.minChanges && now - observed.policy.lastTag.at >= observed.policy.minGapHours * 3_600_000)
          ? current.blocked?.kind === decision.blocker ? current.blocked : { kind: decision.blocker, since: now, episode: `${decision.blocker}:${now}` } : null }));
      if (decision.state !== "due" || !decision.cut) return `release: ${decision.reason}`;
      const cut = decision.cut.revision;
      const prior = row.history.at(-1);
      const key = `release:${project}:${cut}${prior?.cut === cut ? `:after:${prior.at}` : ""}`;
      const request: CreatePipelineRequest = { task: `Реліз Delegatus (після ${observed.policy.lastTag.version})`, repoDir: observed.repoDir,
        src: observed.src, baseBranch: "main", baseRef: cut, autoStart: true, publication: "remote-branch",
        spec: `Production cut ${cut}, served since ${new Date(decision.cut.at).toISOString()}. Trigger: ${decision.reason}; ${decision.count} visible candidates.`,
        stages: releaseStages({ cut, lastTag: observed.policy.lastTag.name, changes: observed.policy.changes, askBeforePublish: setting?.askBeforePublish ?? true,
          approval: setting && !setting.askBeforePublish ? JSON.stringify(setting.publishApproval ?? { at: setting.updatedAt, by: setting.setBy, why: setting.why }) : undefined }) };
      // Claim before the task write; a second process adopts the same frozen request.
      mutateReleaseProject(project, current => current.live ? current : { ...current,
        live: { key, cut, lastTag: observed.policy.lastTag.name, trigger: decision.reason, startedAt: now, requestedAt: row.request?.at ?? null, taskId: null, pipelineId: null, request } });
      return admit(project, ports);
    }),
  };
}
export function releaseRequestDigest(request: CreatePipelineRequest): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
