import type { EffectiveSeatTickSettings, SeatTickSettingsActor } from "@/lib/monitor/seatTickSettings";
import { seatTickPolicy } from "@/lib/monitor/seatTick";
import { peekSeatTickState } from "@/lib/monitor/seatTickState";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { latestLedgerDeployment } from "@/lib/runtime/deploymentLedger";
import { redactMonitorText } from "@/lib/monitor/redact";
import { maintenanceRuns, readMaintenanceProject } from "./store";
import { maintenanceRunIsLive, type MaintenanceRun, type MaintenanceCounts, type MaintenanceRunLog } from "./types";
export interface BoardMaintenanceRunSummary {
  runId: string;
  taskId: string | null;
  conversationId: string | null;
  state: MaintenanceRun["state"];
  claimedAt: string;
  launchedAt: string | null;
  endedAt: string | null;
  failure: MaintenanceRun["failure"];
  counts: MaintenanceCounts;
  attentionCount: number;
}
export interface BoardMaintenanceAnswer {
  enabled: boolean;
  intervalHours: number;
  defaultIntervalHours: 3;
  minIntervalHours: 1;
  maxIntervalHours: 168;
  updatedAt: string | null;
  setBy: SeatTickSettingsActor | null;
  live: BoardMaintenanceRunSummary | null;
  lastRun: BoardMaintenanceRunSummary | null;
  nextEligibleAt: string | null;
  nextRunAt: string | null;
  waitingOn: "off" | "live-run" | "interval" | "deployment" | "no-seat" | null;
  lastRunLog?: MaintenanceRunLog;
  runsError: string | null;
}
interface AnswerPorts {
  now?: number;
  verbose?: boolean;
  runs?: typeof maintenanceRuns;
  project?: typeof readMaintenanceProject;
  seat?: (project: string) => boolean;
  deploying?: () => boolean;
  lastCheckAt?: string | null;
  checkIntervalMs?: number | null;
}
const summary = (r: MaintenanceRun): BoardMaintenanceRunSummary => ({ runId: r.runId, taskId: r.taskId, conversationId: r.conversationId, state: r.state, claimedAt: r.claimedAt, launchedAt: r.launchedAt, endedAt: r.endedAt, failure: r.failure, counts: r.counts, attentionCount: r.log.attention.length });
export function boardMaintenanceAnswer(project: string, settings: EffectiveSeatTickSettings, ports: AnswerPorts = {}): BoardMaintenanceAnswer {
  const now = ports.now ?? Date.now();
  const m = settings.maintenance;
  let runs: MaintenanceRun[] = [], lastLaunch: string | null = null, runsError: string | null = null;
  try { runs = (ports.runs ?? maintenanceRuns)(project); lastLaunch = (ports.project ?? readMaintenanceProject)(project)?.lastLaunchAt ?? null; }
  catch (error) { runsError = redactMonitorText(error instanceof Error ? error.message : "maintenance run store unreadable").slice(0, 300); }
  const live = runs.find(maintenanceRunIsLive) ?? null;
  const last = [...runs].reverse().find(r => !maintenanceRunIsLive(r)) ?? null;
  const legacyLaunch = [...runs].reverse().find(run => run.launchedAt)?.launchedAt ?? null;
  const cooldownAnchor = lastLaunch ?? legacyLaunch;
  const eligible = m.enabled && !live ? (cooldownAnchor ? Date.parse(cooldownAnchor) + m.intervalMs : now) : null;
  let waitingOn: BoardMaintenanceAnswer["waitingOn"] = !m.enabled ? "off" : live ? "live-run" : eligible !== null && eligible > now ? "interval" : null;
  if (!waitingOn) {
    if (!(ports.seat ?? (key => !!orchestratorSeatFor(key).active))(project)) waitingOn = "no-seat";
    else { try { if ((ports.deploying ?? (() => { const d = latestLedgerDeployment(); return d.state === "ok" && !!d.value && !d.value.terminal; }))()) waitingOn = "deployment"; } catch { /* standalone installation */ } }
  }
  let interval: number | null = ports.checkIntervalMs ?? null;
  let check = ports.lastCheckAt;
  try {
    if (ports.checkIntervalMs === undefined) interval = seatTickPolicy()?.checkIntervalMs ?? null;
    if (check === undefined) check = peekSeatTickState(project).lastCheckAt;
  } catch { interval = null; }
  const anchor = check ? Date.parse(check) : now;
  const next = eligible !== null && interval ? anchor + Math.max(1, Math.ceil((Math.max(now, eligible) - anchor) / interval)) * interval : null;
  return { enabled: m.enabled, intervalHours: m.intervalHours, defaultIntervalHours: 3, minIntervalHours: 1, maxIntervalHours: 168, updatedAt: settings.maintenanceSetting?.updatedAt ?? null, setBy: settings.maintenanceSetting?.setBy ?? null,
    live: live ? summary(live) : null, lastRun: last ? summary(last) : null, nextEligibleAt: eligible === null ? null : new Date(eligible).toISOString(), nextRunAt: next === null ? null : new Date(next).toISOString(), waitingOn, ...(ports.verbose && last ? { lastRunLog: last.log } : {}), runsError };
}
