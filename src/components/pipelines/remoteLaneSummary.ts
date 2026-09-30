import type { TFunction } from "@/lib/i18n";
import type { LaneRow } from "@/lib/links/laneFeed";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { KanbanLoop, KanbanPipeline, KanbanStageChip } from "@/components/kanban/kanbanModel";
import type { StageView } from "@/components/kanban/pipelineGraph";

import { stageDisplayName } from "./pipelineModel";

/*
 * A lane another machine published, as the summary the one pipeline block
 * draws (docs/design/synced-task-card.md §6). Pure. The chips come straight
 * from the row: the owner's own board decided every state, so nothing here
 * recomputes one. The `Pipeline` inside is presentation only: ids, states and
 * the roles the glyphs read, with no prompt, report, conversation or cursor. It
 * is built here, never stored and never sent to any API.
 */

/** What `PipelineBlock` needs to draw a lane as managed elsewhere. */
export interface ManagedOn {
  host: string;
  /** The line under the chain when the lane waits on a person, or null. */
  note: string | null;
  /** The phone card's reason line: the note without the host part. */
  reason: string | null;
}

const laneStage = (entry: LaneRow["g"][number]): PipelineStage => ({
  id: entry.id,
  kind: entry.lp ? "review-loop" : "run",
  ...(entry.ro ? { role: { roleId: entry.ro as never } } : {}),
  prompt: "",
  next: null,
  onFail: entry.f ? { to: entry.f.to, maxRounds: entry.f.max } : null,
  effectiveRole: { roleId: (entry.ro ?? null) as never, engine: (entry.e ?? "claude") as never, model: entry.m ?? null, effort: null, access: "read-only", promptScaffold: null },
});

export function remoteLaneSummary(row: LaneRow, taskTitle: string): KanbanPipeline {
  const stages = row.g.map(laneStage);
  const byId = new Map(stages.map((stage) => [stage.id, stage] as const));
  const movedAt = new Date(row.at).toISOString();
  /* One attempt for each stage the owner has run, so the pill's "waiting"
     dash, the model glyph and the attempt count read as they do at home. */
  const runs = row.g.map((entry) => ({
    stageId: entry.id,
    attempts: entry.n ? [{ n: entry.n, state: entry.st, effectiveRole: byId.get(entry.id)!.effectiveRole, startedAt: null, completedAt: null, historical: false, input: null, activatedBy: null, output: null, verdict: null, error: null }] : [],
  })) as unknown as Pipeline["runs"];
  const parked = row.g.find((entry) => entry.st === "needs_decision");
  const pipeline = {
    id: row.k.slice(2), task: taskTitle, taskIds: [...row.tk], project: row.p, repoDir: "", worktreeDir: "", branch: "", baseBranch: "", baseRef: "", lastPassedCommit: "",
    stages, runs,
    cursor: row.s === "needs_decision" && parked ? { stageId: parked.id, state: "pending", input: null, activatedBy: null } : null,
    state: row.s, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: movedAt, closedAt: null,
  } as unknown as Pipeline;
  const chips: KanbanStageChip[] = row.g.map((entry) => ({ stage: byId.get(entry.id)!, state: entry.st, rounds: entry.r ?? 0, branch: Boolean(entry.b), rework: false }));
  const views = new Map<string, StageView>(row.g.map((entry) => [entry.id, { state: entry.st, again: false, previous: null, attempts: entry.n ?? 0, attempt: null, rounds: [], rework: false }] as const));
  const loops: KanbanLoop[] = row.g.flatMap((entry) => entry.f && byId.has(entry.f.to)
    ? [{ from: byId.get(entry.id)!, to: byId.get(entry.f.to)!, fired: entry.f.u, max: entry.f.max }] : []);
  return { pipeline, views, chips, loops, waiting: row.g.filter((entry) => !entry.n).length };
}

/** The stage a waiting lane stands on: the one parked on a decision, else the
    one that failed with a fail edge (a spent review), else the last. */
function parkedEntry(row: LaneRow) {
  return row.g.find((entry) => entry.st === "needs_decision") ?? row.g.find((entry) => entry.st === "failed" && entry.f) ?? row.g.at(-1)!;
}

/** The sentence under a lane that waits on a person (§7), in its two forms:
    `note` names the machine that can answer, `reason` leaves it to the card. */
export function remoteLaneNote(t: TFunction, row: LaneRow, host: string, stale: { asOf: number; locale: string } | null): ManagedOn {
  const head = row.s === "needs_decision" ? "decision" : row.s === "needs_review" ? "review" : row.s === "paused" ? "paused" : null;
  let reason: string | null = null;
  let note: string | null = null;
  if (head) {
    const entry = parkedEntry(row);
    const stage = stageDisplayName(t, laneStage(entry));
    const findings = row.s === "needs_decision" && entry.fc ? t("pipelineVerdict.findings", { count: entry.fc }) : null;
    const first = t(`pipelineBlock.remote.${head}Head`, { stage });
    reason = [first, findings].filter(Boolean).join(" · ");
    note = [reason, t(`pipelineBlock.remote.${head}Tail`, { host })].join(" · ");
  }
  if (stale) {
    const time = new Date(stale.asOf).toLocaleTimeString(stale.locale === "uk" ? "uk-UA" : "en-US", { hour: "2-digit", minute: "2-digit" });
    const asOf = t("pipelineBlock.remote.asOf", { time });
    note = [note, asOf].filter(Boolean).join(" · ");
  }
  return { host, note, reason };
}
