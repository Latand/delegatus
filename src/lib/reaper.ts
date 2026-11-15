import type { TmuxHostEvidence } from "@/lib/agent/registry";
import type { Flow, Round } from "@/lib/flows/types";

export type ReaperClass = "flow-worker" | "headless-reviewer" | "probe" | "duplicate-resume" | "dead-transcript";
export type ReaperProtection =
  | "user-authored-message"
  | "authorship-unverified"
  | "mid-turn"
  | "manual-board-placement"
  | "migration-in-progress"
  | "newest-duplicate"
  | "flow-in-progress"
  | "flow-not-merged"
  | "review-verdict-pending"
  | "idle-ttl"
  | "observation-pending"
  | "unclassified";

export interface HeadlessReviewerProcess {
  flowId: string;
  round: number;
  pid: number;
  identity: string;
  path: string | null;
}

/** One row of the reaper report. New rows are always `process` rows; the pane
    fields stay so a report written before pane hosts were retired still reads. */
export interface ReaperAgentReport {
  targetKind: "tmux" | "process";
  paneId: string | null;
  panePid: number | null;
  agentPid: number;
  processIdentity: string | null;
  tmuxEvidence: TmuxHostEvidence | null;
  flowId: string | null;
  round: number | null;
  path: string | null;
  conversationId: string | null;
  class: ReaperClass | null;
  idleSeconds: number | null;
  ttlSeconds: number | null;
  protectedReasons: ReaperProtection[];
  eligible: boolean;
  action: "dry-run" | "retained" | "reaped" | "kill-failed";
}

export interface ReaperReport {
  generatedAt: string;
  mode: "dry-run" | "active";
  configFlag: "LLV_REAPER_ENABLED";
  eligibleCount: number;
  agents: ReaperAgentReport[];
}

export interface ReaperInput {
  now: number;
  reviewerProcesses: HeadlessReviewerProcess[];
  flows: Flow[];
  enabled: boolean;
}

export interface ReaperJournalRecord {
  at: string;
  targetKind: "tmux" | "process";
  paneId: string | null;
  agentPid: number;
  path: string | null;
  class: ReaperClass;
  reason: "idle-ttl-exceeded";
  outcome: "reaped" | "kill-failed";
}

const TTL_SECONDS: Record<ReaperClass, number> = {
  "flow-worker": 30 * 60,
  "headless-reviewer": 5 * 60,
  probe: 60 * 60,
  "duplicate-resume": 0,
  "dead-transcript": 30 * 60,
};

function secondsSince(now: number, timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1000)) : null;
}

function reviewerIdleSeconds(now: number, round: Round): number | null {
  if (!round.error) return secondsSince(now, round.reviewedAt);
  const legacyFallback = [round.reviewedAt, round.relayedAt, round.relayStartedAt, round.spawnStartedAt, round.startedAt]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return secondsSince(now, round.terminalAt ?? (legacyFallback === undefined ? null : new Date(legacyFallback).toISOString()));
}

export function evaluateReaper(input: ReaperInput): ReaperReport {
  const reviewerAgents = input.reviewerProcesses.map((process): ReaperAgentReport => {
    const flow = input.flows.find((candidate) => candidate.id === process.flowId);
    const round = flow?.rounds.find((candidate) => candidate.n === process.round) ?? null;
    const idleSeconds = round ? reviewerIdleSeconds(input.now, round) : null;
    const protectedReasons: ReaperProtection[] = [];
    if (!flow || !round || flow.reviewerMode !== "headless") protectedReasons.push("unclassified");
    else if (!round.verdict && !round.error) protectedReasons.push("review-verdict-pending");
    if (idleSeconds === null) protectedReasons.push("observation-pending");
    else if (idleSeconds < TTL_SECONDS["headless-reviewer"]) protectedReasons.push("idle-ttl");
    const eligible = flow !== undefined && round !== null && flow.reviewerMode === "headless" && protectedReasons.length === 0;
    return {
      targetKind: "process",
      paneId: null,
      panePid: null,
      agentPid: process.pid,
      processIdentity: process.identity,
      tmuxEvidence: null,
      flowId: process.flowId,
      round: process.round,
      path: process.path,
      conversationId: null,
      class: "headless-reviewer",
      idleSeconds,
      ttlSeconds: TTL_SECONDS["headless-reviewer"],
      protectedReasons,
      eligible,
      action: eligible && !input.enabled ? "dry-run" : "retained",
    };
  });
  const agents = reviewerAgents;
  return {
    generatedAt: new Date(input.now).toISOString(),
    mode: input.enabled ? "active" : "dry-run",
    configFlag: "LLV_REAPER_ENABLED",
    eligibleCount: agents.filter((agent) => agent.eligible).length,
    agents,
  };
}

export async function runEvaluatedReaper(
  report: ReaperReport,
  deps: {
    actuate(agent: ReaperAgentReport): Promise<boolean>;
    journal(record: ReaperJournalRecord): void;
  },
): Promise<ReaperReport> {
  if (report.mode === "dry-run") return report;
  for (const agent of report.agents) {
    if (!agent.eligible || agent.class === null) continue;
    let killed = false;
    try {
      killed = await deps.actuate(agent);
    } catch {
      killed = false;
    }
    agent.action = killed ? "reaped" : "kill-failed";
    deps.journal({
      at: new Date().toISOString(),
      targetKind: agent.targetKind,
      paneId: agent.paneId,
      agentPid: agent.agentPid,
      path: agent.path,
      class: agent.class,
      reason: "idle-ttl-exceeded",
      outcome: killed ? "reaped" : "kill-failed",
    });
  }
  return report;
}
