import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { latestOperationalStageAttempt } from "@/lib/pipelines/attemptSelection";
import type { Pipeline } from "@/lib/pipelines/types";
import type { ResourceSession } from "@/lib/types";
import type { accountLimitRows } from "./compactAnswers";

export type FleetScope = "all" | { project: string };
export type FleetState = "running" | "waiting" | "stalled" | "limitWait" | "throttled" | "permission";
export interface FleetFilters {
  conversationId?: string; pipelineId?: string; engine?: string; model?: string;
  effort?: string; account?: string; state?: FleetState;
}
type Pair = [number, number];
type LimitWait = { account: string; resetsAt: string | null; resumeAt: string };
type Activity = { state: "working" | "checking" | "idle"; check?: string | null; idleForMs?: number | null };
export interface FleetAgent {
  conversationId: string | null; title: string; project: string;
  pipeline: { id: string; stage: string; attempt: number } | null;
  engine: string; model: string; effort: string; account: string;
  turn: string; silentForMs: number | null;
  seat: boolean; throttled: boolean; permissionWaiting: boolean; permission?: { tool: string; reason: string | null; since: string };
  limitWait?: LimitWait; stalledForMs?: number; retryAt?: string;
  activity?: Activity; check?: unknown; verified?: boolean;
  rssMB?: number; procs?: number; memStale?: boolean; memLimitMB?: number; memKills?: number;
}

/** Indexed durable joins, never a transcript path's account-looking segments. */
export function fleetRuntimeFor(rows: readonly AgentLivenessRecord[], registry: RegistryFile) {
  const entries = registryRowsMatching(registry, "entries", "artifactPath", rows.map(row => row.transcriptPath));
  const byPath = new Map<string, AgentRegistryEntry[]>();
  for (const entry of entries) {
    const group = byPath.get(entry.artifactPath) ?? [];
    group.push(entry); byPath.set(entry.artifactPath, group);
  }
  const receipts = registryRowsMatching(registry, "receipts", "conversationId", rows.flatMap(row => row.conversationId ? [row.conversationId] : []));
  return (row: AgentLivenessRecord) => {
    const rank = (entry: AgentRegistryEntry) => {
      const pid = entry.structuredHost?.process?.pid ?? entry.host?.panePid.pid;
      if (row.host.state === "alive" && row.host.pid !== null && pid === row.host.pid) return 4 + (entry.status === "live" ? 2 : entry.status === "idle" ? 1 : 0);
      return entry.status === "live" ? 2 : entry.status === "idle" ? 1 : 0;
    };
    const entry = [...(byPath.get(row.transcriptPath) ?? [])].sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt))[0];
    const generation = row.conversationId ? registry.conversations[row.conversationId]?.generations.at(-1) : undefined;
    const receipt = receipts.filter(item => item.conversationId === row.conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const profile = entry?.launchProfile ?? generation?.launchProfile ?? receipt?.launchProfile;
    return {
      account: entry?.accountId ?? generation?.accountId ?? receipt?.accountId ?? "unknown",
      model: profile ? profile.model ?? "default" : "unknown",
      effort: profile ? profile.effort ?? "default" : "unknown",
      memory: entry?.structuredHost?.memory,
    };
  };
}

export function fleetLimitWaits(pipelines: readonly Pipeline[]): Map<string, LimitWait> {
  const waits = new Map<string, LimitWait>();
  for (const pipeline of pipelines) {
    if (pipeline.closedAt || pipeline.state === "closed" || pipeline.state === "completed") continue;
    for (const run of pipeline.runs) {
      const attempt = latestOperationalStageAttempt(pipeline, run.stageId);
      const wait = attempt?.providerWait;
      if (!attempt?.conversationId || !wait || wait.actionAt || wait.condition.kind !== "usage_limit") continue;
      waits.set(attempt.conversationId, { account: wait.accountId ?? "unknown",
        resetsAt: wait.resetsAt === null ? null : new Date(wait.resetsAt).toISOString(), resumeAt: wait.resumeAt });
    }
  }
  return waits;
}

export function fleetAgents(rows: readonly AgentLivenessRecord[], runtimeFor: ReturnType<typeof fleetRuntimeFor>,
  seats: ReadonlySet<string>, waits: ReadonlyMap<string, LimitWait>, sessions: readonly ResourceSession[], memStale = false): FleetAgent[] {
  const memory = new Map(sessions.flatMap(row => row.conversationId ? [[row.conversationId, row] as const] : []));
  return rows.map(row => {
    const runtime = runtimeFor(row), session = row.conversationId ? memory.get(row.conversationId) : undefined;
    // #2783 supplies these additive fields; keep its vocabulary without editing its files.
    const activity = row as AgentLivenessRecord & { activity?: Activity; check?: unknown; verified?: boolean };
    return {
      conversationId: row.conversationId, title: row.title, project: row.project,
      pipeline: row.pipeline ? { id: row.pipeline.pipelineId, stage: row.pipeline.stageId, attempt: row.pipeline.attempt } : null,
      engine: row.engine, model: runtime.model, effort: runtime.effort, account: runtime.account,
      turn: row.lifecycle, silentForMs: row.silentForMs, seat: !!row.conversationId && seats.has(row.conversationId),
      throttled: row.reason === "provider_throttled", permissionWaiting: row.reason === "permission_request",
      ...(row.permission ? { permission: { tool: row.permission.tool, reason: row.permission.reason, since: row.permission.since } } : {}),
      ...(row.conversationId && waits.has(row.conversationId) ? { limitWait: waits.get(row.conversationId)! } : {}),
      ...(row.stalledForMs !== null ? { stalledForMs: row.stalledForMs } : {}),
      ...(row.retryAt ? { retryAt: row.retryAt } : {}),
      ...(activity.activity ? { activity: activity.activity } : {}),
      ...(activity.check ? { check: activity.check } : {}),
      ...(activity.verified !== undefined ? { verified: activity.verified } : {}),
      ...(session ? { rssMB: Math.round(session.rssBytes / 2 ** 20), procs: session.procCount,
        ...(memStale ? { memStale: true } : {}) } : {}),
      ...(runtime.memory ? { memLimitMB: Math.round(runtime.memory.limitBytes / 2 ** 20), memKills: runtime.memory.kills } : {}),
    };
  });
}

export function fleetDetailRows(agents: readonly FleetAgent[], filters: FleetFilters): FleetAgent[] {
  return agents.filter(row => (!filters.conversationId || row.conversationId === filters.conversationId)
    && (!filters.pipelineId || row.pipeline?.id === filters.pipelineId)
    && (!filters.engine || row.engine === filters.engine) && (!filters.model || row.model === filters.model)
    && (!filters.effort || row.effort === filters.effort) && (!filters.account || row.account === filters.account)
    && (!filters.state || (filters.state === "limitWait" ? !!row.limitWait : filters.state === "throttled" ? row.throttled
      : filters.state === "permission" ? row.permissionWaiting : row.turn === filters.state)))
    .sort((a, b) => Number(b.turn === "running") - Number(a.turn === "running")
      || (b.silentForMs ?? 0) - (a.silentForMs ?? 0) || String(a.conversationId).localeCompare(String(b.conversationId)));
}

export function fleetPublicRow(row: FleetAgent, scope: FleetScope) {
  const { seat: _seat, throttled: _throttled, permissionWaiting: _permissionWaiting, project, ...detail } = row;
  return { ...detail, ...(scope === "all" ? { project } : {}) };
}

function add(pair: Pair, row: FleetAgent) { pair[0]++; pair[1] += Number(row.turn === "running"); }
function groups(agents: readonly FleetAgent[], field: "engine" | "model" | "effort"): Record<string, Pair> {
  const map = new Map<string, Pair>();
  for (const row of agents) { const pair = map.get(row[field]) ?? [0, 0]; add(pair, row); map.set(row[field], pair); }
  return Object.fromEntries([...map].sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0] || a[0].localeCompare(b[0])));
}
function foldGroup(group: Record<string, Pair>) {
  const keys = Object.keys(group).filter(key => key !== "other");
  const key = keys.at(-1);
  if (!key) return false;
  const pair = group[key], other = group.other ?? [0, 0];
  group.other = [other[0] + pair[0], other[1] + pair[1]]; delete group[key]; return true;
}

export const FLEET_SUMMARY_BYTES = 2_048;
/** Folding retains total pairs and omitted account counts even when all accounts are busy. */
export function fleetSummary(agents: readonly FleetAgent[], accountRows: ReturnType<typeof accountLimitRows>,
  scope: FleetScope, observedAt: string, coverage?: Record<string, unknown>) {
  const byAccount = new Map<string, { engine: string; account: string; agents: Pair; limitWait: number }>();
  for (const row of agents) {
    const key = JSON.stringify([row.engine, row.account]);
    const account = byAccount.get(key) ?? { engine: row.engine, account: row.account, agents: [0, 0], limitWait: 0 };
    add(account.agents, row); byAccount.set(key, account);
    if (row.limitWait) {
      const waitKey = JSON.stringify([row.engine, row.limitWait.account]);
      const waiting = byAccount.get(waitKey) ?? { engine: row.engine, account: row.limitWait.account, agents: [0, 0], limitWait: 0 };
      waiting.limitWait++; byAccount.set(waitKey, waiting);
    }
  }
  for (const row of accountRows.filter(row => row.active)) {
    const key = JSON.stringify([row.engine, row.accountId]);
    if (!byAccount.has(key)) byAccount.set(key, { engine: row.engine, account: row.accountId, agents: [0, 0], limitWait: 0 });
  }
  const accounts = [...byAccount.values()].map(row => {
    const limits = accountRows.find(account => account.engine === row.engine && account.accountId === row.account);
    return { engine: row.engine, account: row.account, agents: row.agents,
      session: limits?.session ? [limits.session.usedPercent, limits.session.resetsAt] : null,
      weekly: limits?.weekly?.usedPercent ?? null,
      ...(limits?.active ? { active: true } : {}), ...(limits && !limits.fresh ? { fresh: false } : {}),
      ...(row.limitWait ? { limitWait: row.limitWait } : {}) };
  }).sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.limitWait ?? 0) - (a.limitWait ?? 0)
    || b.agents[1] - a.agents[1] || b.agents[0] - a.agents[0] || a.account.localeCompare(b.account));
  const activity = { working: 0, checking: 0, idle: 0 };
  for (const row of agents) if (row.turn === "running" && row.activity) activity[row.activity.state]++;
  const summary = {
    observedAt, scope, counts: "[live, running]",
    agents: { live: agents.length, running: agents.filter(row => row.turn === "running").length,
      waiting: agents.filter(row => row.turn === "waiting").length, stalled: agents.filter(row => row.turn === "stalled").length,
      limitWait: agents.filter(row => row.limitWait).length, throttled: agents.filter(row => row.throttled).length,
      permission: agents.filter(row => row.permissionWaiting).length,
      ...(agents.some(row => row.activity) ? { activity } : {}) },
    where: { pipeline: agents.filter(row => row.pipeline).length, seat: agents.filter(row => !row.pipeline && row.seat).length,
      other: agents.filter(row => !row.pipeline && !row.seat).length },
    byEngine: groups(agents, "engine"), byModel: groups(agents, "model"), byEffort: groups(agents, "effort"), accounts,
    ...(coverage && Object.keys(coverage).length ? { coverage } : {}),
    moreAccounts: 0, moreAccountAgents: [0, 0] as Pair, moreAccountLimitWait: 0,
  };
  while (Object.keys(summary.byModel).length > 8) foldGroup(summary.byModel);
  const foldAccount = () => {
    const row = accounts.pop(); if (!row) return false;
    summary.moreAccounts++; summary.moreAccountAgents[0] += row.agents[0]; summary.moreAccountAgents[1] += row.agents[1];
    summary.moreAccountLimitWait += row.limitWait ?? 0; return true;
  };
  while (accounts.length > 8) foldAccount();
  while (Buffer.byteLength(JSON.stringify(summary)) > FLEET_SUMMARY_BYTES) {
    if ((Object.keys(summary.byModel).length > 1 || Object.keys(summary.byModel).some(key => Buffer.byteLength(key) > 128)) && foldGroup(summary.byModel)) continue;
    if (accounts.length && foldAccount()) continue;
    if (Object.keys(summary.byEffort).length > 1 && foldGroup(summary.byEffort)) continue;
    if (Object.keys(summary.byEngine).length > 1 && foldGroup(summary.byEngine)) continue;
    // A single unusually long recorded alias can also exceed the voice budget.
    if (foldGroup(summary.byModel) || foldGroup(summary.byEffort) || foldGroup(summary.byEngine)) continue;
    throw new Error("agent_fleet summary metadata exceeds its byte budget");
  }
  const { moreAccounts, moreAccountAgents, moreAccountLimitWait, ...base } = summary;
  return { ...base, ...(moreAccounts ? { moreAccounts, moreAccountAgents, moreAccountLimitWait } : {}) };
}
