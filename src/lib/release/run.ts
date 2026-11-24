import { createHash } from "node:crypto";
import type { SeatTickCheckInput } from "@/lib/monitor/types";
import type { CreatePipelineRequest } from "@/lib/pipelines/types";
import type { ReleaseInput } from "./policy";
import { releaseGapStart, releaseState } from "./policy";
import { releasePublishStages, releaseStages } from "./stages";
import { mutateReleaseProject, readReleaseProject, type ReleaseRun, type ReleaseProject } from "./store";
import type { ReleaseSetting } from "./settings";

export interface ReleasePorts {
  now: () => number;
  settings: (project: string) => ReleaseSetting | null | undefined;
  observe: (project: string, frozenCut?: string) => Promise<{ policy: ReleaseInput; repoDir: string; src: string;
    recovery?: { commit: string; pr: number; cut: string | null } | null; recoveryForPipeline?: string } | null>;
  taskDone: (project: string, taskId: string) => boolean;
  supersedingTag: (project: string, run: ReleaseRun) => Promise<string | null>;
  task: (project: string, run: ReleaseRun, adopted?: string) => string;
  create: (request: CreatePipelineRequest, key: string) => Promise<string>;
  lookup?: (key: string) => string | null;
  pipeline: (id: string) => { state: string; merged: boolean; declined: boolean; mergeActive?: boolean; mergeCancelled?: boolean; mergeStopReason?: string | null; mergeCommit?: string | null; pr?: number | null } | null;
}
export interface ReleaseController {
  reconcile: (project: string) => Promise<string | null>;
  launchIfDue: (input: SeatTickCheckInput) => Promise<string | null>;
}
/** Proof from the create adapter that this exact payload failed before admission. */
export class ReleaseValidationRefusal extends Error {
  constructor(readonly digest: string, reason: string) { super(reason); }
}
const NOT_APPLICABLE = "release: not applicable (origin/main has no root package.json)";
function retireInapplicableBlocker(project: string) {
  mutateReleaseProject(project, current => current.blocked ? { ...current, blocked: null } : current);
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
  if (!ports.settings(project)?.enabled) return null;
  // Recheck current safety evidence even when recovering a lost create receipt.
  const claim = run;
  const observed = await ports.observe(project, run.cut);
  if (!ports.settings(project)?.enabled) return null;
  if (!observed) { retireInapplicableBlocker(project); return NOT_APPLICABLE; }
  row = readReleaseProject(project);
  run = row.live;
  if (!run || run.key !== claim.key || run.cut !== claim.cut || run.pipelineId || !run.request) return null;
  const candidate = observed.recovery;
  const releasePrMerged = !!candidate && candidate.commit === run.request.baseRef
    && candidate.cut === run.cut
    && run.request.stages.some(stage => stage.id === "review" && stage.prompt?.includes(`PR ${candidate.pr}`));
  if (run.trigger === "recovery" || run.phase === "publish" && !observed.policy.registryHasTag) {
    if (!releasePrMerged) {
      return settle(project, ports, run, "failed", "release-recovery-evidence-changed") ? "release: recovery-candidate-changed" : null;
    }
  }
  const safety = await releaseState({ ...observed.policy, requested: run.phase === "publish" ? run.trigger === "requested" || run.trigger === "recovery" : true,
    publishing: run.phase === "publish", releasePrMerged: run.phase === "publish" && releasePrMerged,
    frozenCut: run.cut, hold: row.hold?.reason ?? null });
  if (safety.state !== "due") {
    if (run.trigger === "recovery") return settle(project, ports, run, "failed", `release-recovery-safety:${safety.reason}`)
      ? `release: ${safety.reason}` : null;
    return `release: ${safety.reason}`;
  }
  // An operator action can arrive during the ancestry reads inside the policy.
  row = readReleaseProject(project);
  run = row.live;
  if (!run || run.key !== claim.key || run.cut !== claim.cut || run.pipelineId || !run.request) return null;
  if (run.phase !== "publish" && run.taskId && ports.taskDone(project, run.taskId)) {
    return settle(project, ports, run, "completed", "task-done") ? "release: completed" : null;
  }
  if (row.hold) return "release: hold";
  if (!ports.settings(project)?.enabled) return null;
  if (!run.taskId) {
    const prior = row.history.at(-1);
    const refusedTask = prior?.outcome === "refused" && (prior.requestedAt ?? null) === (run.requestedAt ?? null) ? prior.taskId ?? undefined : undefined;
    const adopted = row.request?.taskId ?? refusedTask;
    if (adopted && ports.taskDone(project, adopted)) {
      return settle(project, ports, run, "completed", "task-done") ? "release: completed" : null;
    }
    const taskId = ports.task(project, run, adopted);
    row = mutateReleaseProject(project, current => current.live?.key === run!.key
      ? { ...current, live: { ...current.live, taskId, request: { ...current.live.request!, taskIds: [taskId], finishesTask: current.live.phase === "publish" } } } : current);
    run = row.live;
  }
  if (!run?.request) return null;
  const submitted = run;
  const digest = releaseRequestDigest(run.request);
  let pipelineId: string;
  try { pipelineId = await ports.create(run.request, run.key); }
  catch (error) {
    // Transport errors and unknown outcomes keep both the payload and replay key.
    const lookup = ports.lookup;
    if (!(error instanceof ReleaseValidationRefusal) || error.digest !== digest || !lookup) throw error;
    let retired = false;
    mutateReleaseProject(project, current => {
      const live = current.live;
      if (!live || live.key !== submitted.key || live.cut !== submitted.cut || live.taskId !== submitted.taskId
        || live.pipelineId !== null || !live.request || releaseRequestDigest(live.request) !== digest
        || lookup(live.key)) return current;
      retired = true;
      // Keep the pending request; the next launch selects a current cut through all gates.
      return { ...current, live: null, blocked: null,
        history: [...current.history, { ...live, outcome: "refused" as const, at: ports.now(), reason: error.message }].slice(-10) };
    });
    return retired ? "release: refused" : null;
  }
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
  let run = readReleaseProject(project).live;
  if (!run) return null;

  // A create may have committed durably while its reply was lost. Recover its
  // receipt before stale task/tag evidence can settle and consume this claim.
  if (!run.pipelineId) {
    const pipelineId = ports.lookup?.(run.key);
    if (pipelineId) {
      const claim = run;
      let recovered = false;
      mutateReleaseProject(project, current => {
        if (current.live?.key !== claim.key || current.live.cut !== claim.cut
          || current.live.taskId !== claim.taskId || current.live.pipelineId !== null) return current;
        recovered = true;
        return { ...current, live: { ...current.live, pipelineId },
          request: current.request?.at === claim.requestedAt ? null : current.request };
      });
      const current = readReleaseProject(project).live;
      if (!recovered || !current || current.key !== claim.key || current.cut !== claim.cut
        || current.taskId !== claim.taskId || current.pipelineId !== pipelineId) return null;
      run = current;
    }
  }

  const lane = run.pipelineId ? ports.pipeline(run.pipelineId) : null;
  if (lane?.state === "completed" && run.phase !== "publish" && !lane.mergeActive
    && (lane.mergeCancelled || lane.mergeStopReason)) {
    const reason = lane.mergeCancelled ? "release-merge-cancelled" : `release-merge-stopped: ${lane.mergeStopReason}`;
    return settle(project, ports, run, "failed", reason) ? `release: ${reason}` : null;
  }
  let landing = lane?.state === "completed" && lane.merged ? { commit: lane.mergeCommit, pr: lane.pr } : null;
  if (!landing && lane?.state === "completed" && !lane.mergeActive && run.phase !== "publish"
    && run.request && ports.settings(project)?.enabled) {
    const observed = await ports.observe(project, run.cut);
    const proof = observed?.recovery;
    if (observed?.recoveryForPipeline === run.pipelineId && proof?.cut === run.cut) {
      const current = ports.pipeline(run.pipelineId!);
      if (current?.state === "completed" && !current.mergeActive && !current.mergeCancelled && !current.mergeStopReason) {
        landing = proof;
      }
    }
  }
  if (landing && run.phase !== "publish") {
    const { commit, pr } = landing;
    if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !pr || !run.request) return "release: merge receipt incomplete";
    const setting = ports.settings(project);
    if (!setting?.enabled) return null;
    const request: CreatePipelineRequest = { ...run.request, task: `${run.request.task}: публікація`, baseRef: commit, finishesTask: true,
      stages: releasePublishStages({ cut: run.cut, lastTag: run.lastTag, changes: [], commit, pr,
        askBeforePublish: setting.askBeforePublish,
        approval: !setting.askBeforePublish ? JSON.stringify(setting.publishApproval ?? { at: setting.updatedAt, by: setting.setBy, why: setting.why }) : undefined }) };
    const claim = run;
    const transitioned = mutateReleaseProject(project, current => current.live?.key === claim.key && current.live.cut === claim.cut
      && current.live.taskId === claim.taskId && current.live.pipelineId === claim.pipelineId && current.live.phase !== "publish"
      ? { ...current, live: { ...current.live, key: `${claim.key}:publish`, phase: "publish", releasePipelineId: claim.pipelineId!, pipelineId: null, request,
          trigger: lane?.merged ? claim.trigger : "recovery" } } : current);
    if (transitioned.live?.key !== `${claim.key}:publish`) return null;
    return admit(project, ports);
  }
  const outcome = lane?.state === "completed" && run.phase === "publish" ? "published"
    : lane?.state === "closed" ? lane.declined ? "declined" : "failed" : null;
  if (outcome) return settle(project, ports, run, outcome) ? `release: ${outcome}` : null;
  // Once a creation receipt binds the run, only the pipeline lifecycle can settle it.
  // A done task or a manually pushed tag may predate the pipeline's verification/merge.
  if (run.pipelineId) return lane ? null : "release: pipeline unreadable";
  if (run.phase !== "publish" && run.taskId && ports.taskDone(project, run.taskId)) {
    return settle(project, ports, run, "completed", "task-done") ? "release: completed" : null;
  }
  if (!ports.settings(project)?.enabled) return null;
  const tag = await ports.supersedingTag(project, run);
  // Another process may bind or replace the run while the repository is read.
  const current = readReleaseProject(project).live;
  if (!current || current.key !== run.key || current.cut !== run.cut
    || current.taskId !== run.taskId || current.pipelineId !== run.pipelineId) return null;
  if (tag) return settle(project, ports, run, "superseded", `published-tag: ${tag}`) ? "release: superseded" : null;
  if (run.phase !== "publish" && run.taskId && ports.taskDone(project, run.taskId)) {
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
      if (!setting?.enabled || !input.settings.enabled || !input.seat) return null;
      const observed = await ports.observe(project);
      if (!ports.settings(project)?.enabled) return null;
      if (!observed) { retireInapplicableBlocker(project); return NOT_APPLICABLE; }
      const recovery = observed.policy.mainVersion !== observed.policy.lastTag.version ? observed.recovery : null;
      const recoveryProven = !!recovery?.cut;
      const decision = await releaseState({ ...observed.policy, publishing: recoveryProven, releasePrMerged: recoveryProven,
        frozenCut: recovery?.cut ?? undefined,
        hold: row.hold?.reason ?? null, requested: !!row.request || recoveryProven,
        settled: row.history.at(-1) ?? null });
      if (!ports.settings(project)?.enabled) return null;
      const now = ports.now();
      // A version mismatch needs seat attention even below the next release's amount/gap thresholds.
      const trackBlocker = decision.reason === "release-version-mismatch" || !!row.request
        || decision.count >= observed.policy.minChanges && now - observed.policy.lastTag.at >= observed.policy.minGapHours * 3_600_000;
      mutateReleaseProject(project, current => ({ ...current, observation: { ...decision, at: now, lastTag: observed.policy.lastTag.name,
        nextEligibleAt: releaseGapStart(observed.policy.lastTag.at, row.history.at(-1)) + observed.policy.minGapHours * 3_600_000 },
        blocked: decision.blocker && trackBlocker
          ? current.blocked?.kind === decision.blocker ? current.blocked : { kind: decision.blocker, since: now, episode: `${decision.blocker}:${now}` } : null }));
      if (recovery && !recovery.cut) return "release: release-recovery-cut-unavailable";
      if (recovery) {
        if (decision.state !== "due" || !decision.cut) return `release: ${decision.reason}`;
        if (!/^[a-f0-9]{40}$/.test(recovery.commit) || !Number.isSafeInteger(recovery.pr) || recovery.pr < 1) return "release: recovery-candidate-invalid";
        const runCut = recovery.cut!;
        const key = `release-recovery:${observed.policy.mainVersion}:${recovery.commit}`;
        const request: CreatePipelineRequest = { task: `Release ${observed.policy.mainVersion}: publication recovery`, repoDir: observed.repoDir,
          src: observed.src, baseBranch: "main", baseRef: recovery.commit, autoStart: true, publication: "remote-branch", finishesTask: true,
          spec: `Recover the merged Release ${observed.policy.mainVersion} PR #${recovery.pr} at ${recovery.commit}. Production cut ${runCut}.`,
          stages: releasePublishStages({ cut: runCut, lastTag: observed.policy.lastTag.name, changes: [], commit: recovery.commit, pr: recovery.pr,
            askBeforePublish: setting.askBeforePublish,
            approval: !setting.askBeforePublish ? JSON.stringify(setting.publishApproval ?? { at: setting.updatedAt, by: setting.setBy, why: setting.why }) : undefined }) };
        mutateReleaseProject(project, current => current.live ? current : { ...current, live: { key, cut: runCut,
          lastTag: observed.policy.lastTag.name, trigger: "recovery", phase: "publish", startedAt: now,
          requestedAt: row.request?.at ?? null, taskId: null, pipelineId: null, request } });
        return admit(project, ports);
      }
      if (decision.state !== "due" || !decision.cut) return `release: ${decision.reason}`;
      const cut = decision.cut.revision;
      const prior = row.history.at(-1);
      const key = `release:${project}:${cut}${prior?.cut === cut ? `:after:${prior.at}` : ""}`;
      const request: CreatePipelineRequest = { task: `Реліз Delegatus (після ${observed.policy.lastTag.version})`, repoDir: observed.repoDir,
        src: observed.src, baseBranch: "main", baseRef: cut, autoStart: true, publication: "remote-branch",
        spec: `Production cut ${cut}, served since ${new Date(decision.cut.at).toISOString()}. Trigger: ${decision.reason}; ${decision.count} visible candidates.`,
        stages: releaseStages({ cut, lastTag: observed.policy.lastTag.name, lastTagBoundary: observed.policy.lastTag.boundary, changes: observed.policy.changes, askBeforePublish: setting.askBeforePublish,
          approval: !setting.askBeforePublish ? JSON.stringify(setting.publishApproval ?? { at: setting.updatedAt, by: setting.setBy, why: setting.why }) : undefined }) };
      // Claim before the task write; a second process adopts the same frozen request.
      mutateReleaseProject(project, current => current.live ? current : { ...current,
        live: { key, cut, lastTag: observed.policy.lastTag.name, trigger: decision.reason, startedAt: now, requestedAt: row.request?.at ?? null, taskId: null, pipelineId: null, request } });
      return admit(project, ports);
    }),
  };
}
export function releaseRequestDigest(request: CreatePipelineRequest): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
