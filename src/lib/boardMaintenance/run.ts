import { statePath } from "@/lib/configDir";
import type { NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { loadTasks, mutateTasks, mutateTasksFile } from "@/lib/tasks/store";
import { taskSeatHoldingSnapshot } from "@/lib/tasks/seatHolding";
import { archiveConversationPaths } from "@/lib/board/archivePlacement";
import { boardFor } from "@/lib/board/store";
import { applyBoardCommand } from "@/lib/board/command";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { repoDirForProject, pipelineSummary, viewerOwnProjectKeys, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { SeatTickCheckInput } from "@/lib/monitor/types";
import { redactMonitorText } from "@/lib/monitor/redact";
import { spawnNoticeFinalMessage } from "@/lib/spawnNotice/production";
import { reportSpawnHeaders, startDeferredSpawnWork, type ReportSpawnResult } from "@/lib/telegram/reportSpawn";
import { claimMaintenanceRun, readMaintenanceProject, readMaintenanceRun, maintenanceRuns, previousMaintenanceRun, patchMaintenanceRun } from "./store";
import { maintenanceRunIsLive, MAINTENANCE_LAUNCH_TIMEOUT_MS, MAINTENANCE_LAUNCH_GRACE_MS, MAINTENANCE_RUN_TIMEOUT_MS, type MaintenanceRun } from "./types";
import { maintenanceBrief, maintenanceCardText, maintenanceCardDetails, parseMaintenanceReport } from "./text";
import { newestWorkAt, taskWorkEvidence, type TaskWorkEvidence, type WorkerEvidence } from "./evidence";

export interface BoardMaintenanceController {
  reconcile(project: string): Promise<string | null>;
  launchIfDue(input: SeatTickCheckInput): Promise<string | null>;
}
export interface MaintenanceObservation {
  state: "running" | "ended" | "failed";
  failure?: MaintenanceRun["failure"];
  conversationId?: string;
  launchId?: string;
  path?: string | null;
  finalText?: string | null;
  turnError?: string | null;
}
export interface BoardMaintenancePorts {
  sources: SeatTickSources;
  launch?: (body: Record<string, unknown>) => Promise<ReportSpawnResult>;
  observe?: (run: MaintenanceRun) => Promise<MaintenanceObservation>;
  evidence?: (project: string, now: number, repoDir: string | null) => Promise<TaskWorkEvidence[]>;
  archive?: (run: MaintenanceRun) => void;
  locale?: () => "uk" | "en";
  timeZone?: () => string | undefined;
  launchTimeoutMs?: number;
}

/** The normal spawn lane, outside Next's request-scoped after(). */
export async function launchMaintenanceConversation(body: Record<string, unknown>): Promise<ReportSpawnResult> {
  const [{ executeSpawnRequest, productionSpawnCommandDependencies }, { ensureOperatorSpawnCapability }, { VIEWER_SPAWN_CAPABILITY_HEADER }] = await Promise.all([
    import("@/lib/agent/spawnCommand"), import("@/lib/agent/operatorCapability"), import("@/lib/agent/spawnPolicy"),
  ]);
  const request = { headers: reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER), json: async () => body } as unknown as NextRequest;
  const response = await executeSpawnRequest(request, { ...productionSpawnCommandDependencies, defer: startDeferredSpawnWork });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
export async function maintenanceWorkEvidence(project: string, now: number, sources: SeatTickSources, repoDir: string | null): Promise<TaskWorkEvidence[]> {
  const tasks = sources.tasks().filter(t => canonicalOrchestratorProject(t.project) === project && t.status !== "done");
  const pipelines = sources.pipelines().filter(p => canonicalOrchestratorProject(p.project) === project);
  const records = await sources.liveness({ project, stallAfterMs: 30 * 60_000, limit: 200 }).catch(() => []);
  const byId = new Map(records.filter(r => r.conversationId).map(r => [r.conversationId!, r]));
  const branches = [...new Set(pipelines.map(p => p.branch).filter(Boolean))];
  const commits = new Map<string, string>();
  if (repoDir && branches.length) {
    try {
      const { stdout } = await promisify(execFile)("git", ["for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "--", ...branches.map(b => `refs/heads/${b}`)], { cwd: repoDir, timeout: 5000, maxBuffer: 256 * 1024 });
      for (const line of stdout.split("\n")) {
        const match = /^(\S+) (\d+)$/.exec(line);
        if (match) commits.set(match[1], new Date(Number(match[2]) * 1000).toISOString());
      }
    } catch { /* The evidence line explicitly renders missing commits as unread. */ }
  }
  return tasks.map(task => {
    const lanes = pipelines.filter(p => p.taskIds?.includes(task.id));
    const workers: WorkerEvidence[] = [];
    const add = (id: string | null | undefined, via: WorkerEvidence["via"], pipelineId?: string, stageId?: string) => {
      if (!id || workers.some(w => w.conversationId === id && w.via === via)) return;
      const r = byId.get(id);
      workers.push({ conversationId: id, via, pipelineId, stageId, lifecycle: r?.lifecycle ?? "unknown", lastRecordAt: r?.lastRecordAt ?? null });
    };
    task.assignments.forEach(a => add(a.conversationId, "assignment"));
    lanes.forEach(p => p.runs.forEach(r => r.attempts.forEach(a => add(a.conversationId, "stage", p.id, r.stageId))));
    return taskWorkEvidence(task, workers, lanes.map(p => ({ pipelineId: p.id, state: p.state, closedAt: p.closedAt, hiddenAt: p.hiddenAt, branch: p.branch, movedAt: newestWorkAt(pipelineSummary(p).activityAt ?? []), branchCommitAt: commits.get(p.branch) ?? null })), now);
  }).filter(e => e.verdict !== "idle");
}
export async function observeMaintenanceRun(run: MaintenanceRun, sources: SeatTickSources): Promise<MaintenanceObservation> {
  const registry = sources.registry();
  const receipt = registry.spawnReceiptForClientAttempt(run.clientAttemptId);
  const bound = receipt ? { conversationId: receipt.conversationId, launchId: receipt.launchId, path: receipt.artifactPath } : {};
  if (receipt && (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted")) return { ...bound, state: "failed", failure: { kind: "launch-failed", detail: receipt.error ?? "launch refused" } };
  const id = receipt?.conversationId ?? run.conversationId;
  const record = id ? (await sources.liveness({ conversationId: id, stallAfterMs: 30 * 60_000, limit: 1 }))[0] : null;
  if (record?.reason === "host_gone_turn_open") return { ...bound, state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } };
  if (record?.reason === "launch_unproven_expired" || (!record || record.reason === "launch_unproven") && sources.now() - Date.parse(run.claimedAt) > MAINTENANCE_LAUNCH_GRACE_MS) return { ...bound, state: "failed", failure: { kind: "launch-failed", detail: "no host proved the launch" } };
  if (receipt?.state === "completed" && record && ["host_alive_turn_idle", "host_gone_turn_settled"].includes(record.reason) && record.lastRecordAt && Date.parse(record.lastRecordAt) >= Date.parse(run.launchedAt ?? run.claimedAt)) {
    const final = spawnNoticeFinalMessage(id!);
    return { ...bound, state: "ended", finalText: final.text, turnError: final.error };
  }
  return { ...bound, state: "running" };
}
function createCard(run: MaintenanceRun, ports: BoardMaintenancePorts): string {
  const input = { project: run.project, text: maintenanceCardText((ports.locale ?? (() => operatorLocale() ?? "uk"))(), run, ports.timeZone?.() ?? operatorTimeZone() ?? undefined), details: maintenanceCardDetails(run), icon: "brush-cleaning", color: "slate", placement: "unplaced", clientRequestId: `board-maintenance:${run.runId}` };
  const outcome = mutateTasksFile(state => {
    let result = createTask(state.tasks, input, state.recentCreates);
    if (!result.ok && result.code === "TASK_BOARD_FULL") result = createTask(state.tasks, { ...input, board: "hidden" }, state.recentCreates);
    return { state: result.ok && !result.replay ? { tasks: result.tasks, recentCreates: result.recentCreates } : undefined, result };
  }, statePath("tasks.json"));
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.task.id;
}
function patchCard(id: string, patch: Record<string, unknown>): void {
  mutateTasks(tasks => {
    const task = tasks.find(t => t.id === id);
    const safePatch = { ...patch };
    if (typeof safePatch.appendLine === "string" && task?.details?.split("\n").includes(safePatch.appendLine)) delete safePatch.appendLine;
    let outcome = patchTask(tasks, id, safePatch);
    if (!outcome.ok && outcome.code === "TASK_BOARD_FULL" && safePatch.status === "blocked") {
      // A full board's fallback card remains reachable via the timer and wake.
      delete safePatch.board;
      outcome = patchTask(tasks, id, safePatch);
    }
    if (!outcome.ok) throw new Error(outcome.error);
    return { tasks: outcome.tasks, result: undefined };
  }, statePath("tasks.json"));
}
function archiveRun(run: MaintenanceRun, sources: SeatTickSources): void {
  if (!run.conversationId && !run.transcriptPath) return;
  const snapshot = sources.registry().readOnlySnapshot();
  const conversation = run.conversationId ? snapshot.conversations[run.conversationId as `conversation_${string}`] : null;
  const paths = [...new Set([...(conversation?.generations.map(g => g.path) ?? []), ...(run.transcriptPath ? [run.transcriptPath] : []), ...(run.launchId ? [`spawn:${run.launchId}`] : [])])];
  if (!paths.length) throw new Error("maintenance conversation has no archivable path yet");
  archiveConversationPaths(run.project, "archive", paths, snapshot, { boardFor, applyBoardCommand: (input, record) => applyBoardCommand(input, { registrySnapshot: () => record }) });
}
function settle(run: MaintenanceRun, patch: Partial<MaintenanceRun>, ports: BoardMaintenancePorts): void {
  const fresh = readMaintenanceRun(run.runId);
  if (!fresh || !maintenanceRunIsLive(fresh)) return;
  const next = { ...fresh, ...patch, ...(patch.log ? { log: { ...fresh.log, attention: patch.log.attention, leftAlone: patch.log.leftAlone, verdict: patch.log.verdict } } : {}), endedAt: new Date(ports.sources.now()).toISOString() };
  if (next.failure) next.failure = { ...next.failure, detail: redactMonitorText(next.failure.detail).replace(/\s+/g, " ").slice(0, 300) };
  if (next.taskId) patchCard(next.taskId, { text: maintenanceCardText((ports.locale ?? (() => operatorLocale() ?? "uk"))(), next, ports.timeZone?.() ?? operatorTimeZone() ?? undefined), status: next.state === "succeeded" ? "done" : "blocked", board: next.state === "succeeded" ? "hidden" : "shown", appendLine: `Result: ${next.state} ${next.endedAt}; ${next.failure ? `${next.failure.kind}: ${next.failure.detail}` : `${next.counts.writes} writes on ${next.counts.tasks} tasks${next.log.verdict ? "" : "; no verdict line"}`}.` });
  if (next.state === "succeeded") (ports.archive ?? (r => archiveRun(r, ports.sources)))(next);
  const superseded: string[] = [];
  const tasks = loadTasks(statePath("tasks.json"));
  for (const old of maintenanceRuns(run.project)) {
    if (old.runId === run.runId || !old.taskId || tasks.find(t => t.id === old.taskId)?.status !== "blocked") continue;
    patchCard(old.taskId, { status: "done", board: "hidden", appendLine: `Superseded by maintenance run ${run.runId} (card ${run.taskId}).` });
    superseded.push(old.taskId);
  }
  patchMaintenanceRun(run.runId, { ...next, supersededTaskIds: superseded });
}
async function launchRun(run: MaintenanceRun, ports: BoardMaintenancePorts): Promise<string> {
  if (!run.taskId) {
    run = patchMaintenanceRun(run.runId, { taskId: createCard(run, ports) })!;
  }
  if (!run.repoDir) { settle(run, { state: "failed", failure: { kind: "no-repository", detail: "project repository could not be found" } }, ports); return "maintenance: failed, no repository"; }
  if (!run.launchBody) {
    const tasks = ports.sources.tasks();
    const previous = previousMaintenanceRun(run.project, run.runId);
    const evidence = await (ports.evidence ?? ((project, now, cwd) => maintenanceWorkEvidence(project, now, ports.sources, cwd)))(run.project, ports.sources.now(), run.repoDir);
    const holding = taskSeatHoldingSnapshot();
    let deployment: ReturnType<SeatTickSources["latestDeployment"]> = { state: "ok", value: null };
    try { deployment = ports.sources.latestDeployment(); } catch { /* installs without a deployment ledger */ }
    const productionLine = viewerOwnProjectKeys().includes(run.project) ? `Delegatus deployment: ${(deployment.state === "ok" ? deployment.value?.revision : null) ?? "unread"}; confirm it succeeded and git merge-base --is-ancestor <merge sha> <deployed revision>.` : "Delegatus records no deployments for this project. Read its instruction files for how it ships; when they name none, a merged pull request is shipped.";
    const brief = maintenanceBrief({ run, previous, previousCardText: tasks.find(t => t.id === previous?.taskId)?.text ?? null, seatTaskIds: tasks.filter(t => t.project === run.project && holding(t) === "holds").map(t => t.id), productionLine, evidence, openCount: tasks.filter(t => t.project === run.project && t.status !== "done").length, now: ports.sources.now() });
    const body = { role: "maintainer", roleParams: {}, cwd: run.repoDir, project: run.project, "prompt": brief, title: tasks.find(t => t.id === run.taskId)?.text.split("\n")[0], taskId: run.taskId, clientAttemptId: run.runId, mcpServers: ["viewer"], notifyLauncher: false };
    // Persist the exact spawn payload before dispatch; restart replays the same digest.
    run = patchMaintenanceRun(run.runId, { state: "launching", launchBody: body, launchedAt: new Date(ports.sources.now()).toISOString() })!;
  }
  if (!maintenanceRunIsLive(run)) return "maintenance: already settled";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    (ports.launch ?? launchMaintenanceConversation)(run.launchBody!),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ports.launchTimeoutMs ?? MAINTENANCE_LAUNCH_TIMEOUT_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!response) return "maintenance: launch pending";
  if (response.status < 200 || response.status >= 300) {
    const kind = ["project_account_refused", "ENGINE_NOT_CONNECTED", "service_tier_unavailable"].includes(String(response.body.code)) ? "no-account" : "launch-refused";
    settle(run, { state: "failed", failure: { kind, detail: String(response.body.error ?? "spawn refused") } }, ports);
    return `maintenance: failed, ${kind}`;
  }
  patchMaintenanceRun(run.runId, { state: response.body.state === "starting" ? "launching" : "running", launchId: typeof response.body.launchId === "string" ? response.body.launchId : null, conversationId: typeof response.body.conversationId === "string" ? response.body.conversationId : null, transcriptPath: typeof response.body.path === "string" ? response.body.path : null });
  return `maintenance: launched ${run.runId}`;
}
export async function reconcileBoardMaintenance(project: string, ports: BoardMaintenancePorts): Promise<string | null> {
  const id = readMaintenanceProject(project)?.currentRunId;
  let run = id ? readMaintenanceRun(id) : null;
  if (!run || !maintenanceRunIsLive(run)) return null;
  if (run.state === "claimed") {
    if (ports.sources.now() - Date.parse(run.claimedAt) > MAINTENANCE_LAUNCH_GRACE_MS) { settle(run, { state: "failed", failure: { kind: "launch-failed", detail: "claimed launch expired before dispatch" } }, ports); return "maintenance: launch expired"; }
    // A restarted controller never spends the same slot twice.
    return launchRun(run, ports);
  }
  const observed = await (ports.observe ?? (r => observeMaintenanceRun(r, ports.sources)))(run);
  if (observed.conversationId) run = patchMaintenanceRun(run.runId, { conversationId: observed.conversationId, launchId: observed.launchId ?? run.launchId, transcriptPath: observed.path ?? run.transcriptPath })!;
  if (observed.state === "failed") settle(run, { state: "failed", failure: observed.failure ?? { kind: "launch-failed", detail: "launch failed" } }, ports);
  else if (observed.state === "ended") {
    if (observed.turnError && !observed.finalText) settle(run, { state: "failed", failure: { kind: "turn-error", detail: observed.turnError } }, ports);
    else {
      const parsed = parseMaintenanceReport(observed.finalText ?? "");
      settle(run, { state: parsed.verdict === "fail" ? "failed" : "succeeded", log: { ...run.log, ...parsed }, failure: parsed.verdict === "fail" ? { kind: "agent-fail", detail: (observed.finalText ?? "").slice(-300) } : null }, ports);
    }
  } else if (ports.sources.now() - Date.parse(run.launchedAt ?? run.claimedAt) > MAINTENANCE_RUN_TIMEOUT_MS) settle(run, { state: "failed", failure: { kind: "timed-out", detail: "maintenance turn exceeded 90 minutes" } }, ports);
  else if (run.state === "launching" && !observed.conversationId && !run.conversationId) return launchRun(run, ports);
  else return null;
  return `maintenance: settled ${run.runId}`;
}
export async function launchBoardMaintenanceIfDue(input: SeatTickCheckInput, ports: BoardMaintenancePorts): Promise<string | null> {
  const setting = input.settings.maintenance;
  if (!setting.enabled) return null;
  if (!input.seat) return "maintenance: waits for a seat";
  const held = readMaintenanceProject(input.project)?.currentRunId;
  if (held && maintenanceRunIsLive(readMaintenanceRun(held)!)) return null;
  try { const deploy = ports.sources.latestDeployment(); if (deploy.state === "ok" && deploy.value && !deploy.value.terminal) return "maintenance: waits, a deployment is running"; } catch { /* No ledger on standalone installs. */ }
  const registry = ports.sources.registry();
  const conversation = registry.conversation(input.seat.conversationId as `conversation_${string}`);
  const repoDir = repoDirForProject(input.project, ports.sources) ?? conversation?.generations.at(-1)?.launchProfile.cwd ?? null;
  const claim = claimMaintenanceRun({ project: input.project, now: ports.sources.now(), intervalHours: setting.intervalHours, seat: { seatEpoch: input.seat.seatEpoch, conversationId: input.seat.conversationId }, repoDir });
  return claim.claimed ? launchRun(claim.run, ports) : null;
}
export function productionBoardMaintenanceController(sources: SeatTickSources, overrides: Omit<BoardMaintenancePorts, "sources"> = {}): BoardMaintenanceController {
  const ports = { sources, ...overrides };
  return { reconcile: project => reconcileBoardMaintenance(project, ports), launchIfDue: input => launchBoardMaintenanceIfDue(input, ports) };
}
