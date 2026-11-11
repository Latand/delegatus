import type { BoardTask } from "@/lib/tasks/types";
import { declaredClassSchema, splitAttemptTime, type LaneClass } from "./accounting";
import type { Pipeline } from "./types";

const time = (at: string | null | undefined) => Date.parse(at ?? "");
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]! : null;
const original = (task: BoardTask) => !task.accounting?.originalTaskId && !task.accounting?.correctsTaskId;
const taskClass = (task: BoardTask): LaneClass => task.accounting?.declaredClass ?? { ...declaredClassSchema.parse({}), project: task.project };

/** All inputs are persisted records. Half-open UTC instants define the
 * calendar period; cohort membership uses creation and retains every lane.
 * Acceptance is explicit; task status and a passed lane earn no completion. */
export function accountingReport(tasks: readonly BoardTask[], pipelines: readonly Pipeline[], period: { from: string; to: string; asOf: string }) {
  const from = time(period.from), to = time(period.to), asOf = time(period.asOf);
  if (![from, to, asOf].every(Number.isFinite) || from >= to || asOf < to) throw new Error("invalid report period");
  const inPeriod = (at: string | null | undefined) => time(at) >= from && time(at) < to;
  const roots = [...new Map(tasks.filter(original).map(task => [task.id, task])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const lanes = [...new Map(pipelines.filter(lane => time(lane.createdAt) <= asOf).map(pipeline => [pipeline.id, pipeline])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const rootId = (id: string) => {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const declaration = taskById.get(id)?.accounting;
      const parent = declaration?.originalTaskId ?? declaration?.correctsTaskId;
      if (!parent) break;
      id = parent;
    }
    return id;
  };
  const laneRoots = new Map(lanes.map(lane => [lane.id, new Set(lane.taskIds.map(rootId))]));
  const attempts = lanes.flatMap(lane => lane.runs.flatMap(run => run.attempts.filter(a => !a.historical).map(attempt => ({ lane, stage: run.stageId, attempt }))));
  const view = (cohort: boolean) => {
    const selected = cohort ? roots.filter(task => inPeriod(task.createdAt)) : roots.filter(task => time(task.createdAt) < to);
    const ids = new Set(selected.map(task => task.id));
    const selectedLanes = lanes.filter(lane => [...laneRoots.get(lane.id)!].some(id => ids.has(id)));
    const laneIds = new Set(selectedLanes.map(lane => lane.id));
    const selectedAttempts = attempts.filter(row => laneIds.has(row.lane.id)
      && (cohort || (!row.attempt.completedAt || time(row.attempt.completedAt) > from)
        && time(row.attempt.startedAt ?? row.attempt.accounting?.admittedAt) < to));
    const accepted = selected.filter(task => task.accounting?.accepted
      && time(task.accounting.accepted.at) <= (cohort ? asOf : to - 1)
      && (cohort || inPeriod(task.accounting.accepted.at)));
    const durations = accepted.flatMap(task => {
      const delta = time(task.accounting!.accepted!.at) - time(task.accounting!.readyAt);
      return Number.isFinite(delta) && delta >= 0 ? [delta] : [];
    });
    const cutoff = cohort ? asOf : to;
    const remainder = selected.filter(task => !task.accounting?.accepted || (cohort ? time(task.accounting.accepted.at) > cutoff : time(task.accounting.accepted.at) >= cutoff))
      .map(task => ({ taskId: task.id, ageMs: Math.max(0, cutoff - time(task.createdAt)),
        readyAgeMs: task.accounting?.readyAt && time(task.accounting.readyAt) <= cutoff ? cutoff - time(task.accounting.readyAt) : null,
        holdKnown: !!task.accounting,
        hold: task.accounting?.holds?.findLast(hold => time(hold.since) < cutoff && (!hold.endedAt || time(hold.endedAt) >= cutoff))?.kind ?? null }));
    const holds = { external: 0, task: 0, postponed: 0, operator: 0, other: 0, unknown: 0 };
    for (const row of remainder) if (!row.holdKnown) holds.unknown++; else if (row.hold) holds[row.hold in holds ? row.hold as keyof typeof holds : "other"]++;
    const classes = new Map<string, { declaredClass: LaneClass; acceptedOriginalTasks: number; p50ReadyToAcceptedMs: number | null; p90ReadyToAcceptedMs: number | null; tasks: string[] }>();
    for (const task of accepted) {
      const declaration = taskClass(task), key = JSON.stringify(declaration);
      const group = classes.get(key) ?? { declaredClass: declaration, acceptedOriginalTasks: 0, p50ReadyToAcceptedMs: null, p90ReadyToAcceptedMs: null, tasks: [] };
      group.acceptedOriginalTasks++; group.tasks.push(task.id); classes.set(key, group);
    }
    for (const group of classes.values()) {
      const times = accepted.filter(task => group.tasks.includes(task.id)).flatMap(task => {
        const ms = time(task.accounting!.accepted!.at) - time(task.accounting!.readyAt);
        return Number.isFinite(ms) && ms >= 0 ? [ms] : [];
      });
      group.p50ReadyToAcceptedMs = percentile(times, .5); group.p90ReadyToAcceptedMs = percentile(times, .9);
    }
    const repeated = selectedAttempts.filter(row => row.attempt.n > 1);
    const unknown = repeated.filter(row => !row.attempt.accounting?.repeatReason || row.attempt.accounting.repeatReason === "unknown").length;
    return { originalTasks: selected.map(task => task.id), acceptedOriginalTasks: accepted.length,
      acceptedTaskIds: accepted.map(task => task.id), classes: [...classes.values()].sort((a, b) => JSON.stringify(a.declaredClass).localeCompare(JSON.stringify(b.declaredClass))),
      p50ReadyToAcceptedMs: percentile(durations, .5), p90ReadyToAcceptedMs: percentile(durations, .9),
      acceptanceTimeUnknown: accepted.length - durations.length, remainder, holds,
      repeatReasons: { repeated: repeated.length, unknown, unknownShare: repeated.length ? unknown / repeated.length : null },
      corrections: tasks.filter(task => task.accounting?.correctsTaskId && ids.has(rootId(task.id)))
        .map(task => ({ taskId: task.id, correctsTaskId: task.accounting!.correctsTaskId })).sort((a, b) => a.taskId.localeCompare(b.taskId)),
      lanes: selectedLanes.map(lane => ({ id: lane.id, taskIds: lane.taskIds, declaredClass: lane.taskClass ?? null })),
      attempts: selectedAttempts.map(({ lane, stage, attempt }) => ({ pipelineId: lane.id, stageId: stage, attempt: attempt.n,
        admittedAt: attempt.accounting?.admittedAt ?? null, startedAt: attempt.accounting?.startedAt ?? attempt.startedAt,
        waitBeforeStartMs: attempt.accounting?.admittedAt && attempt.accounting.startedAt
          ? Math.max(0, time(attempt.accounting.startedAt) - time(attempt.accounting.admittedAt)) : null,
        repeatReason: attempt.n > 1 ? attempt.accounting?.repeatReason ?? "unknown" : null,
        time: cohort ? attempt.accounting?.time ?? splitAttemptTime(attempt.startedAt, attempt.completedAt)
          : splitAttemptTime(new Date(Math.max(from, time(attempt.accounting?.startedAt ?? attempt.startedAt ?? attempt.accounting?.admittedAt))).toISOString(),
            new Date(Math.min(to, attempt.completedAt ? time(attempt.completedAt) : to)).toISOString(), attempt.accounting?.spans) })),
    };
  };
  return { period, calendar: view(false), cohort: view(true) };
}
